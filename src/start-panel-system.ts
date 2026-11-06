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
const PANEL_POSITION = { x: 0, y: 1.9, z: -2.1 };
/** Panel is a 1 m square; the hidden state is the small end of the scale. */
const PANEL_SCALE = 1;
const PANEL_HIDDEN_SCALE = 0.5;

type StartPhase = 'idle' | 'appearing' | 'ready' | 'dismissing' | 'delay';

/**
 * START gate: grows in over the ocean; START shrinks it out and hands control
 * to LevelWaveSystem one second later.
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

  /** Reveal the START panel (called once the loading panel has hidden). */
  show(): void {
    if (this.phase !== 'idle') return;
    // Round-trip reuse: after MAIN the entity persists, so just regrow it.
    if (this.panel && this.panelEntity) {
      this.panel.visible = true;
      this.panelEntity.setValue(
        PanelScaleAnim,
        'currentScale',
        PANEL_HIDDEN_SCALE,
      );
      this.panelEntity.setValue(PanelScaleAnim, 'targetScale', PANEL_SCALE);
      this.phase = 'appearing';
      return;
    }
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

  private dismiss(): void {
    if (this.phase !== 'ready') return;
    this.panelEntity?.setValue(
      PanelScaleAnim,
      'targetScale',
      PANEL_HIDDEN_SCALE,
    );
    this.phase = 'dismissing';
  }

  /** MAIN-menu hand-off: park the gate pre-battle, keeping the hidden entity for reuse. */
  reset(): void {
    if (this.phase === 'idle') return;
    if (this.panel) this.panel.visible = false;
    this.panelEntity?.setValue(
      PanelScaleAnim,
      'currentScale',
      PANEL_HIDDEN_SCALE,
    );
    this.panelEntity?.setValue(PanelScaleAnim, 'targetScale', PANEL_HIDDEN_SCALE);
    this.phase = 'idle';
    this.timer = 0;
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
