/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  createSystem,
  loadUIKitMLAsset,
  RayInteractable,
} from '@iwsdk/core';
import type { Entity, UIKitMLAsset } from '@iwsdk/core';
import { Billboard, PanelScaleAnim } from './components.js';
import { PACING } from './level-config.js';
import { LevelWaveSystem } from './level-wave-system.js';

/** Panel anchor: above the ocean's near edge, clear of the wall and cannons. */
const PANEL_POSITION = { x: 0, y: 1.7, z: -2.1 };
/** Panel is a 1 m square; the hidden state is the small end of the scale. */
const PANEL_SCALE = 1;
const PANEL_HIDDEN_SCALE = 0.5;

type StartPhase = 'idle' | 'appearing' | 'ready' | 'dismissing' | 'delay';

/**
 * Owns the START gate between loading and the first level.
 *
 * Sequence: the loading panel hides, then this panel grows in (0.5 -> 1.0)
 * above the ocean near edge, billboarded toward the player. Clicking START
 * shrinks it back to 0.5, hides it, and — one second later — hands control to
 * LevelWaveSystem. This is the beat that separates menu, load and play.
 */
export class StartPanelSystem extends createSystem({}) {
  private levelSystem: LevelWaveSystem | undefined;
  private panel: UIKitMLAsset | undefined;
  private panelEntity: Entity | undefined;
  private phase: StartPhase = 'idle';
  private timer = 0;

  init(): void {
    this.levelSystem = this.world
      .getSystems()
      .find(
        (system): system is LevelWaveSystem =>
          system instanceof LevelWaveSystem,
      );
  }

  /** Reveal the START panel. Called once the loading panel has hidden. */
  show(): void {
    if (this.phase !== 'idle') return;
    loadUIKitMLAsset('start-panel')
      .then((panel) => {
        panel.position.set(PANEL_POSITION.x, PANEL_POSITION.y, PANEL_POSITION.z);
        panel.scale.setScalar(PANEL_HIDDEN_SCALE);

        const entity = this.world.createTransformEntity(panel);
        entity.addComponent(RayInteractable);
        entity.addComponent(Billboard);
        entity.addComponent(PanelScaleAnim, {
          targetScale: PANEL_SCALE,
          currentScale: PANEL_HIDDEN_SCALE,
        });

        panel
          .getElementById('start-button')
          ?.addEventListener('click', () => this.dismiss());

        this.panel = panel;
        this.panelEntity = entity;
        this.phase = 'appearing';
      })
      .catch((err: unknown) =>
        console.error('StartPanelSystem: failed to load start panel', err),
      );
  }

  /** START pressed: shrink out, then wait out the hand-off delay. */
  private dismiss(): void {
    if (this.phase !== 'ready') return;
    this.panelEntity?.setValue(
      PanelScaleAnim,
      'targetScale',
      PANEL_HIDDEN_SCALE,
    );
    this.phase = 'dismissing';
  }

  update(delta: number): void {
    if (!this.panelEntity || this.phase === 'idle') return;
    const current = Number(
      this.panelEntity.getValue(PanelScaleAnim, 'currentScale'),
    );

    if (this.phase === 'appearing' && current >= PANEL_SCALE) {
      this.phase = 'ready';
      return;
    }
    if (this.phase === 'dismissing' && current <= PANEL_HIDDEN_SCALE) {
      if (this.panel) this.panel.visible = false;
      this.phase = 'delay';
      this.timer = PACING.postStartDelay;
      return;
    }
    if (this.phase === 'delay') {
      this.timer -= delta;
      if (this.timer <= 0) {
        this.phase = 'idle';
        this.levelSystem?.beginLevel();
      }
    }
  }
}
