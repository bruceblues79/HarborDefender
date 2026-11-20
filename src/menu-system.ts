/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  createSystem,
  Object3D,
  RayInteractable,
  UIKitMLAsset,
  VisibilityState,
  loadUIKitMLAsset,
} from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';
import {
  CameraBlocker,
  GameOver,
  GamePaused,
  GameStarted,
  LevelDirector,
} from './components.js';
import { StartPanelSystem } from './start-panel-system.js';
import { LevelWaveSystem } from './level-wave-system.js';
import { recycleCombatEffects, returnToWelcome } from './battle-setup.js';
import { WALL_LAND_FACE_Z } from './level-config.js';

/** Scale the call button shrinks to while the menu is open (hidden, not removed). */
const CALL_HIDDEN_SCALE = 0.001;
/** Call button half-height at rig-local scale 1, metres; the menu top pins here. */
const CALL_BUTTON_RADIUS = 0.11;
/** Call button's visible scale relative to the rig (user-tuned +1/2 bigger). */
const CALL_VISIBLE_SCALE = 1.5;
/**
 * Uniform shrink of the whole menu rig (button + menu): the shared baseline
 * both environments start from. Cumulative user tuning: 1/3 then 1/4
 * smaller — 1 × 2/3 × 3/4 = 1/2 of original size.
 */
const MENU_SCALE = 1 / 2;
/**
 * Per-environment button factors on top of the baseline (user tuning v0.1.122
 * + v0.1.124): XR shrinks the call button 1/3 then grows it 1/4 —
 * 1 × 2/3 × 5/4 = 5/6 — and flat mode grows it 1/3. The opened panel now
 * shares one size in both environments: the wall anchor replaces the
 * head-relative/flat stand-off difference that the old ×3 flat factor served.
 */
const MENU_PANEL_SCALE = 1.2;
const MENU_FACTORS_XR = { call: 5 / 6, menu: MENU_PANEL_SCALE };
const MENU_FACTORS_FLAT = { call: 4 / 3, menu: MENU_PANEL_SCALE };
/** Pause-menu height, metres (150 × 100 UIKit units at scale 1). */
const MENU_HEIGHT = 1.0;
/** Seconds for the expand / collapse animation. */
const MENU_ANIM_TIME = 0.25;
/**
 * Fixed world anchor on the wall's land face: wall max z + 6 cm (keeps the
 * glass layers clear of the stone), centred across x, vertically at the
 * wall body's centre with a slight upward bias (body spans y 0.30–0.80,
 * centre 0.55). No head-follow and no billboard — the rig faces +Z, the same
 * way the land face does, and both flat and XR view it front-on.
 */
const MENU_ANCHOR = { x: 0, y: 0.6, z: WALL_LAND_FACE_Z + 0.06 };
/**
 * Rig-local gap between the anchor (button centre) and the panel's bottom
 * edge: clears the largest button (flat, radius 0.22 rig-local) plus 0.2.
 */
const MENU_PANEL_BOTTOM = 0.42;

type MenuMode = 'closed' | 'opening' | 'open' | 'closing';

/**
 * Pause-menu orchestrator. Owns two runtime panels that load once and live
 * under one rig anchored to the harbour wall's land face:
 *
 * - Call button: a small circular hamburger that appears once the START gate
 *   opens (GameStarted) and hides while the menu is open.
 * - Pause menu: 1.5 m × 1 m at rig scale 1 (rig runs a uniform ×1/2 shrink;
 *   the opened panel then reads 0.9 × 0.6 m in both environments), expanding
 *   upward from the call button with three column buttons — MAIN (back to
 *   welcome), RESTART (rerun the level), RESUME (unpause).
 *
 * Placement is one fixed world anchor on the wall's max-z face: centred
 * across x, just above the wall top. The rig faces +Z exactly like the land
 * face, so there is no head-follow, no follower easing and no billboard;
 * flat and XR both view it front-on. Pausing hides what would otherwise
 * overlap the wall-top health bars, so overhanging the wall top is fine.
 *
 * Pausing is the `GamePaused` tag on the director entity: every simulation
 * system early-returns while it is present (added on open, removed on MAIN /
 * RESTART / RESUME). UI and camera systems ignore the tag, so the menu keeps
 * animating and stays interactive — pausing never blocks input.
 */
export class MenuSystem extends createSystem({
  directors: { required: [LevelDirector] },
  /** Fires qualify/dismiss exactly when GameStarted is added/removed. */
  started: { required: [LevelDirector, GameStarted] },
  /** Fires qualify/dismiss exactly when GameOver is added/removed. */
  over: { required: [LevelDirector, GameOver] },
}) {
  private mode: MenuMode = 'closed';
  private pendingCommand: 'main' | 'restart' | null = null;
  private animProgress = 0;
  /** Environment the panel scales were last applied for; a flip re-applies. */
  private factorsEnvironment: boolean | null = null;
  private panelRig: Object3D | null = null;
  private menuPanel: UIKitMLAsset | null = null;
  private callButton: UIKitMLAsset | null = null;
  private panelEntity: Entity | null = null;

  init(): void {
    // The call button and menu track GameStarted on the director entity.
    this.queries.started.subscribe('qualify', () => this.onGameStart());
    this.queries.started.subscribe('disqualify', () => this.onGameEnd());
    // An outcome hides the pause UI for good; a fresh RESTART (GameOver
    // dismissed while GameStarted is still on the director) brings it back.
    this.queries.over.subscribe('qualify', () => this.onOutcome());
    this.queries.over.subscribe('disqualify', (entity) =>
      this.onOutcomeDismissed(entity),
    );

    // Load both panels once; they stay in the world (invisible when closed),
    // parked on the wall anchor for the whole run.
    this.loadPanels();
  }

  private loadPanels(): void {
    Promise.all([
      loadUIKitMLAsset('menu-call'),
      loadUIKitMLAsset('pause-menu'),
    ])
      .then(([callButton, menuPanel]) => {
        this.callButton = callButton;
        this.menuPanel = menuPanel;

        // One rig holds both panels; it is parked on the wall anchor and
        // never moves or turns. Uniform baseline shrink; the per-environment
        // factors (menuFactors) ride on the panels' own rig-local scales, so
        // the upward expansion stays proportional (CALL_BUTTON_RADIUS /
        // MENU_HEIGHT are rig-local).
        const rig = new Object3D();
        rig.name = 'MenuRig';
        rig.position.set(MENU_ANCHOR.x, MENU_ANCHOR.y, MENU_ANCHOR.z);
        rig.scale.setScalar(MENU_SCALE);
        rig.add(callButton);
        rig.add(menuPanel);
        rig.visible = false;
        this.panelRig = rig;

        this.panelEntity = this.world.createTransformEntity(rig);
        // One interactable covering both child panels: InputSystem ray-tests
        // the rig and its descendants, routing clicks into the UIKitML
        // documents (same pattern as the scene-authored welcome panel).
        this.panelEntity.addComponent(RayInteractable);
        // Presses anywhere on the rig (call button, menu panel, gaps) belong
        // to the menu — the flat camera rig must never orbit them. The ECS
        // tag rides Hovered/Pressed, so it also holds for touch where the
        // per-element addUiBlocker path's pointerId match fails.
        this.panelEntity.addComponent(CameraBlocker);

        // Panels load while the welcome screen is still up; park them closed
        // until the START gate opens.
        menuPanel.visible = false;
        this.setPanelScales(this.menuFactors().call, CALL_HIDDEN_SCALE);

        this.wireMenuButtons();
        if (this.queries.started.entities.size > 0) this.onGameStart();
      })
      .catch((err: unknown) => {
        console.error('Failed to load menu panels:', err);
      });
  }

  private wireMenuButtons(): void {
    const callButton = this.callButton?.getElementById('menu-call-button');
    const menuMain = this.menuPanel?.getElementById('menu-main-button');
    const menuRestart = this.menuPanel?.getElementById('menu-restart-button');
    const menuResume = this.menuPanel?.getElementById('menu-resume-button');

    const bind = (
      element: Object3D | null | undefined,
      fn: () => void,
    ): void => {
      if (!element) return;
      element.addEventListener('click', fn);
      this.cleanupFuncs.push(() => element.removeEventListener('click', fn));
    };

    bind(callButton, () => this.openMenu());
    bind(menuMain, () => {
      this.pendingCommand = 'main';
      this.closeMenu();
    });
    bind(menuRestart, () => {
      this.pendingCommand = 'restart';
      this.closeMenu();
    });
    bind(menuResume, () => this.closeMenu());
  }

  /** START gate opened: reveal the rig with only the call button visible. */
  private onGameStart(): void {
    if (!this.panelRig) return;
    this.panelRig.visible = true;
    this.setPanelScales(this.menuFactors().call, CALL_HIDDEN_SCALE);
    this.mode = 'closed';
  }

  /** Game left (MAIN hand-off): drop pause, hide everything, reset mode. */
  private onGameEnd(): void {
    this.setPaused(false);
    this.mode = 'closed';
    this.pendingCommand = null;
    if (!this.panelRig) return;
    this.panelRig.visible = false;
    if (this.menuPanel) this.menuPanel.visible = false;
    this.setPanelScales(this.menuFactors().call, CALL_HIDDEN_SCALE);
  }

  /**
   * Run ended (victory / defeat): park the pause UI entirely — the result
   * panel takes over, so the call button must not invite a pause on top of
   * it. The simulation cannot be mid-pause here (pausing halts it), but the
   * tag is dropped defensively anyway.
   */
  private onOutcome(): void {
    this.setPaused(false);
    this.mode = 'closed';
    this.pendingCommand = null;
    if (!this.panelRig) return;
    this.panelRig.visible = false;
    if (this.menuPanel) this.menuPanel.visible = false;
    this.setPanelScales(this.menuFactors().call, CALL_HIDDEN_SCALE);
  }

  /**
   * GameOver dismissed: a RESTART keeps GameStarted on the director, so the
   * call-button state comes back; a MAIN hand-off has already dropped
   * GameStarted and its own dismissal hides everything — do nothing there.
   */
  private onOutcomeDismissed(director: Entity): void {
    if (!director.hasComponent(GameStarted)) return;
    this.mode = 'closed';
    if (!this.panelRig) return;
    this.panelRig.visible = true;
    this.setPanelScales(this.menuFactors().call, CALL_HIDDEN_SCALE);
  }

  private openMenu(): void {
    if (this.mode !== 'closed') return;
    this.mode = 'opening';
    this.setPaused(true);
    this.menuPanel!.visible = true;
    this.applyMenuScale(0);
  }

  private closeMenu(): void {
    if (this.mode !== 'open') return;
    this.mode = 'closing';
    // Unpause immediately: RESUME resumes play behind the shrink animation,
    // and MAIN / RESTART run their resets there too — the simulation is
    // never held behind UI teardown.
    this.setPaused(false);
  }

  private setPaused(paused: boolean): void {
    for (const director of this.queries.directors.entities) {
      if (paused) director.addComponent(GamePaused);
      else director.removeComponent(GamePaused);
    }
  }

  update(delta: number): void {
    if (!this.panelRig?.visible) return;
    this.updateEnvironmentFactors();
    if (this.mode === 'opening') {
      this.animProgress = Math.min(1, this.animProgress + delta / MENU_ANIM_TIME);
      if (this.animProgress >= 1) {
        this.mode = 'open';
        this.setPanelScales(CALL_HIDDEN_SCALE, this.menuFactors().menu);
      }
      this.applyMenuScale(this.animProgress);
    } else if (this.mode === 'closing') {
      this.animProgress = Math.max(0, this.animProgress - delta / MENU_ANIM_TIME);
      this.applyMenuScale(this.animProgress);
      if (this.animProgress <= 0) {
        this.menuPanel!.visible = false;
        this.setPanelScales(this.menuFactors().call, CALL_HIDDEN_SCALE);
        const command = this.pendingCommand;
        this.pendingCommand = null;
        this.mode = 'closed';
        if (command === 'main') this.runMain();
        else if (command === 'restart') this.runRestart();
      }
    }
  }

  /**
   * Expand / collapse animation. t = 0 fully closed, t = 1 fully open. The
   * menu grows upward from the call button: its scale goes 0.001 -> 1 while
   * its centre slides from the button's top edge up to the open position, so
   * the menu's bottom edge stays pinned above the button. The call button
   * shrinks away as the menu takes over. EaseOutCubic.
   */
  private applyMenuScale(t: number): void {
    const eased = 1 - (1 - t) ** 3;
    const factors = this.menuFactors();
    if (this.menuPanel) {
      // The menu grows upward from the call button: its bottom edge stays
      // pinned above the button while its centre slides up by its own
      // (factor-scaled) half height.
      this.menuPanel.scale.setScalar(
        Math.max(CALL_HIDDEN_SCALE, eased * factors.menu),
      );
      this.menuPanel.position.y =
        MENU_PANEL_BOTTOM + (MENU_HEIGHT / 2) * eased * factors.menu;
    }
    if (this.callButton) {
      this.callButton.scale.setScalar(
        Math.max(CALL_HIDDEN_SCALE, factors.call * (1 - eased)),
      );
    }
  }

  /** Per-environment button/menu scale factors over the shared baseline. */
  private menuFactors(): { call: number; menu: number } {
    const immersive =
      this.world.visibilityState.peek() !== VisibilityState.NonImmersive;
    return immersive ? MENU_FACTORS_XR : MENU_FACTORS_FLAT;
  }

  /**
   * React to an environment flip mid-game (XR <-> flat): the discrete
   * moments that read menuFactors() (game start, menu open/close) already
   * pick up the new factors, but a static closed button or an open menu
   * would otherwise keep the old environment's size until touched again.
   * Animating states self-correct — applyMenuScale re-reads every frame.
   */
  private updateEnvironmentFactors(): void {
    const immersive =
      this.world.visibilityState.peek() !== VisibilityState.NonImmersive;
    if (this.factorsEnvironment === immersive) return;
    this.factorsEnvironment = immersive;
    if (this.mode === 'open') {
      this.setPanelScales(CALL_HIDDEN_SCALE, this.menuFactors().menu);
    } else if (this.mode === 'closed') {
      this.setPanelScales(this.menuFactors().call, CALL_HIDDEN_SCALE);
    }
  }

  private setPanelScales(callScale: number, menuScale: number): void {
    if (this.callButton) this.callButton.scale.setScalar(callScale);
    if (this.menuPanel) {
      this.menuPanel.scale.setScalar(menuScale);
      this.menuPanel.position.y =
        MENU_PANEL_BOTTOM + (MENU_HEIGHT / 2) * menuScale;
    }
  }

  /**
   * MAIN: reset the director to the welcome gate and swap back the welcome
   * UI. Public: the result panel's MAIN button runs the same hand-off.
   */
  runMain(): void {
    recycleCombatEffects(this.world);
    this.findByClass(LevelWaveSystem)?.resetToWelcome();
    this.findByClass(StartPanelSystem)?.reset();
    returnToWelcome(this.world);
  }

  /**
   * RESTART: clear the field, re-crew the battery to the level's initial
   * layout, rerun the current level. Public: the result panel's RESTART
   * button runs the same reset. (restoreCannons / resetCannonAim ride
   * inside restartLevel's syncBatteryToLevel — no separate pass here.)
   */
  runRestart(): void {
    recycleCombatEffects(this.world);
    this.findByClass(LevelWaveSystem)?.restartLevel();
  }

  private findByClass<T>(type: new (...args: never[]) => T): T | undefined {
    const found = this.world
      .getSystems()
      .find((system) => system instanceof type);
    return found as T | undefined;
  }
}
