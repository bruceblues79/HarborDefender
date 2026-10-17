/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  createSystem,
  Hovered,
  Object3D,
  Pressed,
  UIKitMLAsset,
  Vector3,
  VisibilityState,
} from '@iwsdk/core';
import { CannonAim } from './components.js';

/**
 * Browser-mode (non-immersive) orbit camera rig.
 *
 * IWSDK does not own browser camera controls, so this system implements them:
 * - One pointer drag: orbit around a fixed target point (yaw + pitch on a
 *   sphere of constant radius, camera always facing the target). The feel
 *   follows three.js OrbitControls conventions: drag right swings the camera
 *   counter-clockwise around the target; drag down raises the camera.
 * - Two-finger pinch (and the mouse wheel): adjusts camera FOV — zoom here
 *   changes the field of view, never the orbit radius.
 *
 * Orbit yaw/pitch are clamped to a window around the default battle view
 * (±YAW_RANGE / ±PITCH_RANGE); FOV is clamped to [FOV_MIN, FOV_MAX]. The
 * camera never translates freely and never free-looks.
 *
 * The rig only runs outside XR; during an immersive session the tracked player
 * owns the camera.
 */

const ORBIT_SPEED = 0.004; // radians per dragged pixel
const YAW_RANGE = Math.PI / 4; // ±45° around the default view
const PITCH_RANGE = Math.PI / 18; // ±10° around the default view
const FOV_MIN = 40; // pinch/wheel zoom clamp, degrees
const FOV_MAX = 60;
const PINCH_SPEED = 0.05; // FOV degrees per pixel of pinch spread
const WHEEL_SPEED = 0.02; // FOV degrees per wheel deltaY unit

const easeInOutCubic = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;

type DragMode = 'none' | 'orbit' | 'pinch';

export class CameraOrbitSystem extends createSystem({
  // Watched so a drag that belongs to a cannon never also orbits the camera.
  cannons: { required: [CannonAim] },
}) {
  // Orbit state. Seed matches the welcome/loading pose from
  // iwsdk.config.json — camera (0,1.25,2) looking level at (0,1.25,-1.5) — so
  // the target starts 3.5 m ahead at zero yaw/pitch. Game-start transitions
  // re-seed through moveToView() and are eased in update().
  private readonly target = new Vector3(0, 1.25, -1.5);
  private radius = 3.5;
  private yaw = 0;
  private pitch = 0;
  // Clamp window center, re-seeded by moveToView() once the tween completes.
  private defaultYaw = 0;
  private defaultPitch = 0;
  // FOV zoom state; defaultFov is read from the world camera at init
  // (world.render.fov in iwsdk.config.json).
  private currentFov = 50;
  private defaultFov = 50;

  private mode: DragMode = 'none';
  private readonly pointers = new Map<number, { x: number; y: number }>();
  // Pointers whose press landed on an interactive UI element: the UI owns the
  // whole gesture, so the camera rig must not react to it at all.
  private readonly blockedPointers = new Set<number>();
  // Last anchor for orbit mode (the single tracked pointer).
  private orbitLast = { x: 0, y: 0 };
  // Pinch anchors: finger spread at the second press plus the FOV then.
  private pinchStartDist = 0;
  private pinchStartFov = 50;

  // Eased game-start camera move (browser mode only)
  private readonly targetFrom = new Vector3();
  private readonly targetTo = new Vector3();
  private fromRadius = 3.5;
  private toRadius = 3.5;
  private viewElapsed = 1; // >= viewDuration means "no active tween"
  private viewDuration = 1;
  private fromYaw = 0;
  private fromPitch = 0;
  private toYaw = 0;
  private toPitch = 0;

  // Per-frame scratch, allocated once (never in update).
  private readonly orbitOffset = new Vector3();

  init(): void {
    const camera = this.world.camera;
    if ('fov' in camera) {
      this.currentFov = camera.fov;
      this.defaultFov = camera.fov;
    }

    const canvas = this.world.renderer.domElement;
    // Without this, mobile browsers intercept touch drags for page
    // scroll/zoom and only deliver sparse, cancelled pointer events —
    // this is what made camera control feel stuck/janky.
    canvas.style.touchAction = 'none';

    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });

    // Mobile browsers run two-finger pinch/pan as native page gestures on top
    // of pointer events. Once the browser decides a native gesture takes over
    // a touch it fires pointercancel and stops delivering pointer moves — our
    // rig state machine would then flap. touch-action: none is not honored by
    // every mobile browser (iOS Safari ignores it for page pinch), so suppress
    // the touch defaults on the canvas directly — the r3f-style approach.
    // Canvas scope only: the DOM ENTER XR button must keep receiving
    // taps/clicks.
    const blockGesture = (e: Event): void => e.preventDefault();
    canvas.addEventListener('touchstart', blockGesture, { passive: false });
    canvas.addEventListener('touchmove', blockGesture, { passive: false });
    // Belt and suspenders for iOS page pinch (gesture events).
    document.addEventListener('gesturestart', blockGesture);
    document.addEventListener('gesturechange', blockGesture);

    // A press starting on the ENTER GAME button belongs to the button (tap /
    // click / button drag), never to the camera rig. UIKitML buttons live
    // inside the same WebGL canvas, so their pointer events are synthetic;
    // they share the exact hit-test that fires the button's own click.
    const enterGameButton = this.world
      .getSceneObject<UIKitMLAsset>('welcome-panel')
      ?.getElementById('enter-game-button');
    if (enterGameButton) this.addUiBlocker(enterGameButton);

    this.cleanupFuncs.push(
      () => canvas.removeEventListener('pointerdown', this.onPointerDown),
      () => canvas.removeEventListener('pointermove', this.onPointerMove),
      () => canvas.removeEventListener('touchstart', blockGesture),
      () => canvas.removeEventListener('touchmove', blockGesture),
      () => canvas.removeEventListener('wheel', this.onWheel),
      () => window.removeEventListener('pointerup', this.onPointerUp),
      () => window.removeEventListener('pointercancel', this.onPointerUp),
      () => document.removeEventListener('gesturestart', blockGesture),
      () => document.removeEventListener('gesturechange', blockGesture),
    );
  }

  /**
   * Register a UIKitML button whose presses must never reach the camera rig —
   * the same contract the welcome button gets at init. Systems owning runtime
   * panels (pause menu) call this once per button when the panel resolves.
   */
  addUiBlocker(element: Object3D): void {
    element.addEventListener('pointerdown', this.onUiPointerDown);
    this.cleanupFuncs.push(() =>
      element.removeEventListener('pointerdown', this.onUiPointerDown),
    );
  }

  private readonly onUiPointerDown = (e: { pointerId: number }): void => {
    this.blockedPointers.add(e.pointerId);
  };

  private onPointerDown = (e: PointerEvent): void => {
    if (this.world.visibilityState.peek() !== VisibilityState.NonImmersive) {
      return;
    }
    // Press started on a UI element: ignore this pointer for the gesture.
    if (this.blockedPointers.has(e.pointerId)) return;
    // Press started on a cannon: the aim drag owns it (Hovered is already set
    // for a mouse; touch gets Pressed one frame later, covered in onMove).
    if (this.anyCannon(Hovered)) {
      this.blockedPointers.add(e.pointerId);
      return;
    }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.pointers.size === 1) {
      // Single finger drives the orbit.
      this.mode = 'orbit';
      this.orbitLast.x = e.clientX;
      this.orbitLast.y = e.clientY;
    } else if (this.pointers.size === 2) {
      // Second finger switches to FOV pinch; snapshot the anchors so the
      // zoom starts from the current view with no jump.
      this.mode = 'pinch';
      this.pinchStartDist = this.currentPinchDist();
      this.pinchStartFov = this.currentFov;
    } else {
      this.mode = 'none';
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId)) return;
    // Always refresh the stored position, even outside 'orbit' mode, so
    // re-anchoring after a finger lifts never jumps from a stale coordinate.
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // A cannon press owns this gesture (covers the touch case where Pressed
    // lands a frame after pointerdown): stay anchored on every anchor so
    // resuming the camera after the drag never jumps.
    if (this.anyCannon(Pressed)) {
      this.orbitLast.x = e.clientX;
      this.orbitLast.y = e.clientY;
      if (this.pointers.size === 2) {
        this.pinchStartDist = this.currentPinchDist();
        this.pinchStartFov = this.currentFov;
      }
      return;
    }

    if (this.mode === 'pinch' && this.pointers.size === 2) {
      // Spread fingers -> zoom in (FOV shrinks); pinch in -> zoom out.
      const spread = this.currentPinchDist() - this.pinchStartDist;
      this.currentFov = this.clampFov(
        this.pinchStartFov - spread * PINCH_SPEED,
      );
      this.applyFov();
      return;
    }
    if (this.mode !== 'orbit') return;

    const dx = e.clientX - this.orbitLast.x;
    const dy = e.clientY - this.orbitLast.y;
    // OrbitControls convention: drag right swings the camera around the
    // target's left (scene appears to rotate right); drag down raises the
    // camera above the target. Yaw/pitch stay clamped to the window around
    // the default view — the camera can never leave the battle framing.
    this.yaw = this.clampAngle(
      this.yaw - dx * ORBIT_SPEED,
      this.defaultYaw,
      YAW_RANGE,
    );
    this.pitch = this.clampAngle(
      this.pitch + dy * ORBIT_SPEED,
      this.defaultPitch,
      PITCH_RANGE,
    );
    this.orbitLast.x = e.clientX;
    this.orbitLast.y = e.clientY;
  };

  private onPointerUp = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    this.blockedPointers.delete(e.pointerId);
    if (this.pointers.size === 0) {
      this.mode = 'none';
    } else if (this.pointers.size === 1) {
      // One finger remains after the other lifted: re-anchor orbit mode so
      // the view does not jump.
      this.mode = 'orbit';
      const remaining = [...this.pointers.values()][0];
      this.orbitLast.x = remaining.x;
      this.orbitLast.y = remaining.y;
    } else if (this.pointers.size === 2) {
      // Back to exactly two pointers (a third lifted): re-anchor the pinch.
      this.mode = 'pinch';
      this.pinchStartDist = this.currentPinchDist();
      this.pinchStartFov = this.currentFov;
    }
  };

  private onWheel = (e: WheelEvent): void => {
    if (this.world.visibilityState.peek() !== VisibilityState.NonImmersive) {
      return;
    }
    e.preventDefault();
    // Scroll up (deltaY < 0) zooms in — same FOV semantics as the pinch.
    this.currentFov = this.clampFov(
      this.currentFov + e.deltaY * WHEEL_SPEED,
    );
    this.applyFov();
  };

  /**
   * Ease the browser-mode camera to orbit `target` from `position`. Called
   * once when loading finishes. Allocation is confined to this call; the
   * per-frame tween in update() reuses class-owned vectors only.
   */
  moveToView(position: Vector3, target: Vector3, duration = 0.9): void {
    this.targetFrom.copy(this.target);
    this.targetTo.copy(target);
    const dx = position.x - target.x;
    const dy = position.y - target.y;
    const dz = position.z - target.z;
    this.fromRadius = this.radius;
    this.toRadius = Math.hypot(dx, dy, dz);
    this.fromYaw = this.yaw;
    this.toYaw = Math.atan2(dx, dz);
    this.fromPitch = this.pitch;
    this.toPitch = Math.asin(dy / this.toRadius);
    this.viewElapsed = 0;
    this.viewDuration = duration;
  }

  /**
   * Ease back to the authored welcome pose — the same camera/target pair the
   * world starts with (0,1.25,2) looking level at (0,1.25,-1.5). Called on the
   * MAIN-menu hand-off; the welcome view becomes the clamp window center on
   * arrival, exactly like any other completed tween.
   */
  returnToWelcome(): void {
    this.moveToView(
      new Vector3(0, 1.25, 2),
      new Vector3(0, 1.25, -1.5),
    );
  }

  private currentPinchDist(): number {
    const [a, b] = [...this.pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  /** True while any cannon carries the given transient interaction tag. */
  private anyCannon(tag: typeof Hovered | typeof Pressed): boolean {
    for (const entity of this.queries.cannons.entities) {
      if (entity.hasComponent(tag)) return true;
    }
    return false;
  }

  private clampAngle(value: number, center: number, range: number): number {
    return Math.max(center - range, Math.min(center + range, value));
  }

  private clampFov(value: number): number {
    return Math.max(FOV_MIN, Math.min(FOV_MAX, value));
  }

  private applyFov(): void {
    const camera = this.world.camera;
    if ('fov' in camera) {
      camera.fov = this.currentFov;
      camera.updateProjectionMatrix();
    }
  }

  update(delta: number): void {
    if (this.world.visibilityState.peek() !== VisibilityState.NonImmersive) {
      return;
    }
    if (this.viewElapsed < this.viewDuration) {
      this.viewElapsed = Math.min(
        this.viewDuration,
        this.viewElapsed + delta,
      );
      const t = easeInOutCubic(this.viewElapsed / this.viewDuration);
      this.target.lerpVectors(this.targetFrom, this.targetTo, t);
      this.radius = this.fromRadius + (this.toRadius - this.fromRadius) * t;
      this.yaw = this.fromYaw + (this.toYaw - this.fromYaw) * t;
      this.pitch = this.fromPitch + (this.toPitch - this.fromPitch) * t;
      if (this.viewElapsed >= this.viewDuration) {
        // The battle view becomes the new clamp window center.
        this.defaultYaw = this.toYaw;
        this.defaultPitch = this.toPitch;
      }
    }
    const camera = this.world.camera;
    const cosPitch = Math.cos(this.pitch);
    this.orbitOffset.set(
      this.radius * cosPitch * Math.sin(this.yaw),
      this.radius * Math.sin(this.pitch),
      this.radius * cosPitch * Math.cos(this.yaw),
    );
    camera.position.copy(this.target).add(this.orbitOffset);
    camera.lookAt(this.target);
  }
}
