/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createSystem, Vector3 } from '@iwsdk/core';
import type { Entity, Object3D } from '@iwsdk/core';
import {
  Destroyed,
  GameOver,
  GamePaused,
  Health,
  HitCore,
  KamikazeDive,
  LevelDirector,
  ShipMovement,
} from './components.js';
import { BOSS } from './level-config.js';

/**
 * Flies a kamikaze-ordered ornithopter onto its victim. The dive owns the
 * minion's motion (ShipMovementSystem excludes KamikazeDive carriers): each
 * frame it yaws nose-first at the victim's hit core and closes at
 * `kamikazeSpeed`. Within `kamikazeHitDistance` the payload delivers — the
 * victim's Health drops by `kamikazeDamagePct` % of its MAX pool (direct
 * write; the same max-pool special case as the boss laser) and the flapper's
 * own pool is spent to zero, so ShellHitSystem's death sweep collects it on
 * the same frame: burst, sink ripple, unified 200g bounty, dispose.
 *
 * Lock discipline: the victim is re-validated every frame against the live
 * cores query — a victim knocked out mid-dive is replaced by a fresh random
 * one; with no defender left the dive holds (the defeat check settles the
 * run on the same frame).
 */
export class BossKamikazeSystem extends createSystem({
  divers: { required: [KamikazeDive, ShipMovement] },
  cores: { required: [HitCore], excluded: [Destroyed] },
  directors: { required: [LevelDirector] },
}) {
  /** Defender hit_core nodes per core entity index, resolved once on qualify. */
  private readonly coreNodes = new Map<number, Object3D>();
  private readonly victimPos = new Vector3();

  init(): void {
    this.queries.cores.subscribe('qualify', (core) => {
      if (core.getValue(HitCore, 'faction') !== 'defender') return;
      const node = core.object3D?.getObjectByName('hit_core');
      if (node) this.coreNodes.set(core.index, node);
    });
  }

  update(delta: number): void {
    if (this.paused() || this.over() || !this.gameRunning()) return;
    for (const diver of this.queries.divers.entities) {
      const object = diver.object3D;
      if (!object) continue;
      let victim = this.lockedVictim(diver);
      if (!victim) {
        victim = this.randomDefenderCore();
        if (!victim) continue; // no defender left: hold; defeat check lands
        diver.setValue(KamikazeDive, 'victimCoreIndex', victim.index);
      }
      const node = this.coreNodes.get(victim.index);
      if (!node) continue;
      node.getWorldPosition(this.victimPos);
      const dx = this.victimPos.x - object.position.x;
      const dy = this.victimPos.y - object.position.y;
      const dz = this.victimPos.z - object.position.z;
      const remaining = Math.hypot(dx, dy, dz);

      // Nose-first at the victim — the same whole-hull yaw the pivotless
      // flyers use for their drops.
      if (remaining > 1e-6) {
        object.rotation.y = Math.atan2(-dx, -dz);
      }
      const step = Number(diver.getValue(KamikazeDive, 'speed')) * delta;
      if (remaining <= Math.max(step, BOSS.kamikazeHitDistance)) {
        this.detonate(diver, victim);
        continue;
      }
      object.position.set(
        object.position.x + (dx / remaining) * step,
        object.position.y + (dy / remaining) * step,
        object.position.z + (dz / remaining) * step,
      );
    }
  }

  /** Deliver the payload: burn the victim's pool, spend the diver's own. */
  private detonate(diver: Entity, victim: Entity): void {
    const victimMax = Number(victim.getValue(Health, 'max'));
    const victimCurrent = Number(victim.getValue(Health, 'current'));
    victim.setValue(
      Health,
      'current',
      Math.max(0, victimCurrent - (victimMax * BOSS.kamikazeDamagePct) / 100),
    );
    // The flapper is spent: the death sweep (same frame, later priority)
    // runs the standard attacker death — burst, ripple, bounty, dispose.
    diver.setValue(Health, 'current', 0);
  }

  /** The locked victim, or undefined once it has left the live query. */
  private lockedVictim(diver: Entity): Entity | undefined {
    const locked = Number(diver.getValue(KamikazeDive, 'victimCoreIndex'));
    if (locked < 0) return undefined;
    for (const core of this.queries.cores.entities) {
      if (core.getValue(HitCore, 'faction') !== 'defender') continue;
      if (core.index === locked) return core;
    }
    return undefined;
  }

  /**
   * One uniformly random live defender core — the shared two-pass roll.
   * Runs only on re-acquisition (order out, victim died), never per frame.
   */
  private randomDefenderCore(): Entity | undefined {
    let defenderCount = 0;
    for (const core of this.queries.cores.entities) {
      if (core.getValue(HitCore, 'faction') === 'defender') defenderCount += 1;
    }
    if (defenderCount === 0) return undefined;
    let pick = Math.floor(Math.random() * defenderCount);
    for (const core of this.queries.cores.entities) {
      if (core.getValue(HitCore, 'faction') !== 'defender') continue;
      if (pick > 0) {
        pick -= 1;
        continue;
      }
      return core;
    }
    return undefined;
  }

  /** True while the pause-menu tag sits on the director entity. */
  private paused(): boolean {
    for (const director of this.queries.directors.entities) {
      return director.hasComponent(GamePaused);
    }
    return false;
  }

  /** True once the run has ended — divers hold. */
  private over(): boolean {
    for (const director of this.queries.directors.entities) {
      return director.hasComponent(GameOver);
    }
    return false;
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
}
