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
  WingFlap,
} from './components.js';

/**
 * Beats a flying unit's wings. Presence of `WingFlap` *is* the tag "this
 * unit has driven wings": on qualify the system resolves the model's
 * `wing_left` / `wing_right` flap pivots once and caches them
 * (PropellerSpinSystem's node-cache idiom), then each frame writes mirrored
 * `rotation.z` — the right wing rides `amplitude * sin(phase)`, the left
 * wing its negation, so both tips rise and fall together around the shared
 * shoulder axle. Pure scalar integration, no physics.
 *
 * A hovering flyer keeps flapping: motion state never gates the animation,
 * only the pause/hold tags do — the wings freeze while the game is paused
 * or over, exactly like every other simulation system.
 */
export class WingFlapSystem extends createSystem({
  flappers: { required: [WingFlap], excluded: [Destroyed] },
  directors: { required: [LevelDirector] },
}) {
  /** `wing_left` node per flapper entity index, resolved once on qualify. */
  private readonly leftWings = new Map<number, Object3D>();
  /** `wing_right` node per flapper entity index, resolved once on qualify. */
  private readonly rightWings = new Map<number, Object3D>();
  /** Flap phase per entity index, advanced by speed * delta. */
  private readonly phases = new Map<number, number>();

  init(): void {
    this.queries.flappers.subscribe('qualify', (entity) => {
      const object = entity.object3D;
      const left = object?.getObjectByName('wing_left');
      const right = object?.getObjectByName('wing_right');
      if (left && right) {
        this.leftWings.set(entity.index, left);
        this.rightWings.set(entity.index, right);
        this.phases.set(entity.index, 0);
      }
    });
  }

  update(delta: number): void {
    if (this.paused() || this.over()) return;
    for (const entity of this.queries.flappers.entities) {
      const left = this.leftWings.get(entity.index);
      const right = this.rightWings.get(entity.index);
      if (!left || !right) continue;
      const speed = Number(entity.getValue(WingFlap, 'speed'));
      const amplitude = Number(entity.getValue(WingFlap, 'amplitude'));
      const phase = (this.phases.get(entity.index) ?? 0) + speed * delta;
      this.phases.set(entity.index, phase);
      const swing = amplitude * Math.sin(phase);
      right.rotation.z = swing;
      left.rotation.z = -swing;
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
