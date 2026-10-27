/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createSystem, Vector3 } from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';
import {
  Destroyed,
  GameOver,
  GamePaused,
  HitCore,
  LevelDirector,
  LockTarget,
} from './components.js';

/**
 * Free random targeting (自由索敌) for every gun entity that carries a
 * `LockTarget` slot — the boss hull never needs to know its guns exist.
 * While the fight runs, any gun whose slot is empty or whose locked core has
 * died gets a uniform-random roll over the surviving defender cores. A roll
 * may legitimately land on the same core — especially when only one defender
 * is left — which is the requested "never locked forever, but repeats are
 * fine" behaviour.
 *
 * The fire cycle (GunCycleSystem) never writes targets: after a shot it
 * clears the slot, and this system refills it — that clear is what re-rolls
 * the target after every shot.
 */
export class FreeLockTargetSystem extends createSystem({
  guns: { required: [LockTarget] },
  cores: { required: [HitCore], excluded: [Destroyed] },
  directors: { required: [LevelDirector] },
}) {
  private readonly corePos = new Vector3();

  update(): void {
    if (this.paused() || this.over() || !this.gameRunning()) return;
    for (const gun of this.queries.guns.entities) {
      const locked = Number(gun.getValue(LockTarget, 'targetCoreIndex'));
      if (locked !== -1 && this.isLiveDefender(locked)) continue;
      this.rollTarget(gun);
    }
  }

  /** Whether `index` is still a surviving defender core in the live query. */
  private isLiveDefender(index: number): boolean {
    for (const core of this.queries.cores.entities) {
      if (core.getValue(HitCore, 'faction') !== 'defender') continue;
      if (core.index === index) return true;
    }
    return false;
  }

  /**
   * Roll one uniform-random live defender core and snapshot its hit_core
   * world position into the gun's slot. Two passes over the query (count,
   * then pick) keep the roll allocation-free.
   */
  private rollTarget(gun: Entity): void {
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
      gun.setValue(LockTarget, 'targetCoreIndex', core.index);
      gun.setValue(LockTarget, 'targetX', this.corePos.x);
      gun.setValue(LockTarget, 'targetY', this.corePos.y);
      gun.setValue(LockTarget, 'targetZ', this.corePos.z);
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

  /** True once the run has ended (victory or defeat) — targeting stops. */
  private over(): boolean {
    for (const director of this.queries.directors.entities) {
      return director.hasComponent(GameOver);
    }
    return false;
  }
}
