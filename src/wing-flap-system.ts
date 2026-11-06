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
 * Drives `wing_left` / `wing_right` (resolved once on qualify) with mirrored
 * rotation.z; only the pause/over tags gate the flap.
 */
export class WingFlapSystem extends createSystem({
  flappers: { required: [WingFlap], excluded: [Destroyed] },
  directors: { required: [LevelDirector] },
}) {
  private readonly leftWings = new Map<number, Object3D>();
  private readonly rightWings = new Map<number, Object3D>();
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
