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
import { Billboard, GameOver, LevelDirector, PanelScaleAnim } from './components.js';
import { MenuSystem } from './menu-system.js';

/** Panel anchor: the START panel's spot above the ocean's near edge — free
 * again by the time an outcome lands, and centred over the battle. */
const PANEL_POSITION = { x: 0, y: 1.9, z: -2.1 };
/** Panel is 1.5 m × 1 m; the hidden state is the small end of the scale. */
const PANEL_SCALE = 1;
const PANEL_HIDDEN_SCALE = 0.5;

/** Outcome presentation, keyed by the director phase at GameOver qualify. */
const OUTCOMES: Record<string, { title: string; color: string; subtitle: string }> = {
  'game-cleared': {
    title: 'VICTORY',
    color: '#1e6f34',
    subtitle: 'ALL RAIDERS SUNK',
  },
  defeated: {
    title: 'DEFEAT',
    color: '#8a1400',
    subtitle: 'THE BATTERY IS LOST',
  },
};

type ResultPhase = 'idle' | 'appearing' | 'ready';

/**
 * Owns the end-of-run result panel. It qualifies on the GameOver tag the
 * LevelWaveSystem writes when the phase flips to 'game-cleared' (every wave
 * of the last level cleared) or 'defeated' (the whole battery knocked out),
 * grows in over the battlefield and offers RESTART / MAIN — the exact reset
 * sequences MenuSystem.runRestart / runMain run from the pause menu.
 *
 * The panel follows the START-panel pattern: fixed world anchor, Billboard,
 * PanelScaleAnim grow-in, RayInteractable for browser and XR rays alike.
 * Dismissing GameOver (either button) hides it again.
 */
export class ResultPanelSystem extends createSystem({
  over: { required: [LevelDirector, GameOver] },
}) {
  private panel: UIKitMLAsset | undefined;
  private panelEntity: Entity | undefined;
  private phase: ResultPhase = 'idle';

  init(): void {
    this.queries.over.subscribe('qualify', (entity) => this.showOutcome(entity));
    this.queries.over.subscribe('disqualify', () => this.hide());
  }

  /** Grow the panel in, presented for the phase the director just flipped to. */
  private showOutcome(director: Entity): void {
    const outcome = OUTCOMES[String(director.getValue(LevelDirector, 'phase'))];
    if (!outcome) return;
    // Round-trip reuse: the panel entity persists across outcomes.
    if (this.panel && this.panelEntity) {
      this.applyOutcome(outcome);
      return;
    }
    loadUIKitMLAsset('result-panel')
      .then((panel) => {
        panel.position.set(PANEL_POSITION.x, PANEL_POSITION.y, PANEL_POSITION.z);
        panel.scale.setScalar(PANEL_HIDDEN_SCALE);

        const entity = this.world.createTransformEntity(panel);
        entity.addComponent(RayInteractable);
        entity.addComponent(Billboard);
        entity.addComponent(PanelScaleAnim, {
          targetScale: PANEL_HIDDEN_SCALE,
          currentScale: PANEL_HIDDEN_SCALE,
        });

        const menuSystem = this.world
          .getSystems()
          .find((system): system is MenuSystem => system instanceof MenuSystem);
        panel
          .getElementById('result-restart-button')
          ?.addEventListener('click', () => {
            if (this.phase !== 'ready') return;
            menuSystem?.runRestart();
          });
        panel
          .getElementById('result-main-button')
          ?.addEventListener('click', () => {
            if (this.phase !== 'ready') return;
            menuSystem?.runMain();
          });

        this.panel = panel;
        this.panelEntity = entity;
        // The outcome may have landed while the panel was still loading.
        let pending = director;
        for (const entity of this.queries.over.entities) {
          pending = entity;
          break;
        }
        this.applyOutcome(
          OUTCOMES[String(pending.getValue(LevelDirector, 'phase'))] ?? outcome,
        );
      })
      .catch((err: unknown) =>
        console.error('ResultPanelSystem: failed to load result panel', err),
      );
  }

  /** Swap the copy for the outcome and start the grow-in. */
  private applyOutcome(outcome: {
    title: string;
    color: string;
    subtitle: string;
  }): void {
    if (!this.panel || !this.panelEntity) return;
    this.panel
      .getElementById('result-title')
      ?.setProperties({ text: outcome.title, color: outcome.color });
    this.panel
      .getElementById('result-subtitle')
      ?.setProperties({ text: outcome.subtitle });
    this.panel.visible = true;
    this.panelEntity.setValue(PanelScaleAnim, 'currentScale', PANEL_HIDDEN_SCALE);
    this.panelEntity.setValue(PanelScaleAnim, 'targetScale', PANEL_SCALE);
    this.phase = 'appearing';
  }

  /** GameOver dismissed (RESTART / MAIN): park the panel back in hiding. */
  private hide(): void {
    if (this.phase === 'idle') return;
    if (this.panel) this.panel.visible = false;
    this.panelEntity?.setValue(PanelScaleAnim, 'currentScale', PANEL_HIDDEN_SCALE);
    this.panelEntity?.setValue(PanelScaleAnim, 'targetScale', PANEL_HIDDEN_SCALE);
    this.phase = 'idle';
  }

  update(): void {
    if (!this.panelEntity || this.phase !== 'appearing') return;
    const current = Number(
      this.panelEntity.getValue(PanelScaleAnim, 'currentScale'),
    );
    if (current >= PANEL_SCALE) this.phase = 'ready';
  }
}
