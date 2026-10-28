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
  Pressed,
  Vector3,
} from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';
import {
  CannonAim,
  CannonFire,
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
 * Aim-drag trajectory guide: while a defense unit is being dragged, a sparse
 * row of small unlit cubes traces the shot its muzzle would launch right now.
 *
 * The sampling is the closed form of the live flight, not a re-simulation —
 * launch vector copied from CannonFireSystem.fire (muzzle world -Z scaled by
 * COMBAT.shellSpeed), gravity per CannonFire.gravityScale, and the same three
 * terminations BallisticSystem enforces (water splash, straight-bolt reclaim
 * ceiling, ocean far-edge backstop). Horizontal speed is constant mid-flight,
 * so equal time steps land at equal horizontal gaps: the dots read evenly
 * spaced on any arc without any arc-length math.
 *
 * Rendering is one InstancedMesh (TRAJECTORY_PREVIEW.maxDots capacity, one
 * draw call): per frame the system rewrites at most maxDots instance matrices
 * and the .count — zero allocation, matching the no-allocate-in-update rule.
 * The trigger reuses the aim system's own drag semantics (CannonAim + Pressed
 * with no new state), so the phase gating is inherited for free: outside the
 * running phase cannons cannot be dragged, so the guide never appears. When
 * two guns are somehow pressed at once (two XR hands), the first query entry
 * wins — one guide, deterministically.
 */
export class TrajectoryPreviewSystem extends createSystem({
  guides: { required: [TrajectoryPreview] },
  guns: { required: [CannonAim], excluded: [Destroyed] },
  aiming: { required: [CannonAim, Pressed], excluded: [Destroyed] },
  directors: { required: [LevelDirector] },
}) {
  /** Muzzle object per gun entity index, resolved once on qualify. */
  private readonly muzzles = new Map<number, Object3D>();
  private mesh: InstancedMesh | null = null;
  /** Scratch transform for composing instance matrices; never allocated. */
  private readonly dummy = new Object3D();
  private readonly muzzlePos = new Vector3();
  private readonly muzzleDir = new Vector3();

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
    const g =
      COMBAT.gravity * Number(dragged.getValue(CannonFire, 'gravityScale'));
    const splashY = OCEAN.surfaceY - COMBAT.splashMargin;
    const dt = TRAJECTORY_PREVIEW.timeStep;

    let count = 0;
    // i starts at 1: the first dot sits one step out of the muzzle, not
    // inside the barrel. Terminations mirror BallisticSystem exactly —
    // shells end at the water, straight bolts at the reclaim ceiling, and
    // the far-edge backstop covers both.
    for (let i = 1; count < TRAJECTORY_PREVIEW.maxDots; i++) {
      const t = i * dt;
      const y = this.muzzlePos.y + vy * t - 0.5 * g * t * t;
      if (y <= splashY || y >= COMBAT.boltReclaimY) break;
      if (this.muzzlePos.z + vz * t <= OCEAN_FAR_Z) break;
      this.dummy.position.set(
        this.muzzlePos.x + vx * t,
        y,
        this.muzzlePos.z + vz * t,
      );
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(count, this.dummy.matrix);
      count++;
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
