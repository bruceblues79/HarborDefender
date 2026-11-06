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
 * Repair drain — the only per-frame writer of the wallet. Drains the ECONOMY rates
 * while Repairing; full-health units and paused/over states never drain.
 */
export class RepairSystem extends createSystem({
  repairing: { required: [Repairing, Health] },
  directors: { required: [LevelDirector] },
}) {
  private walletEntity: Entity | null = null;

  init(): void {
    // Wallet rides the director, which LevelWaveSystem creates later; resolve it
    // lazily each frame until it exists.
    this.queries.repairing.subscribe('qualify', (entity) => {
      // Full-health units leave immediately, so clicking repair on an intact unit is a no-op.
      const health = entity.getValue(Health, 'current') as number;
      const max = entity.getValue(Health, 'max') as number;
      if (health >= max) entity.removeComponent(Repairing);
    });
  }

  update(delta: number): void {
    for (const director of this.queries.directors.entities) {
      // Paused and over freeze the drain; tags mounted before a pause resume or peel afterwards.
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
        // Out of money: peel the tag; the repair button's shrunk pose and glow go with it.
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
