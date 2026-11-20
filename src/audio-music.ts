/**
 * 程序化配乐：在加载阶段用 OfflineAudioContext 把每个段落渲染成可循环缓冲，
 * 之后交给 IWSDK AudioSystem 的 AudioSource 播放，音频上下文与 XR 生命周期由 IWSDK 管理。
 */

export type MusicSection =
  | 'title'
  | 'battle'
  | 'boss1'
  | 'boss2'
  | 'victory'
  | 'defeat';

export type MusicStem = 'full' | 'base' | 'arp' | 'brass' | 'lead';

export interface MusicAssetDef {
  key: string;
  section: MusicSection;
  stem: MusicStem;
  bpm: number;
  bars: number;
  loop: boolean;
}

/** 战斗曲的层：基础节奏、琶音、铜管、主旋律，全部来自同一时间轴的离线渲染。 */
export const MUSIC_ASSETS: MusicAssetDef[] = [
  { key: 'music/title.wav', section: 'title', stem: 'full', bpm: 63, bars: 8, loop: true },
  { key: 'music/battle-base.wav', section: 'battle', stem: 'base', bpm: 108, bars: 8, loop: true },
  { key: 'music/battle-arp.wav', section: 'battle', stem: 'arp', bpm: 108, bars: 8, loop: true },
  { key: 'music/battle-brass.wav', section: 'battle', stem: 'brass', bpm: 108, bars: 8, loop: true },
  { key: 'music/battle-lead.wav', section: 'battle', stem: 'lead', bpm: 108, bars: 8, loop: true },
  { key: 'music/boss1.wav', section: 'boss1', stem: 'full', bpm: 126, bars: 8, loop: true },
  { key: 'music/boss2.wav', section: 'boss2', stem: 'full', bpm: 146, bars: 8, loop: true },
  { key: 'music/victory.wav', section: 'victory', stem: 'full', bpm: 120, bars: 4, loop: false },
  { key: 'music/defeat.wav', section: 'defeat', stem: 'full', bpm: 56, bars: 3, loop: false },
];

const mtof = (midi: number): number => 440 * Math.pow(2, (midi - 69) / 12);

const BATTLE_CHORDS = [
  [50, 53, 57],
  [46, 50, 53],
  [41, 45, 48],
  [48, 52, 55],
];
const BOSS_ONE_CHORDS = [
  [50, 53, 57],
  [51, 55, 58],
  [50, 53, 57],
  [45, 49, 52],
];
const BOSS_TWO_CHORDS = [
  [50, 53, 57],
  [49, 52, 55],
  [48, 52, 55],
  [47, 50, 53],
];
const TITLE_CHORDS = [
  [50, 53, 57],
  [46, 50, 53],
  [41, 45, 48],
  [45, 49, 52],
];
const VICTORY_CHORDS = [
  [50, 54, 57],
  [43, 50, 55],
  [45, 49, 52],
  [50, 54, 57],
];

class OfflineComposer {
  private readonly ctx: BaseAudioContext;
  private readonly out: AudioNode;
  private readonly def: MusicAssetDef;

  constructor(ctx: BaseAudioContext, out: AudioNode, def: MusicAssetDef) {
    this.ctx = ctx;
    this.out = out;
    this.def = def;
  }

  render(): void {
    const stepDuration = 60 / this.def.bpm / 4;
    const total = this.def.bars * 16;
    for (let step = 0; step < total; step++) {
      this.scheduleStep(step, 0.02 + step * stepDuration);
    }
  }

  private barDuration(): number {
    return (60 / this.def.bpm) * 4;
  }

  private scheduleStep(step: number, time: number): void {
    const bar = Math.floor(step / 16);
    const i = step % 16;
    switch (this.def.section) {
      case 'title':
        this.titleStep(i, bar, time);
        break;
      case 'battle':
        this.battleStep(i, bar, time);
        break;
      case 'boss1':
        this.bossOneStep(i, bar, time);
        break;
      case 'boss2':
        this.bossTwoStep(i, bar, time);
        break;
      case 'victory':
        this.victoryStep(i, bar, time);
        break;
      case 'defeat':
        this.defeatStep(i, bar, time);
        break;
    }
  }

  private titleStep(i: number, bar: number, time: number): void {
    const chord = TITLE_CHORDS[Math.floor(bar / 2) % 4];
    if (i === 0 && bar % 2 === 0) {
      this.pad(time, chord, this.barDuration() * 2, 0.05);
      this.voice('sine', chord[0] - 12, time, this.barDuration() * 2, 0.14, 0.5);
    }
    const motif =
      bar % 2 === 0
        ? [74, 0, 0, 0, 77, 0, 76, 0, 0, 0, 72, 0, 69, 0, 0, 0]
        : [72, 0, 0, 0, 74, 0, 72, 0, 0, 0, 69, 0, 65, 0, 0, 0];
    const note = motif[i];
    if (note) this.voice('triangle', note, time, 0.9, 0.085, 0.01, 3200);
  }

  private battleStep(i: number, bar: number, time: number): void {
    const chord = BATTLE_CHORDS[Math.floor(bar / 2) % 4];
    if (this.def.stem === 'base') {
      if (i === 0 && bar % 2 === 0) {
        this.pad(time, chord, this.barDuration() * 2, 0.035);
        this.voice('sine', chord[0] - 12, time, this.barDuration() * 2, 0.14, 0.2);
      }
      if (i % 2 === 0) {
        const offsets = [0, 0, 7, 0, 12, 7, 0, 7];
        this.voice('square', chord[0] - 12 + offsets[i / 2], time, 0.17, 0.11, 0.005, 680);
      }
      if (i === 0 || i === 8) this.kick(time, 0.55);
      if (i === 4 || i === 12) this.snare(time, 0.24);
      if (i % 2 === 0) this.hat(time, 0.07);
      if (i % 2 === 1) this.hat(time, 0.04);
      if (i === 14) this.kick(time, 0.3);
      if (bar % 8 === 7 && i >= 12) this.tom(time, 50, 0.16);
      return;
    }
    if (this.def.stem === 'arp') {
      const arpNote = chord[i % 3] + 12 + (Math.floor(i / 3) % 2 === 0 ? 0 : 12);
      this.voice('triangle', arpNote, time, 0.09, 0.035, 0.004, 4200);
      return;
    }
    if (this.def.stem === 'brass') {
      if (i === 0) this.stab(time, chord, 0.5, 0.05);
      return;
    }
    if (this.def.stem === 'lead' && bar % 4 === 0) {
      const lead = [74, 0, 0, 0, 77, 0, 76, 0, 74, 0, 0, 0, 72, 0, 69, 0];
      const note = lead[i];
      if (note) this.voice('sawtooth', note, time, 0.8, 0.05, 0.02, 2700);
    }
  }

  private bossOneStep(i: number, bar: number, time: number): void {
    const chord = BOSS_ONE_CHORDS[Math.floor(bar / 2) % 4];
    if (i === 0 && bar % 2 === 0) {
      this.pad(time, chord, this.barDuration() * 2, 0.045);
      this.voice('sine', chord[0] - 12, time, this.barDuration() * 2, 0.16, 0.15);
    }
    if (i % 2 === 0) {
      const offsets = [0, 0, 1, 0, 12, 1, 0, -1];
      this.voice('square', chord[0] - 12 + offsets[i / 2], time, 0.15, 0.13, 0.004, 720);
    }
    if (i === 0 || i === 8) {
      this.kick(time, 0.6);
      this.timpani(time, 38, 0.42);
    }
    if (i === 4 || i === 12) this.snare(time, 0.26);
    if (i % 2 === 0) this.hat(time, 0.075);
    if (i === 0) this.stab(time, chord, 0.6, 0.055);
    if (i === 0 && bar % 4 === 0) this.siren(time, 81, 82, 1.5, 0.04);
    if (bar % 4 === 3 && i >= 8 && i % 2 === 0) this.snare(time, 0.12);
  }

  private bossTwoStep(i: number, bar: number, time: number): void {
    const chord = BOSS_TWO_CHORDS[bar % 4];
    if (i % 2 === 0) {
      const note = i % 4 === 0 ? chord[0] - 12 : chord[0];
      this.voice('square', note, time, 0.09, 0.12, 0.003, 820);
    }
    if (i % 4 === 0) this.kick(time, 0.58);
    if (i === 14) this.kick(time, 0.32);
    if (i === 4 || i === 12) this.snare(time, 0.27);
    this.hat(time, i % 2 === 0 ? 0.06 : 0.03);
    this.voice('triangle', chord[i % 3] + 24, time, 0.07, 0.03, 0.003, 5000);
    if (i === 0) {
      this.stab(time, chord, 0.9, 0.045);
      if (bar % 4 === 0) this.cymbal(time, 0.18);
    }
    if (i === 0 && bar % 2 === 0) this.siren(time, 83, 84, 1.2, 0.035);
    if (bar % 4 === 3 && i >= 12) this.tom(time, 48, 0.18);
  }

  private victoryStep(i: number, bar: number, time: number): void {
    const chord = VICTORY_CHORDS[bar % 4];
    if (i === 0) {
      this.pad(time, chord, this.barDuration(), 0.06);
      this.voice('sine', chord[0] - 12, time, this.barDuration(), 0.18, 0.05);
      this.timpani(time, 38, 0.5);
    }
    if (i % 4 === 0) {
      const melody = [74, 78, 81, 86];
      this.voice('sawtooth', melody[i / 4], time, 0.6, 0.09, 0.02, 3000);
    }
    if (i === 0 || i === 8) this.kick(time, 0.5);
    if (i === 4 || i === 12) this.snare(time, 0.2);
    if (bar % 4 === 3 && i === 0) this.cymbal(time, 0.16);
  }

  private defeatStep(i: number, bar: number, time: number): void {
    const line = [62, 60, 58];
    if (i === 0) {
      this.voice('sine', 26, time, this.barDuration(), 0.3, 0.4);
      this.voice('sawtooth', line[bar % 3], time, this.barDuration() * 0.9, 0.075, 0.35, 900);
      this.timpani(time, 33, 0.35);
    }
    if (bar % 2 === 1 && i === 8) {
      this.voice('triangle', line[bar % 3] + 12, time, 1.2, 0.03, 0.1);
    }
  }

  private voice(
    type: OscillatorType,
    midi: number,
    time: number,
    duration: number,
    peak: number,
    attack = 0.01,
    cutoff = 0,
  ): void {
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = mtof(midi);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), time + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    let tail: AudioNode = osc;
    if (cutoff > 0) {
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = cutoff;
      filter.Q.value = 0.7;
      osc.connect(filter);
      tail = filter;
    }
    tail.connect(gain);
    gain.connect(this.out);
    osc.start(time);
    osc.stop(time + duration + 0.03);
  }

  private pad(time: number, notes: number[], duration: number, peak: number): void {
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1400;
    filter.Q.value = 0.5;
    filter.connect(this.out);
    for (const midi of notes) {
      for (const detune of [-7, 7]) {
        const osc = this.ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = mtof(midi);
        osc.detune.value = detune;
        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(0.0001, time);
        gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), time + 0.6);
        gain.gain.setValueAtTime(Math.max(0.0002, peak), time + duration * 0.7);
        gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);
        osc.connect(gain);
        gain.connect(filter);
        osc.start(time);
        osc.stop(time + duration + 0.03);
      }
    }
  }

  private stab(time: number, notes: number[], duration: number, peak: number): void {
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(2600, time);
    filter.frequency.exponentialRampToValueAtTime(900, time + duration);
    filter.Q.value = 0.8;
    filter.connect(this.out);
    for (const midi of notes) {
      const osc = this.ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = mtof(midi);
      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.0001, time);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), time + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);
      osc.connect(gain);
      gain.connect(filter);
      osc.start(time);
      osc.stop(time + duration + 0.03);
    }
  }

  private siren(time: number, from: number, to: number, duration: number, peak: number): void {
    const osc = this.ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(mtof(from), time);
    osc.frequency.linearRampToValueAtTime(mtof(to), time + duration * 0.5);
    osc.frequency.linearRampToValueAtTime(mtof(from), time + duration);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), time + 0.15);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    osc.connect(gain);
    gain.connect(this.out);
    osc.start(time);
    osc.stop(time + duration + 0.03);
  }

  private noiseVoice(
    time: number,
    duration: number,
    filterType: BiquadFilterType,
    frequency: number,
    peak: number,
  ): void {
    const length = Math.max(1, Math.ceil(this.ctx.sampleRate * (duration + 0.05)));
    const buffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = frequency;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), time + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.out);
    source.start(time);
    source.stop(time + duration + 0.02);
  }

  private kick(time: number, peak: number): void {
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(130, time);
    osc.frequency.exponentialRampToValueAtTime(45, time + 0.16);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(peak, time);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.2);
    osc.connect(gain);
    gain.connect(this.out);
    osc.start(time);
    osc.stop(time + 0.22);
    this.noiseVoice(time, 0.04, 'lowpass', 160, peak * 0.25);
  }

  private snare(time: number, peak: number): void {
    this.noiseVoice(time, 0.16, 'highpass', 1300, peak);
    const osc = this.ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(190, time);
    osc.frequency.exponentialRampToValueAtTime(150, time + 0.1);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(peak * 0.5, time);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.12);
    osc.connect(gain);
    gain.connect(this.out);
    osc.start(time);
    osc.stop(time + 0.14);
  }

  private hat(time: number, peak: number): void {
    this.noiseVoice(time, 0.035, 'highpass', 7200, peak);
  }

  private timpani(time: number, midi: number, peak: number): void {
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(mtof(midi), time);
    osc.frequency.exponentialRampToValueAtTime(mtof(midi) * 0.92, time + 0.5);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(peak, time);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.85);
    osc.connect(gain);
    gain.connect(this.out);
    osc.start(time);
    osc.stop(time + 0.9);
    this.noiseVoice(time, 0.25, 'lowpass', 220, peak * 0.35);
  }

  private tom(time: number, midi: number, peak: number): void {
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(mtof(midi), time);
    osc.frequency.exponentialRampToValueAtTime(mtof(midi) * 0.8, time + 0.2);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(peak, time);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.25);
    osc.connect(gain);
    gain.connect(this.out);
    osc.start(time);
    osc.stop(time + 0.27);
  }

  private cymbal(time: number, peak: number): void {
    this.noiseVoice(time, 1.4, 'highpass', 5200, peak);
  }
}

/** 离线渲染一个音乐段落 / 分轨，循环段落首尾各做 8ms 淡入淡出避免接缝爆音。 */
export async function renderMusicAsset(
  def: MusicAssetDef,
  sampleRate: number,
): Promise<AudioBuffer> {
  const barDuration = (60 / def.bpm) * 4;
  const tail = def.loop ? 0 : 0.7;
  const duration = def.bars * barDuration + tail;
  const ctx = new OfflineAudioContext(1, Math.ceil(duration * sampleRate), sampleRate);
  const out = ctx.createGain();
  if (def.loop) {
    out.gain.setValueAtTime(0.0001, 0);
    out.gain.exponentialRampToValueAtTime(1, 0.008);
    out.gain.setValueAtTime(1, Math.max(0.02, duration - 0.012));
    out.gain.exponentialRampToValueAtTime(0.0001, duration);
  }
  out.connect(ctx.destination);
  const composer = new OfflineComposer(ctx, out, def);
  composer.render();
  return ctx.startRendering();
}

export function musicAssetDuration(def: MusicAssetDef): number {
  return def.bars * ((60 / def.bpm) * 4);
}
