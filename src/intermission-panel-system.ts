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
import {
  Billboard,
  LevelDirector,
  PanelScaleAnim,
  WaveIntermission,
} from './components.js';
import { endlessLevel } from './level-config.js';

/** Result panel's spot above the ocean's near edge; the two never show at once. */
const PANEL_POSITION = { x: 0, y: 1.9, z: -2.1 };
/** Panel is 1.5 m × 1 m; the hidden state is the small end of the scale. */
const PANEL_SCALE = 1;
const PANEL_HIDDEN_SCALE = 0.5;

/** Victory green: the intermission reads as a go signal. */
const TITLE_COLOR = '#1e6f34';

type PanelPhase = 'idle' | 'appearing';

/**
 * Endless intermission panel: shows "WAVE <n> / GET READY" while the director
 * carries `WaveIntermission`; pure display, the game keeps running.
 */
export class IntermissionPanelSystem extends createSystem({
  gates: { required: [LevelDirector, WaveIntermission] },
}) {
  private panel: UIKitMLAsset | undefined;
  private panelEntity: Entity | undefined;
  private phase: PanelPhase = 'idle';

  init(): void {
    this.queries.gates.subscribe('qualify', () => this.show());
    this.queries.gates.subscribe('disqualify', () => this.hide());
  }

  private show(): void {
    if (this.panel && this.panelEntity) {
      this.apply();
      return;
    }
    loadUIKitMLAsset('intermission-panel')
      .then((panel) => {
        panel.position.set(PANEL_POSITION.x, PANEL_POSITION.y, PANEL_POSITION.z);
        panel.scale.setScalar(PANEL_HIDDEN_SCALE);
        // Panels load visible; park before mounting or un-laid-out markup
        // flashes for a frame.
        panel.visible = false;

        const entity = this.world.createTransformEntity(panel);
        entity.addComponent(RayInteractable);
        entity.addComponent(Billboard);
        entity.addComponent(PanelScaleAnim, {
          targetScale: PANEL_HIDDEN_SCALE,
          currentScale: PANEL_HIDDEN_SCALE,
        });

        this.panel = panel;
        this.panelEntity = entity;
        // The gate may have closed while loading; land in the gate's current
        // state so a missed disqualify never strands the panel on screen.
        if (this.queries.gates.entities.size > 0) this.apply();
      })
      .catch((err: unknown) =>
        console.error(
          'IntermissionPanelSystem: failed to load intermission panel',
          err,
        ),
      );
  }

  private apply(): void {
    if (!this.panel || !this.panelEntity) return;
    // The planner appends the wave before the tag lands, so the list length
    // IS the next wave's 1-based number.
    const waveNumber = endlessLevel.waves.length;
    this.panel
      .getElementById('inter-title')
      ?.setProperties({ text: `WAVE ${waveNumber}`, color: TITLE_COLOR });
    this.panel.visible = true;
    this.panelEntity.setValue(PanelScaleAnim, 'currentScale', PANEL_HIDDEN_SCALE);
    this.panelEntity.setValue(PanelScaleAnim, 'targetScale', PANEL_SCALE);
    this.phase = 'appearing';
  }

  /**
   * No phase guard: a disqualify may arrive while the panel is still loading;
   * parking early is what keeps it from appearing after its window is gone.
   */
  private hide(): void {
    if (!this.panelEntity) return;
    if (this.panel) this.panel.visible = false;
    this.panelEntity.setValue(PanelScaleAnim, 'currentScale', PANEL_HIDDEN_SCALE);
    this.panelEntity.setValue(PanelScaleAnim, 'targetScale', PANEL_HIDDEN_SCALE);
    this.phase = 'idle';
  }

  update(): void {
    if (!this.panelEntity || this.phase !== 'appearing') return;
    const current = Number(
      this.panelEntity.getValue(PanelScaleAnim, 'currentScale'),
    );
    if (current >= PANEL_SCALE) this.phase = 'idle';
  }
}
