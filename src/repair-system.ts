/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createSystem } from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';
import {
  Destroyed,
  GameOver,
  GamePaused,
  Health,
  LevelDirector,
  Repairing,
  Wallet,
} from './components.js';
import { ECONOMY } from './level-config.js';

/**
 * Repair drain — the only per-frame writer of the wallet. Every entity
 * carrying Repairing pulls ECONOMY.repairHpPerSecond of health out of
 * ECONOMY.repairCostPerSecond of money per second; the pool or the wallet
 * ends the state (repairing stops of its own accord when either runs out).
 * Full-health targets are peeled by the qualify guard: an entity can only
 * qualify while damaged, so clicking repair on an intact unit does nothing.
 *
 * Paused and over phases stay out of the way via the standard tag gate —
 * MenuSystem refuses repair commands then anyway, but tags mounted before a
 * pause would otherwise keep draining.
 */
export class RepairSystem extends createSystem({
  repairing: { required: [Repairing, Health] },
  directors: { required: [LevelDirector] },
}) {
  private walletEntity: Entity | null = null;

  init(): void {
    // The wallet rides the director; resolve it lazily each frame until it
    // exists (LevelWaveSystem creates the director entity with the wallet).
    this.queries.repairing.subscribe('qualify', (entity) => {
      // Intact units never enter the drain — the state is unreachable for
      // them and clicking repair on a full-health unit is a no-op.
      const health = entity.getValue(Health, 'current') as number;
      const max = entity.getValue(Health, 'max') as number;
      if (health >= max) entity.removeComponent(Repairing);
    });
  }

  update(delta: number): void {
    for (const director of this.queries.directors.entities) {
      // Paused (pause menu) and over (victory/defeat) freeze the drain like
      // every other sim system; mounted Repairing tags survive both and
      // resume or peel afterwards.
      if (director.hasComponent(GamePaused)) return;
      if (director.hasComponent(GameOver)) return;
      this.walletEntity = director.hasComponent(Wallet) ? director : null;
      break;
    }
    if (!this.walletEntity) return;
    const wallet = this.walletEntity;
    let money = wallet.getValue(Wallet, 'money') as number;

    for (const entity of this.queries.repairing.entities) {
      if (entity.hasComponent(Destroyed)) {
        entity.removeComponent(Repairing);
        continue;
      }
      const cost = ECONOMY.repairCostPerSecond * delta;
      if (money < cost) {
        // Out of money: stop here — the state peels for everyone and the
        // buttons' breathing dies with the tags.
        entity.removeComponent(Repairing);
        continue;
      }
      money -= cost;
      const max = entity.getValue(Health, 'max') as number;
      const healed = Math.min(
        (entity.getValue(Health, 'current') as number) +
          ECONOMY.repairHpPerSecond * delta,
        max,
      );
      entity.setValue(Health, 'current', healed);
      if (healed >= max) entity.removeComponent(Repairing);
    }

    wallet.setValue(Wallet, 'money', money);
  }
}
