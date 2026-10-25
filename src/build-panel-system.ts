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
  WALL_CENTER_Z,
} from './level-config.js';
import type { DefenseUnitId } from './level-config.js';
import { getDefenseSlotInfo, removeDefenseUnit, replaceDefenseUnit } from './battle-setup.js';

/** Minimal shape of a uikit element's runtime class list (class layer). */
type UiElement = Object3D & {
  classList: {
    add(...classes: string[]): unknown;
    remove(...classes: string[]): unknown;
  };
};

/**
 * Fixed world anchor of the dock: x follows the opened slot
 * (DEFENSE_SLOTS[slot].x) and z sits exactly on the wall centre line — the
 * same xz the mounted units stand at (battle-setup) — so the bar hangs
 * straight over the unit it builds for. The height clears every defender
 * health bar (bbox top + margin, worst case ≈ 1.64 with units standing 0.04
 * higher on the pedestal pads) with room to spare; the Billboard(lockY)
 * component on the dock entity yaws it toward the viewer.
 */
const BAR_ANCHOR = { y: 1.85, z: WALL_CENTER_Z };
/**
 * Per-environment scale over the dock's authored 0.33 × 0.205 m: XR runs
 * the authored size exactly, flat mode grows it 1.8x for readability across
 * the orbit camera's ~5 m stand-off (same pattern as the pause menu factors).
 */
const PANEL_FACTORS = { xr: 1, flat: 1.8 };

/**
 * The shared build dock — the only writer of the BuildOpen lifecycle.
 *
 * A BuildOpen tag on the director (added by a build-button press) reveals
 * the billboarded dock over that slot: one circular button per placeable
 * unit with the live price overlaid — full book value into a destroyed
 * (empty) slot, the in-place trade-in price (value minus the occupant's
 * book value × ECONOMY.replaceDiscount) while it is alive. The occupant's
 * own button stays hidden, and a button whose price exceeds the wallet
 * renders dimmed; the top-row badge beside the close button shows the live
 * gold. Picking a button swaps the slot's occupant via replaceDefenseUnit,
 * deducts from the wallet and closes; the round close button above the bar
 * dismisses without spending. While the tag sits on the director the build
 * buttons render grayed and refuse presses (DefenseButtonSystem's half of
 * the contract).
 *
 * The recycle button below the bar sells the opening slot's live occupant
 * for its depreciated book value (book value × ECONOMY.replaceDiscount —
 * the same 30% the trade-in credit uses, so replace ≡ recycle + rebuild):
 * the gold is credited instantly and the unit is stripped via
 * removeDefenseUnit, which drops its combat components so enemy targeting
 * naturally re-selects another defender. The panel stays open after a sale
 * so the player can immediately rebuild at full price; the button renders
 * dimmed while the slot has no live occupant and refuses presses.
 */
export class BuildPanelSystem extends createSystem({
  directors: { required: [LevelDirector] },
  /**
   * The open state needs its own query: BuildOpen mounts onto a director
   * that has long since qualified the plain directors query, and adding a
   * component to an already-qualifying entity does NOT re-fire 'qualify'
   * there. This query qualifies exactly when BuildOpen mounts (panel opens)
   * and disqualifies when it is removed (panel closes).
   */
  openDirectors: { required: [LevelDirector, BuildOpen] },
}) {
  private panel: UIKitMLAsset | null = null;
  /** Environment the panel scale was last applied for; a flip re-applies. */
  private factorsEnvironment: boolean | null = null;
  /** Live gold readout in the top-row badge, next to the close button. */
  private walletText: Text | null = null;
  /** Unit buttons keyed by unit — driven through the three-state class below. */
  private readonly rows = new Map<DefenseUnitId, UiElement | null>();
  /** Class currently applied per unit button; guards redundant class swaps. */
  private readonly unitClasses = new Map<DefenseUnitId, string>();
  /** The recycle button below the bar: sells the slot's live occupant. */
  private recycleRow: UiElement | null = null;
  /** Class currently applied to the recycle button; guards redundant swaps. */
  private recycleClass: string | null = null;

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
        // The whole panel surface blocks the camera rig: rows, the scroll
        // list, the header, the gaps between them — a drag anywhere on the
        // glass must never orbit the flat camera. The ECS tag rides the
        // same Hovered/Pressed route the cannon aim drags use, so it also
        // holds for touch where synthetic pointerIds never match native
        // ones (the per-element addUiBlocker path fails there).
        panelEntity.addComponent(CameraBlocker);

        for (const unitId of PLACEABLE_UNITS) {
          const row = panel.getElementById(`row-${unitId}`) as UiElement | null;
          if (row) {
            row.addEventListener('click', () => this.onRowPicked(unitId));
            this.cleanupFuncs.push(() =>
              row.removeEventListener('click', () => this.onRowPicked(unitId)),
            );
            this.rows.set(unitId, row);
          }
        }
        const dismiss = panel.getElementById('build-dismiss');
        this.walletText = this.resolveText(
          panel.getElementById('wallet-value'),
        );
        if (dismiss) {
          dismiss.addEventListener('click', () => this.closePanel());
          this.cleanupFuncs.push(() =>
            dismiss.removeEventListener('click', () => this.closePanel()),
          );
        }
        const recycle = panel.getElementById(
          'dock-recycle',
        ) as UiElement | null;
        if (recycle) {
          recycle.addEventListener('click', () => this.onRecycle());
          this.cleanupFuncs.push(() =>
            recycle.removeEventListener('click', () => this.onRecycle()),
          );
          this.recycleRow = recycle;
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
   * UIKitML has no <text> element: static markup text children become Text
   * components under their container. A dynamic readout is therefore a
   * container with an id wrapping one text child — this finds that child so
   * its `text` property can be rewritten.
   */
  private resolveText(container: Object3D | null): Text | null {
    if (!container) return null;
    const child = container.children.find(
      (candidate) =>
        typeof (candidate as Text).properties?.value?.text === 'string',
    );
    return (child as Text | undefined) ?? null;
  }

  /** The director currently holding BuildOpen, if any. */
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

  /**
   * Price for unitId into the slot the panel was opened for: an empty or
   * destroyed slot pays the book value in full (200); a live occupant turns
   * the swap into a value difference — the new unit's book value minus the
   * old unit's depreciated value (200 − 200×0.3 = 140, either direction).
   */
  private priceFor(director: Entity, unitId: DefenseUnitId): number {
    const slot = Number(director.getValue(BuildOpen, 'slot'));
    const info = getDefenseSlotInfo(slot);
    const price = ECONOMY.unitValues[unitId] ?? 0;
    if (!info || info.entity.hasComponent(Destroyed)) return price;
    const credit =
      (ECONOMY.unitValues[info.unit] ?? 0) * ECONOMY.replaceDiscount;
    return Math.max(0, price - credit);
  }

  /**
   * Drive every button's three-state class from live state: the unit
   * occupying the open slot hides its own button, a price above the current
   * wallet dims the button, the rest stay in the default style. The top-row
   * badge mirrors the wallet, so gold spent or earned elsewhere shows live
   * while the dock is open. The recycle button below mirrors the slot's
   * occupancy: live occupant → active, empty or destroyed slot → dimmed.
   */
  private refreshRows(director: Entity): void {
    const slot = Number(director.getValue(BuildOpen, 'slot'));
    const info = getDefenseSlotInfo(slot);
    const occupant =
      info && !info.entity.hasComponent(Destroyed) ? info.unit : null;
    const money = director.hasComponent(Wallet)
      ? (director.getValue(Wallet, 'money') as number)
      : Number.POSITIVE_INFINITY;
    if (this.walletText && director.hasComponent(Wallet)) {
      this.walletText.setProperties({ text: `${Math.floor(money)}g` });
    }
    for (const unitId of PLACEABLE_UNITS) {
      const row = this.rows.get(unitId);
      if (!row) continue;
      const price = this.priceFor(director, unitId);
      let next: string;
      if (unitId === occupant) {
        next = 'dock-unit-hidden';
      } else if (price > money) {
        next = 'dock-unit-off';
      } else {
        next = 'dock-unit';
      }
      this.setUnitClass(unitId, row, next);
    }
    if (this.recycleRow) {
      this.setRecycleClass(
        this.recycleRow,
        occupant ? 'dock-recycle' : 'dock-recycle-off',
      );
    }
  }

  /**
   * Show/hide/dim a unit button through its class list: runtime setProperties
   * display writes the base property layer, which the markup's .dock-unit
   * class layer outranks — only a class swap reliably toggles the state.
   */
  private setUnitClass(
    unitId: DefenseUnitId,
    row: UiElement,
    next: string,
  ): void {
    if (this.unitClasses.get(unitId) === next) return;
    for (const candidate of ['dock-unit', 'dock-unit-off', 'dock-unit-hidden']) {
      row.classList.remove(candidate);
    }
    row.classList.add(next);
    this.unitClasses.set(unitId, next);
  }

  /**
   * Show/dim the recycle button through its class list — same base-vs-class
   * layer rule as setUnitClass, with only the two occupancy states.
   */
  private setRecycleClass(row: UiElement, next: string): void {
    if (this.recycleClass === next) return;
    row.classList.remove('dock-recycle');
    row.classList.remove('dock-recycle-off');
    row.classList.add(next);
    this.recycleClass = next;
  }

  /**
   * BuildOpen mounted: move the dock over that slot (x follows the slot, y/z
   * constant), reveal it and price the buttons.
   */
  private openPanel(director: Entity): void {
    if (!this.panel) {
      // The panel asset has not finished loading yet; drop the command —
      // the player simply clicks the build button again.
      director.removeComponent(BuildOpen);
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
    this.findOpenDirector()?.removeComponent(BuildOpen);
    this.applyVisibility();
  }

  private onRowPicked(unitId: DefenseUnitId): void {
    const director = this.findOpenDirector();
    if (!director || !director.hasComponent(Wallet)) return;
    const slot = Number(director.getValue(BuildOpen, 'slot'));
    if (!getDefenseSlotInfo(slot)) return;
    const price = this.priceFor(director, unitId);
    const money = director.getValue(Wallet, 'money') as number;
    if (money < price) return;

    director.setValue(Wallet, 'money', money - price);
    const next = replaceDefenseUnit(this.world, slot, unitId);
    if (next.object3D) next.object3D.visible = true;
    this.closePanel();
  }

  /**
   * Sell the opening slot's live occupant: credit the depreciated book
   * value instantly, strip the unit structurally and refresh in place —
   * the dock stays open so the player can immediately rebuild at full
   * price. Empty or destroyed slots refuse, matching the dimmed state.
   * Pausing or an outcome closes the dock in update(), so neither can
   * interleave a sale.
   */
  private onRecycle(): void {
    const director = this.findOpenDirector();
    if (!director || !director.hasComponent(Wallet)) return;
    const slot = Number(director.getValue(BuildOpen, 'slot'));
    const info = getDefenseSlotInfo(slot);
    if (!info || info.entity.hasComponent(Destroyed)) return;
    const refund = Math.floor(
      (ECONOMY.unitValues[info.unit] ?? 0) * ECONOMY.replaceDiscount,
    );
    const money = director.getValue(Wallet, 'money') as number;
    director.setValue(Wallet, 'money', money + refund);
    removeDefenseUnit(this.world, slot);
    this.refreshRows(director);
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
