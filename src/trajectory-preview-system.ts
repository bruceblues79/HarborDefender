/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  BoxGeometry,
  createSystem,
  DynamicDrawUsage,
  InstancedMesh,
  MeshBasicMaterial,
  Object3D,
  Vector3,
} from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';
import {
  AimDragging,
  CannonAim,
  Destroyed,
  GameOver,
  GamePaused,
  LevelDirector,
  TrajectoryPreview,
} from './components.js';
import {
  COMBAT,
  OCEAN,
  OCEAN_FAR_Z,
  TRAJECTORY_PREVIEW,
} from './level-config.js';

/**
 * Aim-drag trajectory guide: while a defense unit is being dragged, a guide
 * traces the shot its muzzle would launch right now — the sparse row of
 * small unlit cubes, tapered by instance scale alone — near-invisible at
 * the muzzle (dotScaleNear × dotSize), full size at the water end. No
 * alpha, no fade: the gradient lives in the same matrices already
 * rewritten every frame, so it costs nothing beyond the dots themselves.
 *
 * The sampling is the closed form of the live flight, not a re-simulation —
 * launch vector copied from CannonFireSystem.fire (muzzle world -Z scaled by
 * COMBAT.shellSpeed) flown under gravity plus COMBAT.shellDrag linear drag,
 * with the same two terminations BallisticSystem enforces (water splash,
 * ocean far-edge backstop). Horizontal speed decays exponentially, so equal
 * time steps bunch toward the tail: the dots double as a read on the shell
 * shedding speed, still with no arc-length math.
 *
 * Rendering is one always-alive InstancedMesh (per frame at most maxDots
 * instance matrices + .count) — zero allocation, matching the
 * no-allocate-in-update rule. The trigger is CannonAimSystem's whole-gesture
 * `AimDragging` tag — no new input bookkeeping here — so the phase gating is
 * inherited for free: outside the running phase cannons cannot be dragged,
 * so the guide never appears. When two guns are somehow dragged at once (two
 * XR hands), the first query entry wins — one guide, deterministically.
 */
export class TrajectoryPreviewSystem extends createSystem({
  guides: { required: [TrajectoryPreview] },
  guns: { required: [CannonAim], excluded: [Destroyed] },
  // CannonAimSystem stamps AimDragging at its drag-session anchors, so the
  // guide tracks the whole gesture — pointer sliding off the mount mid-drag
  // (browser) or a wandering ray (XR) never drops it, same as the drag.
  aiming: { required: [CannonAim, AimDragging], excluded: [Destroyed] },
  directors: { required: [LevelDirector] },
}) {
  /** Muzzle object per gun entity index, resolved once on qualify. */
  private readonly muzzles = new Map<number, Object3D>();
  /** Dot-row guide. */
  private mesh: InstancedMesh | null = null;
  /** Scratch transform for composing instance matrices; never allocated. */
  private readonly dummy = new Object3D();
  private readonly muzzlePos = new Vector3();
  private readonly muzzleDir = new Vector3();
  /** Preallocated dot sample store (xyz per dot) bridging the two passes. */
  private readonly dotPositions = new Float32Array(
    TRAJECTORY_PREVIEW.maxDots * 3,
  );

  init(): void {
    const geometry = new BoxGeometry(
      TRAJECTORY_PREVIEW.dotSize,
      TRAJECTORY_PREVIEW.dotSize,
      TRAJECTORY_PREVIEW.dotSize,
    );
    const material = new MeshBasicMaterial({
      color: TRAJECTORY_PREVIEW.color,
      toneMapped: false,
    });
    const mesh = new InstancedMesh(geometry, material, TRAJECTORY_PREVIEW.maxDots);
    // Instance matrices move every frame; skip per-instance culling, whose
    // bounds would otherwise lag the rewritten matrices.
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.count = 0;
    mesh.visible = false;
    this.mesh = mesh;
    this.world.createTransformEntity(mesh).addComponent(TrajectoryPreview);

    this.queries.guns.subscribe('qualify', (entity) => {
      const muzzle = entity.object3D?.getObjectByName('muzzle');
      if (muzzle) this.muzzles.set(entity.index, muzzle);
    });
  }

  update(): void {
    if (this.paused() || this.over()) {
      this.hide();
      return;
    }
    // Two guns pressed at once (two XR hands): the first query entry wins —
    // one guide, deterministically.
    let dragged: Entity | undefined;
    for (const entity of this.queries.aiming.entities) {
      dragged = entity;
      break;
    }
    const muzzle = dragged ? this.muzzles.get(dragged.index) : undefined;
    if (!dragged || !muzzle || !this.mesh) {
      this.hide();
      return;
    }

    muzzle.getWorldPosition(this.muzzlePos);
    // Object3D.getWorldDirection returns +Z; the barrel fires down its -Z
    // (same convention as CannonFireSystem.fire).
    muzzle.getWorldDirection(this.muzzleDir).negate();
    const speed = COMBAT.shellSpeed;
    const vx = this.muzzleDir.x * speed;
    const vy = this.muzzleDir.y * speed;
    const vz = this.muzzleDir.z * speed;
    const g = COMBAT.gravity;
    const k = COMBAT.shellDrag;
    const dt = TRAJECTORY_PREVIEW.timeStep;
    const splashY = OCEAN.surfaceY - COMBAT.splashMargin;

    let count = 0;
    // Pass one samples the flight into dotPositions. i starts at 1: the first
    // dot sits one step out of the muzzle, not inside the barrel.
    // Terminations mirror BallisticSystem exactly — shells end at the water,
    // and the far-edge backstop covers the rest. Closed form of the
    // drag-loaded flight: (v/k)(1-e^(-kt)) horizontally, gravity's
    // ((vy + g/k)/k)(1-e^(-kt)) - (g/k)·t vertically.
    for (let i = 1; count < TRAJECTORY_PREVIEW.maxDots; i++) {
      const t = i * dt;
      const decay = Math.exp(-k * t);
      const y =
        this.muzzlePos.y + ((vy + g / k) / k) * (1 - decay) - (g / k) * t;
      if (y <= splashY) break;
      if (this.muzzlePos.z + (vz / k) * (1 - decay) <= OCEAN_FAR_Z) break;
      const o = count * 3;
      this.dotPositions[o] = this.muzzlePos.x + (vx / k) * (1 - decay);
      this.dotPositions[o + 1] = y;
      this.dotPositions[o + 2] = this.muzzlePos.z + (vz / k) * (1 - decay);
      count++;
    }
    // Pass two recomposes the matrices with the size taper: dot index reads
    // as an even gradient along the arc — dotScaleNear at the muzzle growing
    // linearly to full size at the water end. Scale-only, no alpha.
    if (count > 0) {
      const near = TRAJECTORY_PREVIEW.dotScaleNear;
      const last = Math.max(1, count - 1);
      for (let i = 0; i < count; i++) {
        const s = near + (1 - near) * (i / last);
        this.dummy.position.set(
          this.dotPositions[i * 3],
          this.dotPositions[i * 3 + 1],
          this.dotPositions[i * 3 + 2],
        );
        this.dummy.scale.setScalar(s);
        this.dummy.updateMatrix();
        this.mesh.setMatrixAt(i, this.dummy.matrix);
      }
    }
    this.mesh.count = count;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.visible = count > 0;
  }

  /** Drop the guide when no gun is being dragged (or while paused / over). */
  private hide(): void {
    if (this.mesh?.visible) this.mesh.visible = false;
  }

  /** True while the pause-menu tag sits on the director entity. */
  private paused(): boolean {
    for (const director of this.queries.directors.entities) {
      return director.hasComponent(GamePaused);
    }
    return false;
  }

  /** True once the run has ended — the guide goes down with the guns. */
  private over(): boolean {
    for (const director of this.queries.directors.entities) {
      return director.hasComponent(GameOver);
    }
    return false;
  }
}
