/**
 * 把游戏状态翻译成声音：观察 ECS 标签与瞬态组件，驱动配乐段落和音效。
 * 只读游戏数据，不写任何玩法组件。
 *
 * 播放全部交给 IWSDK 自带的 AudioSystem / AudioSource：音频上下文、挂在
 * player.head 上的 AudioListener、以及 XR 会话开始/结束时的 resume/suspend
 * 都由引擎负责。这里只做两件事：把程序化音频注册成资产，以及编排播放与混音音量。
 */

import {
  AudioContext,
  AudioSource,
  createSystem,
  Group,
  PlaybackMode,
  Pressed,
  Vector3,
} from '@iwsdk/core';
import type { Entity, World } from '@iwsdk/core';
import {
  BuildOpen,
  ChiefDeathLight,
  Destroyed,
  DieBurst,
  GameOver,
  GamePaused,
  GameStarted,
  HitCore,
  HitFlash,
  IslewrathChief,
  LaserCycle,
  LevelDirector,
  Repairing,
  ShellFaction,
  SplashFade,
  UnitTag,
  WakeSource,
  WaveIntermission,
} from './components.js';
import {
  INTRO_SFX_CUES,
  registerIntroAudioAssets,
  registerRemainingAudioAssets,
  SFX,
  type SfxCue,
  type SfxDef,
} from './audio-engine.js';
import {
  MUSIC_ASSETS,
  musicAssetDuration,
  type MusicAssetDef,
  type MusicSection,
} from './audio-music.js';

const BOSS_UNIT = 'boss_islewrath';

/** 各段落的音乐总线音量（战斗曲的每一层再单独按战况解锁）。 */
const SECTION_VOLUME: Record<MusicSection, number> = {
  title: 0.55,
  battle: 0.6,
  boss1: 0.65,
  boss2: 0.7,
  victory: 0.75,
  defeat: 0.75,
};

const SEA_VOLUME = 0.45;
/** 音量每秒向目标靠拢的比例；越小淡入淡出越慢。 */
const VOLUME_SMOOTHING = 2.4;

interface SfxSlot {
  def: SfxDef;
  entities: Entity[];
  cursor: number;
}

interface MusicSlot {
  def: MusicAssetDef;
  entity: Entity;
  current: number;
  playing: boolean;
}

/**
 * IWSDK 音频编排器：注册程序化资产、维护 AudioSource 发射体与音乐分轨，
 * 并按战况平滑写入音量。所有声音最终都由引擎的 AudioSystem 播放。
 */
class GameAudio {
  private world: World | null = null;
  private preparing = false;
  private started = false;
  private paused = false;
  private section: MusicSection = 'title';
  private intensity = 0;
  private elapsed = 0;
  private oneShotTimer = 0;
  private pendingSection: MusicSection | null = null;
  private seaEntity: Entity | null = null;
  private seaCurrent = 0;
  private readonly sfx = new Map<SfxCue, SfxSlot>();
  private readonly lastPlay = new Map<SfxCue, number>();
  private readonly music: MusicSlot[] = [];

  /**
   * 由 AudioSystem.init 调用：先合成标题曲与首屏音效并立刻排队播放，
   * 其余战斗音效和段落留在后台继续合成，不占首屏时间。
   */
  attach(world: World): void {
    this.world = world;
    if (this.preparing) return;
    this.preparing = true;
    void this.prepare();
  }

  private async prepare(): Promise<void> {
    try {
      await registerIntroAudioAssets();
      this.spawnIntro();
      this.started = true;
      const target = this.section;
      if (this.hasSection(target)) {
        this.beginSection(target);
      } else {
        this.beginSection('title');
        if (target !== 'title') this.pendingSection = target;
      }
      // 浏览器允许自动播放时立即有声；否则上下文保持挂起，
      // 已排队的标题曲会在首次手势 resume 的瞬间从第 0 拍开始。
      this.resumeContext();
    } catch (error) {
      console.error('标题音乐初始化失败', error);
    }
    try {
      await registerRemainingAudioAssets();
      this.spawnRemaining();
      if (this.started && this.pendingSection) {
        const next = this.pendingSection;
        this.pendingSection = null;
        this.beginSection(next);
      }
    } catch (error) {
      console.error('战斗音频初始化失败', error);
    }
  }

  /** 首次用户手势：解锁共享 AudioContext（标题曲已排队等它）。 */
  unlock(): void {
    this.resumeContext();
  }

  private resumeContext(): void {
    const context = AudioContext.getContext();
    if (context.state === 'suspended') {
      void context.resume().catch(() => undefined);
    }
  }

  /** 切换配乐段落；同一段落重复调用无副作用。 */
  setSection(next: MusicSection): void {
    if (next === this.section) return;
    if (!this.started || !this.hasSection(next)) {
      // 目标段落的资产还没合成完：先让现段落继续响，等后台批次补齐再切。
      if (!this.started) this.section = next;
      else this.pendingSection = next;
      return;
    }
    this.beginSection(next);
  }

  setIntensity(value: number): void {
    this.intensity = value;
  }

  setPaused(value: boolean): void {
    this.paused = value;
  }

  /** 非空间化播放（UI、号角、警报）。 */
  play(cue: SfxCue, gain = 1): void {
    const entity = this.claim(cue, gain);
    if (!entity) return;
    entity.setValue(AudioSource, '_playRequested', true);
  }

  /** 世界坐标播放，位置交给 IWSDK 的 PositionalAudio 做衰减与声像。 */
  playAt(cue: SfxCue, x: number, y: number, z: number, gain = 1): void {
    const entity = this.claim(cue, gain);
    if (!entity) return;
    const object = entity.object3D;
    if (object) object.position.set(x, y, z);
    entity.setValue(AudioSource, '_playRequested', true);
  }

  /** 每帧平滑混音；由 AudioSystem.update 在游戏系统之后调用。 */
  update(delta: number): void {
    this.elapsed += delta;
    if (this.oneShotTimer > 0) {
      this.oneShotTimer -= delta;
      if (this.oneShotTimer <= 0) this.finishOneShot();
    }
    if (!this.started) return;

    const smoothing = Math.min(1, delta * VOLUME_SMOOTHING);
    for (const slot of this.music) {
      const target = this.targetFor(slot.def);
      if (Math.abs(target - slot.current) > 0.002) {
        slot.current += (target - slot.current) * smoothing;
        slot.entity.setValue(AudioSource, 'volume', slot.current);
      } else if (slot.current !== target) {
        slot.current = target;
        slot.entity.setValue(AudioSource, 'volume', target);
      }
      // 非当前段落的循环缓冲淡到听不见后停掉，回来时四层会重新同步起播。
      if (
        slot.playing &&
        slot.def.section !== this.section &&
        slot.current <= 0.002
      ) {
        slot.playing = false;
        slot.entity.setValue(AudioSource, '_stopRequested', true);
      }
    }

    if (this.seaEntity) {
      const seaTarget = this.paused ? 0 : SEA_VOLUME;
      if (Math.abs(seaTarget - this.seaCurrent) > 0.002) {
        this.seaCurrent += (seaTarget - this.seaCurrent) * smoothing;
        this.seaEntity.setValue(AudioSource, 'volume', this.seaCurrent);
      }
    }
  }

  /** 该段落的音频资产是否已经合成并建好分轨。 */
  private hasSection(section: MusicSection): boolean {
    for (const slot of this.music) {
      if (slot.def.section === section) return true;
    }
    return false;
  }

  private beginSection(next: MusicSection): void {
    this.section = next;
    this.oneShotTimer = 0;
    for (const slot of this.music) {
      if (slot.def.section !== next) continue;
      if (!slot.playing) {
        slot.playing = true;
        slot.entity.setValue(AudioSource, '_playRequested', true);
      }
      if (!slot.def.loop) {
        this.oneShotTimer = Math.max(
          this.oneShotTimer,
          musicAssetDuration(slot.def) + 0.7,
        );
      }
    }
  }

  private finishOneShot(): void {
    for (const slot of this.music) {
      if (slot.def.loop || slot.def.section !== this.section) continue;
      slot.playing = false;
      slot.entity.setValue(AudioSource, '_stopRequested', true);
    }
    this.beginSection('title');
  }

  private targetFor(def: MusicAssetDef): number {
    if (this.paused || def.section !== this.section) return 0;
    if (def.section === 'battle') {
      switch (def.stem) {
        case 'base':
          return 0.6;
        case 'arp':
          return this.intensity >= 1 ? 0.5 : 0;
        case 'brass':
          return this.intensity >= 2 ? 0.5 : 0;
        case 'lead':
          return this.intensity >= 3 ? 0.55 : 0;
        default:
          return 0;
      }
    }
    return SECTION_VOLUME[def.section];
  }

  /** 取一个可用的发射体：限流、轮转、写入本次音量。 */
  private claim(cue: SfxCue, gain: number): Entity | null {
    if (!this.started) return null;
    const slot = this.sfx.get(cue);
    if (!slot || slot.entities.length === 0) return null;
    const now = this.elapsed;
    const previous = this.lastPlay.get(cue);
    if (previous !== undefined && now - previous < slot.def.minGap) return null;
    this.lastPlay.set(cue, now);
    const entity = slot.entities[slot.cursor];
    slot.cursor = (slot.cursor + 1) % slot.entities.length;
    entity.setValue(
      AudioSource,
      'volume',
      Math.min(1, slot.def.volume * gain),
    );
    return entity;
  }

  /** 首屏批次：标题曲、海浪与界面音效。 */
  private spawnIntro(): void {
    for (const def of MUSIC_ASSETS) {
      if (def.section === 'title') this.spawnMusic(def);
    }
    for (const cue of INTRO_SFX_CUES) this.spawnSfx(cue);
    this.spawnSea();
  }

  /** 后台批次：Boss/胜负段落与其余战斗音效，首屏合成完再补上。 */
  private spawnRemaining(): void {
    for (const def of MUSIC_ASSETS) {
      if (def.section !== 'title') this.spawnMusic(def);
    }
    for (const cue of Object.keys(SFX) as SfxCue[]) {
      if (INTRO_SFX_CUES.includes(cue)) continue;
      this.spawnSfx(cue);
    }
  }

  private spawnSfx(cue: SfxCue): void {
    const world = this.world;
    const def = SFX[cue];
    if (!world || def.pool <= 0 || this.sfx.has(cue)) return;
    const entities: Entity[] = [];
    for (let i = 0; i < def.pool; i++) {
      const entity = world.createTransformEntity(new Group(), {
        persistent: true,
      });
      entity.addComponent(AudioSource, {
        src: def.key,
        volume: def.volume,
        loop: false,
        autoplay: false,
        positional: def.positional,
        refDistance: def.refDistance,
        rolloffFactor: def.rolloffFactor,
        maxDistance: def.maxDistance,
        playbackMode: PlaybackMode.Restart,
        maxInstances: 1,
      });
      entities.push(entity);
    }
    this.sfx.set(cue, { def, entities, cursor: 0 });
  }

  private spawnMusic(def: MusicAssetDef): void {
    const world = this.world;
    if (!world) return;
    const entity = world.createTransformEntity(new Group(), {
      persistent: true,
    });
    entity.addComponent(AudioSource, {
      src: def.key,
      volume: 0,
      loop: def.loop,
      autoplay: false,
      positional: false,
      playbackMode: PlaybackMode.Restart,
      maxInstances: 1,
    });
    this.music.push({ def, entity, current: 0, playing: false });
  }

  private spawnSea(): void {
    const world = this.world;
    if (!world || this.seaEntity) return;
    const sea = world.createTransformEntity(new Group(), { persistent: true });
    sea.addComponent(AudioSource, {
      src: SFX['ambience-sea'].key,
      volume: 0,
      loop: true,
      autoplay: false,
      positional: false,
      playbackMode: PlaybackMode.Restart,
      maxInstances: 1,
    });
    this.seaEntity = sea;
    // 海浪不需要等手势：排进队列，上下文一恢复就从第 0 秒铺底。
    sea.setValue(AudioSource, '_playRequested', true);
  }
}

export const gameAudio = new GameAudio();

/** 浏览器首次手势时调用：解锁 three/IWSDK 共享的 AudioContext。 */
export function unlockAudio(): void {
  gameAudio.unlock();
}

export class AudioSystem extends createSystem({
  directors: { required: [LevelDirector] },
  started: { required: [LevelDirector, GameStarted] },
  over: { required: [LevelDirector, GameOver] },
  intermission: { required: [LevelDirector, WaveIntermission] },
  buildOpen: { required: [LevelDirector, BuildOpen] },
  units: { required: [UnitTag] },
  shots: { required: [ShellFaction] },
  flashes: { required: [HitFlash] },
  bursts: { required: [DieBurst] },
  splashes: { required: [SplashFade, WakeSource] },
  lasers: { required: [LaserCycle] },
  chiefs: { required: [IslewrathChief] },
  deathLights: { required: [ChiefDeathLight] },
  repairing: { required: [Repairing] },
  lostCores: { required: [HitCore, Destroyed] },
  pressed: { required: [Pressed] },
}) {
  private readonly point = new Vector3();
  private readonly laserStates = new Map<number, string>();
  private readonly sweepStates = new Map<number, string>();
  private readonly boltTimers = new Map<number, number>();
  private wasPaused = false;
  private repairTimer = 0;

  init(): void {
    gameAudio.attach(this.world);

    this.queries.shots.subscribe('qualify', (shell: Entity) => {
      const faction = String(shell.getValue(ShellFaction, 'faction'));
      if (faction === 'defender') {
        this.playAt(shell, 'cannon-defender', 0.95);
        return;
      }
      const unitType = String(shell.getValue(ShellFaction, 'unitType'));
      if (unitType === 'ornithopter') {
        this.playAt(shell, 'stone-throw', 0.9);
      } else if (unitType === 'bombardier') {
        this.playAt(shell, 'bomb-drop', 0.9);
      } else if (unitType === 'islewrath-turret') {
        this.playAt(shell, 'cannon-pirate', 0.9);
      } else {
        this.playAt(shell, 'cannon-pirate', 0.75);
      }
    });

    this.queries.flashes.subscribe('qualify', (flash: Entity) => {
      const peakScale = Number(flash.getValue(HitFlash, 'peakScale'));
      this.playAt(flash, peakScale > 1.1 ? 'impact-wood' : 'impact-metal', 0.9);
    });

    this.queries.bursts.subscribe('qualify', (burst: Entity) => {
      const ratio = Number(burst.getValue(DieBurst, 'sizeRatio'));
      this.playAt(burst, ratio >= 0.95 ? 'explosion-ship' : 'explosion-cannon', 1);
    });

    this.queries.splashes.subscribe('qualify', (splash: Entity) => {
      this.playAt(splash, 'splash', 0.8);
    });

    this.queries.units.subscribe('qualify', (unit: Entity) => {
      if (String(unit.getValue(UnitTag, 'unitType')) !== BOSS_UNIT) return;
      gameAudio.play('boss-horn');
    });

    this.queries.chiefs.subscribe('qualify', () => {
      gameAudio.play('chief-rise');
    });

    this.queries.lostCores.subscribe('qualify', (core: Entity) => {
      this.playAt(core, 'defender-lost', 1);
    });

    this.queries.pressed.subscribe('qualify', () => {
      gameAudio.play('ui-click');
    });

    this.queries.started.subscribe('qualify', () => gameAudio.play('wave-horn'));
    this.queries.intermission.subscribe('qualify', () => gameAudio.play('wave-horn'));
    this.queries.buildOpen.subscribe('qualify', () => gameAudio.play('ui-open'));
    this.queries.buildOpen.subscribe('disqualify', () => gameAudio.play('ui-close'));

    this.queries.over.subscribe('qualify', (director: Entity) => {
      const phase = String(director.getValue(LevelDirector, 'phase'));
      if (phase === 'game-cleared') {
        gameAudio.setSection('victory');
        gameAudio.play('boss-horn', 0.7);
      } else {
        gameAudio.setSection('defeat');
        gameAudio.play('defender-lost', 1);
      }
    });

    this.queries.lasers.subscribe('disqualify', (laser: Entity) => {
      this.laserStates.delete(laser.index);
    });
    this.queries.deathLights.subscribe('disqualify', (chief: Entity) => {
      this.sweepStates.delete(chief.index);
      this.boltTimers.delete(chief.index);
    });
  }

  update(delta: number): void {
    this.syncDirector();
    this.trackLasers();
    this.trackDeathLights();
    this.trackRepair(delta);
    gameAudio.setIntensity(this.intensity());
    gameAudio.update(delta);
  }

  private syncDirector(): void {
    let director: Entity | undefined;
    for (const candidate of this.queries.directors.entities) {
      director = candidate;
      break;
    }
    if (!director) return;

    const paused = director.hasComponent(GamePaused);
    if (paused !== this.wasPaused) {
      this.wasPaused = paused;
      gameAudio.setPaused(paused);
    }

    // GameOver 期间音乐的最终段落由 over 查询决定，这里不再抢回。
    if (director.hasComponent(GameOver)) return;

    if (!director.hasComponent(GameStarted)) {
      gameAudio.setSection('title');
      return;
    }
    if (this.queries.chiefs.entities.size > 0) gameAudio.setSection('boss2');
    else if (this.bossAlive()) gameAudio.setSection('boss1');
    else gameAudio.setSection('battle');
  }

  private bossAlive(): boolean {
    for (const unit of this.queries.units.entities) {
      if (String(unit.getValue(UnitTag, 'unitType')) === BOSS_UNIT) return true;
    }
    return false;
  }

  private trackLasers(): void {
    for (const laser of this.queries.lasers.entities) {
      const state = String(laser.getValue(LaserCycle, 'state'));
      const previous = this.laserStates.get(laser.index);
      if (previous === state) continue;
      this.laserStates.set(laser.index, state);
      if (state === 'charging') this.playAt(laser, 'laser-charge', 0.9);
      else if (state === 'firing') this.playAt(laser, 'laser-fire', 1);
    }
  }

  private trackDeathLights(): void {
    for (const chief of this.queries.deathLights.entities) {
      const state = String(chief.getValue(ChiefDeathLight, 'state'));
      const previous = this.sweepStates.get(chief.index);
      if (previous !== state) {
        this.sweepStates.set(chief.index, state);
        if (state === 'forming') this.playAt(chief, 'sweep-form', 1);
        else if (state === 'sweeping') this.playAt(chief, 'sweep-fire', 1);
      }

      const bolt = Number(chief.getValue(ChiefDeathLight, 'boltTimer'));
      const previousBolt = this.boltTimers.get(chief.index) ?? 0;
      this.boltTimers.set(chief.index, bolt);
      if (bolt > previousBolt + 0.05) {
        gameAudio.playAt(
          'lightning',
          Number(chief.getValue(ChiefDeathLight, 'boltTargetX')),
          1.2,
          Number(chief.getValue(ChiefDeathLight, 'boltTargetZ')),
          1,
        );
      }
    }
  }

  private trackRepair(delta: number): void {
    if (this.queries.repairing.entities.size === 0) {
      this.repairTimer = 0;
      return;
    }
    this.repairTimer -= delta;
    if (this.repairTimer > 0) return;
    this.repairTimer = 0.36;
    for (const unit of this.queries.repairing.entities) {
      this.playAt(unit, 'repair-tick', 0.8);
      break;
    }
  }

  private intensity(): number {
    if (this.queries.chiefs.entities.size > 0 || this.bossAlive()) return 3;
    let attackers = 0;
    for (const unit of this.queries.units.entities) {
      if (String(unit.getValue(UnitTag, 'faction')) === 'attacker') attackers += 1;
    }
    if (attackers >= 4) return 3;
    if (attackers >= 2) return 2;
    if (attackers >= 1) return 1;
    return 0;
  }

  private playAt(entity: Entity, cue: SfxCue, gain: number): void {
    const object = entity.object3D;
    if (!object) {
      gameAudio.play(cue, gain);
      return;
    }
    object.getWorldPosition(this.point);
    gameAudio.playAt(cue, this.point.x, this.point.y, this.point.z, gain);
  }
}
