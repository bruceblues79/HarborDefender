/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createSystem, Mesh, MeshStandardMaterial, Pressed } from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';
import {
  BuildOpen,
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
 * Build/repair buttons — the thin command layer over the wall's button rigs.
 *
 * Commands (a `Pressed` tag from InputSystem, one path for mouse, touch and
 * XR ray):
 * - build: opens the shared build panel on the director (BuildOpen + slot).
 *   Pressed while a dock is already open it becomes toggle/switch: the open
 *   slot's own button closes the dock, another slot's button closes the old
 *   dock and reopens it over the new slot — remove+add of the tag fires
 *   disqualify (hide) then qualify (reposition + reprice) inside one frame.
 * - repair: toggles the Repairing tag on the slot's mounted unit. A dead
 *   (Destroyed) slot repairs nothing; the build panel is the way back.
 *
 * Both commands share the cannon-aim phase gate: before the START gate
 * opens, while paused or after an outcome the buttons are scenery.
 *
 * Visuals (single writer for every button icon): the open slot's build
 * icon holds a shrunk "open" pose (DEFENSE_BUTTONS.openScale) — pure scale;
 * a repairing unit's repair icon holds the same shrunk pose plus a warm-gold
 * emissive glow (colour baked into its own material clone at qualify, the
 * update loop writes one intensity scalar). Materials and the hit proxies
 * otherwise never change. Ten scalar writes per frame at most: negligible.
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
      if (String(entity.getValue(DefenseButton, 'kind')) === 'repair') {
        const mat = icon.material as MeshStandardMaterial;
        mat.emissive.setHex(DEFENSE_BUTTONS.repairGlowColor);
        mat.emissiveIntensity = 0;
      }
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

  /** True once the run has ended (victory or defeat) — the buttons park. */
  private over(): boolean {
    for (const director of this.queries.directors.entities) {
      return director.hasComponent(GameOver);
    }
    return false;
  }

  /** True before the START gate opens — the buttons are scenery then. */
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
    const director = this.director();
    if (!director) return;
    if (String(entity.getValue(DefenseButton, 'kind')) === 'build') {
      // Dock already open → toggle/switch: same slot closes, another slot
      // moves the dock there. The remove+add pair drives the panel's
      // disqualify/qualify lifecycle synchronously — no visible flicker.
      if (director.hasComponent(BuildOpen)) {
        const openSlot = Number(director.getValue(BuildOpen, 'slot'));
        director.removeComponent(BuildOpen);
        if (openSlot !== slot) director.addComponent(BuildOpen, { slot });
        return;
      }
      director.addComponent(BuildOpen, { slot });
      return;
    }
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
    // The dock's slot while open (null when closed): that slot's build icon
    // holds the shrunk "open" pose. Scale writes are transform-only — the
    // shared geometry and the enlarged hit proxies never change.
    const openSlot = director.hasComponent(BuildOpen)
      ? Number(director.getValue(BuildOpen, 'slot'))
      : null;

    for (const entity of this.queries.buttons.entities) {
      const icon = this.icons.get(entity.index);
      if (!icon) continue;
      const slot = Number(entity.getValue(DefenseButton, 'slot'));
      if (String(entity.getValue(DefenseButton, 'kind')) === 'build') {
        icon.scale.setScalar(
          openSlot === slot ? DEFENSE_BUTTONS.openScale : 1,
        );
      } else {
        const info = getDefenseSlotInfo(slot);
        const repairing =
          !over &&
          !!info &&
          !info.entity.hasComponent(Destroyed) &&
          info.entity.hasComponent(Repairing);
        // Repair-active pose: the same shrunk scale as the build button's
        // open dock plus the warm-gold glow — two scalar writes, no motion.
        icon.scale.setScalar(repairing ? DEFENSE_BUTTONS.openScale : 1);
        (icon.material as MeshStandardMaterial).emissiveIntensity = repairing
          ? DEFENSE_BUTTONS.repairGlow
          : 0;
      }
    }
  }
}
