/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createSystem, Mesh, Pressed } from '@iwsdk/core';
import type { Entity, MeshStandardMaterial } from '@iwsdk/core';
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
 * - build: opens the shared build panel on the director (BuildOpen + slot)
 *   unless it is already open — the grayed buttons below are the visual
 *   half of that contract.
 * - repair: toggles the Repairing tag on the slot's mounted unit. A dead
 *   (Destroyed) slot repairs nothing; the build panel is the way back.
 *
 * Both commands share the cannon-aim phase gate: before the START gate
 * opens, while paused or after an outcome the buttons are scenery.
 *
 * Visuals (single writer for every button icon): build buttons gray
 * while BuildOpen sits on the director; repair buttons breathe — the icon
 * scales sinusoidally — exactly while their unit carries Repairing. Ten
 * scalar writes per frame at most: negligible.
 */
export class DefenseButtonSystem extends createSystem({
  buttons: { required: [DefenseButton] },
  pressed: { required: [DefenseButton, Pressed] },
  directors: { required: [LevelDirector] },
}) {
  /** Button icon mesh per entity index, resolved once on qualify. */
  private readonly icons = new Map<number, Mesh>();
  /** Seconds accumulated for the repair breathing phase. */
  private breatheTime = 0;

  init(): void {
    this.queries.buttons.subscribe('qualify', (entity) => {
      const icon = entity.object3D?.getObjectByName('button-icon') as
        | Mesh
        | null;
      if (icon) this.icons.set(entity.index, icon);
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
      // Grayed buttons do not answer: the panel is already open.
      if (director.hasComponent(BuildOpen)) return;
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

  update(delta: number): void {
    const director = this.director();
    if (!director) return;
    const over = director.hasComponent(GameOver);
    const buildDisabled = director.hasComponent(BuildOpen);
    this.breatheTime += delta;
    // Repair breathing is pure motion: the icon scales up sinusoidally up
    // to breatheScale over its rest size; material colors never change.
    const breathePulse =
      1 +
      DEFENSE_BUTTONS.breatheScale *
        (0.5 + 0.5 * Math.sin(this.breatheTime * DEFENSE_BUTTONS.breatheSpeed));

    for (const entity of this.queries.buttons.entities) {
      const icon = this.icons.get(entity.index);
      if (!icon) continue;
      const slot = Number(entity.getValue(DefenseButton, 'slot'));
      if (String(entity.getValue(DefenseButton, 'kind')) === 'build') {
        icon.scale.setScalar(1);
        // The icon's colour zones are baked into vertex colors; the material
        // colour multiplies them, so enabled = white (true baked tints) and
        // disabled = the gray dimmer from level-config.
        (icon.material as MeshStandardMaterial).color.setHex(
          buildDisabled
            ? DEFENSE_BUTTONS.disabledColor
            : DEFENSE_BUTTONS.enabledColor,
        );
      } else {
        const info = getDefenseSlotInfo(slot);
        const breathing =
          !over &&
          !!info &&
          !info.entity.hasComponent(Destroyed) &&
          info.entity.hasComponent(Repairing);
        icon.scale.setScalar(breathing ? breathePulse : 1);
      }
    }
  }
}
