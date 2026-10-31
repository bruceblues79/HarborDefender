/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  AdditiveBlending,
  createSystem,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';
import {
  ChiefDeathLight,
  GameOver,
  GamePaused,
  IslewrathChief,
  LevelDirector,
} from './components.js';
import { DEATH_LIGHT } from './level-config.js';
import { rawSrgbColor } from './hit-flash-system.js';

/** Lightning bolt: segment count and the peak lateral noise (m). */
const BOLT_SEGMENTS = 16;
const BOLT_JITTER = 0.11;
/** Segment length padding (x) so joints stay covered at any offset. */
const BOLT_JOINT_OVERLAP = 1.12;
/** Beam widths (m): red cross-slice glow, near-white hot core inside. */
const BOLT_GLOW_WIDTH = 0.065;
const BOLT_CORE_WIDTH = 0.024;
const SWEEP_GLOW_WIDTH = 0.18;
const SWEEP_CORE_WIDTH = 0.075;
/** Draw after every default transparent object (SpawnFade hulls, bars). */
const FX_RENDER_ORDER = 10;

/** sRGB hex: death-light deep red glow, near-white hot core. */
const EDGE_RED = 0xff2f24;
const CORE_HOT = 0xffddd0;

/** Per-chief fx rig: plain Object3D children under a root-level entity. */
interface ChiefDeathLightFxRig {
  /** Owner chief entity — the liveness probe for the per-frame reconcile. */
  owner: Entity;
  /** The root-level world-space rig entity; disposed on teardown. */
  entity: Entity;
  group: Object3D;
  boltGroup: Object3D;
  sweepGroup: Object3D;
  /** Lightning: glow+core meshes per (slice x segment); 0/1 = slice A/B. */
  boltGlows: Mesh[];
  boltCores: Mesh[];
  /** Sweep beam: two cross-slices of glow + core quads. */
  sweepGlows: Mesh[];
  sweepCores: Mesh[];
  /**
   * Continuous-bolt jitter state: lateral (perpA, perpB) offset per shared
   * joint node ((K+1) nodes, both end nodes pinned at zero), re-rolled
   * every frame for the fast writhing.
   */
  boltNodeOffsets: Float32Array;
}

/**
 * Visual rig for the chief death light (铁头死光) — a pure derived view of
 * the `ChiefDeathLight` state, never a writer of it:
 *
 * - lightning bolt: a CONTINUOUS polyline between the FROZEN bolt
 *   endpoints — neighbouring segments share their joint node (a cross-slice
 *   quad pair per span), so the bolt reads as one connected ribbon. The
 *   joint offsets re-roll every frame (fast writhing); the zero-offset end
 *   nodes pin both endpoints, so the bolt always connects chief and victim.
 *   No growth: it snaps on with the component and vanishes when boltTimer
 *   runs out.
 * - sweep beam: the same red cross-slice, unsegmented, stretched along the
 *   sweeping axis — the beam tracks the lerped wall-face aim the attack
 *   system derives from the frozen endpoints, so the fx never reads the
 *   scene graph. `forming` scales the width in over formSec (no charge
 *   props), `sweeping` holds full width with a plasma flicker.
 *
 * The rig hangs under a ROOT-LEVEL transform entity: both beams live in
 * world space (the frozen component fields are world coordinates), and the
 * head yaws beneath the sweep beam independently. Qualify builds one rig
 * per chief, disqualify tears it down; only shared geometry/materials stay
 * for the next battle.
 */
export class ChiefDeathLightFxSystem extends createSystem({
  chiefs: { required: [IslewrathChief, ChiefDeathLight] },
  directors: { required: [LevelDirector] },
}) {
  /** fx rig per chief entity index; the rig entity is root-level. */
  private readonly rigs = new Map<number, ChiefDeathLightFxRig>();
  // Shared geometry/materials — every rig reuses them.
  private quadGeometry!: PlaneGeometry;
  private glowMaterial!: MeshBasicMaterial;
  private coreMaterial!: MeshBasicMaterial;
  // Pre-allocated math scratch — update() never allocates.
  private readonly origin = new Vector3();
  private readonly target = new Vector3();
  private readonly dir = new Vector3();
  private readonly perpA = new Vector3();
  private readonly perpB = new Vector3();
  private readonly center = new Vector3();
  /** Continuous-bolt walk: segment start node, end node, span direction. */
  private readonly nodeA = new Vector3();
  private readonly nodeB = new Vector3();
  private readonly segDir = new Vector3();
  private readonly aimA = new Vector3();
  private readonly aimB = new Vector3();
  private readonly aim = new Vector3();
  private readonly UP = new Vector3(0, 1, 0);
  private readonly qAlign = new Quaternion();
  private readonly qSpin = new Quaternion();

  init(): void {
    this.quadGeometry = new PlaneGeometry(1, 1);
    // Additive cross-slice quads, visible from both sides, depth-write free.
    this.glowMaterial = new MeshBasicMaterial({
      color: rawSrgbColor(EDGE_RED),
      side: DoubleSide,
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });
    this.coreMaterial = new MeshBasicMaterial({
      color: rawSrgbColor(CORE_HOT),
      side: DoubleSide,
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });

    this.queries.chiefs.subscribe('qualify', (entity) => {
      this.rigs.set(entity.index, this.buildRig(entity));
    });
    // The chief left the query (killed or the field cleared): drop the rig.
    // The ROOT-LEVEL rig entity disposes — never the chief, whose death is
    // single-truthed in ShellHitSystem's kill(); shared geometry/materials
    // survive for the next battle.
    this.queries.chiefs.subscribe('disqualify', (entity) => {
      this.teardownRig(entity.index);
    });
  }

  /**
   * Drop one rig: unpin the group and dispose the root-level rig entity
   * (its release detaches the Object3D). The single teardown truth for both
   * the disqualify subscriber and the reconcile sweep in update().
   */
  private teardownRig(index: number): void {
    const rig = this.rigs.get(index);
    if (!rig) return;
    rig.group.removeFromParent();
    rig.entity.dispose({ disposeResources: false });
    this.rigs.delete(index);
  }

  /** Build one root-level rig: bolt group + sweep group, both hidden. */
  private buildRig(owner: Entity): ChiefDeathLightFxRig {
    const group = new Object3D();
    group.name = 'chief-death-light-fx';

    const boltGroup = new Object3D();
    boltGroup.visible = false;
    const boltGlows: Mesh[] = [];
    const boltCores: Mesh[] = [];
    for (let i = 0; i < BOLT_SEGMENTS * 2; i++) {
      const glow = new Mesh(this.quadGeometry, this.glowMaterial);
      glow.renderOrder = FX_RENDER_ORDER;
      const core = new Mesh(this.quadGeometry, this.coreMaterial);
      core.renderOrder = FX_RENDER_ORDER + 1;
      boltGroup.add(glow, core);
      boltGlows.push(glow);
      boltCores.push(core);
    }
    group.add(boltGroup);

    const sweepGroup = new Object3D();
    sweepGroup.visible = false;
    const sweepGlows: Mesh[] = [];
    const sweepCores: Mesh[] = [];
    for (let i = 0; i < 2; i++) {
      const glow = new Mesh(this.quadGeometry, this.glowMaterial);
      glow.renderOrder = FX_RENDER_ORDER;
      const core = new Mesh(this.quadGeometry, this.coreMaterial);
      core.renderOrder = FX_RENDER_ORDER + 1;
      sweepGroup.add(glow, core);
      sweepGlows.push(glow);
      sweepCores.push(core);
    }
    group.add(sweepGroup);

    // Root-level world-space entity — the frozen component fields are world
    // coordinates; nothing parents the fx to the (yawing) head.
    const entity = this.world.createTransformEntity(group);
    return {
      owner,
      entity,
      group,
      boltGroup,
      sweepGroup,
      boltGlows,
      boltCores,
      sweepGlows,
      sweepCores,
      boltNodeOffsets: new Float32Array((BOLT_SEGMENTS + 1) * 2),
    };
  }

  update(delta: number): void {
    // Reconcile: disqualify owns rig teardown, but elics dispatches the
    // subscriber chain synchronously inside dispose — an earlier subscriber
    // throwing aborts the rest, and the root-level world-space beam would
    // float frozen forever. Drop any rig whose chief is already dead.
    for (const [index, rig] of this.rigs) {
      if (!rig.owner.active) this.teardownRig(index);
    }
    // Settlement screen: retire every rig instead of freezing a half-drawn
    // bolt or beam behind the overlay.
    if (this.over()) {
      this.hideAll();
      return;
    }
    // Pause discipline: hold the fx exactly where the simulation stopped.
    if (this.paused()) return;
    for (const chief of this.queries.chiefs.entities) {
      const rig = this.rigs.get(chief.index);
      if (!rig) continue;
      if (Number(chief.getValue(ChiefDeathLight, 'boltTimer')) > 0) {
        this.layoutBolt(rig, chief);
        rig.boltGroup.visible = true;
      } else if (rig.boltGroup.visible) {
        rig.boltGroup.visible = false;
      }

      const state = String(chief.getValue(ChiefDeathLight, 'state'));
      if (state === 'forming' || state === 'sweeping') {
        const t =
          state === 'forming'
            ? 0
            : 1 - Number(chief.getValue(ChiefDeathLight, 'timer')) / DEATH_LIGHT.sweepSec;
        const widthScale =
          state === 'forming'
            ? 1 - Number(chief.getValue(ChiefDeathLight, 'timer')) / DEATH_LIGHT.formSec
            : 1;
        const elapsed =
          state === 'forming'
            ? DEATH_LIGHT.formSec - Number(chief.getValue(ChiefDeathLight, 'timer'))
            : DEATH_LIGHT.sweepSec - Number(chief.getValue(ChiefDeathLight, 'timer'));
        this.layoutSweep(rig, chief, t, widthScale, elapsed);
        rig.sweepGroup.visible = true;
      } else if (rig.sweepGroup.visible) {
        rig.sweepGroup.visible = false;
      }
    }
  }

  /**
   * Lightning layout: a CONTINUOUS polyline between the frozen endpoints.
   * (K+1) shared joint nodes carry the lateral offsets — re-rolled every
   * frame for the fast writhing, both end nodes pinned at zero — and each
   * cross-slice quad pair spans node i -> node i+1, so the bolt reads as
   * one connected ribbon, never disjointed chunks. The 12% length padding
   * keeps every joint covered while the spans swing.
   */
  private layoutBolt(rig: ChiefDeathLightFxRig, chief: Entity): void {
    this.origin.set(
      Number(chief.getValue(ChiefDeathLight, 'boltOriginX')),
      Number(chief.getValue(ChiefDeathLight, 'boltOriginY')),
      Number(chief.getValue(ChiefDeathLight, 'boltOriginZ')),
    );
    this.target.set(
      Number(chief.getValue(ChiefDeathLight, 'boltTargetX')),
      Number(chief.getValue(ChiefDeathLight, 'boltTargetY')),
      Number(chief.getValue(ChiefDeathLight, 'boltTargetZ')),
    );
    this.dir.copy(this.target).sub(this.origin);
    const length = this.dir.length();
    if (length < 1e-6) return;
    this.dir.divideScalar(length);
    // Two frame-stable perpendiculars for the cross slices and the jitter.
    this.perpA.copy(this.UP).cross(this.dir);
    if (this.perpA.lengthSq() < 1e-6) this.perpA.set(1, 0, 0);
    this.perpA.normalize();
    this.perpB.copy(this.dir).cross(this.perpA).normalize();

    // Fast writhing: the shared node offsets re-roll every frame.
    const nodes = rig.boltNodeOffsets;
    for (let i = 0; i <= BOLT_SEGMENTS; i++) {
      // sin envelope: zero at both end nodes, peak mid-bolt.
      const env = Math.sin(Math.PI * (i / BOLT_SEGMENTS));
      nodes[i * 2] = (Math.random() * 2 - 1) * BOLT_JITTER * env;
      nodes[i * 2 + 1] = (Math.random() * 2 - 1) * BOLT_JITTER * 0.6 * env;
    }

    // Walk the polyline: segment i spans node i -> node i+1.
    this.nodeA.copy(this.origin);
    for (let i = 0; i < BOLT_SEGMENTS; i++) {
      this.nodeB
        .copy(this.origin)
        .addScaledVector(this.dir, length * ((i + 1) / BOLT_SEGMENTS))
        .addScaledVector(this.perpA, rig.boltNodeOffsets[(i + 1) * 2])
        .addScaledVector(this.perpB, rig.boltNodeOffsets[(i + 1) * 2 + 1]);
      this.center.copy(this.nodeA).add(this.nodeB).multiplyScalar(0.5);
      this.segDir.copy(this.nodeB).sub(this.nodeA);
      const segLen = this.segDir.length();
      if (segLen < 1e-6) {
        this.nodeA.copy(this.nodeB);
        continue;
      }
      this.segDir.divideScalar(segLen);
      this.qAlign.setFromUnitVectors(this.UP, this.segDir);
      for (let slice = 0; slice < 2; slice++) {
        const index = i * 2 + slice;
        const glow = rig.boltGlows[index];
        const core = rig.boltCores[index];
        glow.position.copy(this.center);
        core.position.copy(this.center);
        // Slice B spins the quad 90 degrees around the span axis.
        glow.quaternion.copy(this.qAlign);
        core.quaternion.copy(this.qAlign);
        if (slice === 1) {
          this.qSpin.setFromAxisAngle(this.UP, Math.PI / 2);
          glow.quaternion.multiply(this.qSpin);
          core.quaternion.multiply(this.qSpin);
        }
        glow.scale.set(BOLT_GLOW_WIDTH, segLen * BOLT_JOINT_OVERLAP, 1);
        core.scale.set(BOLT_CORE_WIDTH, segLen * BOLT_JOINT_OVERLAP, 1);
      }
      this.nodeA.copy(this.nodeB);
    }
  }

  /**
   * Sweep layout: one long cross-slice pair along the current beam axis —
   * the attack system's frozen origin + the lerped aim endpoint. widthScale
   * carries the 0.1 s form-in; the flicker sines read as live plasma.
   */
  private layoutSweep(
    rig: ChiefDeathLightFxRig,
    chief: Entity,
    t: number,
    widthScale: number,
    elapsed: number,
  ): void {
    this.origin.set(
      Number(chief.getValue(ChiefDeathLight, 'originX')),
      Number(chief.getValue(ChiefDeathLight, 'originY')),
      Number(chief.getValue(ChiefDeathLight, 'originZ')),
    );
    this.aimA.set(
      Number(chief.getValue(ChiefDeathLight, 'aimAX')),
      Number(chief.getValue(ChiefDeathLight, 'aimAY')),
      Number(chief.getValue(ChiefDeathLight, 'aimAZ')),
    );
    this.aimB.set(
      Number(chief.getValue(ChiefDeathLight, 'aimBX')),
      Number(chief.getValue(ChiefDeathLight, 'aimBY')),
      Number(chief.getValue(ChiefDeathLight, 'aimBZ')),
    );
    this.aim.lerpVectors(this.aimA, this.aimB, t).sub(this.origin);
    const aimDist = this.aim.length();
    if (aimDist < 1e-6) return;
    this.dir.copy(this.aim).divideScalar(aimDist);
    const length = aimDist * DEATH_LIGHT.beamLengthBoost;
    this.center.copy(this.origin).addScaledVector(this.dir, length / 2);
    this.qAlign.setFromUnitVectors(this.UP, this.dir);
    // Violent plasma churn — the beam's width pulses hard and fast.
    const glowFlicker = 1 + 0.3 * Math.sin(elapsed * 60);
    const coreFlicker = 1 + 0.22 * Math.sin(elapsed * 80 + 1.7);
    for (let slice = 0; slice < 2; slice++) {
      const glow = rig.sweepGlows[slice];
      const core = rig.sweepCores[slice];
      glow.position.copy(this.center);
      core.position.copy(this.center);
      glow.quaternion.copy(this.qAlign);
      core.quaternion.copy(this.qAlign);
      if (slice === 1) {
        this.qSpin.setFromAxisAngle(this.UP, Math.PI / 2);
        glow.quaternion.multiply(this.qSpin);
        core.quaternion.multiply(this.qSpin);
      }
      glow.scale.set(SWEEP_GLOW_WIDTH * widthScale * glowFlicker, length, 1);
      core.scale.set(SWEEP_CORE_WIDTH * widthScale * coreFlicker, length, 1);
    }
  }

  /** Hide every rig's groups (idempotent — skips already-hidden ones). */
  private hideAll(): void {
    for (const rig of this.rigs.values()) {
      if (rig.boltGroup.visible) rig.boltGroup.visible = false;
      if (rig.sweepGroup.visible) rig.sweepGroup.visible = false;
    }
  }

  /** True while the pause-menu tag sits on the director entity. */
  private paused(): boolean {
    for (const director of this.queries.directors.entities) {
      return director.hasComponent(GamePaused);
    }
    return false;
  }

  /** True once the run has ended (victory or defeat). */
  private over(): boolean {
    for (const director of this.queries.directors.entities) {
      return director.hasComponent(GameOver);
    }
    return false;
  }
}
