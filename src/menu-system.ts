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
  CameraBlocker,
  GameOver,
  GamePaused,
  GameStarted,
  LevelDirector,
} from './components.js';
import { StartPanelSystem } from './start-panel-system.js';
import { LevelWaveSystem } from './level-wave-system.js';
import { recycleCombatEffects, returnToWelcome } from './battle-setup.js';

/** Scale the call button shrinks to while the menu is open (hidden, not removed). */
const CALL_HIDDEN_SCALE = 0.001;
/** Call button half-height at rig-local scale 1, metres; the menu top pins here. */
const CALL_BUTTON_RADIUS = 0.11;
/** Call button's visible scale relative to the rig (user-tuned +1/2 bigger). */
const CALL_VISIBLE_SCALE = 1.5;
/** Uniform shrink of the whole menu rig; the shared baseline both environments start from. */
const MENU_SCALE = 1 / 2;
/** Per-environment factors over the shared baseline: XR trims the call button,
 * flat mode enlarges both button and menu. */
const MENU_FACTORS_XR = { call: 5 / 6, menu: 1 };
const MENU_FACTORS_FLAT = { call: 4 / 3, menu: 3 };
/** Pause-menu height, metres (150 × 100 UIKit units at scale 1). */
const MENU_HEIGHT = 1.0;
/** Seconds for the expand / collapse animation. */
const MENU_ANIM_TIME = 0.25;
/** XR: anchor distance ahead of the head along head yaw, metres. */
const MENU_XR_FORWARD = 2.5;
/** XR: anchor lift above head centre, metres. Tunable by feel. */
const MENU_XR_LIFT = 0.612;
/** Flat mode: fixed world anchor over the water. A camera-relative anchor
 * would bob with the orbit camera's pitch changes, so Billboard(lockY) handles facing. */
const MENU_FLAT_ANCHOR = { x: 0, y: 3.495, z: -3.5 };

type MenuMode = 'closed' | 'opening' | 'open' | 'closing';

/**
 * Pause-menu orchestrator: one rig (call button + pause menu) anchored via
 * Follower + Billboard. Pausing is the `GamePaused` tag on the director; UI,
 * camera, billboard and follower systems ignore it, so the menu stays interactive.
 */
export class MenuSystem extends createSystem({
  directors: { required: [LevelDirector] },
  started: { required: [LevelDirector, GameStarted] },
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
  /** Standalone follow target: MenuSystem repositions it, FollowSystem chases it. */
  private readonly anchorObject = new Object3D();
  private readonly headPos = new Vector3();
  private readonly headDir = new Vector3();
  private readonly headQuat = new Quaternion();

  init(): void {
    this.queries.started.subscribe('qualify', () => this.onGameStart());
    this.queries.started.subscribe('disqualify', () => this.onGameEnd());
    // A RESTART dismisses GameOver with GameStarted still on the director.
    this.queries.over.subscribe('qualify', () => this.onOutcome());
    this.queries.over.subscribe('disqualify', (entity) =>
      this.onOutcomeDismissed(entity),
    );

    // Panels load once and are repositioned on every open.
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

        // One rig under the Follower so both panels move and face together; the
        // per-environment factors ride on the panels' own rig-local scales.
        const rig = new Object3D();
        rig.name = 'MenuRig';
        rig.scale.setScalar(MENU_SCALE);
        rig.add(callButton);
        rig.add(menuPanel);
        rig.visible = false;
        this.panelRig = rig;

        this.panelEntity = this.world.createTransformEntity(rig);
        // FollowSystem eases the rig toward the anchor so panels float in space
        // instead of head-locking; rotation is Billboard's job.
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
        // the rig's descendants and routes clicks into the UIKitML documents.
        this.panelEntity.addComponent(RayInteractable);
        // Presses anywhere on the rig belong to the menu, so the flat camera rig
        // must never orbit them; the tag also holds for touch, where the
        // per-element addUiBlocker path's pointerId match fails.
        this.panelEntity.addComponent(CameraBlocker);

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

  private onGameStart(): void {
    if (!this.panelRig) return;
    this.panelRig.visible = true;
    this.setPanelScales(this.menuFactors().call, CALL_HIDDEN_SCALE);
    this.mode = 'closed';
  }

  private onGameEnd(): void {
    this.setPaused(false);
    this.mode = 'closed';
    this.pendingCommand = null;
    if (!this.panelRig) return;
    this.panelRig.visible = false;
    if (this.menuPanel) this.menuPanel.visible = false;
    this.setPanelScales(this.menuFactors().call, CALL_HIDDEN_SCALE);
  }

  /** Run ended: park the pause UI; the result panel takes over. */
  private onOutcome(): void {
    this.setPaused(false);
    this.mode = 'closed';
    this.pendingCommand = null;
    if (!this.panelRig) return;
    this.panelRig.visible = false;
    if (this.menuPanel) this.menuPanel.visible = false;
    this.setPanelScales(this.menuFactors().call, CALL_HIDDEN_SCALE);
  }

  /** GameOver dismissed: re-show the call button only if GameStarted is still on. */
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
    this.updateAnchor();
    this.menuPanel!.visible = true;
    this.applyMenuScale(0);
  }

  private closeMenu(): void {
    if (this.mode !== 'open') return;
    this.mode = 'closing';
    // Unpause immediately: RESUME resumes behind the shrink animation, and
    // MAIN / RESTART run their resets there too.
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
   * Drive the follow anchor. XR: `MENU_XR_FORWARD` ahead along flattened head
   * yaw, `MENU_XR_LIFT` above head centre. Flat: the fixed world anchor.
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
   * Expand / collapse animation (EaseOutCubic): t = 0 closed, t = 1 open. The
   * menu grows downward while its top edge stays pinned under the call button.
   */
  private applyMenuScale(t: number): void {
    const eased = 1 - (1 - t) ** 3;
    const factors = this.menuFactors();
    if (this.menuPanel) {
      // The menu's top edge stays pinned under the button while its centre
      // slides down by its own (factor-scaled) half height.
      this.menuPanel.scale.setScalar(
        Math.max(CALL_HIDDEN_SCALE, eased * factors.menu),
      );
      this.menuPanel.position.y =
        -CALL_BUTTON_RADIUS - (MENU_HEIGHT / 2) * eased * factors.menu;
    }
    if (this.callButton) {
      this.callButton.scale.setScalar(
        Math.max(CALL_HIDDEN_SCALE, factors.call * (1 - eased)),
      );
    }
  }

  private menuFactors(): { call: number; menu: number } {
    const immersive =
      this.world.visibilityState.peek() !== VisibilityState.NonImmersive;
    return immersive ? MENU_FACTORS_XR : MENU_FACTORS_FLAT;
  }

  /**
   * React to an XR <-> flat flip mid-game: static states would keep the old
   * environment's size until touched; animating states self-correct.
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
        -CALL_BUTTON_RADIUS - (MENU_HEIGHT / 2) * menuScale;
    }
  }

  /**
   * MAIN: reset the director to the welcome gate and swap back the welcome UI.
   * Public: the result panel's MAIN button runs the same hand-off.
   */
  runMain(): void {
    recycleCombatEffects(this.world);
    this.findByClass(LevelWaveSystem)?.resetToWelcome();
    this.findByClass(StartPanelSystem)?.reset();
    returnToWelcome(this.world);
  }

  /**
   * RESTART: clear the field, re-crew the battery and rerun the current level.
   * Public: the result panel's RESTART button runs the same reset.
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
