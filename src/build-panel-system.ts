/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  createSystem,
  RayInteractable,
  UIKitMLAsset,
  VisibilityState,
  loadUIKitMLAsset,
} from '@iwsdk/core';
import type { Text } from '@pmndrs/uikit';
import type { Entity, Object3D } from '@iwsdk/core';
import {
  Billboard,
  BuildOpen,
  CameraBlocker,
  Destroyed,
  GameOver,
  GamePaused,
  LevelDirector,
  Wallet,
} from './components.js';
import {
  DEFENSE_SLOTS,
  ECONOMY,
  PLACEABLE_UNITS,
  UNIQUE_UNITS,
  WALL_CENTER_Z,
} from './level-config.js';
import type { DefenseUnitId } from './level-config.js';
import {
  getDefenseSlotInfo,
  hasLiveDefenseUnit,
  replaceDefenseUnit,
} from './battle-setup.js';
import { closeBuildDock } from './build-dock.js';

/** Minimal shape of a uikit element's runtime class list (class layer). */
type UiElement = Object3D & {
  classList: {
    add(...classes: string[]): unknown;
    remove(...classes: string[]): unknown;
  };
};

/**
 * Fixed world anchor of the dock: y sits near the cannon health bar top
 * (≈ 1.34 world), z a hair land-side of the wall centre so the billboarded
 * glass layers in front of the bar plane instead of slicing it.
 */
const BAR_ANCHOR = { y: 1.4, z: WALL_CENTER_Z + 0.1 };
/**
 * Per-environment scale over the dock's authored 0.33 × 0.205 m: flat mode
 * grows it 1.8x for the orbit camera's ~5 m stand-off.
 */
const PANEL_FACTORS = { xr: 1, flat: 1.8 };

/**
 * The shared build dock and its owner: BuildOpen on the director reveals the
 * billboarded dock over that empty slot's pad; a pick mounts the unit, deducts
 * and closes. Every BuildOpen write goes through build-dock.ts.
 */
export class BuildPanelSystem extends createSystem({
  directors: { required: [LevelDirector] },
  /**
   * BuildOpen mounts onto a director that already qualified the plain
   * directors query, and adding a component does NOT re-fire 'qualify'
   * there — so the open state needs its own query.
   */
  openDirectors: { required: [LevelDirector, BuildOpen] },
}) {
  private panel: UIKitMLAsset | null = null;
  /** Environment the panel scale was last applied for; a flip re-applies. */
  private factorsEnvironment: boolean | null = null;
  /** Live gold readout in the top-row badge. */
  private walletText: Text | null = null;
  /** Last badge string written; skips redundant Text writes while gold sits still. */
  private lastWalletText: string | null = null;
  private readonly rows = new Map<DefenseUnitId, UiElement | null>();
  /** Class currently applied per unit button; guards redundant class swaps. */
  private readonly unitClasses = new Map<DefenseUnitId, string>();

  init(): void {
    this.loadPanel();
    // Panel open/close rides the openDirectors query lifecycle: qualify
    // reveals + prices the rows, disqualify hides.
    this.queries.openDirectors.subscribe('qualify', (director) => {
      this.openPanel(director);
    });
    this.queries.openDirectors.subscribe('disqualify', () => {
      this.applyVisibility();
    });
  }

  private loadPanel(): void {
    loadUIKitMLAsset('build-panel')
      .then((panel) => {
        this.panel = panel;
        panel.visible = false;
        panel.position.set(
          DEFENSE_SLOTS[0].x,
          BAR_ANCHOR.y,
          BAR_ANCHOR.z,
        );
        const panelEntity = this.world.createTransformEntity(panel);
        panelEntity.addComponent(Billboard, { lockY: true });
        // One interactable over the whole panel routes presses into the
        // UIKitML documents (same pattern as the scene-authored panels).
        panelEntity.addComponent(RayInteractable);
        // The whole panel surface blocks the camera rig; the tag rides the
        // Hovered/Pressed route, so it also holds for touch where synthetic
        // pointerIds never match native ones.
        panelEntity.addComponent(CameraBlocker);

        for (const unitId of PLACEABLE_UNITS) {
          const row = panel.getElementById(`row-${unitId}`) as UiElement | null;
          if (row) {
            const onPick = () => this.onRowPicked(unitId);
            row.addEventListener('click', onPick);
            this.cleanupFuncs.push(() =>
              row.removeEventListener('click', onPick),
            );
            this.rows.set(unitId, row);
          }
        }
        const dismiss = panel.getElementById('build-dismiss');
        this.walletText = this.resolveText(
          panel.getElementById('wallet-value'),
        );
        if (dismiss) {
          const onDismiss = () => this.closePanel();
          dismiss.addEventListener('click', onDismiss);
          this.cleanupFuncs.push(() =>
            dismiss.removeEventListener('click', onDismiss),
          );
        }

        // The tag may have been raised while the asset was still loading:
        // catch up immediately.
        this.applyVisibility();
        this.applyPanelScale();
        const director = this.findOpenDirector();
        if (director) this.refreshRows(director);
      })
      .catch((err: unknown) => {
        console.error('Failed to load build panel:', err);
      });
  }

  /**
   * UIKitML has no <text> element: a dynamic readout is a container wrapping
   * one Text child — this finds that child.
   */
  private resolveText(container: Object3D | null): Text | null {
    if (!container) return null;
    const child = container.children.find(
      (candidate) =>
        typeof (candidate as Text).properties?.value?.text === 'string',
    );
    return (child as Text | undefined) ?? null;
  }

  private findOpenDirector(): Entity | null {
    for (const director of this.queries.directors.entities) {
      if (director.hasComponent(BuildOpen)) return director;
    }
    return null;
  }

  private immersive(): boolean {
    return (
      this.world.visibilityState.peek() !== VisibilityState.NonImmersive
    );
  }

  private applyVisibility(): void {
    if (!this.panel) return;
    this.panel.visible = !!this.findOpenDirector();
  }

  private applyPanelScale(): void {
    if (!this.panel) return;
    const immersive = this.immersive();
    this.factorsEnvironment = immersive;
    this.panel.scale.setScalar(immersive ? PANEL_FACTORS.xr : PANEL_FACTORS.flat);
  }

  /** Price for unitId: always the full book value — there is no trade-in. */
  private priceFor(unitId: DefenseUnitId): number {
    return ECONOMY.unitValues[unitId] ?? 0;
  }

  /**
   * Drive every button's two-state class from live state and mirror the
   * wallet in the top-row badge.
   */
  private refreshRows(director: Entity): void {
    const money = director.hasComponent(Wallet)
      ? (director.getValue(Wallet, 'money') as number)
      : Number.POSITIVE_INFINITY;
    if (this.walletText && director.hasComponent(Wallet)) {
      // The gold only moves on repair drain, a purchase or a level reset;
      // between those moments rewriting the same string every frame would
      // needlessly dirty the Text component, so guard on the value.
      const text = `${Math.floor(money)}g`;
      if (text !== this.lastWalletText) {
        this.lastWalletText = text;
        this.walletText.setProperties({ text });
      }
    }
    for (const unitId of PLACEABLE_UNITS) {
      const row = this.rows.get(unitId);
      if (!row) continue;
      const price = this.priceFor(unitId);
      let next: string;
      if (
        // UNIQUE_UNITS (全场唯一): a live carrier anywhere grays its row in
        // every other slot's dock, same look as an unmet price.
        (UNIQUE_UNITS.has(unitId) && hasLiveDefenseUnit(unitId)) ||
        price > money
      ) {
        next = 'dock-unit-off';
      } else {
        next = 'dock-unit';
      }
      this.setUnitClass(unitId, row, next);
    }
  }

  /**
   * Runtime setProperties writes the base property layer, which the markup's
   * .dock-unit class layer outranks — only a class swap toggles the state.
   */
  private setUnitClass(
    unitId: DefenseUnitId,
    row: UiElement,
    next: string,
  ): void {
    if (this.unitClasses.get(unitId) === next) return;
    for (const candidate of ['dock-unit', 'dock-unit-off']) {
      row.classList.remove(candidate);
    }
    row.classList.add(next);
    this.unitClasses.set(unitId, next);
  }

  private openPanel(director: Entity): void {
    if (!this.panel) {
      // The panel asset has not finished loading yet; drop the command —
      // the player simply presses the pad again.
      closeBuildDock(director);
      return;
    }
    const slot = Number(director.getValue(BuildOpen, 'slot'));
    const def = DEFENSE_SLOTS[slot];
    if (def) this.panel.position.set(def.x, BAR_ANCHOR.y, BAR_ANCHOR.z);
    this.applyVisibility();
    this.applyPanelScale();
    this.refreshRows(director);
  }

  private closePanel(): void {
    const director = this.findOpenDirector();
    if (director) closeBuildDock(director);
    this.applyVisibility();
  }

  private onRowPicked(unitId: DefenseUnitId): void {
    const director = this.findOpenDirector();
    if (!director || !director.hasComponent(Wallet)) return;
    const slot = Number(director.getValue(BuildOpen, 'slot'));
    // Valid slot index only — an empty (never mounted or knocked clean)
    // slot is the only build target.
    if (!DEFENSE_SLOTS[slot]) return;
    // The dock only opens from an empty pad; refuse anyway so a stale click
    // can never buy into an occupied slot.
    const info = getDefenseSlotInfo(slot);
    if (info && !info.entity.hasComponent(Destroyed)) return;
    // UNIQUE_UNITS (全场唯一): one live iron-guard anywhere forbids a
    // second — the row already renders grayed, this is the stale-click
    // guard behind it.
    if (UNIQUE_UNITS.has(unitId) && hasLiveDefenseUnit(unitId)) return;
    const price = this.priceFor(unitId);
    const money = director.getValue(Wallet, 'money') as number;
    if (money < price) return;

    director.setValue(Wallet, 'money', money - price);
    const next = replaceDefenseUnit(this.world, slot, unitId);
    if (next.object3D) next.object3D.visible = true;
    this.closePanel();
  }

  update(): void {
    // Pause menu or an outcome takes the screen: the panel closes itself.
    const director = this.findOpenDirector();
    if (director) {
      const parked =
        director.hasComponent(GamePaused) || director.hasComponent(GameOver);
      if (parked) this.closePanel();
    }
    const immersive = this.immersive();
    if (this.factorsEnvironment !== immersive) this.applyPanelScale();
    if (!this.panel?.visible) return;
    const open = this.findOpenDirector();
    if (open) this.refreshRows(open);
  }
}
