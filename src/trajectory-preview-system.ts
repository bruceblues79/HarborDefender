/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  createSystem,
  DoubleSide,
  DynamicDrawUsage,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Vector3,
} from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';
import {
  AimDragging,
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

/** Guard against dividing by ~0 when solving the bolt's death point. */
const BOLT_LINE_EPS = 1e-6;

/**
 * Aim-drag trajectory guide: while a defense unit is being dragged, a guide
 * traces the shot its muzzle would launch right now. Two render modes share
 * one sampler, picked per dragged gun by its CannonFire.gravityScale:
 *
 * - Parabolic shots (gravityScale > 0, the cannons) keep the sparse row of
 *   small unlit cubes, tapered by instance scale alone — near-invisible at
 *   the muzzle (dotScaleNear × dotSize), full size at the water end. No
 *   alpha, no fade: the gradient lives in the same matrices already
 *   rewritten every frame, so it costs nothing beyond the dots themselves.
 * - Straight bolts (gravityScale 0, the sky ballista) draw one continuous
 *   crossed-ribbon line — two thin quads crossing at 90°, so the guide keeps
 *   its width from every viewing angle (a single flat ribbon collapses
 *   edge-on). Its alpha gradient is baked into the vertex colours and
 *   brightens toward the far end: alphaNear at the muzzle, alphaFar (the aim
 *   far end) at the bolt's death point.
 *
 * The sampling is the closed form of the live flight, not a re-simulation —
 * launch vector copied from CannonFireSystem.fire (muzzle world -Z scaled by
 * COMBAT.shellSpeed), gravity per CannonFire.gravityScale, and the same three
 * terminations BallisticSystem enforces (water splash, straight-bolt reclaim
 * ceiling, ocean far-edge backstop). Horizontal speed is constant mid-flight,
 * so equal time steps land at equal horizontal gaps: the dots read evenly
 * spaced on any arc without any arc-length math. The straight line solves its
 * termination boundary exactly instead of marching — a continuous ribbon
 * would make a one-step overshoot visible.
 *
 * Rendering is two always-alive meshes, one visible at a time: the dot row is
 * one InstancedMesh (per frame at most maxDots instance matrices + .count),
 * the ribbon is one Mesh whose transform alone redraws it (the vertex-alpha
 * gradient stretches with it) — zero allocation, matching the
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
  /** Dot-row guide for parabolic shots. */
  private mesh: InstancedMesh | null = null;
  /** Crossed-ribbon guide for straight bolts. */
  private lineMesh: Mesh | null = null;
  /** Scratch transform for composing instance matrices; never allocated. */
  private readonly dummy = new Object3D();
  private readonly muzzlePos = new Vector3();
  private readonly muzzleDir = new Vector3();
  /** Preallocated dot sample store (xyz per dot) bridging the two passes. */
  private readonly dotPositions = new Float32Array(
    TRAJECTORY_PREVIEW.maxDots * 3,
  );
  /** Local +Z of the ribbon geometry — setFromUnitVectors' from-vector. */
  private readonly unitZ = new Vector3(0, 0, 1);

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

    const lineGeometry = this.buildBoltLineGeometry();
    const lineMaterial = new MeshBasicMaterial({
      color: TRAJECTORY_PREVIEW.color,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      toneMapped: false,
    });
    const lineMesh = new Mesh(lineGeometry, lineMaterial);
    lineMesh.frustumCulled = false;
    lineMesh.visible = false;
    this.lineMesh = lineMesh;
    this.world.createTransformEntity(lineMesh).addComponent(TrajectoryPreview);

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
    if (!dragged || !muzzle || !this.mesh || !this.lineMesh) {
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
    const gravityScale = Number(
      dragged.getValue(CannonFire, 'gravityScale'),
    );
    const splashY = OCEAN.surfaceY - COMBAT.splashMargin;

    // Straight bolts (gravityScale 0 — the sky ballista) draw the continuous
    // fade ribbon; every other shot keeps the sparse dot row.
    if (gravityScale === 0) {
      if (this.mesh.visible) this.mesh.visible = false;
      this.showBoltLine(vy, vz, splashY, speed);
      return;
    }
    if (this.lineMesh.visible) this.lineMesh.visible = false;
    const g = COMBAT.gravity * gravityScale;
    const dt = TRAJECTORY_PREVIEW.timeStep;

    let count = 0;
    // Pass one samples the flight into dotPositions. i starts at 1: the first
    // dot sits one step out of the muzzle, not inside the barrel.
    // Terminations mirror BallisticSystem exactly — shells end at the water,
    // straight bolts at the reclaim ceiling, and the far-edge backstop
    // covers both.
    for (let i = 1; count < TRAJECTORY_PREVIEW.maxDots; i++) {
      const t = i * dt;
      const y = this.muzzlePos.y + vy * t - 0.5 * g * t * t;
      if (y <= splashY || y >= COMBAT.boltReclaimY) break;
      if (this.muzzlePos.z + vz * t <= OCEAN_FAR_Z) break;
      const o = count * 3;
      this.dotPositions[o] = this.muzzlePos.x + vx * t;
      this.dotPositions[o + 1] = y;
      this.dotPositions[o + 2] = this.muzzlePos.z + vz * t;
      count++;
    }
    // Pass two recomposes the matrices with the size taper: equal time steps
    // land at equal horizontal gaps, so interpolating by dot index reads as
    // an even gradient along the arc — dotScaleNear at the muzzle growing
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

  /**
   * Straight-bolt guide: one continuous crossed ribbon from the muzzle to the
   * bolt's exact death point. tEnd is the closed form of BallisticSystem's
   * terminations — the earliest of the reclaim ceiling (bolt climbing),
   * splash-down (descending) and the ocean far-edge backstop; sign guards
   * keep the solve total for degenerate aim directions. The ribbon geometry
   * runs 0→1 along local +Z, so positioning at the muzzle, rotating +Z onto
   * the launch direction and scaling z by the flight length redraws the whole
   * guide — the baked vertex-alpha gradient stretches with it and stays
   * normalized (alphaNear at the muzzle, alphaFar at the death point).
   */
  private showBoltLine(
    vy: number,
    vz: number,
    splashY: number,
    speed: number,
  ): void {
    if (!this.lineMesh) return;
    let tEnd = Infinity;
    if (vy > BOLT_LINE_EPS) {
      tEnd = Math.min(tEnd, (COMBAT.boltReclaimY - this.muzzlePos.y) / vy);
    } else if (vy < -BOLT_LINE_EPS) {
      tEnd = Math.min(tEnd, (splashY - this.muzzlePos.y) / vy);
    }
    if (vz < -BOLT_LINE_EPS) {
      tEnd = Math.min(tEnd, (OCEAN_FAR_Z - this.muzzlePos.z) / vz);
    }
    if (!Number.isFinite(tEnd) || tEnd <= 0) {
      this.lineMesh.visible = false;
      return;
    }
    this.lineMesh.position.copy(this.muzzlePos);
    this.lineMesh.quaternion.setFromUnitVectors(this.unitZ, this.muzzleDir);
    this.lineMesh.scale.set(1, 1, tEnd * speed);
    this.lineMesh.visible = true;
  }

  /**
   * Two unit-length ribbons crossing at 90°, both running 0→1 along local
   * +Z with the shared gold colour and the baked alpha gradient (alphaNear
   * at the z=0 muzzle end, alphaFar at the z=1 tip). Width is baked in —
   * the update only ever scales z.
   */
  private buildBoltLineGeometry(): BufferGeometry {
    const half = TRAJECTORY_PREVIEW.lineWidth / 2;
    const alphas = [
      TRAJECTORY_PREVIEW.lineAlphaNear,
      TRAJECTORY_PREVIEW.lineAlphaNear,
      TRAJECTORY_PREVIEW.lineAlphaFar,
      TRAJECTORY_PREVIEW.lineAlphaFar,
      TRAJECTORY_PREVIEW.lineAlphaNear,
      TRAJECTORY_PREVIEW.lineAlphaNear,
      TRAJECTORY_PREVIEW.lineAlphaFar,
      TRAJECTORY_PREVIEW.lineAlphaFar,
    ];
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      'position',
      new BufferAttribute(
        new Float32Array([
          // Horizontal ribbon (x spans the width, y = 0).
          -half, 0, 0, half, 0, 0, half, 0, 1, -half, 0, 1,
          // Vertical ribbon (y spans the width, x = 0).
          0, -half, 0, 0, half, 0, 0, half, 1, 0, -half, 1,
        ]),
        3,
      ),
    );
    const colors = new Float32Array(8 * 4);
    for (let v = 0; v < 8; v++) {
      colors[v * 4] = 1;
      colors[v * 4 + 1] = 1;
      colors[v * 4 + 2] = 1;
      colors[v * 4 + 3] = alphas[v];
    }
    geometry.setAttribute('color', new BufferAttribute(colors, 4));
    geometry.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    return geometry;
  }

  /** Drop the guide when no gun is being dragged (or while paused / over). */
  private hide(): void {
    if (this.mesh?.visible) this.mesh.visible = false;
    if (this.lineMesh?.visible) this.lineMesh.visible = false;
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
