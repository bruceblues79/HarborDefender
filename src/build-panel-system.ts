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
import { ECONOMY, PLACEABLE_UNITS } from './level-config.js';
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
 * Fixed world anchor over the wall top — the wall already carries height
 * (units sit at y 0.8), so the panel floats just above it with a slight +Z
 * lean off the land face, between the wall and the viewer; billboarded, so
 * the orbit camera (flat) and a player standing at the battlement (XR) both
 * read it face-on.
 */
const PANEL_ANCHOR = { x: 0, y: 1.75, z: -0.4 };
/**
 * Per-environment scale over the panel's authored 0.75 × 1 m: XR runs the
 * authored size exactly, flat mode grows it 1.5x for readability across the
 * orbit camera's ~5 m stand-off (same pattern as the pause menu factors).
 */
const PANEL_FACTORS = { xr: 1, flat: 1.5 };

/**
 * The shared build panel — the only writer of the BuildOpen lifecycle.
 *
 * A BuildOpen tag on the director (added by a build-button press) reveals
 * the billboarded panel; its rows list the placeable units with live prices
 * — full price into a destroyed (empty) slot, the in-place trade-in price
 * (full minus the occupant's value × ECONOMY.replaceDiscount) while it is
 * alive. The occupant's own row stays hidden: the panel only lists units
 * that can actually be placed into this slot. Picking a row swaps the
 * slot's occupant via replaceDefenseUnit, deducts from the wallet and
 * closes; dismiss closes without spending. While the tag sits on the
 * director the build buttons render grayed and refuse presses
 * (DefenseButtonSystem's half of the contract).
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
  private readonly prices = new Map<DefenseUnitId, Text | null>();
  /** Slot list rows keyed by unit — hidden while that unit occupies the open slot. */
  private readonly rows = new Map<DefenseUnitId, UiElement | null>();
  /** Units whose row is currently class-hidden; guards redundant class swaps. */
  private readonly hiddenRows = new Set<DefenseUnitId>();
  private walletText: Text | null = null;

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
        panel.position.set(PANEL_ANCHOR.x, PANEL_ANCHOR.y, PANEL_ANCHOR.z);
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
          this.prices.set(
            unitId,
            this.resolveText(panel.getElementById(`price-${unitId}`)),
          );
          const row = panel.getElementById(`row-${unitId}`) as UiElement | null;
          if (row) {
            row.addEventListener('click', () => this.onRowPicked(unitId));
            this.cleanupFuncs.push(() =>
              row.removeEventListener('click', () => this.onRowPicked(unitId)),
            );
            this.rows.set(unitId, row);
          }
        }
        this.walletText = this.resolveText(
          panel.getElementById('wallet-value'),
        );
        const dismiss = panel.getElementById('build-dismiss');
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
   * Trade-in price for unitId into the slot the panel was opened for: the
   * occupant's destroyed slot pays full price; a live occupant credits
   * value × replaceDiscount (same-value swap = half price).
   */
  private priceFor(director: Entity, unitId: DefenseUnitId): number {
    const slot = Number(director.getValue(BuildOpen, 'slot'));
    const info = getDefenseSlotInfo(slot);
    const full = ECONOMY.unitPrices[unitId] ?? 0;
    if (!info || info.entity.hasComponent(Destroyed)) return full;
    const credit =
      (ECONOMY.unitPrices[info.unit] ?? 0) * ECONOMY.replaceDiscount;
    return Math.max(0, full - credit);
  }

  /**
   * Rewrite every row's price and the wallet readout from live state, and
   * hide the row of the unit currently occupying the open slot — the panel
   * lists only units you could actually place there.
   */
  private refreshRows(director: Entity): void {
    const slot = Number(director.getValue(BuildOpen, 'slot'));
    const info = getDefenseSlotInfo(slot);
    const occupant =
      info && !info.entity.hasComponent(Destroyed) ? info.unit : null;
    for (const unitId of PLACEABLE_UNITS) {
      const row = this.rows.get(unitId);
      if (row) this.setRowHidden(unitId, row, unitId === occupant);
      this.prices
        .get(unitId)
        ?.setProperties({ text: String(this.priceFor(director, unitId)) });
    }
    if (this.walletText && director.hasComponent(Wallet)) {
      this.walletText.setProperties({
        text: `gold ${Math.floor(director.getValue(Wallet, 'money') as number)}`,
      });
    }
  }

  /**
   * Show/hide a row through its class list: runtime setProperties display
   * writes the base property layer, which the markup's .build-row class
   * layer outranks — only a class swap reliably toggles visibility.
   */
  private setRowHidden(
    unitId: DefenseUnitId,
    row: UiElement,
    hidden: boolean,
  ): void {
    if (hidden === this.hiddenRows.has(unitId)) return;
    if (hidden) {
      row.classList.remove('build-row');
      row.classList.add('build-row-hidden');
      this.hiddenRows.add(unitId);
    } else {
      row.classList.remove('build-row-hidden');
      row.classList.add('build-row');
      this.hiddenRows.delete(unitId);
    }
  }

  /** BuildOpen mounted: reveal the panel and price the rows for that slot. */
  private openPanel(director: Entity): void {
    if (!this.panel) {
      // The panel asset has not finished loading yet; drop the command —
      // the player simply clicks the build button again.
      director.removeComponent(BuildOpen);
      return;
    }
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
