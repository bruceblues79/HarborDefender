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

/** Panel anchor: the result panel's spot above the ocean's near edge — the
 *  two presentations never show at once, so they share the same stage. */
const PANEL_POSITION = { x: 0, y: 1.9, z: -2.1 };
/** Panel is 1.5 m × 1 m; the hidden state is the small end of the scale. */
const PANEL_SCALE = 1;
const PANEL_HIDDEN_SCALE = 0.5;

/** Title colour: the intermission is a go signal, so the victory green. */
const TITLE_COLOR = '#1e6f34';

type PanelPhase = 'idle' | 'appearing';

/**
 * Endless wave intermission presentation (波间歇展示). While the director
 * carries `WaveIntermission` the panel stands over the battlefield reading
 * "WAVE <n> / GET READY FOR NEXT WAVE"; enterWave drops the tag and the
 * panel parks again. Pure display — the game keeps running and the player
 * may build, repair and aim right through it.
 *
 * The panel follows the result-panel pattern: fixed world anchor, Billboard,
 * PanelScaleAnim grow-in, RayInteractable + CameraBlocker so the window's
 * short life never hijacks a camera drag.
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
        // Loaded panels default to visible; park BEFORE mounting or the
        // un-laid-out markup flashes for a frame (intermission-panel loading
        // habit: visible=false first, mount second).
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
        // The gate may have closed while the panel was still loading (the
        // shortest window can beat a cold network): land in the state the
        // gate is in RIGHT NOW, so a missed disqualify can never leave the
        // panel stuck on screen.
        if (this.queries.gates.entities.size > 0) this.apply();
      })
      .catch((err: unknown) =>
        console.error(
          'IntermissionPanelSystem: failed to load intermission panel',
          err,
        ),
      );
  }

  /** Swap the copy for the upcoming wave and start the grow-in. */
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
   * Intermission closed (enterWave): park the panel back in hiding. No
   * phase guard — a disqualify may legitimately arrive while the panel is
   * still loading (the shortest window vs a cold network); parking the
   * not-yet-applied state here is exactly what keeps the panel from
   * appearing after its window is already gone. Without an entity yet there
   * is nothing to park — the load callback re-reads the gate and lands
   * hidden on its own.
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
