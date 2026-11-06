/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createSystem, Pressed, RayInteractable } from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';
import {
  BuildOpen,
  DefensePad,
  Destroyed,
  GameOver,
  GamePaused,
  LevelDirector,
} from './components.js';
import { getDefenseSlotInfo } from './battle-setup.js';

/**
 * Pedestal pads — the build entry and the only writer of the pad's interaction gate.
 * An empty slot's pad (nothing mounted, or the unit carries Destroyed) holds
 * RayInteractable; an occupied slot's pad drops it so the mounted cannon keeps its own
 * ray interaction. Otherwise the pad's look belongs to DefensePadSystem.
 *
 * Pressing an empty pad opens the shared build panel (BuildOpen + slot). Pressing while
 * a dock is open is toggle / switch: remove+add fires the panel's disqualify (hide)
 * then qualify (reposition + reprice) inside one frame.
 *
 * Presses are ignored before START, while paused, and after an outcome.
 */
export class DefensePadInputSystem extends createSystem({
  pads: { required: [DefensePad] },
  pressed: { required: [DefensePad, Pressed] },
  directors: { required: [LevelDirector] },
}) {
  init(): void {
    this.queries.pressed.subscribe('qualify', (entity) => {
      this.onPressed(entity);
    });
  }

  /**
   * Mirror the battery registry onto the pads: the `hasComponent` guard makes this a
   * no-op on frames where occupancy has not changed.
   */
  update(): void {
    for (const pad of this.queries.pads.entities) {
      const slot = Number(pad.getValue(DefensePad, 'slot'));
      if (this.slotEmpty(slot)) {
        if (!pad.hasComponent(RayInteractable)) pad.addComponent(RayInteractable);
      } else if (pad.hasComponent(RayInteractable)) {
        pad.removeComponent(RayInteractable);
      }
    }
  }

  /** A Destroyed mounted unit counts as empty. */
  private slotEmpty(slot: number): boolean {
    const info = getDefenseSlotInfo(slot);
    return !info || info.entity.hasComponent(Destroyed);
  }

  private director(): Entity | undefined {
    for (const entity of this.queries.directors.entities) return entity;
    return undefined;
  }

  /** True before the START gate opens — the pads are scenery then. */
  private waitingStart(director: Entity): boolean {
    return String(director.getValue(LevelDirector, 'phase')) === 'waiting-start';
  }

  private onPressed(pad: Entity): void {
    const director = this.director();
    if (!director) return;
    if (
      director.hasComponent(GamePaused) ||
      director.hasComponent(GameOver) ||
      this.waitingStart(director)
    ) {
      return;
    }
    const slot = Number(pad.getValue(DefensePad, 'slot'));
    if (!this.slotEmpty(slot)) return;

    if (director.hasComponent(BuildOpen)) {
      const openSlot = Number(director.getValue(BuildOpen, 'slot'));
      director.removeComponent(BuildOpen);
      if (openSlot !== slot) director.addComponent(BuildOpen, { slot });
      return;
    }
    director.addComponent(BuildOpen, { slot });
  }
}
