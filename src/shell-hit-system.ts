/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createSystem, Vector3 } from '@iwsdk/core';
import type { Entity, Object3D } from '@iwsdk/core';
import {
  BallisticFlight,
  HitCore,
  HitFlash,
  HitFlashTag,
  ShellFaction,
  ShellTag,
} from './components.js';
import { COMBAT } from './level-config.js';

/**
 * Distance-based hit resolution between airborne shells and combatants'
 * hit cores. A shell whose faction differs from a core's is consumed the
 * moment its centre comes within the core radius: flight and faction tags
 * are removed and the mesh hides, returning the shell to the shared pool
 * exactly like a splash-down — but no ripple is spawned, because the ball
 * struck a solid target. Instead a pooled hit-flash sphere blooms at the
 * impact point: claiming one is a thin spawn command (position + starting
 * state + HitFlash component); HitFlashSystem owns the animation.
 *
 * Runs after BallisticSystem so each frame's motion is tested at its end
 * position. Hits are collected during the sweep and recycled afterwards.
 */
export class ShellHitSystem extends createSystem({
  shells: { required: [ShellTag, BallisticFlight, ShellFaction] },
  cores: { required: [HitCore] },
  freeFlashes: { required: [HitFlashTag], excluded: [HitFlash] },
}) {
  /** hit_core node per core entity index, resolved once on qualify. */
  private readonly coreNodes = new Map<number, Object3D>();
  /** Reusable world position per core; allocated on qualify, never in update. */
  private readonly corePositions = new Map<number, Vector3>();
  /** Shells consumed this frame; recycled after the sweep, not inside it. */
  private readonly hit: Entity[] = [];
  /** Flashes handed out this frame; the free-flash query refreshes next frame. */
  private readonly claimedFlashes = new Set<number>();

  init(): void {
    this.queries.cores.subscribe('qualify', (entity) => {
      const node = entity.object3D?.getObjectByName('hit_core');
      if (!node) return;
      this.coreNodes.set(entity.index, node);
      this.corePositions.set(entity.index, new Vector3());
    });
  }

  update(): void {
    this.hit.length = 0;
    this.claimedFlashes.clear();

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
          break;
        }
      }
    }

    for (const shell of this.hit) {
      // BallisticSystem may have recycled it this same frame; never double-remove.
      if (!shell.hasComponent(BallisticFlight)) continue;
      shell.removeComponent(BallisticFlight);
      shell.removeComponent(ShellFaction);
      if (shell.object3D) {
        this.spawnHitFlash(shell.object3D.position);
        shell.object3D.visible = false;
      }
    }
  }

  /**
   * Claim a free pooled flash and land its starting state at the impact
   * point: position, start scale, visible, then the HitFlash tag that hands
   * animation to HitFlashSystem. Pool empty: skip silently — a busy battle
   * loses the odd bloom, never a hit.
   */
  private spawnHitFlash(position: Vector3): void {
    for (const flash of this.queries.freeFlashes.entities) {
      if (this.claimedFlashes.has(flash.index)) continue;
      // Live guard: another spawn this frame may have claimed it already,
      // since the free-flash query only refreshes next frame.
      if (flash.hasComponent(HitFlash)) continue;
      this.claimedFlashes.add(flash.index);
      const object = flash.object3D;
      if (!object) return;
      object.position.copy(position);
      object.scale.setScalar(COMBAT.hitFlashStartScale);
      object.visible = true;
      flash.addComponent(HitFlash, { duration: COMBAT.hitFlashDuration });
      return;
    }
  }
}
