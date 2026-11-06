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
  Health,
  HitCore,
  LevelDirector,
  TrajectoryPreview,
} from './components.js';
import {
  COMBAT,
  OCEAN,
  OCEAN_FAR_Z,
  TRAJECTORY_PREVIEW,
} from './level-config.js';

/** March-sample ceiling: the longest flight (~2 s at 0.02 s) stays under it. */
const MAX_SAMPLES = 160;

/** An attacker hit core the guide's arc can land on. Built once on qualify. */
interface GuideTarget {
  readonly index: number;
  readonly node: Object3D;
  /** World position of the core node, refreshed in place every frame. */
  readonly position: Vector3;
  readonly radiusSq: number;
}

/**
 * Aim-drag trajectory guide: closed-form march of the shot the muzzle would
 * launch, plus a hit tint. Trigger is CannonAimSystem's whole-gesture
 * `AimDragging` tag; instance buffers are preallocated.
 */
export class TrajectoryPreviewSystem extends createSystem({
  guides: { required: [TrajectoryPreview] },
  guns: { required: [CannonAim], excluded: [Destroyed] },
  // CannonAimSystem stamps AimDragging at its gesture anchors, so the guide
  // tracks the whole drag even when the pointer or ray wanders off.
  aiming: { required: [CannonAim, AimDragging], excluded: [Destroyed] },
  cores: { required: [HitCore, Health], excluded: [Destroyed] },
  directors: { required: [LevelDirector] },
}) {
  /** Muzzle object per gun entity index, resolved on qualify. */
  private readonly muzzles = new Map<number, Object3D>();
  /**
   * Attacker cores this arc can land on; flat array so update() never
   * allocates on Map iteration.
   */
  private readonly targets: GuideTarget[] = [];
  private mesh: InstancedMesh | null = null;
  /** Shared material: the hit tint is a single colour write. */
  private material: MeshBasicMaterial | null = null;
  /** True while the guide's last frame touched a core (or the hold runs). */
  private hot = false;
  /** Hold left after the last touching frame — anti-flicker, in seconds. */
  private hotHold = 0;
  /** Scratch transform for composing instance matrices; never allocated. */
  private readonly dummy = new Object3D();
  private readonly muzzlePos = new Vector3();
  private readonly muzzleDir = new Vector3();
  /** Preallocated march buffers: xyz per sample plus cumulative arc length. */
  private readonly pathPoints = new Float32Array(MAX_SAMPLES * 3);
  private readonly pathLens = new Float32Array(MAX_SAMPLES);

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
    this.material = material;
    this.world.createTransformEntity(mesh).addComponent(TrajectoryPreview);

    this.queries.guns.subscribe('qualify', (entity) => {
      const muzzle = entity.object3D?.getObjectByName('muzzle');
      if (muzzle) this.muzzles.set(entity.index, muzzle);
    });

    // Attacker cores resolved exactly like ShellHitSystem (direct child,
    // then nodeName), so preview and flight agree on what counts as a hit.
    this.queries.cores.subscribe('qualify', (entity) => {
      if (String(entity.getValue(HitCore, 'faction')) !== 'attacker') return;
      const object = entity.object3D;
      const coreName = String(entity.getValue(HitCore, 'nodeName'));
      const node =
        object?.children.find((child) => child.name === coreName) ??
        object?.getObjectByName(coreName);
      if (!node) return;
      // Same consume volume as ShellHitSystem: core radius × shell-precision.
      const radius =
        Number(entity.getValue(HitCore, 'radius')) * COMBAT.shellHitRadiusScale;
      this.targets.push({
        index: entity.index,
        node,
        position: new Vector3(),
        radiusSq: radius * radius,
      });
    });
    // A sunk ship leaves the query — drop its slot so no disposed node is read.
    this.queries.cores.subscribe('disqualify', (entity) => {
      for (let i = 0; i < this.targets.length; i++) {
        if (this.targets[i].index === entity.index) {
          this.targets.splice(i, 1);
          return;
        }
      }
    });
  }

  update(delta: number): void {
    if (this.paused() || this.over()) {
      this.hide();
      return;
    }
    // Two guns dragged at once: the first query entry wins.
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
    // getWorldDirection returns +Z; the barrel fires down its -Z
    // (CannonFireSystem.fire uses the same convention).
    muzzle.getWorldDirection(this.muzzleDir).negate();
    const speed = COMBAT.shellSpeed;
    const vx = this.muzzleDir.x * speed;
    const vy = this.muzzleDir.y * speed;
    const vz = this.muzzleDir.z * speed;
    const g = COMBAT.gravity;
    const k = COMBAT.shellDrag;
    const dt = TRAJECTORY_PREVIEW.sampleStep;
    const splashY = OCEAN.surfaceY - COMBAT.splashMargin;

    // Pass one marches the closed form at a fixed time step, storing samples
    // and cumulative arc length. Sample 0 is the muzzle. Terminations mirror
    // BallisticSystem: water splash, then the far-edge backstop.
    this.pathPoints[0] = this.muzzlePos.x;
    this.pathPoints[1] = this.muzzlePos.y;
    this.pathPoints[2] = this.muzzlePos.z;
    this.pathLens[0] = 0;
    let samples = 1;
    for (let i = 1; i < MAX_SAMPLES; i++) {
      const t = i * dt;
      const decay = Math.exp(-k * t);
      const y =
        this.muzzlePos.y + ((vy + g / k) / k) * (1 - decay) - (g / k) * t;
      if (y <= splashY) break;
      if (this.muzzlePos.z + (vz / k) * (1 - decay) <= OCEAN_FAR_Z) break;
      const o = samples * 3;
      const px = this.muzzlePos.x + (vx / k) * (1 - decay);
      const py = y;
      const pz = this.muzzlePos.z + (vz / k) * (1 - decay);
      const p = (samples - 1) * 3;
      this.pathLens[samples] =
        this.pathLens[samples - 1] +
        Math.hypot(
          px - this.pathPoints[p],
          py - this.pathPoints[p + 1],
          pz - this.pathPoints[p + 2],
        );
      this.pathPoints[o] = px;
      this.pathPoints[o + 1] = py;
      this.pathPoints[o + 2] = pz;
      samples++;
    }

    // Any sample within a core radius is a hit. The tested window matches
    // ShellHitSystem's: BallisticSystem recycles a shell the frame it crosses
    // splashY, before the hit sweep runs.
    let touching = false;
    for (let c = 0; c < this.targets.length; c++) {
      const target = this.targets[c];
      // Ships yaw after stopping, so the core moves with them frame to frame.
      target.node.getWorldPosition(target.position);
      for (let s = 1; s < samples; s++) {
        const o = s * 3;
        const dx = this.pathPoints[o] - target.position.x;
        const dy = this.pathPoints[o + 1] - target.position.y;
        const dz = this.pathPoints[o + 2] - target.position.z;
        if (dx * dx + dy * dy + dz * dz <= target.radiusSq) {
          touching = true;
          break;
        }
      }
      if (touching) break;
    }

    // Anti-flicker: a touch refreshes the hold; the tint flips once, on the edge.
    if (touching) this.hotHold = TRAJECTORY_PREVIEW.hitHoldSec;
    else if (this.hotHold > 0) this.hotHold -= delta;
    const hot = touching || this.hotHold > 0;
    if (hot !== this.hot) {
      this.hot = hot;
      this.material?.color.setHex(
        hot ? TRAJECTORY_PREVIEW.hitColor : TRAJECTORY_PREVIEW.color,
      );
    }

    // Pass two resamples uniformly (one dot per stepDistance of arc length) and
    // tapers scale only, from dotScaleNear at the muzzle to full size at the water.
    let count = Math.min(
      TRAJECTORY_PREVIEW.maxDots,
      Math.floor(this.pathLens[samples - 1] / TRAJECTORY_PREVIEW.stepDistance),
    );
    if (count > 0) {
      const near = TRAJECTORY_PREVIEW.dotScaleNear;
      const last = Math.max(1, count - 1);
      let seg = 1;
      for (let i = 0; i < count; i++) {
        const target = (i + 1) * TRAJECTORY_PREVIEW.stepDistance;
        while (seg < samples - 1 && this.pathLens[seg] < target) seg++;
        const s0 = this.pathLens[seg - 1];
        const s1 = this.pathLens[seg];
        const f = s1 > s0 ? (target - s0) / (s1 - s0) : 0;
        const a = (seg - 1) * 3;
        const b = seg * 3;
        const s = near + (1 - near) * (i / last);
        this.dummy.position.set(
          this.pathPoints[a] + (this.pathPoints[b] - this.pathPoints[a]) * f,
          this.pathPoints[a + 1] +
            (this.pathPoints[b + 1] - this.pathPoints[a + 1]) * f,
          this.pathPoints[a + 2] +
            (this.pathPoints[b + 2] - this.pathPoints[a + 2]) * f,
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

  private hide(): void {
    if (this.mesh?.visible) this.mesh.visible = false;
    // Reset the tint with the guide, so the next drag never starts green.
    if (this.hot) {
      this.hot = false;
      this.hotHold = 0;
      this.material?.color.setHex(TRAJECTORY_PREVIEW.color);
    }
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
