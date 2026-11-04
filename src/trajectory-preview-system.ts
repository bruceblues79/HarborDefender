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
 * ocean far-edge backstop). The arc is then resampled at a fixed spatial
 * step (TRAJECTORY_PREVIEW.stepDistance): dot gaps stay uniform from muzzle
 * to splash regardless of how the shell sheds speed.
 *
 * Rendering is one always-alive InstancedMesh (per frame at most maxDots
 * instance matrices + .count) — zero allocation, matching the
 * no-allocate-in-update rule. The trigger is CannonAimSystem's whole-gesture
 * `AimDragging` tag — no new input bookkeeping here — so the phase gating is
 * inherited for free: outside the running phase cannons cannot be dragged,
 * so the guide never appears. When two guns are somehow dragged at once (two
 * XR hands), the first query entry wins — one guide, deterministically.
 *
 * Hit tint: every march sample is a position the fired shell would really
 * occupy, so a sample inside an attacker hit core means the shot lands — the
 * whole guide flips from gold to a saturated cool green. All dots share one
 * material, so the flip is a single uniform write; it is held for
 * TRAJECTORY_PREVIEW.hitHoldSec after the last touching frame so the colour
 * does not strobe while the aim sweeps across a hull edge. Attacker cores
 * only, resolved exactly like ShellHitSystem so preview and flight agree on
 * what counts as a hit.
 */
export class TrajectoryPreviewSystem extends createSystem({
  guides: { required: [TrajectoryPreview] },
  guns: { required: [CannonAim], excluded: [Destroyed] },
  // CannonAimSystem stamps AimDragging at its drag-session anchors, so the
  // guide tracks the whole gesture — pointer sliding off the mount mid-drag
  // (browser) or a wandering ray (XR) never drops it, same as the drag.
  aiming: { required: [CannonAim, AimDragging], excluded: [Destroyed] },
  cores: { required: [HitCore, Health], excluded: [Destroyed] },
  directors: { required: [LevelDirector] },
}) {
  /** Muzzle object per gun entity index, resolved once on qualify. */
  private readonly muzzles = new Map<number, Object3D>();
  /**
   * Attacker cores this arc can land on, rebuilt on qualify/disqualify only —
   * update() walks this flat array so no Map iteration allocates per frame.
   */
  private readonly targets: GuideTarget[] = [];
  /** Dot-row guide. */
  private mesh: InstancedMesh | null = null;
  /** Shared material: the hit tint is one uniform write per state flip. */
  private material: MeshBasicMaterial | null = null;
  /** True while the guide's last frame touched a core (or the hold runs). */
  private hot = false;
  /** Hold left after the last touching frame — anti-flicker, in seconds. */
  private hotHold = 0;
  /** Scratch transform for composing instance matrices; never allocated. */
  private readonly dummy = new Object3D();
  private readonly muzzlePos = new Vector3();
  private readonly muzzleDir = new Vector3();
  /** Preallocated closed-form march buffers: xyz per sample plus the
   * cumulative arc length at each sample, bridging the two passes. */
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

    // Targets of a defender shot: attacker cores, resolved exactly like
    // ShellHitSystem (direct child first, nodeName from the component) so the
    // guide's notion of a hit matches what the flight will do.
    this.queries.cores.subscribe('qualify', (entity) => {
      if (String(entity.getValue(HitCore, 'faction')) !== 'attacker') return;
      const object = entity.object3D;
      const coreName = String(entity.getValue(HitCore, 'nodeName'));
      const node =
        object?.children.find((child) => child.name === coreName) ??
        object?.getObjectByName(coreName);
      if (!node) return;
      // Same consume volume as ShellHitSystem: the authored core radius
      // scaled by the shared shell-precision factor.
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
    const dt = TRAJECTORY_PREVIEW.sampleStep;
    const splashY = OCEAN.surfaceY - COMBAT.splashMargin;

    // Pass one marches the closed form at a fine fixed time step, storing
    // each sample and the cumulative arc length up to it. Sample 0 is the
    // muzzle itself (length 0). Terminations mirror BallisticSystem exactly —
    // shells end at the water, and the far-edge backstop covers the rest.
    // Closed form of the drag-loaded flight: (v/k)(1-e^(-kt)) horizontally,
    // gravity's ((vy + g/k)/k)(1-e^(-kt)) - (g/k)·t vertically.
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

    // Hit state: every march sample is a shell position the flight really
    // reaches, so a sample within a core radius is a hit. The loops invert —
    // one core at a time, then the point sweep — because the answer is a
    // boolean; the first touch exits both. Every sample above the water is
    // tested, which is exactly the window ShellHitSystem sees: BallisticSystem
    // recycles a shell the frame it crosses splashY, before the hit sweep runs.
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

    // Anti-flicker hold: a touch refreshes the window and the guide keeps the
    // tint until it has gone untouched for the whole window. The tint flips
    // once, on the edge — no lerp, no per-frame colour write.
    if (touching) this.hotHold = TRAJECTORY_PREVIEW.hitHoldSec;
    else if (this.hotHold > 0) this.hotHold -= delta;
    const hot = touching || this.hotHold > 0;
    if (hot !== this.hot) {
      this.hot = hot;
      this.material?.color.setHex(
        hot ? TRAJECTORY_PREVIEW.hitColor : TRAJECTORY_PREVIEW.color,
      );
    }

    // Pass two resamples the arc uniformly — one dot every stepDistance
    // metres of path length, linearly interpolated between march samples —
    // so gaps never bunch as the shell sheds speed. The size taper rides
    // along: dotScaleNear at the muzzle growing linearly to full size at the
    // water end. Scale-only, no alpha.
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

  /** Drop the guide when no gun is being dragged (or while paused / over). */
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
