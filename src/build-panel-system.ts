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
  AmmoSelected,
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
  AMMO_DEFS,
  DEFENSE_SLOTS,
  ECONOMY,
  PLACEABLE_UNITS,
  WALL_CENTER_Z,
} from './level-config.js';
import type { DefenseUnitId } from './level-config.js';
import { getDefenseSlotInfo, replaceDefenseUnit } from './battle-setup.js';

/** Minimal shape of a uikit element's runtime class list (class layer). */
type UiElement = Object3D & {
  classList: {
    add(...classes: string[]): unknown;
    remove(...classes: string[]): unknown;
  };
};

/**
 * Fixed world anchor of the dock: x follows the opened slot
 * (DEFENSE_SLOTS[slot].x) and the height sits near the cannon health bar
 * (bar top ≈ 1.34 world) — the dock hangs just over the unit's bar instead
 * of floating clear of every defender. z runs a hair land-side (+z) of the
 * wall centre line so the billboarded glass layers in front of the bar
 * plane rather than slicing it. The Billboard(lockY) component on the dock
 * entity yaws it toward the viewer.
 */
const BAR_ANCHOR = { y: 1.4, z: WALL_CENTER_Z + 0.1 };
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
 * the billboarded dock over that slot: one circular purchase button per
 * placeable unit, always at the full book value — there is no trade-in,
 * and a slot's live occupant simply hides its own button. A button whose
 * price exceeds the wallet renders dimmed; the top-row badge beside the
 * close button shows the live gold. Picking a button mounts the unit into
 * the empty slot via replaceDefenseUnit, deducts from the wallet and
 * closes; the round close button above the bar dismisses without spending.
 * While the tag sits on the director the open slot's build icon renders
 * shrunk (DefenseButtonSystem's half of the contract); pressing another
 * slot's button moves the dock there, pressing the open slot's own button
 * closes it. The bar's second button is the ammo row: a global single
 * select (AmmoSelected on the director, one row per AMMO_DEFS entry) that
 * retargets every cannon's next shot — picking the already-selected round
 * is a no-op, and with v1's single free iron ball it always is.
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
  /** Last badge string written; skips redundant Text writes while gold sits still. */
  private lastWalletText: string | null = null;
  /** Unit buttons keyed by unit — driven through the three-state class below. */
  private readonly rows = new Map<DefenseUnitId, UiElement | null>();
  /** Class currently applied per unit button; guards redundant class swaps. */
  private readonly unitClasses = new Map<DefenseUnitId, string>();
  /** Ammo buttons keyed by ammo id — the global single-select row(s). */
  private readonly ammoRows = new Map<string, UiElement | null>();
  /** Class currently applied per ammo button; guards redundant class swaps. */
  private readonly ammoClasses = new Map<string, string>();

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
        for (const def of AMMO_DEFS) {
          const row = panel.getElementById(
            `ammo-${def.id}`,
          ) as UiElement | null;
          if (row) {
            row.addEventListener('click', () => this.onAmmoPicked(def.id));
            this.cleanupFuncs.push(() =>
              row.removeEventListener('click', () => this.onAmmoPicked(def.id)),
            );
            this.ammoRows.set(def.id, row);
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

        // The tag may have been raised while the asset was still loading:
        // catch up immediately.
        this.applyVisibility();
        this.applyPanelScale();
        this.refreshAmmoRows();
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
   * Price for unitId: always the full book value — there is no trade-in;
   * an occupied slot's own button is simply hidden instead.
   */
  private priceFor(unitId: DefenseUnitId): number {
    return ECONOMY.unitValues[unitId] ?? 0;
  }

  /**
   * Drive every button's three-state class from live state: the unit
   * occupying the open slot hides its own button, a price above the current
   * wallet dims the button, the rest stay in the default style. The top-row
   * badge mirrors the wallet, so gold spent or earned elsewhere shows live
   * while the dock is open.
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
      // The gold only moves on repair drain, a purchase, a sale or a level
      // reset; between those moments rewriting the same string every frame
      // would needlessly dirty the Text component, so guard on the value.
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
      if (unitId === occupant) {
        next = 'dock-unit-hidden';
      } else if (price > money) {
        next = 'dock-unit-off';
      } else {
        next = 'dock-unit';
      }
      this.setUnitClass(unitId, row, next);
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
    // Valid slot index only — an empty (never mounted or knocked clean)
    // slot is the only build target.
    if (!DEFENSE_SLOTS[slot]) return;
    // A live occupant's own button is already hidden; refuse anyway so a
    // stale click can never buy into an occupied slot.
    const info = getDefenseSlotInfo(slot);
    if (info && !info.entity.hasComponent(Destroyed)) return;
    const price = this.priceFor(unitId);
    const money = director.getValue(Wallet, 'money') as number;
    if (money < price) return;

    director.setValue(Wallet, 'money', money - price);
    const next = replaceDefenseUnit(this.world, slot, unitId);
    if (next.object3D) next.object3D.visible = true;
    this.closePanel();
  }

  /**
   * Ammo row picked: retargets every cannon's next shot globally (one
   * truth on the director, not per slot). Picking the already-selected
   * round is a no-op — v1's single free iron ball always is.
   */
  private onAmmoPicked(ammoId: string): void {
    const director = this.findOpenDirector();
    if (!director || !director.hasComponent(AmmoSelected)) return;
    if (String(director.getValue(AmmoSelected, 'ammoId')) === ammoId) return;
    director.setValue(AmmoSelected, 'ammoId', ammoId);
    this.refreshAmmoRows();
  }

  /**
   * Gold face = the selected round, every other row falls back to the base
   * circle. Global state: refreshed on load and on pick, never per slot —
   * the class swap is the only reliable toggle (same layer rule as units).
   */
  private refreshAmmoRows(): void {
    const director = this.findOpenDirector();
    if (!director) return;
    const selected = String(director.getValue(AmmoSelected, 'ammoId'));
    for (const [ammoId, row] of this.ammoRows) {
      if (!row) continue;
      const next = ammoId === selected ? 'ammo-active' : 'ammo-unit';
      if (this.ammoClasses.get(ammoId) === next) continue;
      row.classList.remove('ammo-unit', 'ammo-active');
      row.classList.add(next);
      this.ammoClasses.set(ammoId, next);
    }
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
