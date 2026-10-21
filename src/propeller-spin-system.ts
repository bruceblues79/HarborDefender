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
 * Turns a flying unit's rotors. Presence of `PropellerSpin` *is* the tag
 * "this unit has a driven rotor": on qualify the system resolves the model's
 * `propellers` node once and caches it (CannonAimSystem's gunPivots idiom),
 * then each frame spins every child rotor about its local +Y — the
 * bombardier's tandem discs each live on their own mast node, so one shared
 * component drives them all.
 *
 * A hovering flyer keeps its rotors turning: motion state never gates the
 * spin, only the pause/hold tags do — exactly like every other simulation
 * system, the rotors freeze while the game is paused or over.
 */
export class PropellerSpinSystem extends createSystem({
  rotors: { required: [PropellerSpin], excluded: [Destroyed] },
  directors: { required: [LevelDirector] },
}) {
  /** `propellers` node per rotor entity index, resolved once on qualify. */
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

  /** True while the pause-menu tag sits on the director entity. */
  private paused(): boolean {
    for (const director of this.queries.directors.entities) {
      return director.hasComponent(GamePaused);
    }
    return false;
  }

  /** True while the run has ended (result panel up, battlefield frozen). */
  private over(): boolean {
    for (const director of this.queries.directors.entities) {
      return director.hasComponent(GameOver);
    }
    return false;
  }
}
