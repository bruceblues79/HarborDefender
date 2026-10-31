/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  AdditiveBlending,
  BackSide,
  Color,
  createSystem,
  CylinderGeometry,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Quaternion,
  ShaderMaterial,
  SphereGeometry,
  TetrahedronGeometry,
  Vector3,
} from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';
import { GameOver, GamePaused, LaserCycle, LevelDirector } from './components.js';
import { BOSS } from './level-config.js';
import { rawSrgbColor } from './hit-flash-system.js';

/** Charged energy shards: count, tetra size, and the shell they spawn on. */
const PARTICLE_COUNT = 24;
const PARTICLE_SIZE = 0.035;
const PARTICLE_SHELL = 0.66;
/** Each shard loops from the shell to the centre this many times per charge. */
const PARTICLE_LOOPS = 2;
/** Muzzle glow sphere radius at full charge (fresnel: blue rim, white core). */
const GLOW_RADIUS = 0.168;
/** Beam radii: white-hot inner core, deep-blue inverted-normal outer glow. */
const BEAM_CORE_RADIUS = 0.0504;
const BEAM_GLOW_RADIUS = 0.1152;
/** Draw after every default transparent object (SpawnFade hulls, bars). */
const FX_RENDER_ORDER = 10;

/** sRGB hex: glow/beam rim blue, beam core near-white, shard blue->cyan lerp. */
const EDGE_BLUE = 0x2244ee;
const CORE_WHITE = 0xffffff;
const BEAM_CORE_WHITE = 0xeef6ff;
const SHARD_BLUE = 0x2244ff;
const SHARD_CYAN = 0x66ddff;

/** Per-cannon fx rig: plain Object3D children under the frozen muzzle node. */
interface LaserFxRig {
  /** Owner laser entity — the liveness probe for the per-frame reconcile. */
  entity: Entity;
  group: Object3D;
  particles: InstancedMesh;
  /** Unit spawn direction per shard, muzzle-local (3 floats each). */
  dirs: Float32Array;
  /** Spawn-shell radius factor per shard. */
  radii: Float32Array;
  /** Loop stagger per shard, [0, 1). */
  phases: Float32Array;
  /** Fresnel charge sphere; its cloned material carries the uProgress. */
  glow: Mesh;
  beam: Object3D;
  beamCore: Mesh;
  beamGlow: Mesh;
}

/**
 * Visual rig for the boss laser main cannon — a pure derived view of the
 * `LaserCycle` state, never a writer of it:
 *
 * - charging: instanced energy shards spiral-converge onto the muzzle
 *   (scalar position math only — no physics), while a fresnel sphere swells
 *   and brightens at the muzzle (deep-blue rim, white-hot core);
 * - firing: a two-layer additive cylinder stretches along the FROZEN beam
 *   axis — inner white core (FrontSide) inside a deep-blue outer glow
 *   (BackSide, the inverted-normal look), both depthWrite-free.
 *
 * Every mesh hangs under the muzzle node in its LOCAL space: the beam
 * geometry is pre-rotated to span z ∈ [-1, 0], so `scale.z = length` points
 * it down the muzzle's -Z — which equals the frozen world direction, since
 * the hull is berthed and the pivot frozen when the axis locks. Qualify
 * builds the rig (one per laser entity), disqualify tears it down; only
 * per-entity cloned materials and instance buffers are disposed — the
 * shared geometry/templates survive for the next battle.
 */
export class LaserFxSystem extends createSystem({
  lasers: { required: [LaserCycle] },
  directors: { required: [LevelDirector] },
}) {
  /** fx rig per laser entity index; the muzzle node is its parent. */
  private readonly rigs = new Map<number, LaserFxRig>();
  // Shared geometry — created once, cloned from by every rig build.
  private particleGeometry!: TetrahedronGeometry;
  private glowGeometry!: SphereGeometry;
  private beamGeometry!: CylinderGeometry;
  // Shared materials — per-entity state lives in instance buffers/uniforms.
  private particleMaterial!: MeshBasicMaterial;
  private beamCoreMaterial!: MeshBasicMaterial;
  private beamGlowMaterial!: MeshBasicMaterial;
  private glowMaterialTemplate!: ShaderMaterial;
  // Pre-allocated math scratch — update() never allocates.
  private readonly composeMatrix = new Matrix4();
  private readonly identityQuat = new Quaternion();
  private readonly shardPos = new Vector3();
  private readonly shardScale = new Vector3();
  private readonly shardColor = new Color();

  init(): void {
    this.particleGeometry = new TetrahedronGeometry(PARTICLE_SIZE);
    this.glowGeometry = new SphereGeometry(1, 16, 12);
    // Unit cylinder pre-rotated onto -Z and shifted to span z ∈ [-1, 0]:
    // scale.z stretches the beam from the muzzle along the frozen axis.
    this.beamGeometry = new CylinderGeometry(1, 1, 1, 10, 1, true);
    this.beamGeometry.rotateX(Math.PI / 2);
    this.beamGeometry.translate(0, 0, -0.5);

    this.particleMaterial = new MeshBasicMaterial({
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });
    this.beamCoreMaterial = new MeshBasicMaterial({
      color: rawSrgbColor(BEAM_CORE_WHITE),
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });
    // Inverted normals: BackSide renders the tube's inner surface, so the
    // glow thickens toward the axis instead of shading off at grazing angles.
    this.beamGlowMaterial = new MeshBasicMaterial({
      color: rawSrgbColor(EDGE_BLUE),
      side: BackSide,
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });
    // Charge sphere: same fresnel trick as the hit flash, driven by
    // uProgress instead of uOpacity — brightens and saturates as it swells.
    this.glowMaterialTemplate = new ShaderMaterial({
      vertexShader: /* glsl */ `
        varying vec3 vNormal;
        varying vec3 vViewDir;
        void main() {
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          vNormal = normalize(normalMatrix * normal);
          vViewDir = normalize(-mvPosition.xyz);
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uProgress;
        uniform vec3 uCenterColor;
        uniform vec3 uEdgeColor;
        varying vec3 vNormal;
        varying vec3 vViewDir;
        void main() {
          float fresnel =
            pow(1.0 - abs(dot(normalize(vNormal), normalize(vViewDir))), 1.5);
          float intensity = 0.25 + 0.75 * uProgress;
          vec3 color = mix(uCenterColor, uEdgeColor, fresnel) * intensity;
          gl_FragColor = vec4(color, intensity);
        }
      `,
      uniforms: {
        uProgress: { value: 0 },
        uCenterColor: { value: rawSrgbColor(CORE_WHITE) },
        uEdgeColor: { value: rawSrgbColor(EDGE_BLUE) },
      },
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
    });

    this.queries.lasers.subscribe('qualify', (entity) => {
      const turret = entity.object3D;
      if (!turret) return;
      const muzzle = turret.getObjectByName(
        String(entity.getValue(LaserCycle, 'muzzleName')),
      );
      if (!muzzle) return;
      this.rigs.set(entity.index, this.buildRig(muzzle, entity));
    });
    // The turret left the query (boss torn down or turret destroyed): drop
    // the rig. Per-entity resources only — the muzzle node itself belongs to
    // the prototype clone and must survive for the next battle.
    this.queries.lasers.subscribe('disqualify', (entity) => {
      this.teardownRig(entity.index);
    });
  }

  /**
   * Drop one rig: per-entity resources disposed, group unpinned from the
   * muzzle, map entry cleared. The single teardown truth for both the
   * disqualify subscriber and the reconcile sweep in update().
   */
  private teardownRig(index: number): void {
    const rig = this.rigs.get(index);
    if (!rig) return;
    (rig.glow.material as ShaderMaterial).dispose();
    rig.particles.dispose();
    rig.group.removeFromParent();
    this.rigs.delete(index);
  }

  /** Build the charge/beam rig under the given muzzle node. */
  private buildRig(muzzle: Object3D, entity: Entity): LaserFxRig {
    const group = new Object3D();
    group.name = 'laser-fx';
    group.visible = false;

    // Converging energy shards: per-instance spawn direction, shell radius
    // and loop stagger, frozen at build time — update() only integrates.
    const particles = new InstancedMesh(
      this.particleGeometry,
      this.particleMaterial,
      PARTICLE_COUNT,
    );
    particles.instanceMatrix.setUsage(DynamicDrawUsage);
    particles.frustumCulled = false;
    particles.renderOrder = FX_RENDER_ORDER;
    const dirs = new Float32Array(PARTICLE_COUNT * 3);
    const radii = new Float32Array(PARTICLE_COUNT);
    const phases = new Float32Array(PARTICLE_COUNT);
    const shardBlue = rawSrgbColor(SHARD_BLUE);
    const shardCyan = rawSrgbColor(SHARD_CYAN);
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      // Uniform sphere pick: cos-weighted latitude + full-longitude turn.
      const turn = Math.random() * Math.PI * 2;
      const latitude = Math.random() * 2 - 1;
      const ring = Math.sqrt(1 - latitude * latitude);
      dirs[i * 3] = ring * Math.cos(turn);
      dirs[i * 3 + 1] = latitude;
      dirs[i * 3 + 2] = ring * Math.sin(turn);
      radii[i] = 0.55 + Math.random() * 0.45;
      phases[i] = (i + Math.random() * 0.6) / PARTICLE_COUNT;
      this.shardColor.copy(shardBlue).lerp(shardCyan, Math.random());
      particles.setColorAt(i, this.shardColor);
    }
    if (particles.instanceColor) particles.instanceColor.needsUpdate = true;
    group.add(particles);

    const glow = new Mesh(
      this.glowGeometry,
      this.glowMaterialTemplate.clone(),
    );
    glow.renderOrder = FX_RENDER_ORDER;
    group.add(glow);

    const beam = new Object3D();
    const beamGlow = new Mesh(this.beamGeometry, this.beamGlowMaterial);
    beamGlow.renderOrder = FX_RENDER_ORDER;
    const beamCore = new Mesh(this.beamGeometry, this.beamCoreMaterial);
    beamCore.renderOrder = FX_RENDER_ORDER + 1;
    beam.add(beamGlow, beamCore);
    group.add(beam);

    muzzle.add(group);
    return { entity, group, particles, dirs, radii, phases, glow, beam, beamCore, beamGlow };
  }

  update(delta: number): void {
    // Reconcile: disqualify owns rig teardown, but elics dispatches the
    // subscriber chain synchronously inside dispose — an earlier subscriber
    // throwing aborts the rest, and the beam would outlive its cannon. Drop
    // any rig whose owner entity is already dead, one frame late at worst.
    for (const [index, rig] of this.rigs) {
      if (!rig.entity.active) this.teardownRig(index);
    }
    // Settlement screen: the run is over — retire every rig instead of
    // freezing a half-drawn beam or charge cloud behind the overlay.
    if (this.over()) {
      this.hideAll();
      return;
    }
    // Same freeze discipline as the cycle system: pauses hold the fx exactly
    // where the simulation stopped. State drives everything else.
    if (this.paused()) return;
    for (const entity of this.queries.lasers.entities) {
      const rig = this.rigs.get(entity.index);
      if (!rig) continue;
      const state = String(entity.getValue(LaserCycle, 'state'));
      if (state === 'charging') {
        const chargeSec = Number(entity.getValue(LaserCycle, 'chargeSec'));
        const t = Math.min(
          1,
          Math.max(0, 1 - Number(entity.getValue(LaserCycle, 'timer')) / chargeSec),
        );
        rig.group.visible = true;
        this.animateCharge(rig, t);
        continue;
      }
      if (state === 'firing') {
        const fireSec = Number(entity.getValue(LaserCycle, 'fireSec'));
        const elapsed = fireSec - Number(entity.getValue(LaserCycle, 'timer'));
        const length = Number(entity.getValue(LaserCycle, 'length'));
        rig.group.visible = true;
        this.animateBeam(rig, elapsed, length);
        continue;
      }
      if (rig.group.visible) rig.group.visible = false;
    }
  }

  /**
   * Charge beat: shards loop inward from their spawn shell (accelerating
   * converge, shrinking as they fall in) while the fresnel sphere swells
   * from a seed toward GLOW_RADIUS and brightens through uProgress.
   */
  private animateCharge(rig: LaserFxRig, t: number): void {
    rig.particles.visible = true;
    rig.glow.visible = true;
    rig.beam.visible = false;
    const { dirs, radii, phases } = rig;
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      // Per-shard inward loop: 0 spawns on the shell, 1 lands on the muzzle.
      const cycle = (t * PARTICLE_LOOPS + phases[i]) % 1;
      const fall = 1 - cycle * cycle; // accelerating drop toward the centre
      const r = radii[i] * PARTICLE_SHELL * fall;
      this.shardPos.set(
        dirs[i * 3] * r,
        dirs[i * 3 + 1] * r,
        dirs[i * 3 + 2] * r,
      );
      const s = Math.max(0.15, 1 - cycle * 0.85);
      this.shardScale.setScalar(s);
      this.composeMatrix.compose(
        this.shardPos,
        this.identityQuat,
        this.shardScale,
      );
      rig.particles.setMatrixAt(i, this.composeMatrix);
    }
    rig.particles.instanceMatrix.needsUpdate = true;
    const ease = 1 - (1 - t) ** 3; // EaseOutCubic swell
    rig.glow.scale.setScalar(GLOW_RADIUS * (0.15 + 0.85 * ease));
    (rig.glow.material as ShaderMaterial).uniforms.uProgress.value = t;
  }

  /**
   * Firing beat: stretch the two-layer beam along the frozen axis and wobble
   * the radii with offset sines — a live sweep reads as plasma, a rigid tube
   * reads as geometry. Length comes straight from the frozen component data.
   */
  private animateBeam(rig: LaserFxRig, elapsed: number, length: number): void {
    rig.particles.visible = false;
    rig.glow.visible = false;
    rig.beam.visible = true;
    rig.beam.scale.set(1, 1, Math.max(0.01, length));
    const glowFlicker = 1 + 0.18 * Math.sin(elapsed * 46);
    const coreFlicker = 1 + 0.12 * Math.sin(elapsed * 61 + 1.7);
    rig.beamGlow.scale.set(BEAM_GLOW_RADIUS * glowFlicker, BEAM_GLOW_RADIUS * glowFlicker, 1);
    rig.beamCore.scale.set(BEAM_CORE_RADIUS * coreFlicker, BEAM_CORE_RADIUS * coreFlicker, 1);
  }

  /** Hide every rig's group (idempotent — skips already-hidden ones). */
  private hideAll(): void {
    for (const rig of this.rigs.values()) {
      if (rig.group.visible) rig.group.visible = false;
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
