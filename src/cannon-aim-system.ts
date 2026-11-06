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
import {
  AimDragging,
  Destroyed,
  GameOver,
  GamePaused,
  LevelDirector,
  CannonAim,
} from './components.js';
import { COMBAT } from './level-config.js';

const DEG2RAD = Math.PI / 180;

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

/**
 * Drag aiming for the cannons (browser drag / XR wrist-drag) on top of IWSDK's
 * native ray interaction:
 * - browser: a press anchors one pointer until pointerup; the whole mount is
 *   one hit target, horizontal travel feeds yaw and vertical feeds pitch;
 * - XR: `Hovered` starts the drag, because `Pressed` is cleared the moment the
 *   ray slides off the barrel, even mid-pinch.
 * `CannonAim` stays the single truth; this system only applies yaw/pitch.
 */
export class CannonAimSystem extends createSystem({
  cannons: { required: [CannonAim], excluded: [Destroyed] },
  pressed: { required: [CannonAim, Pressed], excluded: [Destroyed] },
  /** Self-healing XR grab candidates: ray currently over the cannon. */
  hovered: { required: [CannonAim, Hovered], excluded: [Destroyed] },
  directors: { required: [LevelDirector] },
}) {
  private readonly gunPivots = new Map<number, Object3D>();

  // Browser drag state (CameraOrbitSystem's pointer-tracking pattern).
  private readonly pointers = new Map<number, { x: number; y: number }>();
  /** Pointer and cannon owning the active browser drag, once anchored. */
  private dragPointerId: number | null = null;
  private dragCannon: Entity | null = null;
  private readonly dragLast = { x: 0, y: 0 };

  // XR drag state: one active drag, anchored to one hand's wrist travel.
  private xrDragCannon: number | null = null;
  /** Same session as xrDragCannon, kept for tag teardown on release. */
  private xrDragEntity: Entity | null = null;
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
    // A unit leaving the registry (Destroyed, or swapped out by the build
    // panel) must not carry a stale mid-drag tag into its next life.
    this.queries.cannons.subscribe('disqualify', (entity) => {
      if (entity.hasComponent(AimDragging)) entity.removeComponent(AimDragging);
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
      this.dragCannon?.removeComponent(AimDragging);
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
    // Pause/GameOver freeze new drags and transform application; an in-flight
    // drag simply stops updating (its pointer-up cleanup still runs).
    if (this.paused() || this.over()) return;
    // The START gate blocks new drags; the transform pass below still runs so
    // resetCannonAim() re-applies the levelled pose.
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

  private updateBrowserDrag(): void {
    if (this.dragPointerId === null || !this.dragCannon) {
      // A press on open water belongs to the camera rig, never an aim drag.
      const cannon = this.firstPressedCannon();
      if (!cannon || this.pointers.size === 0) return;
      const [id, pos] = [...this.pointers.entries()][0];
      this.dragPointerId = id;
      this.dragCannon = cannon;
      // Whole-gesture marker: survives sliding off the mount; cleared on pointerup.
      cannon.addComponent(AimDragging);
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
    // One hit target, two axes at once — mirrored: pull right -> muzzle left.
    const sensitivity = COMBAT.aimDegreesPerPixel;
    this.addAim(this.dragCannon, -dx * sensitivity, -dy * sensitivity);
  }

  private updateXRDrag(): void {
    if (this.xrDragSpace === null) {
      // Start: trigger held while the ray hovers a cannon. `Hovered` self-heals
      // when a jittered ray slides off and back, unlike `Pressed`.
      const space = this.heldRaySpace();
      const cannon = space ? this.firstHoveredCannon() : undefined;
      if (!space || !cannon) return;
      this.xrDragCannon = cannon.index;
      this.xrDragEntity = cannon;
      this.xrDragSpace = space;
      // Whole-gesture marker, mirroring the browser anchor; the guide tracks the tag.
      cannon.addComponent(AimDragging);
      space.getWorldPosition(this.xrHandStart);
      this.xrAimStartYaw = Number(cannon.getValue(CannonAim, 'yawDeg'));
      this.xrAimStartPitch = Number(cannon.getValue(CannonAim, 'pitchDeg'));
      return;
    }
    // Continue with the anchoring hand only; its release is the sole exit.
    if (!this.handTriggerHeld(this.xrDragSpace)) {
      this.xrDragEntity?.removeComponent(AimDragging);
      this.xrDragEntity = null;
      this.xrDragCannon = null;
      this.xrDragSpace = null;
      return;
    }
    const dragIndex = this.xrDragCannon;
    if (dragIndex === null) return;
    const cannon = this.findCannonByIndex(dragIndex);
    if (!cannon) {
      // Knocked out mid-drag: nothing left to steer.
      this.xrDragEntity?.removeComponent(AimDragging);
      this.xrDragEntity = null;
      this.xrDragCannon = null;
      this.xrDragSpace = null;
      return;
    }
    this.xrDragSpace.getWorldPosition(this.xrHandPos);
    // Wrist travel from the grab pose drives both axes, mirrored like the browser drag.
    const handDx = this.xrHandPos.x - this.xrHandStart.x;
    const handDy = this.xrHandPos.y - this.xrHandStart.y;
    this.setAim(
      cannon,
      this.xrAimStartYaw + handDx * COMBAT.aimDegreesPerMeterYaw,
      this.xrAimStartPitch + handDy * COMBAT.aimDegreesPerMeterPitch,
    );
  }

  private heldRaySpace(): Object3D | undefined {
    const raySpaces = this.world.player.raySpaces;
    if (this.handTriggerHeld(raySpaces.right)) return raySpaces.right;
    if (this.handTriggerHeld(raySpaces.left)) return raySpaces.left;
    return undefined;
  }

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
    // Traverse limits live on the entity; cannons keep the stock ±45° default.
    const yawRange = Number(cannon.getValue(CannonAim, 'yawRangeDeg'));
    cannon.setValue(
      CannonAim,
      'yawDeg',
      clamp(yawDeg, -yawRange, yawRange),
    );
    // Elevation limits live on the entity; cannons get the stock 0-80 envelope.
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
