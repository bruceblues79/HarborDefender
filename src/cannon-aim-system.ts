/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  createSystem,
  Hovered,
  InputComponent,
  Pressed,
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
 * - XR: grabbing a hovered cannon while the trigger is held anchors that
 *   hand; the hand's world-space travel from the grab pose maps to yaw/pitch
 *   (wrist displacement, not ray-plane geometry — turret rotation never
 *   feeds back into the mapping). The drag continues until that hand
 *   releases, so the barrel or the ray wandering off never drops the gesture.
 *   Starts key off `Hovered` rather than `Pressed`: InputSystem clears
 *   `Pressed` the moment the ray slides off the barrel (even mid-pinch) and
 *   never re-fires it without a fresh pinch, while `Hovered` returns as soon
 *   as the ray is back — a grazing pinch no longer loses the grab.
 *
 * `CannonAim` stays the single truth: this system applies it to the cannon
 * root's yaw and the gun_rotate pivot's pitch every frame, dragging or not.
 */
export class CannonAimSystem extends createSystem({
  cannons: { required: [CannonAim], excluded: [Destroyed] },
  pressed: { required: [CannonAim, Pressed], excluded: [Destroyed] },
  /** Self-healing XR grab candidates: ray currently over the cannon. */
  hovered: { required: [CannonAim, Hovered], excluded: [Destroyed] },
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

  // --- XR drag state: one active drag, anchored to one hand's wrist travel ---
  private xrDragCannon: number | null = null;
  /** Ray space of the hand that started the drag; its release ends it. */
  private xrDragSpace: Object3D | null = null;
  private readonly xrHandStart = new Vector3();
  private readonly xrHandPos = new Vector3();
  private xrAimStartYaw = 0;
  private xrAimStartPitch = 0;

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
    if (this.xrDragSpace === null) {
      // Start: trigger held while the ray hovers a cannon. `Hovered` is the
      // grab signal — it self-heals when a jittered ray slides off and back
      // (InputSystem re-enters without a fresh pinch, unlike `Pressed`).
      const space = this.heldRaySpace();
      const cannon = space ? this.firstHoveredCannon() : undefined;
      if (!space || !cannon) return;
      this.xrDragCannon = cannon.index;
      this.xrDragSpace = space;
      space.getWorldPosition(this.xrHandStart);
      this.xrAimStartYaw = Number(cannon.getValue(CannonAim, 'yawDeg'));
      this.xrAimStartPitch = Number(cannon.getValue(CannonAim, 'pitchDeg'));
      return;
    }
    // Continue with the anchoring hand only — releasing it is the sole exit,
    // so the barrel rotating away or the ray wandering never drops the drag.
    if (!this.handTriggerHeld(this.xrDragSpace)) {
      this.xrDragCannon = null;
      this.xrDragSpace = null;
      return;
    }
    const dragIndex = this.xrDragCannon;
    if (dragIndex === null) return;
    const cannon = this.findCannonByIndex(dragIndex);
    if (!cannon) {
      // Knocked out mid-drag: nothing left to steer.
      this.xrDragCannon = null;
      this.xrDragSpace = null;
      return;
    }
    this.xrDragSpace.getWorldPosition(this.xrHandPos);
    // Wrist travel drives the aim, absolute from the grab pose: hand
    // right/left -> muzzle right/left, hand up/down -> muzzle up/down.
    this.setAim(
      cannon,
      this.xrAimStartYaw -
        (this.xrHandPos.x - this.xrHandStart.x) * COMBAT.aimDegreesPerMeter,
      this.xrAimStartPitch +
        (this.xrHandPos.y - this.xrHandStart.y) * COMBAT.aimDegreesPerMeter,
    );
  }

  /** Hand whose select (trigger / pinch) is currently held, right first. */
  private heldRaySpace(): Object3D | undefined {
    const raySpaces = this.world.player.raySpaces;
    if (this.handTriggerHeld(raySpaces.right)) return raySpaces.right;
    if (this.handTriggerHeld(raySpaces.left)) return raySpaces.left;
    return undefined;
  }

  /** Trigger state of the specific hand that owns `space`. */
  private handTriggerHeld(space: Object3D | undefined): boolean {
    if (!space) return false;
    const gamepads = this.world.input.xr.gamepads;
    const raySpaces = this.world.player.raySpaces;
    if (space === raySpaces.right) {
      return gamepads.right?.getButtonPressed(InputComponent.Trigger) ?? false;
    }
    if (space === raySpaces.left) {
      return gamepads.left?.getButtonPressed(InputComponent.Trigger) ?? false;
    }
    return false;
  }

  private firstHoveredCannon(): Entity | undefined {
    for (const entity of this.queries.hovered.entities) return entity;
    return undefined;
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
    // Elevation limits live on the entity: cannons get the stock 0-45 envelope
    // via component defaults, the sky ballista overrides with its own.
    cannon.setValue(
      CannonAim,
      'pitchDeg',
      clamp(
        pitchDeg,
        Number(cannon.getValue(CannonAim, 'pitchMinDeg')),
        Number(cannon.getValue(CannonAim, 'pitchMaxDeg')),
      ),
    );
  }
}
