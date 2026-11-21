/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  AdditiveBlending,
  createSystem,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  PlaneGeometry,
  ShaderMaterial,
  Vector3,
} from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';
import {
  GamePaused,
  LevelDirector,
  SparkBurst,
  SparkBurstTag,
} from './components.js';
import { COMBAT } from './level-config.js';
import { rawSrgbColor } from './hit-flash-system.js';

/** Per-particle state: position, velocity, age, life, base size. */
const P_FLOATS = 9;
const POS = 0;
const VEL = 3;
const AGE = 6;
const LIFE = 7;
const SIZE = 8;

/**
 * Owns the shared impact-ember pool and integrates every playing burst.
 *
 * Pool: `COMBAT.hitSparkPoolSize` InstancedMeshes created once at init, all
 * sharing one plane geometry AND one material — the gradient lives in the
 * fragment shader, so nothing is allocated or recompiled per play. A burst is
 * free exactly while it does NOT carry `SparkBurst` (ShellHitSystem claims one
 * by adding that component). Recycling hides the mesh and returns it to the
 * pool; nothing is ever disposed.
 *
 * Per-particle state lives in system-side typed arrays indexed by pool slot,
 * so `update()` never allocates. Claim -> randomise runs on the synchronous
 * `qualify` callback: the burst is fully posed before its first update tick.
 *
 * Billboard: the vertex shader centres each instance on the particle point and
 * applies the instance scale on the view-space X/Y axes, so the quads always
 * face the eye without any per-frame camera math on the CPU.
 */
export class SparkBurstSystem extends createSystem({
  bursts: { required: [SparkBurst] },
  directors: { required: [LevelDirector] },
}) {
  /** Per-slot particle state, indexed `slot * particles * 9 + particle * 9`. */
  private readonly partState = new Float32Array(
    COMBAT.hitSparkPoolSize * COMBAT.hitSparkParticles * P_FLOATS,
  );
  /** Pool slot per pooled entity index, resolved once at init. */
  private readonly slots = new Map<number, number>();
  /** Bursts that reached zero this frame; recycled after the sweep. */
  private readonly expired: Entity[] = [];
  /** Snapshot buffer for bulk recall; allocated once, reused per call. */
  private readonly retiring: Entity[] = [];
  // Scratch objects, allocated once — never inside update().
  private readonly matrix = new Matrix4();
  private readonly position = new Vector3();

  init(): void {
    const geometry = new PlaneGeometry(1, 1);
    const material = createBillboardEmberMaterial(
      COMBAT.hitSparkCoreColor,
      COMBAT.hitSparkEdgeColor,
    );
    for (let slot = 0; slot < COMBAT.hitSparkPoolSize; slot++) {
      const mesh = new InstancedMesh(
        geometry,
        material,
        COMBAT.hitSparkParticles,
      );
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      // Embers travel far beyond the pooled origin — never cull.
      mesh.frustumCulled = false;
      mesh.visible = false;
      // Draw after every default-order transparent object (hull spawn fades
      // are alpha-blended; additive must land on top of them).
      mesh.renderOrder = 10;
      const entity = this.world.createTransformEntity(mesh);
      this.slots.set(entity.index, slot);
      entity.addComponent(SparkBurstTag);
    }
    // Claim time: the spawner's addComponent(SparkBurst) lands here
    // synchronously, so scattering happens the very frame the burst spawns.
    this.queries.bursts.subscribe('qualify', (entity) => {
      this.scatterBurst(entity);
    });
  }

  /**
   * Randomise one claimed burst's particles and write their initial instance
   * matrices. Runs on `qualify`, so the burst is fully posed before its first
   * update tick.
   */
  private scatterBurst(entity: Entity): void {
    const slot = this.slots.get(entity.index);
    if (slot === undefined) return;
    const mesh = entity.object3D as InstancedMesh | undefined;
    if (!mesh) return;
    const duration = Number(entity.getValue(SparkBurst, 'duration'));
    const sizeRatio = Number(entity.getValue(SparkBurst, 'sizeRatio'));
    const count = Math.min(
      COMBAT.hitSparkParticles,
      Math.max(0, Math.floor(Number(entity.getValue(SparkBurst, 'count')))),
    );
    mesh.count = count;
    const base = slot * COMBAT.hitSparkParticles * P_FLOATS;
    const state = this.partState;
    for (let particle = 0; particle < count; particle++) {
      const f = base + particle * P_FLOATS;
      // Launch: randomised upward-biased cone, speed scaled by the burst.
      const angle = Math.random() * Math.PI * 2;
      const speed =
        COMBAT.hitSparkSpeedMin +
        Math.random() * (COMBAT.hitSparkSpeedMax - COMBAT.hitSparkSpeedMin);
      const horizontal = 0.6 + Math.random() * 0.6;
      state[f + VEL] = Math.cos(angle) * horizontal * speed;
      state[f + VEL + 1] = (0.35 + Math.random() * 0.9) * speed;
      state[f + VEL + 2] = Math.sin(angle) * horizontal * speed;
      state[f + AGE] = 0;
      // Per-particle life inside the burst window: the embers thin out
      // instead of all dying on the same frame.
      state[f + LIFE] = duration * (0.4 + Math.random() * 0.6);
      state[f + SIZE] =
        (COMBAT.hitSparkSizeMin +
          Math.random() * (COMBAT.hitSparkSizeMax - COMBAT.hitSparkSizeMin)) *
        sizeRatio;
      state[f + POS] = (Math.random() * 2 - 1) * 0.03 * sizeRatio;
      state[f + POS + 1] = Math.random() * 0.03 * sizeRatio;
      state[f + POS + 2] = (Math.random() * 2 - 1) * 0.03 * sizeRatio;
      this.writeParticle(mesh, slot, particle, state[f + SIZE]);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  /** Compose and upload one particle's instance matrix (zero size if dead). */
  private writeParticle(
    mesh: InstancedMesh,
    slot: number,
    particle: number,
    size: number,
  ): void {
    const f =
      slot * COMBAT.hitSparkParticles * P_FLOATS + particle * P_FLOATS;
    const state = this.partState;
    this.position.set(
      state[f + POS],
      state[f + POS + 1],
      state[f + POS + 2],
    );
    this.matrix.makeScale(size, size, 1);
    this.matrix.setPosition(this.position);
    mesh.setMatrixAt(particle, this.matrix);
  }

  update(delta: number): void {
    if (this.paused()) return;
    this.expired.length = 0;
    const state = this.partState;
    for (const entity of this.queries.bursts.entities) {
      const duration = Number(entity.getValue(SparkBurst, 'duration'));
      const elapsed = Number(entity.getValue(SparkBurst, 'elapsed')) + delta;
      const object = entity.object3D as InstancedMesh | undefined;
      if (!object) continue;
      if (elapsed >= duration) {
        this.expired.push(entity);
        continue;
      }
      entity.setValue(SparkBurst, 'elapsed', elapsed);
      const slot = this.slots.get(entity.index);
      if (slot === undefined) continue;
      const count = Math.min(
        COMBAT.hitSparkParticles,
        Math.max(0, Math.floor(Number(entity.getValue(SparkBurst, 'count')))),
      );
      const base = slot * COMBAT.hitSparkParticles * P_FLOATS;
      // Drag and gravity per second, resolved once for every particle.
      const drag = Math.max(0, 1 - COMBAT.hitSparkDrag * delta);
      const fall = COMBAT.hitSparkGravity * delta;
      for (let particle = 0; particle < count; particle++) {
        const f = base + particle * P_FLOATS;
        const age = state[f + AGE] + delta;
        state[f + AGE] = age;
        const life = state[f + LIFE];
        if (age >= life) {
          this.writeParticle(object, slot, particle, 0);
          continue;
        }
        state[f + VEL] *= drag;
        state[f + VEL + 2] *= drag;
        state[f + VEL + 1] = state[f + VEL + 1] * drag - fall;
        state[f + POS] += state[f + VEL] * delta;
        state[f + POS + 1] += state[f + VEL + 1] * delta;
        state[f + POS + 2] += state[f + VEL + 2] * delta;
        // Shrink to nothing over the ember's life: additive light fades out
        // without any per-instance opacity attribute.
        const remaining = 1 - age / life;
        this.writeParticle(
          object,
          slot,
          particle,
          state[f + SIZE] * remaining,
        );
      }
      object.instanceMatrix.needsUpdate = true;
    }
    // Recycle, never dispose(): pooled entities return to the free list.
    for (const entity of this.expired) {
      entity.removeComponent(SparkBurst);
      if (entity.object3D) entity.object3D.visible = false;
    }
  }

  /** True while the pause-menu tag sits on the director entity. */
  private paused(): boolean {
    for (const director of this.queries.directors.entities) {
      return director.hasComponent(GamePaused);
    }
    return false;
  }

  /** Recall every playing burst to the pool (RESTART / MAIN reset). */
  recycleAll(): void {
    this.retiring.length = 0;
    for (const entity of this.queries.bursts.entities) {
      this.retiring.push(entity);
    }
    for (const entity of this.retiring) {
      entity.removeComponent(SparkBurst);
      if (entity.object3D) entity.object3D.visible = false;
    }
  }
}

/**
 * Shared billboard-embers material: one camera-facing soft dot with a hot core
 * and a cool rim, drawn additively. Reused by the impact sparks and the
 * burning wreck flame so both effects stay one visual family.
 */
export function createBillboardEmberMaterial(
  coreHex: number,
  edgeHex: number,
): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec4 center = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        vec3 scale = vec3(
          length(instanceMatrix[0].xyz),
          length(instanceMatrix[1].xyz),
          1.0
        );
        vec4 mvPosition = modelViewMatrix * center;
        mvPosition.xy += position.xy * scale.xy;
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uCoreColor;
      uniform vec3 uEdgeColor;
      varying vec2 vUv;
      void main() {
        float d = length(vUv - 0.5) * 2.0;
        float alpha = smoothstep(1.0, 0.0, d);
        vec3 color = mix(uCoreColor, uEdgeColor, smoothstep(0.0, 0.9, d));
        gl_FragColor = vec4(color, alpha);
      }
    `,
    uniforms: {
      uCoreColor: { value: rawSrgbColor(coreHex) },
      uEdgeColor: { value: rawSrgbColor(edgeHex) },
    },
    transparent: true,
    // Additive embers add light on top of the scene; no depth write, same
    // transient-glow treatment as the hit flash.
    blending: AdditiveBlending,
    depthWrite: false,
  });
}
