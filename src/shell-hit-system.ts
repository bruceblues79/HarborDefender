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
  Destroyed,
  DieBurst,
  DieBurstTag,
  GamePaused,
  Health,
  HitCore,
  HitFlash,
  HitFlashTag,
  LevelDirector,
  ShellFaction,
  ShellTag,
  SplashFade,
  WakeSource,
  Wallet,
} from './components.js';
import { COMBAT, DAMAGE_MATRIX, ECONOMY, OCEAN } from './level-config.js';

/**
 * Distance-based hit resolution between airborne shells and combatants'
 * hit cores. A shell whose faction differs from a core's is consumed the
 * moment its centre comes within the core radius: flight and faction tags
 * are removed and the mesh hides, returning the shell to the shared pool
 * exactly like a splash-down — but no water ripple is spawned, because the
 * ball struck a solid target. Instead a pooled hit-flash sphere blooms at
 * the struck core's centre — not the contact point, which sits inside the
 * core radius and reads as a dented hull edge rather than a clean hit.
 *
 * The hit also deals damage to the core's Health, read from the
 * attacker->target damage matrix (DAMAGE_MATRIX, keyed by the shell's
 * attacker unit type and the core's unit type; unknown pairs read 0). At
 * zero the unit dies — an attacker sinks (entity disposed, a splash ripple
 * marks the spot on the surface) and a defender cannon or ballista is
 * tagged Destroyed (hidden, out of every combat query; LevelWaveSystem
 * reads the tags for defeat).
 *
 * Runs after BallisticSystem so each frame's motion is tested at its end
 * position. Hits are collected during the sweep and resolved afterwards.
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
  /** Damage per `hit` entry, read from the shell's faction. */
  private readonly hitDamages: number[] = [];
  /** Flashes handed out this frame; the free-flash query refreshes next frame. */
  private readonly claimedFlashes = new Set<number>();
  /** Bursts handed out this frame; the free-burst query refreshes next frame. */
  private readonly claimedBursts = new Set<number>();
  /** Zero-health snapshot buffer for the death sweep; reused per frame. */
  private readonly dying: Entity[] = [];

  init(): void {
    this.queries.cores.subscribe('qualify', (entity) => {
      const node = entity.object3D?.getObjectByName('hit_core');
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

  /** True while the pause-menu tag sits on the director entity. */
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
        const radius = Number(core.getValue(HitCore, 'radius'));
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
          this.hitDamages.push(
            DAMAGE_MATRIX[
              `${String(shell.getValue(ShellFaction, 'unitType'))}->${String(core.getValue(HitCore, 'unitType'))}`
            ] ?? 0,
          );
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
      // Always consume the shell mesh. Two shells can strike one core in the
      // same sweep; the first kill drops the core's cached position, and the
      // overkill hit must still hide its ball or it freezes mid-air as a
      // visible orphan no system ever touches again.
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

    // Death sweep: any live core whose pool has run dry dies here — whatever
    // wrote the last points (a shell above, the boss laser, a kamikaze
    // payload), the death path stays single-truthed in this system. Runs
    // after the shell resolution so a same-frame shell kill is not doubled.
    // The victims are snapshotted first: kill() disposes entities, which
    // mutates the live query array mid-iteration. The position-cache guard
    // then skips anything already killed this frame (its disqualify ran and
    // cleared the cache).
    this.dying.length = 0;
    for (const core of this.queries.cores.entities) {
      if (Number(core.getValue(Health, 'current')) <= 0) this.dying.push(core);
    }
    for (const core of this.dying) {
      if (this.corePositions.has(core.index)) this.kill(core);
    }
  }

  /**
   * Charge one hit of damage. The pool is the single truth: reaching zero
   * funnels into `kill`, exactly like any other lethal write (boss laser,
   * kamikaze payload) picked up by the death sweep.
   */
  private applyDamage(core: Entity, damage: number): void {
    const hp = Number(core.getValue(Health, 'current')) - damage;
    core.setValue(Health, 'current', Math.max(0, hp));
    if (hp > 0) return;
    this.kill(core);
  }

  /**
   * Kill a core whose pool is empty. An attacker bursts into pooled
   * wood-and-iron chunks at the core's centre, then its hull is disposed (its
   * materials are per-ship clones) and a splash ripple marks the sinking
   * spot; a defender cannon is tagged Destroyed and hidden — the tag, not a
   * component strip, takes it out of every combat query.
   */
  private kill(core: Entity): void {
    const at = this.corePositions.get(core.index);
    if (String(core.getValue(HitCore, 'faction')) === 'attacker') {
      // Kill bounty: one unified price per attacker sunk, paid into the
      // director's wallet — the same pool repairs and builds drain.
      this.creditKillReward();
      if (at) {
        this.spawnDieBurst(at, true, COMBAT.dieBurstShipRatio);
        this.spawnSinkRipple(at.x, at.z);
      }
      // Keep the shared prototype resources alive: ships are prototype
      // clones, and the default resource sweep would free geometry/materials/
      // textures every later spawn clones from.
      core.dispose({ disposeResources: false });
    } else {
      if (at) this.spawnDieBurst(at, false, COMBAT.dieBurstCannonRatio);
      core.addComponent(Destroyed);
      if (core.object3D) core.object3D.visible = false;
    }
  }

  /**
   * Pay the kill bounty into the director's wallet. Runs on the death frame
   * only (never per ship per frame); several kills in one sweep each pay.
   */
  private creditKillReward(): void {
    for (const director of this.queries.directors.entities) {
      const money = Number(director.getValue(Wallet, 'money'));
      director.setValue(Wallet, 'money', money + ECONOMY.killReward);
      return;
    }
  }

  /**
   * Claim a free pooled burst and plant it at the dying unit's core:
   * position, visible, then the `DieBurst` component that both hands
   * animation to DieBurstSystem and (via its synchronous qualify callback)
   * scatters the chunks. Defenders burst on their wall top and rebound;
   * attackers burst just above the waves and sink through, with boss armour
   * plates scaled down by the caller. Pool empty: skip silently — a busy
   * battle loses the odd burst, never a hit.
   */
  private spawnDieBurst(
    position: Vector3,
    attacker: boolean,
    sizeRatio: number,
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
      // Chunk matrices integrate in the pooled mesh's LOCAL space, so the
      // rest floor must be converted into it once at spawn: the wall top
      // sits slightly below the core (chunks read as resting on the stone,
      // not hovering at gun height) and the water line sits a bit below a
      // sinking ship's core.
      burst.addComponent(DieBurst, {
        duration: COMBAT.dieBurstDuration,
        sizeRatio,
        floorY: attacker
          ? OCEAN.surfaceY - 0.05 - position.y
          : -0.085,
        floorBounce: attacker ? 0 : COMBAT.dieBurstFloorBounce,
      });
      return;
    }
  }

  /**
   * Claim a free pooled flash and land its starting state at the struck
   * core's centre: position, start scale, visible, then the HitFlash tag
   * that hands animation to HitFlashSystem. Pool empty: skip silently — a
   * busy battle loses the odd bloom, never a hit.
   */
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
   * Surface ripple where a ship went down — the same pooled-splash pattern
   * BallisticSystem uses for splash-downs; SplashSystem owns the fade-out.
   * The hull itself is disposed, so the ripple is the sinking's only trace.
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
