/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createSystem, UIKitMLAsset, Vector3, VisibilityState } from '@iwsdk/core';

/**
 * Browser-mode (non-immersive) touch/mouse camera rig.
 *
 * IWSDK does not own browser camera controls, so this system implements them:
 * - One pointer drag: first-person look-around (yaw + pitch only, never roll).
 *   Drag right -> look right; drag up -> look up.
 * - Two pointer drag: grab-style pan — horizontal drag strafes left/right,
 *   vertical drag raises/lowers the rig (drag the world under the fingers).
 * - Two pointer pinch: dolly forward/back along the view direction.
 *
 * The rig only runs outside XR; during an immersive session the tracked player
 * owns the camera.
 */

const LOOK_SPEED = 0.004; // radians per dragged pixel
const PAN_SPEED = 0.0035; // metres per dragged pixel
const DOLLY_SPEED = 0.015; // metres per pixel of pinch gap change
const PITCH_LIMIT = Math.PI / 2 - 0.05;
const MIN_RIG_HEIGHT = 0.2; // metres; keep the rig above the water plane
const MAX_RIG_HEIGHT = 4; // metres

const easeInOutCubic = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;

type DragMode = 'none' | 'look' | 'move';

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
  // Last anchors for move mode (two-pointer midpoint + gap).
  private moveMid = { x: 0, y: 0 };
  private moveGap = 0;

  private readonly right = new Vector3();
  private readonly forward = new Vector3();
  private readonly move = new Vector3();

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
      () => window.removeEventListener('pointerup', this.onPointerUp),
      () => window.removeEventListener('pointercancel', this.onPointerUp),
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

    if (this.pointers.size === 1) {
      this.mode = 'look';
      this.lookLast.x = e.clientX;
      this.lookLast.y = e.clientY;
    } else if (this.pointers.size === 2) {
      // Adding a second finger switches to move mode; re-anchor so the new
      // finger does not cause a position jump.
      this.mode = 'move';
      this.refreshMoveAnchor();
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (this.mode === 'none' || !this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.mode === 'look' && this.pointers.size === 1) {
      const dx = e.clientX - this.lookLast.x;
      const dy = e.clientY - this.lookLast.y;
      // Drag right -> look right; drag up -> look up. YXZ order keeps the
      // movement a pure yaw/pitch with zero roll (z rotation untouched).
      this.yaw -= dx * LOOK_SPEED;
      this.pitch -= dy * LOOK_SPEED;
      this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch));
      this.lookLast.x = e.clientX;
      this.lookLast.y = e.clientY;
    } else if (this.mode === 'move' && this.pointers.size >= 2) {
      const pts = [...this.pointers.values()];
      const midX = (pts[0].x + pts[1].x) / 2;
      const midY = (pts[0].y + pts[1].y) / 2;
      const gap = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);

      const dx = midX - this.moveMid.x;
      const dy = midY - this.moveMid.y;
      const dGap = gap - this.moveGap;
      this.applyMove(dx, dy, dGap);

      this.moveMid.x = midX;
      this.moveMid.y = midY;
      this.moveGap = gap;
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    this.blockedPointers.delete(e.pointerId);
    if (this.pointers.size === 0) {
      this.mode = 'none';
    } else if (this.pointers.size === 1) {
      // One finger remains after releasing the other: re-anchor look mode so
      // the view does not jump.
      this.mode = 'look';
      const remaining = [...this.pointers.values()][0];
      this.lookLast.x = remaining.x;
      this.lookLast.y = remaining.y;
    }
  };

  private refreshMoveAnchor(): void {
    const pts = [...this.pointers.values()];
    this.moveMid.x = (pts[0].x + pts[1].x) / 2;
    this.moveMid.y = (pts[0].y + pts[1].y) / 2;
    this.moveGap = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }

  private applyMove(dx: number, dy: number, dGap: number): void {
    const camera = this.world.camera;
    // Ground-plane basis from the current yaw: right and horizontal forward.
    this.right.setFromMatrixColumn(camera.matrixWorld, 0);
    this.right.y = 0;
    this.right.normalize();
    this.forward.crossVectors(camera.up, this.right).normalize();

    // Grab-style pan: world follows the fingers. Horizontal drag strafes,
    // pinch dollies along the view. Vertical drag raises/lowers the rig —
    // sliding along forward felt identical to the pinch dolly, so it is
    // deliberately NOT used for translation.
    const player = this.world.player;
    this.move
      .set(0, 0, 0)
      .addScaledVector(this.right, -dx * PAN_SPEED)
      .addScaledVector(this.forward, dGap * DOLLY_SPEED);
    player.position.add(this.move);

    // Finger up -> world follows -> camera lowers (grab convention).
    player.position.y = Math.max(
      MIN_RIG_HEIGHT,
      Math.min(MAX_RIG_HEIGHT, player.position.y + dy * PAN_SPEED),
    );
  }

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
