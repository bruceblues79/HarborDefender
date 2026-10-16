/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createSystem, Vector3 } from '@iwsdk/core';
import type { Entity, Object3D } from '@iwsdk/core';
import { BallisticFlight, HitCore, ShellFaction, ShellTag } from './components.js';

/**
 * Distance-based hit resolution between airborne shells and combatants'
 * hit cores. A shell whose faction differs from a core's is consumed the
 * moment its centre comes within the core radius: flight and faction tags
 * are removed and the mesh hides, returning the shell to the shared pool
 * exactly like a splash-down — but no ripple is spawned, because the ball
 * struck a solid target rather than the water.
 *
 * Runs after BallisticSystem so each frame's motion is tested at its end
 * position. Hits are collected during the sweep and recycled afterwards.
 */
export class ShellHitSystem extends createSystem({
  shells: { required: [ShellTag, BallisticFlight, ShellFaction] },
  cores: { required: [HitCore] },
}) {
  /** hit_core node per core entity index, resolved once on qualify. */
  private readonly coreNodes = new Map<number, Object3D>();
  /** Reusable world position per core; allocated on qualify, never in update. */
  private readonly corePositions = new Map<number, Vector3>();
  /** Shells consumed this frame; recycled after the sweep, not inside it. */
  private readonly hit: Entity[] = [];

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
      if (shell.object3D) shell.object3D.visible = false;
    }
  }
}
