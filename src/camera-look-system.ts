/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  createSystem,
  UIKitMLAsset,
  Vector3,
  VisibilityState,
} from '@iwsdk/core';

/**
 * Browser-mode (non-immersive) touch/mouse camera rig.
 *
 * IWSDK does not own browser camera controls, so this system implements them:
 * - One pointer drag: first-person look-around (yaw + pitch only, never roll).
 *   Drag right -> look right; drag up -> look up. Looking never moves the rig.
 *
 * All two-finger / multi-pointer and wheel input is intentionally ignored so
 * the camera never translates in flat mode; only single-finger look remains.
 *
 * The rig only runs outside XR; during an immersive session the tracked player
 * owns the camera.
 */

const LOOK_SPEED = 0.004; // radians per dragged pixel
const PITCH_LIMIT = Math.PI / 2 - 0.05;

const easeInOutCubic = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;

type DragMode = 'none' | 'look';

export class CameraLookSystem extends createSystem({}) {
  private yaw = 0;
  // Welcome/loading pose from iwsdk.config.json: (0,1.5,2) looking level at
  // (0,1.5,-1.5), so the seed pitch is 0. Game-start transitions are driven
  // through moveToView() and eased in update().
  private pitch = 0;
  private mode: DragMode = 'none';
  private readonly pointers = new Map<number, { x: number; y: number }>();
  // Pointers whose press landed on an interactive UI element: the UI owns the
  // whole gesture, so the camera rig must not react to it at all.
  private readonly blockedPointers = new Set<number>();
  // Last anchor for look mode (the single tracked pointer).
  private lookLast = { x: 0, y: 0 };

  // Eased game-start camera move (browser mode only)
  private readonly viewFrom = new Vector3();
  private readonly viewTo = new Vector3();
  private viewElapsed = 1; // >= viewDuration means "no active tween"
  private viewDuration = 1;
  private fromYaw = 0;
  private fromPitch = 0;
  private toYaw = 0;
  private toPitch = 0;

  init(): void {
    const canvas = this.world.renderer.domElement;
    // Without this, mobile browsers intercept touch drags for page
    // scroll/zoom and only deliver sparse, cancelled pointer events —
    // this is what made look-around feel stuck/janky.
    canvas.style.touchAction = 'none';

    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);

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
    const onUiPointerDown = (e: { pointerId: number }): void => {
      this.blockedPointers.add(e.pointerId);
    };
    enterGameButton?.addEventListener('pointerdown', onUiPointerDown);

    this.cleanupFuncs.push(
      () => canvas.removeEventListener('pointerdown', this.onPointerDown),
      () => canvas.removeEventListener('pointermove', this.onPointerMove),
      () => canvas.removeEventListener('touchstart', blockGesture),
      () => canvas.removeEventListener('touchmove', blockGesture),
      () => window.removeEventListener('pointerup', this.onPointerUp),
      () => window.removeEventListener('pointercancel', this.onPointerUp),
      () => document.removeEventListener('gesturestart', blockGesture),
      () => document.removeEventListener('gesturechange', blockGesture),
      () =>
        enterGameButton?.removeEventListener('pointerdown', onUiPointerDown),
    );
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (this.world.visibilityState.peek() !== VisibilityState.NonImmersive) {
      return;
    }
    // Press started on a UI element: ignore this pointer for the gesture.
    if (this.blockedPointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // Single finger drives look-around. A second finger down does NOT switch
    // into a translate mode; it is simply ignored until it lifts.
    if (this.pointers.size === 1) {
      this.mode = 'look';
      this.lookLast.x = e.clientX;
      this.lookLast.y = e.clientY;
    } else {
      this.mode = 'none';
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId)) return;
    // Always refresh the stored position, even in 'none' (two-finger) mode,
    // so when one finger lifts and we re-anchor look mode the delta is ~0
    // instead of a jump from a stale coordinate.
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.mode !== 'look') return;

    const dx = e.clientX - this.lookLast.x;
    const dy = e.clientY - this.lookLast.y;
    // Drag right -> look right; drag up -> look up. YXZ order keeps the
    // movement a pure yaw/pitch with zero roll (z rotation untouched).
    this.yaw -= dx * LOOK_SPEED;
    this.pitch -= dy * LOOK_SPEED;
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch));
    this.lookLast.x = e.clientX;
    this.lookLast.y = e.clientY;
  };

  private onPointerUp = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    this.blockedPointers.delete(e.pointerId);
    if (this.pointers.size === 0) {
      this.mode = 'none';
    } else if (this.pointers.size === 1) {
      // One finger remains after the other lifted: re-anchor look mode so
      // the view does not jump.
      this.mode = 'look';
      const remaining = [...this.pointers.values()][0];
      this.lookLast.x = remaining.x;
      this.lookLast.y = remaining.y;
    }
  };

  /**
   * Ease the browser-mode camera to `position` looking at `target`. Called
   * once when loading finishes. Allocation is confined to this call; the
   * per-frame tween in update() reuses class-owned vectors only.
   */
  moveToView(position: Vector3, target: Vector3, duration = 0.9): void {
    this.viewFrom.copy(this.world.camera.position);
    this.viewTo.copy(position);
    const dx = target.x - position.x;
    const dy = target.y - position.y;
    const dz = target.z - position.z;
    this.toYaw = Math.atan2(-dx, -dz);
    this.toPitch = Math.atan2(dy, Math.hypot(dx, dz));
    this.fromYaw = this.yaw;
    this.fromPitch = this.pitch;
    this.viewElapsed = 0;
    this.viewDuration = duration;
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
      this.world.camera.position.lerpVectors(this.viewFrom, this.viewTo, t);
      this.yaw = this.fromYaw + (this.toYaw - this.fromYaw) * t;
      this.pitch = this.fromPitch + (this.toPitch - this.fromPitch) * t;
    }
    const camera = this.world.camera;
    camera.rotation.order = 'YXZ';
    camera.rotation.y = this.yaw;
    camera.rotation.x = this.pitch;
    camera.rotation.z = 0;
  }
}
