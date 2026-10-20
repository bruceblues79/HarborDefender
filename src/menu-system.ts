/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  createSystem,
  FollowBehavior,
  Follower,
  Object3D,
  Quaternion,
  RayInteractable,
  UIKitMLAsset,
  Vector3,
  VisibilityState,
  loadUIKitMLAsset,
} from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';
import {
  Billboard,
  GameOver,
  GamePaused,
  GameStarted,
  LevelDirector,
} from './components.js';
import { CameraOrbitSystem } from './camera-orbit-system.js';
import { StartPanelSystem } from './start-panel-system.js';
import { LevelWaveSystem } from './level-wave-system.js';
import {
  recycleCombatEffects,
  resetCannonAim,
  restoreCannons,
  returnToWelcome,
} from './battle-setup.js';

/** Scale the call button shrinks to while the menu is open (hidden, not removed). */
const CALL_HIDDEN_SCALE = 0.001;
/** Call button half-height at rig-local scale 1, metres; the menu top pins here. */
const CALL_BUTTON_RADIUS = 0.11;
/** Call button's visible scale relative to the rig (user-tuned +1/2 bigger). */
const CALL_VISIBLE_SCALE = 1.5;
/**
 * Uniform shrink of the whole menu rig (button + menu). Cumulative user
 * tuning: 1/3 then 1/4 smaller — 1 × 2/3 × 3/4 = 1/2 of original size.
 */
const MENU_SCALE = 1 / 2;
/** Pause-menu height, metres (150 × 100 UIKit units at scale 1). */
const MENU_HEIGHT = 1.0;
/** Seconds for the expand / collapse animation. */
const MENU_ANIM_TIME = 0.25;
/** XR: anchor distance ahead of the head along head yaw, metres. */
const MENU_XR_FORWARD = 2.5;
/**
 * XR: anchor lift above head centre, metres. Was 0.85 (flat view's ~19°
 * elevation), then shrunk to 2/3 with the menu sizes, then nudged up
 * 0.015 + 0.03. Tunable by feel.
 */
const MENU_XR_LIFT = 0.612;
/**
 * Flat mode: fixed world anchor over the water, ahead of the wall, high
 * enough that the default battle view projects it near the DOM ENTER-XR
 * button's screen spot (upper edge of the frame). The orbit camera moves on
 * every pitch change, so a camera-relative anchor made the menu bob
 * vertically; a world anchor + Billboard(lockY) keeps it perfectly still
 * while still facing the camera.
 */
const MENU_FLAT_ANCHOR = { x: 0, y: 3.495, z: -3.5 };

type MenuMode = 'closed' | 'opening' | 'open' | 'closing';

/**
 * Pause-menu orchestrator. Owns two runtime panels that load once and live
 * under one rig anchored to the player's head:
 *
 * - Call button: a small circular hamburger that appears once the START gate
 *   opens (GameStarted) and hides while the menu is open.
 * - Pause menu: 1.5 m × 1 m at rig scale 1 (rig runs a uniform ×1/2
 *   shrink), expanding downward from the call button with
 *   three column buttons — MAIN (back to welcome), RESTART (rerun the
 *   level), RESUME (unpause).
 *
 * Placement follows the spatial-UI guidance for compact global UI: a
 * world-space `Follower` holds the rig at a stable anchor — head-relative
 * in immersive XR (2.5 m ahead, lifted clearly above the gaze line), a fixed
 * world spot in flat desktop mode (the orbit camera moves with pitch,
 * so a camera-derived anchor would make the menu bob). The rig's own
 * Billboard(lockY) yaw keeps the panels faced toward the viewer in both
 * modes; the menu never head-locks.
 *
 * Pausing is the `GamePaused` tag on the director entity: every simulation
 * system early-returns while it is present (added on open, removed on MAIN /
 * RESTART / RESUME). UI, camera, billboard and follower systems ignore the
 * tag, so the menu keeps animating and stays interactive — pausing never
 * blocks input.
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
  private panelRig: Object3D | null = null;
  private menuPanel: UIKitMLAsset | null = null;
  private callButton: UIKitMLAsset | null = null;
  private panelEntity: Entity | null = null;
  /** Standalone follow target: MenuSystem repositions it, FollowSystem chases it. */
  private readonly anchorObject = new Object3D();
  private readonly headPos = new Vector3();
  private readonly headDir = new Vector3();
  private readonly headQuat = new Quaternion();

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
    // repositioned next to the player's head on every open.
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

        // One rig under the Follower so both panels move and face together.
        // Uniform 2/3 shrink: button, menu and the downward expansion all
        // stay proportional (CALL_BUTTON_RADIUS / MENU_HEIGHT are rig-local).
        const rig = new Object3D();
        rig.name = 'MenuRig';
        rig.scale.setScalar(MENU_SCALE);
        rig.add(callButton);
        rig.add(menuPanel);
        rig.visible = false;
        this.panelRig = rig;

        this.panelEntity = this.world.createTransformEntity(rig);
        // Native position follow: MenuSystem drives anchorObject each frame
        // (head-relative in XR, fixed world spot in flat mode); FollowSystem
        // eases the rig toward it with mild smoothing, so the panels float
        // in space instead of head-locking. Rotation is Billboard's job.
        this.panelEntity.addComponent(Follower, {
          target: this.anchorObject,
          behavior: FollowBehavior.NoRotation,
          offsetPosition: [0, 0, 0],
          tolerance: 0.02,
          maxAngle: 2,
          speed: 20,
        });
        this.panelEntity.addComponent(Billboard, { lockY: true });
        // One interactable covering both child panels: InputSystem ray-tests
        // the rig and its descendants, routing clicks into the UIKitML
        // documents (same pattern as the scene-authored welcome panel).
        this.panelEntity.addComponent(RayInteractable);

        // Panels load while the welcome screen is still up; park them closed
        // until the START gate opens.
        menuPanel.visible = false;
        this.setPanelScales(CALL_VISIBLE_SCALE, CALL_HIDDEN_SCALE);

        this.wireMenuButtons();
        if (this.queries.started.entities.size > 0) this.onGameStart();
      })
      .catch((err: unknown) => {
        console.error('Failed to load menu panels:', err);
      });
  }

  private wireMenuButtons(): void {
    const cameraSystem = this.world
      .getSystems()
      .find((system): system is CameraOrbitSystem =>
        system instanceof CameraOrbitSystem,
      );
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

    // Keep presses on the menu from reaching the flat camera rig.
    for (const element of [callButton, menuMain, menuRestart, menuResume]) {
      if (element) cameraSystem?.addUiBlocker(element);
    }
  }

  /** START gate opened: reveal the rig with only the call button visible. */
  private onGameStart(): void {
    if (!this.panelRig) return;
    this.panelRig.visible = true;
    this.setPanelScales(CALL_VISIBLE_SCALE, CALL_HIDDEN_SCALE);
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
    this.setPanelScales(CALL_VISIBLE_SCALE, CALL_HIDDEN_SCALE);
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
    this.setPanelScales(CALL_VISIBLE_SCALE, CALL_HIDDEN_SCALE);
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
    this.setPanelScales(CALL_VISIBLE_SCALE, CALL_HIDDEN_SCALE);
  }

  private openMenu(): void {
    if (this.mode !== 'closed') return;
    this.mode = 'opening';
    this.setPaused(true);
    this.updateAnchor();
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
    this.updateAnchor();
    if (this.mode === 'opening') {
      this.animProgress = Math.min(1, this.animProgress + delta / MENU_ANIM_TIME);
      if (this.animProgress >= 1) {
        this.mode = 'open';
        this.setPanelScales(CALL_HIDDEN_SCALE, 1);
      }
      this.applyMenuScale(this.animProgress);
    } else if (this.mode === 'closing') {
      this.animProgress = Math.max(0, this.animProgress - delta / MENU_ANIM_TIME);
      this.applyMenuScale(this.animProgress);
      if (this.animProgress <= 0) {
        this.menuPanel!.visible = false;
        this.setPanelScales(CALL_VISIBLE_SCALE, CALL_HIDDEN_SCALE);
        const command = this.pendingCommand;
        this.pendingCommand = null;
        this.mode = 'closed';
        if (command === 'main') this.runMain();
        else if (command === 'restart') this.runRestart();
      }
    }
  }

  /**
   * Drive the follow anchor. Immersive XR: the tracked head's pose — the
   * anchor sits `MENU_XR_FORWARD` ahead along head yaw (flattened, so pitch
   * never swings it into the ground) at `MENU_XR_LIFT` above head centre,
   * matching the flat view's elevation so the menu never reads as eye level.
   * Flat desktop mode: a fixed world anchor — the orbit
   * camera changes position on every pitch, so deriving the anchor from the
   * camera made the menu bob vertically; Billboard(lockY) alone keeps it
   * faced toward the camera there.
   */
  private updateAnchor(): void {
    const immersive =
      this.world.visibilityState.peek() !== VisibilityState.NonImmersive;
    if (!immersive) {
      this.anchorObject.position.set(
        MENU_FLAT_ANCHOR.x,
        MENU_FLAT_ANCHOR.y,
        MENU_FLAT_ANCHOR.z,
      );
      return;
    }
    const head = this.world.player.head;
    head.getWorldPosition(this.headPos);
    head.getWorldQuaternion(this.headQuat);
    this.headDir.set(0, 0, -1).applyQuaternion(this.headQuat);
    this.headDir.y = 0;
    if (this.headDir.lengthSq() < 0.0001) this.headDir.set(0, 0, -1);
    this.headDir.normalize();
    this.anchorObject.position
      .copy(this.headPos)
      .addScaledVector(this.headDir, MENU_XR_FORWARD);
    this.anchorObject.position.y = this.headPos.y + MENU_XR_LIFT;
  }

  /**
   * Expand / collapse animation. t = 0 fully closed, t = 1 fully open. The
   * menu grows downward from the call button: its scale goes 0.001 -> 1
   * while its centre slides from the button's bottom edge down to the open
   * position, so the menu's top edge stays pinned under the button. The
   * call button shrinks away as the menu takes over. EaseOutCubic.
   */
  private applyMenuScale(t: number): void {
    const eased = 1 - (1 - t) ** 3;
    if (this.menuPanel) {
      this.menuPanel.scale.setScalar(Math.max(CALL_HIDDEN_SCALE, eased));
      this.menuPanel.position.y =
        -CALL_BUTTON_RADIUS - (MENU_HEIGHT / 2) * eased;
    }
    if (this.callButton) {
      this.callButton.scale.setScalar(
        Math.max(CALL_HIDDEN_SCALE, CALL_VISIBLE_SCALE * (1 - eased)),
      );
    }
  }

  private setPanelScales(callScale: number, menuScale: number): void {
    if (this.callButton) this.callButton.scale.setScalar(callScale);
    if (this.menuPanel) {
      this.menuPanel.scale.setScalar(menuScale);
      this.menuPanel.position.y =
        -CALL_BUTTON_RADIUS - (MENU_HEIGHT / 2) * menuScale;
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
   * RESTART: clear the field, restore the battery, rerun the current level.
   * Public: the result panel's RESTART button runs the same reset.
   */
  runRestart(): void {
    recycleCombatEffects(this.world);
    restoreCannons();
    resetCannonAim();
    this.findByClass(LevelWaveSystem)?.restartLevel();
  }

  private findByClass<T>(type: new (...args: never[]) => T): T | undefined {
    const found = this.world
      .getSystems()
      .find((system) => system instanceof type);
    return found as T | undefined;
  }
}
