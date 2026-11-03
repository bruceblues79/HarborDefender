/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createSystem, Mesh, MeshStandardMaterial, Pressed } from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';
import {
  DefenseButton,
  Destroyed,
  GameOver,
  GamePaused,
  LevelDirector,
  Repairing,
} from './components.js';
import { DEFENSE_BUTTONS } from './level-config.js';
import { getDefenseSlotInfo } from './battle-setup.js';

/**
 * Repair buttons — the thin command layer over the wall's repair rigs.
 *
 * A `Pressed` tag from InputSystem (one path for mouse, touch and XR ray)
 * toggles the Repairing tag on the slot's mounted unit. A dead (Destroyed)
 * slot repairs nothing; its pedestal pad is the way back to the build panel.
 *
 * A slot mounted with a live iron-guard (钢铁卫士) is inert: its repair
 * button grays out (DEFENSE_BUTTONS.blockedColor) and swallows presses
 * until the guard is knocked out and the slot frees. Gray-out is a
 * material-colour multiply on the icon (its own clone), so the GLB's baked
 * look returns untouched the moment the slot frees.
 *
 * The command shares the cannon-aim phase gate: before the START gate
 * opens, while paused or after an outcome the button is scenery.
 *
 * Visuals (single writer for the icon): a repairing unit's icon holds a
 * shrunk pose (DEFENSE_BUTTONS.openScale) plus a warm-gold emissive glow
 * (colour baked into its own material clone at qualify, the update loop
 * writes one intensity scalar). Materials and the hit proxy otherwise never
 * change.
 */
export class DefenseButtonSystem extends createSystem({
  buttons: { required: [DefenseButton] },
  pressed: { required: [DefenseButton, Pressed] },
  directors: { required: [LevelDirector] },
}) {
  /** Button icon mesh per entity index, resolved once on qualify. */
  private readonly icons = new Map<number, Mesh>();

  init(): void {
    this.queries.buttons.subscribe('qualify', (entity) => {
      const icon = entity.object3D?.getObjectByName('button-icon') as
        | Mesh
        | null;
      if (!icon) return;
      this.icons.set(entity.index, icon);
      // Repair glow: bake the warm-gold emissive colour once — the update
      // loop only toggles the intensity scalar between 0 and repairGlow.
      const mat = icon.material as MeshStandardMaterial;
      mat.emissive.setHex(DEFENSE_BUTTONS.repairGlowColor);
      mat.emissiveIntensity = 0;
    });
    this.queries.pressed.subscribe('qualify', (entity) => {
      this.onPressed(entity);
    });
  }

  /** The one director entity, or undefined before LevelWaveSystem init. */
  private director(): Entity | undefined {
    for (const entity of this.queries.directors.entities) return entity;
    return undefined;
  }

  /** True while the pause-menu tag sits on the director entity. */
  private paused(): boolean {
    for (const director of this.queries.directors.entities) {
      return director.hasComponent(GamePaused);
    }
    return false;
  }

  /** True once the run has ended (victory or defeat) — the button parks. */
  private over(): boolean {
    for (const director of this.queries.directors.entities) {
      return director.hasComponent(GameOver);
    }
    return false;
  }

  /**
   * A live iron-guard blocks its slot: the repair button grays out and
   * ignores presses until the guard falls (Destroyed frees the slot).
   */
  private blocked(slot: number): boolean {
    const info = getDefenseSlotInfo(slot);
    return (
      !!info &&
      info.unit === 'iron-guard' &&
      !info.entity.hasComponent(Destroyed)
    );
  }

  /** True before the START gate opens — the button is scenery then. */
  private waitingStart(): boolean {
    for (const director of this.queries.directors.entities) {
      return (
        String(director.getValue(LevelDirector, 'phase')) === 'waiting-start'
      );
    }
    return false;
  }

  private onPressed(entity: Entity): void {
    if (this.paused() || this.over() || this.waitingStart()) return;
    const slot = Number(entity.getValue(DefenseButton, 'slot'));
    // A live iron-guard owns the slot: no repair.
    if (this.blocked(slot)) return;
    const info = getDefenseSlotInfo(slot);
    if (!info || info.entity.hasComponent(Destroyed)) return;
    if (info.entity.hasComponent(Repairing)) {
      info.entity.removeComponent(Repairing);
    } else {
      info.entity.addComponent(Repairing);
    }
  }

  update(): void {
    const director = this.director();
    if (!director) return;
    const over = director.hasComponent(GameOver);

    for (const entity of this.queries.buttons.entities) {
      const icon = this.icons.get(entity.index);
      if (!icon) continue;
      const slot = Number(entity.getValue(DefenseButton, 'slot'));
      // Iron-guard slot: the icon sits flat gray until the guard falls.
      const mat = icon.material as MeshStandardMaterial;
      mat.color.setHex(
        this.blocked(slot) ? DEFENSE_BUTTONS.blockedColor : 0xffffff,
      );
      const info = getDefenseSlotInfo(slot);
      const repairing =
        !over &&
        !!info &&
        !info.entity.hasComponent(Destroyed) &&
        info.entity.hasComponent(Repairing);
      // Repair-active pose: the shrunk scale plus the warm-gold glow — two
      // scalar writes, no motion.
      icon.scale.setScalar(repairing ? DEFENSE_BUTTONS.openScale : 1);
      mat.emissiveIntensity = repairing ? DEFENSE_BUTTONS.repairGlow : 0;
    }
  }
}
