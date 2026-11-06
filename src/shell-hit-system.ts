/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createSystem, Object3D, Vector3 } from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';
import {
  BallisticFlight,
  BossTurret,
  ChiefDown,
  Destroyed,
  DieBurst,
  DieBurstTag,
  GamePaused,
  Health,
  HitCore,
  HitFlash,
  HitFlashTag,
  IslewrathChief,
  LevelDirector,
  ShellFaction,
  ShellTag,
  SplashFade,
  WakeSource,
  Wallet,
} from './components.js';
import {
  BOSS,
  BOSS_CHIEF,
  COMBAT,
  DAMAGE_MATRIX,
  OCEAN,
  REWARD_TABLE,
  RewardTier,
} from './level-config.js';

/**
 * Distance-based hit resolution between shells and combatants' hit cores;
 * runs after BallisticSystem so motion is tested at each frame's end
 * position, and hits are collected during the sweep, resolved afterwards.
 */
export class ShellHitSystem extends createSystem({
  shells: { required: [ShellTag, BallisticFlight, ShellFaction] },
  cores: { required: [HitCore, Health], excluded: [Destroyed] },
  freeFlashes: { required: [HitFlashTag], excluded: [HitFlash] },
  freeBursts: { required: [DieBurstTag], excluded: [DieBurst] },
  directors: { required: [LevelDirector] },
}) {
  /** hit_core node per core entity index, resolved once on qualify. */
  private readonly coreNodes = new Map<number, Object3D>();
  /** Reusable world position per core; allocated on qualify, never in update. */
  private readonly corePositions = new Map<number, Vector3>();
  /** Shells consumed this frame; resolved after the sweep, not inside it. */
  private readonly hit: Entity[] = [];
  /** Core entity per `hit` entry; its cached position feeds the flash. */
  private readonly hitCores: Entity[] = [];
  /** Peak scale per `hit` entry: defender cores at base size, ships larger. */
  private readonly hitPeakScales: number[] = [];
  private readonly hitDamages: number[] = [];
  /** Flashes handed out this frame; the free-flash query refreshes next frame. */
  private readonly claimedFlashes = new Set<number>();
  /** Bursts handed out this frame; the free-burst query refreshes next frame. */
  private readonly claimedBursts = new Set<number>();
  /** Zero-health snapshot buffer for the death sweep; reused per frame. */
  private readonly dying: Entity[] = [];

  init(): void {
    this.queries.cores.subscribe('qualify', (entity) => {
      // Resolve via the component's exact core-node name — unique per seat
      // in multi-seat assets (GLTFLoader de-duplicates same-name nodes).
      // Preference for a DIRECT child stays: deep-first search could bind a
      // whole-ship entity to a nested turret core instead of the hull's.
      const object = entity.object3D;
      const coreName = String(entity.getValue(HitCore, 'nodeName'));
      const node =
        object?.children.find((child) => child.name === coreName) ??
        object?.getObjectByName(coreName);
      if (!node) return;
      this.coreNodes.set(entity.index, node);
      this.corePositions.set(entity.index, new Vector3());
    });
    // A sunk ship (or hidden cannon) leaves the query — drop its cached
    // world position so the maps never pin a disposed object.
    this.queries.cores.subscribe('disqualify', (entity) => {
      this.coreNodes.delete(entity.index);
      this.corePositions.delete(entity.index);
    });
  }

  private paused(): boolean {
    for (const director of this.queries.directors.entities) {
      return director.hasComponent(GamePaused);
    }
    return false;
  }

  update(): void {
    if (this.paused()) return;
    this.hit.length = 0;
    this.hitCores.length = 0;
    this.hitPeakScales.length = 0;
    this.hitDamages.length = 0;
    this.claimedFlashes.clear();
    this.claimedBursts.clear();

    // Core world positions once per frame (pirate ships yaw after stopping).
    for (const [index, node] of this.coreNodes) {
      node.getWorldPosition(this.corePositions.get(index)!);
    }

    for (const shell of this.queries.shells.entities) {
      const shellObject = shell.object3D;
      if (!shellObject) continue;
      const faction = String(shell.getValue(ShellFaction, 'faction'));
      const sx = shellObject.position.x;
      const sy = shellObject.position.y;
      const sz = shellObject.position.z;
      for (const core of this.queries.cores.entities) {
        if (String(core.getValue(HitCore, 'faction')) === faction) continue;
        const position = this.corePositions.get(core.index);
        if (!position) continue;
        const radius =
          Number(core.getValue(HitCore, 'radius')) * COMBAT.shellHitRadiusScale;
        const dx = sx - position.x;
        const dy = sy - position.y;
        const dz = sz - position.z;
        if (dx * dx + dy * dy + dz * dz <= radius * radius) {
          this.hit.push(shell);
          this.hitCores.push(core);
          // Ship cores bloom larger than harbour-cannon cores; the shared
          // pool geometry is the defender size, so scale is a ratio.
          this.hitPeakScales.push(
            faction === 'attacker' // a pirate shell struck a defender core
              ? 1
              : COMBAT.hitFlashShipRadius / COMBAT.hitFlashRadius,
          );
          // Damage is a matrix lookup, not a faction flat rate: the shell's
          // attacker unit type x the core's unit type (unknown pair -> 0).
          let damage =
            DAMAGE_MATRIX[
              `${String(shell.getValue(ShellFaction, 'unitType'))}->${String(core.getValue(HitCore, 'unitType'))}`
            ] ?? 0;
          this.hitDamages.push(damage);
          break;
        }
      }
    }

    for (let i = 0; i < this.hit.length; i++) {
      const shell = this.hit[i];
      // BallisticSystem may have recycled it this same frame; never double-remove.
      if (!shell.hasComponent(BallisticFlight)) continue;
      shell.removeComponent(BallisticFlight);
      shell.removeComponent(ShellFaction);
      // Two shells can strike one core in the same sweep; the overkill hit
      // must still hide its ball or it freezes mid-air as a visible orphan.
      if (shell.object3D) shell.object3D.visible = false;
      const core = this.hitCores[i];
      // No cached position = the core died earlier in this same loop (its
      // disqualify callback cleared the map): skip the flash and the damage,
      // never touch the dead entity again.
      const corePosition = this.corePositions.get(core.index);
      if (!corePosition) continue;
      // Bloom at the struck core's centre: positions were refreshed at the
      // top of this frame, so the map is current for every hit this sweep.
      this.spawnHitFlash(corePosition, this.hitPeakScales[i]);
      this.applyDamage(core, this.hitDamages[i]);
    }

    // Death sweep: any live core whose pool has run dry dies here, whatever
    // wrote the last points. Victims are snapshotted first because kill()
    // disposes entities and mutates the live query array mid-iteration.
    this.dying.length = 0;
    for (const core of this.queries.cores.entities) {
      if (Number(core.getValue(Health, 'current')) <= 0) this.dying.push(core);
    }
    for (const core of this.dying) {
      if (this.corePositions.has(core.index)) this.kill(core);
    }
  }

  /** Charge one hit; zero funnels into `kill`, the same death path as every other lethal write. */
  private applyDamage(core: Entity, damage: number): void {
    const hp = Number(core.getValue(Health, 'current')) - damage;
    core.setValue(Health, 'current', Math.max(0, hp));
    if (hp > 0) return;
    this.kill(core);
  }

  private kill(core: Entity): void {
    const at = this.corePositions.get(core.index);
    // One tier read per kill: the spawn site wrote the bounty class onto the
    // core's HitCore; every paying branch below shares this single lookup.
    const reward = String(core.getValue(HitCore, 'reward')) as RewardTier;
    if (core.hasComponent(IslewrathChief)) {
      this.creditKillReward(reward);
      if (at) {
        this.spawnDieBurst(
          at,
          BOSS_CHIEF.burstRatio,
          BOSS_CHIEF.burstFloorY,
          COMBAT.dieBurstFloorBounce,
        );
      }
      core.dispose({ disposeResources: false });
      // Thin command (薄命令): the run is won. The director is the single
      // command bus; LevelWaveSystem consumes ChiefDown next update.
      for (const director of this.queries.directors.entities) {
        director.addComponent(ChiefDown);
        break;
      }
      return;
    }
    if (core.hasComponent(BossTurret)) {
      this.creditKillReward(reward);
      if (at) {
        this.spawnDieBurst(
          at,
          BOSS.turretBurstRatio,
          BOSS.turretBurstFloorY,
          COMBAT.dieBurstFloorBounce,
        );
      }
      // Keep the shared prototype resources alive: boss parts are prototype
      // clones. dispose() also removes the turret mesh from the hull clone
      // (removeFromParent) and disqualifies it from every query this frame.
      core.dispose({ disposeResources: false });
      return;
    }
    if (String(core.getValue(HitCore, 'faction')) === 'attacker') {
      this.creditKillReward(reward);
      if (at) {
        this.spawnDieBurst(
          at,
          COMBAT.dieBurstShipRatio,
          OCEAN.surfaceY - 0.05 - at.y,
          0,
        );
        this.spawnSinkRipple(at.x, at.z);
      }
      core.dispose({ disposeResources: false });
    } else {
      if (at) {
        this.spawnDieBurst(
          at,
          COMBAT.dieBurstCannonRatio,
          -0.085,
          COMBAT.dieBurstFloorBounce,
        );
      }
      core.addComponent(Destroyed);
      if (core.object3D) core.object3D.visible = false;
    }
  }

  private creditKillReward(tier: RewardTier): void {
    if (tier === RewardTier.None) return;
    const amount = REWARD_TABLE[tier];
    for (const director of this.queries.directors.entities) {
      const money = Number(director.getValue(Wallet, 'money'));
      director.setValue(Wallet, 'money', money + amount);
      return;
    }
  }

  /**
   * `floorY` is the rest floor in the pooled mesh's LOCAL space; callers
   * convert once at spawn. Pool empty: skip silently.
   */
  private spawnDieBurst(
    position: Vector3,
    sizeRatio: number,
    floorY: number,
    floorBounce: number,
  ): void {
    for (const burst of this.queries.freeBursts.entities) {
      if (this.claimedBursts.has(burst.index)) continue;
      // Live guard: another spawn this frame may have claimed it already,
      // since the free-burst query only refreshes next frame.
      if (burst.hasComponent(DieBurst)) continue;
      this.claimedBursts.add(burst.index);
      const object = burst.object3D;
      if (!object) return;
      object.position.copy(position);
      object.visible = true;
      burst.addComponent(DieBurst, {
        duration: COMBAT.dieBurstDuration,
        sizeRatio,
        floorY,
        floorBounce,
      });
      return;
    }
  }

  /** Claim a free pooled flash at the struck core's centre; pool empty skips silently. */
  private spawnHitFlash(position: Vector3, peakScale: number): void {
    for (const flash of this.queries.freeFlashes.entities) {
      if (this.claimedFlashes.has(flash.index)) continue;
      // Live guard: another spawn this frame may have claimed it already,
      // since the free-flash query only refreshes next frame.
      if (flash.hasComponent(HitFlash)) continue;
      this.claimedFlashes.add(flash.index);
      const object = flash.object3D;
      if (!object) return;
      object.position.copy(position);
      object.scale.setScalar(COMBAT.hitFlashStartScale * peakScale);
      object.visible = true;
      flash.addComponent(HitFlash, {
        duration: COMBAT.hitFlashDuration,
        peakScale,
      });
      return;
    }
  }

  /**
   * Ripple where a ship went down — the hull itself is disposed, so this is
   * the sinking's only trace.
   */
  private spawnSinkRipple(x: number, z: number): void {
    const ripple = new Object3D();
    ripple.position.set(x, OCEAN.surfaceY, z);
    this.world
      .createTransformEntity(ripple)
      .addComponent(WakeSource, {
        strength: 1,
        targetStrength: 1,
        radius: COMBAT.splashRadius,
        targetRadius: COMBAT.splashRadius,
        amplitude: COMBAT.splashAmplitude,
        frequency: COMBAT.splashFrequency,
        speed: COMBAT.splashSpeed,
      })
      .addComponent(SplashFade, { duration: COMBAT.splashDuration });
  }
}
