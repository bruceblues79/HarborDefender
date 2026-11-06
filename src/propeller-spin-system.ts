/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createSystem } from '@iwsdk/core';
import type { Object3D } from '@iwsdk/core';
import {
  Destroyed,
  GameOver,
  GamePaused,
  LevelDirector,
  PropellerSpin,
} from './components.js';

/**
 * Spins every child of the `propellers` node (resolved once on qualify) about its
 * local +Y; only the pause/over tags gate the spin.
 */
export class PropellerSpinSystem extends createSystem({
  rotors: { required: [PropellerSpin], excluded: [Destroyed] },
  directors: { required: [LevelDirector] },
}) {
  private readonly rotorSets = new Map<number, Object3D>();

  init(): void {
    this.queries.rotors.subscribe('qualify', (entity) => {
      const propellers = entity.object3D?.getObjectByName('propellers');
      if (propellers) this.rotorSets.set(entity.index, propellers);
    });
  }

  update(delta: number): void {
    if (this.paused() || this.over()) return;
    for (const entity of this.queries.rotors.entities) {
      const propellers = this.rotorSets.get(entity.index);
      if (!propellers) continue;
      const speed = Number(entity.getValue(PropellerSpin, 'speed'));
      for (const rotor of propellers.children) {
        rotor.rotation.y += speed * delta;
      }
    }
  }

  private paused(): boolean {
    for (const director of this.queries.directors.entities) {
      return director.hasComponent(GamePaused);
    }
    return false;
  }

  private over(): boolean {
    for (const director of this.queries.directors.entities) {
      return director.hasComponent(GameOver);
    }
    return false;
  }
}
