/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createSystem } from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';
import {
  BossLaser,
  BossSummon,
  BossTurret,
  BossVulnerable,
  Health,
  HideHealthBar,
  HitCore,
  ShipMovement,
  UnitTag,
} from './components.js';
import { BOSS, COMBAT } from './level-config.js';

/**
 * Assembles the Islewrath's fighting parts and runs its armour phases.
 *
 * Assembly (boss qualify, once): the GLB ships five armour-part wrappers —
 * gun_t1..t4 on their bastion seats and laser_turret on the citadel crown.
 * Each wrapper owns a `gun_rotate` yaw pivot carrying its gun mesh, a
 * `muzzle` and a `hit_core`. Each wrapper becomes a child ECS entity
 * (`createTransformEntity(pivot, bossEntity)` — the wrapper is already a
 * scene-graph child of the hull, so the hierarchy is preserved) with its own
 * Health pool, attacker HitCore and HideHealthBar tag. From this frame on the
 * turrets are hittable, targetable combat parts.
 *
 * Armour phases: while any part lives, the hull itself is NOT hittable — no
 * HitCore, no Health, no health bar. The moment every part is gone (both
 * part queries run empty for a boss that is still in the fight), the hull
 * is revealed: the GLB's baked root `hit_core` (first child, island
 * bounding-box centre) is what ShellHitSystem resolves, and Health + HitCore
 * + BossVulnerable land together — HealthBarSystem's qualify is the "亮出主
 * 血条" moment, and BossSummonSystem reads the tag to shorten its cycle.
 *
 * Part lifecycle cleanup: on boss disqualify (sunk by the player, or the
 * field cleared on RESTART/MAIN) any surviving part entities are disposed —
 * their object3D nodes go down with the hull either way; the entities must
 * not linger in the combat queries as dangling cores.
 */
export class BossRigSystem extends createSystem({
  bosses: { required: [UnitTag, ShipMovement, BossSummon] },
  turrets: { required: [BossTurret] },
  lasers: { required: [BossLaser] },
}) {
  /** Part entities per boss entity index; rebuilt on every boss qualify. */
  private readonly partsByBoss = new Map<number, Entity[]>();

  init(): void {
    this.queries.bosses.subscribe('qualify', (boss) => {
      this.assemble(boss);
    });
    this.queries.bosses.subscribe('disqualify', (boss) => {
      this.retireParts(boss);
    });
  }

  update(): void {
    for (const boss of this.queries.bosses.entities) {
      if (boss.hasComponent(BossVulnerable)) continue;
      if (
        this.queries.turrets.entities.size > 0 ||
        this.queries.lasers.entities.size > 0
      ) {
        continue;
      }
      this.revealHull(boss);
    }
  }

  /**
   * Wrap every baked yaw pivot in a child entity with its combat kit. Runs
   * once per boss spawn — the pivot nodes live in the per-clone object tree,
   * so re-spawns assemble their own parts.
   */
  private assemble(boss: Entity): void {
    const root = boss.object3D;
    if (!root) return;
    const parts: Entity[] = [];
    for (const name of ['gun_t1', 'gun_t2', 'gun_t3', 'gun_t4']) {
      const pivot = root.getObjectByName(name);
      if (!pivot) continue;
      const part = this.world.createTransformEntity(pivot, boss);
      part.addComponent(BossTurret);
      this.armPart(part, BOSS.turretCoreRadius, BOSS.turretUnitType);
      parts.push(part);
    }
    const laserPivot = root.getObjectByName('laser_turret');
    if (laserPivot) {
      const laser = this.world.createTransformEntity(laserPivot, boss);
      laser.addComponent(BossLaser);
      this.armPart(laser, BOSS.laserCoreRadius, BOSS.laserUnitType);
      parts.push(laser);
    }
    this.partsByBoss.set(boss.index, parts);
  }

  /** The shared combat kit of every boss part: pool, core, hidden bar. */
  private armPart(part: Entity, radius: number, unitType: string): void {
    part.addComponent(Health, {
      current: COMBAT.unitHealth,
      max: COMBAT.unitHealth,
    });
    part.addComponent(HitCore, {
      radius,
      faction: 'attacker',
      unitType,
    });
    part.addComponent(HideHealthBar);
  }

  /**
   * The last plate falls: hand the hull its own health pool and hit core.
   * The GLB bakes the hull `hit_core` as the root's first child at the
   * island's bounding-box centre, so ShellHitSystem resolves it directly —
   * this system never invents a node. The components land together:
   * HealthBarSystem's qualify is the "亮出主血条" moment, and BossSummonSystem
   * reads the tag to shorten its cycle.
   */
  private revealHull(boss: Entity): void {
    boss.addComponent(Health, {
      current: COMBAT.unitHealth,
      max: COMBAT.unitHealth,
    });
    boss.addComponent(HitCore, {
      radius: BOSS.hullCoreRadius,
      faction: 'attacker',
      unitType: BOSS.hullUnitType,
    });
    boss.addComponent(BossVulnerable);
  }

  /** Drop every surviving part entity of a departing boss. */
  private retireParts(boss: Entity): void {
    const parts = this.partsByBoss.get(boss.index);
    if (!parts) return;
    for (const part of parts) {
      // Destroyed parts already left their components (ShellHitSystem killed
      // them); a hasComponent check keeps the dispose single-shot.
      if (part.hasComponent(BossTurret) || part.hasComponent(BossLaser)) {
        part.dispose({ disposeResources: false });
      }
    }
    this.partsByBoss.delete(boss.index);
  }
}
