/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createSystem, Object3D, Vector3 } from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';
import {
  Destroyed,
  DieBurst,
  DieBurstTag,
  GameOver,
  GamePaused,
  Health,
  HitCore,
  HitFlash,
  HitFlashTag,
  Kamikaze,
  LevelDirector,
  PirateCannon,
  ShipMovement,
  UnitTag,
} from './components.js';
import { COMBAT, KAMIKAZE } from './level-config.js';

/**
 * Kamikaze ability (玉碎) for the boss chief's summoned ornithopters —
 * task 031. Flight and the stone attack stay in the shared armed-flyer
 * systems; this system only runs the fuse-and-dive:
 *
 * - `waiting`: the fuse (KAMIKAZE.waitSec) burns ONLY once the flyer has
 *   parked in its berth band (ShipMovement state 'stopped').
 * - at zero: one surviving defender core is rolled (two passes,
 *   allocation-free) and FROZEN into the component — index plus world
 *   position. The dive never re-acquires: a victim that dies mid-dive
 *   still eats the crash at its last position (the flyer shatters on the
 *   wall). The stone attack is stripped (PirateCannon removed) — a diving
 *   flyer does not fire.
 * - `diving`: straight scalar chase at KAMIKAZE.diveSpeed, bow (-Z) onto
 *   the flight direction. Inside the arrival radius: the victim (if still
 *   a live core) loses KAMIKAZE.damageRatio of its MAX Health — the death
 *   itself stays single-truthed in ShellHitSystem's death sweep — then the
 *   flyer bursts and disposes. NO bounty: a self-destruction is not a
 *   player kill.
 */
export class KamikazeSystem extends createSystem({
  flyers: { required: [UnitTag, ShipMovement, Kamikaze] },
  cores: { required: [HitCore, Health], excluded: [Destroyed] },
  freeFlashes: { required: [HitFlashTag], excluded: [HitFlash] },
  freeBursts: { required: [DieBurstTag], excluded: [DieBurst] },
  directors: { required: [LevelDirector] },
}) {
  /** Scratch buffer for the target snapshot; allocated once. */
  private readonly corePos = new Vector3();
  /** Flashes handed out this frame; the free-flash query refreshes next frame. */
  private readonly claimedFlashes = new Set<number>();
  /** Bursts handed out this frame; the free-burst query refreshes next frame. */
  private readonly claimedBursts = new Set<number>();

  update(delta: number): void {
    if (this.paused() || this.over() || !this.gameRunning()) return;
    this.claimedFlashes.clear();
    this.claimedBursts.clear();
    for (const flyer of this.queries.flyers.entities) {
      const object = flyer.object3D;
      if (!object) continue;
      if (String(flyer.getValue(Kamikaze, 'state')) !== 'diving') {
        // The fuse only burns once the flyer has parked in its berth band.
        if (String(flyer.getValue(ShipMovement, 'state')) !== 'stopped') {
          continue;
        }
        const timer = Number(flyer.getValue(Kamikaze, 'timer')) - delta;
        if (timer > 0) {
          flyer.setValue(Kamikaze, 'timer', timer);
          continue;
        }
        // beginDive may legitimately bail (no defender left to hit — the
        // run is being lost anyway): park the fuse and retry next frame.
        this.beginDive(flyer);
        if (String(flyer.getValue(Kamikaze, 'state')) !== 'diving') continue;
      }
      this.tickDive(flyer, object, delta);
    }
  }

  /**
   * Fuse burned out: roll one surviving defender core and freeze the dive
   * target — core index plus its hit_core's world position. The snapshot is
   * the flight plan; nothing downstream re-reads the victim's live position.
   */
  private beginDive(flyer: Entity): void {
    let defenderCount = 0;
    for (const core of this.queries.cores.entities) {
      if (core.getValue(HitCore, 'faction') === 'defender') defenderCount += 1;
    }
    if (defenderCount === 0) return;
    let pick = Math.floor(Math.random() * defenderCount);
    for (const core of this.queries.cores.entities) {
      if (core.getValue(HitCore, 'faction') !== 'defender') continue;
      if (pick > 0) {
        pick -= 1;
        continue;
      }
      const node = core.object3D?.getObjectByName(
        String(core.getValue(HitCore, 'nodeName')),
      );
      if (!node) return;
      node.getWorldPosition(this.corePos);
      flyer.setValue(Kamikaze, 'targetCoreIndex', core.index);
      flyer.setValue(Kamikaze, 'targetX', this.corePos.x);
      flyer.setValue(Kamikaze, 'targetY', this.corePos.y);
      flyer.setValue(Kamikaze, 'targetZ', this.corePos.z);
      flyer.setValue(Kamikaze, 'state', 'diving');
      // Ability strip: a diving flyer does not fire — the dive replaces the
      // stone attack for the rest of its (short) life.
      flyer.removeComponent(PirateCannon);
      return;
    }
  }

  /** Straight scalar chase toward the frozen snapshot; no physics anywhere. */
  private tickDive(flyer: Entity, object: Object3D, delta: number): void {
    const tx = Number(flyer.getValue(Kamikaze, 'targetX'));
    const ty = Number(flyer.getValue(Kamikaze, 'targetY'));
    const tz = Number(flyer.getValue(Kamikaze, 'targetZ'));
    const dx = tx - object.position.x;
    const dy = ty - object.position.y;
    const dz = tz - object.position.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const step = KAMIKAZE.diveSpeed * delta;
    if (dist <= Math.max(step, KAMIKAZE.arriveRadius)) {
      this.crash(flyer, object.position);
      return;
    }
    object.position.x += (dx / dist) * step;
    object.position.y += (dy / dist) * step;
    object.position.z += (dz / dist) * step;
    // Bow is the model's local -Z; yaw it onto the flight direction.
    object.rotation.y = Math.atan2(-dx, -dz);
  }

  /**
   * Impact: the frozen victim, if it is still a live core, takes
   * damageRatio of its max Health (zero-pool deaths are picked up by
   * ShellHitSystem's death sweep the same frame); the crash point blooms a
   * ship-scale flash and bursts wall-resting debris — the flyer shatters
   * where it hit, whether or not the victim survived to see it. Then the
   * flyer disposes. Deliberately NOT creditKillReward: the flyer killed
   * itself.
   */
  private crash(flyer: Entity, at: Vector3): void {
    const victimIndex = Number(flyer.getValue(Kamikaze, 'targetCoreIndex'));
    for (const core of this.queries.cores.entities) {
      if (core.index !== victimIndex) continue;
      const max = Number(core.getValue(Health, 'max'));
      const hp =
        Number(core.getValue(Health, 'current')) - max * KAMIKAZE.damageRatio;
      core.setValue(Health, 'current', Math.max(0, hp));
      break;
    }
    this.spawnHitFlash(at, COMBAT.hitFlashShipRadius / COMBAT.hitFlashRadius);
    this.spawnDieBurst(
      at,
      COMBAT.dieBurstCannonRatio,
      -0.085,
      COMBAT.dieBurstFloorBounce,
    );
    flyer.dispose({ disposeResources: false });
  }

  /**
   * Claim a free pooled flash — the same convention as ShellHitSystem:
   * claimed-set plus live hasComponent guard, position + start scale +
   * visible, then the HitFlash component hands animation to HitFlashSystem.
   * Pool empty: skip silently.
   */
  private spawnHitFlash(position: Vector3, peakScale: number): void {
    for (const flash of this.queries.freeFlashes.entities) {
      if (this.claimedFlashes.has(flash.index)) continue;
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
   * Claim a free pooled burst — ShellHitSystem's convention again. The
   * debris rests on the wall stone (defender-cannon floor semantics: the
   * crash lands on the rampart, not the water).
   */
  private spawnDieBurst(
    position: Vector3,
    sizeRatio: number,
    floorY: number,
    floorBounce: number,
  ): void {
    for (const burst of this.queries.freeBursts.entities) {
      if (this.claimedBursts.has(burst.index)) continue;
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

  /** True once the START hand-off has moved the director past waiting-start. */
  private gameRunning(): boolean {
    for (const director of this.queries.directors.entities) {
      return (
        String(director.getValue(LevelDirector, 'phase')) !== 'waiting-start'
      );
    }
    return false;
  }

  /** True while the pause-menu tag sits on the director entity. */
  private paused(): boolean {
    for (const director of this.queries.directors.entities) {
      return director.hasComponent(GamePaused);
    }
    return false;
  }

  /** True once the run has ended (victory or defeat) — fuses freeze. */
  private over(): boolean {
    for (const director of this.queries.directors.entities) {
      return director.hasComponent(GameOver);
    }
    return false;
  }
}
