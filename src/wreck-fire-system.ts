/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  createSystem,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  PlaneGeometry,
  Vector3,
} from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';
import {
  ChiefMount,
  GamePaused,
  LevelDirector,
  WreckFire,
  WreckFireTag,
} from './components.js';
import { COMBAT } from './level-config.js';
import { createBillboardEmberMaterial } from './spark-burst-system.js';

/** Per-particle state: age, life, size, rise speed, sway phase, offsets. */
const P_FLOATS = 7;
const AGE = 0;
const LIFE = 1;
const SIZE = 2;
const RISE = 3;
const PHASE = 4;
const OFFSET_X = 5;
const OFFSET_Z = 6;

/**
 * Owns the shared burning-wreck pool: the looping flame a destroyed boss
 * turret leaves on the deck.
 *
 * Each emitter keeps its few quads alive for as long as the Islewrath hull is
 * still afloat: a particle that reaches the end of its short life respawns at
 * the emitter with fresh speed, size and sway, so the flame reads as
 * continuous without ever allocating anything. Quads are local — the point is
 * a fire cue at the turret's socket, not a scene-wide smoke column. Once the
 * hull itself is gone (no entity carrying `ChiefMount`, which only the boss
 * hull has) every flame is recycled, which is also the signal that the boss is
 * fully destroyed.
 */
export class WreckFireSystem extends createSystem({
  emitters: { required: [WreckFire] },
  bossHulls: { required: [ChiefMount] },
  directors: { required: [LevelDirector] },
}) {
  /** Per-slot particle state, indexed `slot * particles * 7 + particle * 7`. */
  private readonly partState = new Float32Array(
    COMBAT.wreckFirePoolSize * COMBAT.wreckFireParticles * P_FLOATS,
  );
  /** Pool slot per pooled entity index, resolved once at init. */
  private readonly slots = new Map<number, number>();
  /** Snapshot buffer for bulk recall; allocated once, reused per call. */
  private readonly retiring: Entity[] = [];
  // Scratch objects, allocated once — never inside update().
  private readonly matrix = new Matrix4();
  private readonly position = new Vector3();

  init(): void {
    const geometry = new PlaneGeometry(1, 1);
    const material = createBillboardEmberMaterial(
      COMBAT.wreckFireCoreColor,
      COMBAT.wreckFireEdgeColor,
    );
    for (let slot = 0; slot < COMBAT.wreckFirePoolSize; slot++) {
      const mesh = new InstancedMesh(
        geometry,
        material,
        COMBAT.wreckFireParticles,
      );
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      // Embers rise past the pooled origin — never cull.
      mesh.frustumCulled = false;
      mesh.visible = false;
      // Same additive layer as the hit flash and impact sparks.
      mesh.renderOrder = 10;
      const entity = this.world.createTransformEntity(mesh);
      this.slots.set(entity.index, slot);
      entity.addComponent(WreckFireTag);
    }
    this.queries.emitters.subscribe('qualify', (entity) => {
      this.seedEmitter(entity);
    });
  }

  /**
   * Stagger the few embers across their lifespans so the flame is already
   * continuous on the first frame, then write their initial matrices.
   */
  private seedEmitter(entity: Entity): void {
    const slot = this.slots.get(entity.index);
    if (slot === undefined) return;
    const mesh = entity.object3D as InstancedMesh | undefined;
    if (!mesh) return;
    const sizeRatio = Number(entity.getValue(WreckFire, 'sizeRatio'));
    for (let particle = 0; particle < COMBAT.wreckFireParticles; particle++) {
      const f = this.respawnParticle(slot, particle, sizeRatio);
      const state = this.partState;
      // Pre-advance the ages so the column does not pulse on spawn.
      state[f + AGE] = Math.random() * state[f + LIFE];
      this.writeParticle(mesh, slot, particle, state[f + SIZE]);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  /** Fill one slot/particle's state; used by seeding and by recycling. */
  private respawnParticle(
    slot: number,
    particle: number,
    sizeRatio: number,
  ): number {
    const f =
      slot * COMBAT.wreckFireParticles * P_FLOATS + particle * P_FLOATS;
    const state = this.partState;
    state[f + AGE] = 0;
    state[f + LIFE] =
      COMBAT.wreckFireLifeMin +
      Math.random() * (COMBAT.wreckFireLifeMax - COMBAT.wreckFireLifeMin);
    state[f + SIZE] =
      (COMBAT.wreckFireSizeMin +
        Math.random() * (COMBAT.wreckFireSizeMax - COMBAT.wreckFireSizeMin)) *
      sizeRatio;
    state[f + RISE] =
      COMBAT.wreckFireRiseMin +
      Math.random() * (COMBAT.wreckFireRiseMax - COMBAT.wreckFireRiseMin);
    state[f + PHASE] = Math.random() * Math.PI * 2;
    state[f + OFFSET_X] = (Math.random() * 2 - 1) * 0.02;
    state[f + OFFSET_Z] = (Math.random() * 2 - 1) * 0.02;
    return f;
  }

  /** Compose and upload one particle's instance matrix (zero size if dead). */
  private writeParticle(
    mesh: InstancedMesh,
    slot: number,
    particle: number,
    size: number,
  ): void {
    const f =
      slot * COMBAT.wreckFireParticles * P_FLOATS + particle * P_FLOATS;
    const state = this.partState;
    const age = state[f + AGE];
    const sway = age * 7;
    this.position.set(
      state[f + OFFSET_X] + Math.sin(state[f + PHASE] + sway) * COMBAT.wreckFireDrift,
      state[f + RISE] * age,
      state[f + OFFSET_Z] + Math.cos(state[f + PHASE] * 1.3 + sway) * COMBAT.wreckFireDrift,
    );
    this.matrix.makeScale(size, size, 1);
    this.matrix.setPosition(this.position);
    mesh.setMatrixAt(particle, this.matrix);
  }

  update(delta: number): void {
    if (this.paused()) return;
    // The hull is the contract: while the Islewrath exists its dead turrets
    // keep burning; the moment it is fully destroyed the flames go with it.
    if (!this.bossAlive()) {
      this.recycleAll();
      return;
    }
    const state = this.partState;
    for (const entity of this.queries.emitters.entities) {
      const object = entity.object3D as InstancedMesh | undefined;
      if (!object) continue;
      const slot = this.slots.get(entity.index);
      if (slot === undefined) continue;
      const sizeRatio = Number(entity.getValue(WreckFire, 'sizeRatio'));
      for (let particle = 0; particle < COMBAT.wreckFireParticles; particle++) {
        const f =
          slot * COMBAT.wreckFireParticles * P_FLOATS + particle * P_FLOATS;
        const age = state[f + AGE] + delta;
        if (age >= state[f + LIFE]) {
          // Loop: the ember restarts at the emitter, keeping the fire alive.
          this.respawnParticle(slot, particle, sizeRatio);
        } else {
          state[f + AGE] = age;
        }
        const life = state[f + LIFE];
        const alive = state[f + AGE];
        const fadeIn = Math.min(1, alive / 0.12);
        const shrink = 1 - alive / life;
        // Slight sine flicker keeps the quads from looking like a still decal
        // without costing any extra state.
        const flicker = 0.8 + 0.2 * Math.sin(alive * 26 + state[f + PHASE]);
        this.writeParticle(
          object,
          slot,
          particle,
          state[f + SIZE] * shrink * fadeIn * flicker,
        );
      }
      object.instanceMatrix.needsUpdate = true;
    }
  }

  /** True while the boss hull entity is still in the world. */
  private bossAlive(): boolean {
    return this.queries.bossHulls.entities.size > 0;
  }

  /** True while the pause-menu tag sits on the director entity. */
  private paused(): boolean {
    for (const director of this.queries.directors.entities) {
      return director.hasComponent(GamePaused);
    }
    return false;
  }

  /** Recall every burning wreck (RESTART / MAIN reset). */
  recycleAll(): void {
    this.retiring.length = 0;
    for (const entity of this.queries.emitters.entities) {
      this.retiring.push(entity);
    }
    for (const entity of this.retiring) {
      entity.removeComponent(WreckFire);
      if (entity.object3D) entity.object3D.visible = false;
    }
  }
}
