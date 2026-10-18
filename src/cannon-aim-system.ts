/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  createSystem,
  InputComponent,
  Plane,
  Pressed,
  Ray,
  Vector3,
  VisibilityState,
} from '@iwsdk/core';
import type { Entity, Object3D } from '@iwsdk/core';
import { Destroyed, GameOver, GamePaused, LevelDirector, CannonAim } from './components.js';
import { COMBAT } from './level-config.js';

const DEG2RAD = Math.PI / 180;

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

/**
 * Drag aiming for the cannons (browser drag / XR pinch-drag), built on
 * IWSDK's native ray interaction: the press itself is the InputSystem's
 * `Pressed` tag, so one gesture path covers mouse, touch and XR rays — no
 * hand-rolled gesture recognition.
 *
 * - Browser: once a press on a cannon anchors a pointer, that pointer owns
 *   the drag until pointerup (grab-the-barrel semantics — the drag survives
 *   sliding off the barrel, matching how a real grabbed object behaves).
 *   Pixel deltas map to yaw/pitch: pull right swings the muzzle right, pull
 *   down drops it.
 * - XR: the pressing hand's ray is intersected with a vertical aim plane
 *   through the cannon (ray-plane geometry, not a scene Raycaster). The hit
 *   point's cannon-local travel from the anchor maps to yaw/pitch. The drag
 *   continues while the trigger/pinch is held, so rotating the barrel away
 *   from the ray never drops the gesture mid-aim.
 *
 * `CannonAim` stays the single truth: this system applies it to the cannon
 * root's yaw and the gun_rotate pivot's pitch every frame, dragging or not.
 */
export class CannonAimSystem extends createSystem({
  cannons: { required: [CannonAim], excluded: [Destroyed] },
  pressed: { required: [CannonAim, Pressed], excluded: [Destroyed] },
  directors: { required: [LevelDirector] },
}) {
  /** gun_rotate pivot per cannon entity index, resolved once on qualify. */
  private readonly gunPivots = new Map<number, Object3D>();

  // --- browser drag state (CameraOrbitSystem's pointer-tracking pattern) ---
  private readonly pointers = new Map<number, { x: number; y: number }>();
  /** Pointer and cannon owning the active browser drag, once anchored. */
  private dragPointerId: number | null = null;
  private dragCannon: Entity | null = null;
  private readonly dragLast = { x: 0, y: 0 };

  // --- XR drag state: one active drag, anchored in cannon-local space ---
  private xrDragCannon: number | null = null;
  private readonly xrHitStart = new Vector3();
  private xrAimStartYaw = 0;
  private xrAimStartPitch = 0;

  // Per-frame scratch, allocated once (never in update).
  private readonly rayOrigin = new Vector3();
  private readonly rayDir = new Vector3();
  private readonly hitLocal = new Vector3();
  private readonly planePoint = new Vector3();
  private readonly planeNormal = new Vector3(0, 0, 1);
  private readonly aimPlane = new Plane();
  private readonly ray = new Ray();

  init(): void {
    const canvas = this.world.renderer.domElement;
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
    this.cleanupFuncs.push(
      () => canvas.removeEventListener('pointerdown', this.onPointerDown),
      () => canvas.removeEventListener('pointermove', this.onPointerMove),
      () => window.removeEventListener('pointerup', this.onPointerUp),
      () => window.removeEventListener('pointercancel', this.onPointerUp),
    );
    this.queries.cannons.subscribe('qualify', (entity) => {
      const pivot = entity.object3D?.getObjectByName('gun_rotate');
      if (pivot) this.gunPivots.set(entity.index, pivot);
    });
  }

  private onPointerDown = (e: PointerEvent): void => {
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  };

  private onPointerUp = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    if (this.dragPointerId === e.pointerId) {
      this.dragPointerId = null;
      this.dragCannon = null;
    }
  };

  /** True while the pause-menu tag sits on the director entity. */
  private paused(): boolean {
    for (const director of this.queries.directors.entities) {
      return director.hasComponent(GamePaused);
    }
    return false;
  }

  /** True once the START hand-off has moved the director past waiting-start. */
  private gameRunning(): boolean {
    for (const director of this.queries.directors.entities) {
      return (
        String(director.getValue(LevelDirector, 'phase')) !== 'waiting-start'
      );
    }
    return false;
  }

  /** True once the run has ended (victory or defeat) — the guns park. */
  private over(): boolean {
    for (const director of this.queries.directors.entities) {
      return director.hasComponent(GameOver);
    }
    return false;
  }

  update(): void {
    // Pause freezes new drags and transform application; an in-flight drag is
    // simply never updated further (its pointer-up cleanup still runs). The
    // GameOver hold keeps the battery parked behind the result panel too.
    if (this.paused() || this.over()) return;
    // The START gate blocks new aim drags exactly like the fire rhythm is
    // held: before beginLevel() the guns are scenery, not controls. The
    // transform pass below still runs, so resetCannonAim() re-applies the
    // levelled pose while the START panel is up.
    if (this.gameRunning()) {
      if (this.world.visibilityState.peek() === VisibilityState.NonImmersive) {
        this.updateBrowserDrag();
      } else {
        this.updateXRDrag();
      }
    }
    // Single truth -> transforms, applied every frame whether dragging or not.
    for (const entity of this.queries.cannons.entities) {
      const object = entity.object3D;
      if (!object) continue;
      object.rotation.y =
        Number(entity.getValue(CannonAim, 'yawDeg')) * DEG2RAD;
      const pivot = this.gunPivots.get(entity.index);
      if (pivot) {
        pivot.rotation.x =
          Number(entity.getValue(CannonAim, 'pitchDeg')) * DEG2RAD;
      }
    }
  }

  // ---------------------------------------------------------------- browser

  private updateBrowserDrag(): void {
    if (this.dragPointerId === null || !this.dragCannon) {
      // Anchor only when a cannon is actually pressed; a press on open water
      // belongs to the camera rig and must never start an aim drag.
      const cannon = this.firstPressedCannon();
      if (!cannon || this.pointers.size === 0) return;
      const [id, pos] = [...this.pointers.entries()][0];
      this.dragPointerId = id;
      this.dragCannon = cannon;
      this.dragLast.x = pos.x;
      this.dragLast.y = pos.y;
      return;
    }
    const pos = this.pointers.get(this.dragPointerId);
    if (!pos) return; // pointerup already cleared the drag in onPointerUp
    const dx = pos.x - this.dragLast.x;
    const dy = pos.y - this.dragLast.y;
    this.dragLast.x = pos.x;
    this.dragLast.y = pos.y;
    // Grab-the-barrel: pull right -> muzzle right (+yaw), pull down -> muzzle
    // down (-pitch). Sensitivities live in COMBAT for feel tuning.
    this.addAim(
      this.dragCannon,
      dx * COMBAT.aimDegreesPerPixel,
      -dy * COMBAT.aimDegreesPerPixel,
    );
  }

  // -------------------------------------------------------------------- XR

  private updateXRDrag(): void {
    if (this.xrDragCannon === null) {
      const cannon = this.firstPressedCannon();
      if (!cannon || !this.xrRayHit(cannon)) return;
      this.xrDragCannon = cannon.index;
      cannon.object3D?.worldToLocal(this.hitLocal);
      this.xrHitStart.copy(this.hitLocal);
      this.xrAimStartYaw = Number(cannon.getValue(CannonAim, 'yawDeg'));
      this.xrAimStartPitch = Number(cannon.getValue(CannonAim, 'pitchDeg'));
      return;
    }
    // Continue while the pinch/trigger is held — releasing is the only exit,
    // so the barrel rotating away from the ray never drops the gesture.
    if (!this.xrTriggerHeld()) {
      this.xrDragCannon = null;
      return;
    }
    const cannon = this.findCannonByIndex(this.xrDragCannon);
    if (!cannon || !this.xrRayHit(cannon)) return;
    cannon.object3D?.worldToLocal(this.hitLocal);
    // Hand travels left/up in cannon space -> muzzle follows left/up.
    const dYaw =
      -(this.hitLocal.x - this.xrHitStart.x) * COMBAT.aimDegreesPerMeter;
    const dPitch =
      (this.hitLocal.y - this.xrHitStart.y) * COMBAT.aimDegreesPerMeter;
    this.setAim(
      cannon,
      this.xrAimStartYaw + dYaw,
      this.xrAimStartPitch + dPitch,
    );
  }

  /**
   * Intersect the pressing hand's ray with the vertical aim plane through the
   * cannon (normal +Z, the player's side). Leaves the WORLD hit point in
   * `hitLocal`; callers transform it into cannon space. False when the ray
   * runs parallel — that frame is simply skipped.
   */
  private xrRayHit(cannon: Entity): boolean {
    const space = this.activeRaySpace();
    const object = cannon.object3D;
    if (!space || !object) return false;
    space.getWorldPosition(this.rayOrigin);
    // Object3D.getWorldDirection yields +Z; XR rays point down their -Z.
    space.getWorldDirection(this.rayDir).negate();
    this.ray.set(this.rayOrigin, this.rayDir);
    this.planePoint.copy(object.position);
    this.aimPlane.setFromNormalAndCoplanarPoint(this.planeNormal, this.planePoint);
    return this.ray.intersectPlane(this.aimPlane, this.hitLocal) !== null;
  }

  /** Hand whose select (trigger / pinch) is currently held, right first. */
  private activeRaySpace(): Object3D | undefined {
    const gamepads = this.world.input.xr.gamepads;
    const raySpaces = this.world.player.raySpaces;
    if (gamepads.right?.getButtonPressed(InputComponent.Trigger)) {
      return raySpaces.right;
    }
    if (gamepads.left?.getButtonPressed(InputComponent.Trigger)) {
      return raySpaces.left;
    }
    return undefined;
  }

  private xrTriggerHeld(): boolean {
    return this.activeRaySpace() !== undefined;
  }

  // ---------------------------------------------------------------- shared

  private firstPressedCannon(): Entity | undefined {
    for (const entity of this.queries.pressed.entities) return entity;
    return undefined;
  }

  private findCannonByIndex(index: number): Entity | undefined {
    for (const entity of this.queries.cannons.entities) {
      if (entity.index === index) return entity;
    }
    return undefined;
  }

  private addAim(cannon: Entity, dYaw: number, dPitch: number): void {
    this.setAim(
      cannon,
      Number(cannon.getValue(CannonAim, 'yawDeg')) + dYaw,
      Number(cannon.getValue(CannonAim, 'pitchDeg')) + dPitch,
    );
  }

  private setAim(cannon: Entity, yawDeg: number, pitchDeg: number): void {
    cannon.setValue(
      CannonAim,
      'yawDeg',
      clamp(yawDeg, -COMBAT.aimYawRange, COMBAT.aimYawRange),
    );
    cannon.setValue(
      CannonAim,
      'pitchDeg',
      clamp(pitchDeg, COMBAT.aimPitchMin, COMBAT.aimPitchMax),
    );
  }
}
