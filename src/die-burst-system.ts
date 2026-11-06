/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  BoxGeometry,
  Color,
  createSystem,
  DynamicDrawUsage,
  Euler,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';
import { DieBurst, DieBurstTag, GamePaused, LevelDirector } from './components.js';
import { COMBAT, OCEAN, WALL_LAND_FACE_Z, WALL_SEA_FACE_Z } from './level-config.js';

/**
 * Owns the shared death-burst pool; a burst is free while it lacks `DieBurst`
 * (ShellHitSystem claims one by adding it). Recycling never disposes.
 */
const CHUNK_FLOATS = 15; // pos3 + vel3 + angVel3 + scale3 + euler3 per chunk
const POS = 0;
const VEL = 3;
const ANG = 6;
const SCALE = 9;
const EUL = 12;

export class DieBurstSystem extends createSystem({
  bursts: { required: [DieBurst] },
  directors: { required: [LevelDirector] },
}) {
  /** Per-slot chunk state, indexed `slot * chunks * 15 + chunk * 15 + f`. */
  private readonly chunkState = new Float32Array(
    COMBAT.dieBurstPoolSize * COMBAT.dieBurstChunkCount * CHUNK_FLOATS,
  );
  /** Per-slot chunk life state: 0 hidden, 1 flying, 2 grounded. */
  private readonly chunkAlive = new Uint8Array(
    COMBAT.dieBurstPoolSize * COMBAT.dieBurstChunkCount,
  );
  private readonly slots = new Map<number, number>();
  private readonly expired: Entity[] = [];
  private readonly retiring: Entity[] = [];
  private readonly matrix = new Matrix4();
  private readonly quaternion = new Quaternion();
  private readonly euler = new Euler();
  private readonly position = new Vector3();
  private readonly chunkScale = new Vector3();
  private readonly color = new Color();

  init(): void {
    const geometry = new BoxGeometry(1, 1, 1);
    // One shared material; per-chunk tint rides instanceColor, base stays white.
    const material = new MeshStandardMaterial({ roughness: 0.85 });
    for (let slot = 0; slot < COMBAT.dieBurstPoolSize; slot++) {
      const mesh = new InstancedMesh(
        geometry,
        material,
        COMBAT.dieBurstChunkCount,
      );
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      // Instance spreads far beyond the unit box's bounds — never cull.
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.visible = false;
      // Build instanceColor before the first render, or the colour-program
      // recompile is skipped and every tint is silently dropped.
      for (let chunk = 0; chunk < COMBAT.dieBurstChunkCount; chunk++) {
        mesh.setColorAt(chunk, this.color.setHex(0xffffff));
      }
      const entity = this.world.createTransformEntity(mesh);
      this.slots.set(entity.index, slot);
      entity.addComponent(DieBurstTag);
    }
    // addComponent(DieBurst) fires this synchronously, so the burst scatters
    // on its spawn frame.
    this.queries.bursts.subscribe('qualify', (entity) => {
      this.scatterBurst(entity);
    });
  }

  private scatterBurst(entity: Entity): void {
    const slot = this.slots.get(entity.index);
    if (slot === undefined) return;
    const mesh = entity.object3D as InstancedMesh | undefined;
    if (!mesh) return;
    const sizeRatio = Number(entity.getValue(DieBurst, 'sizeRatio'));
    const base = slot * COMBAT.dieBurstChunkCount * CHUNK_FLOATS;
    for (let chunk = 0; chunk < COMBAT.dieBurstChunkCount; chunk++) {
      const f = base + chunk * CHUNK_FLOATS;
      const state = this.chunkState;
      // The launch impulse scales with sizeRatio: a cannon (0.8) throws softer
      // than a ship (1.0).
      const angle = Math.random() * Math.PI * 2;
      const speed =
        COMBAT.dieBurstSpeedMin +
        Math.random() * (COMBAT.dieBurstSpeedMax - COMBAT.dieBurstSpeedMin);
      state[f + VEL] = Math.cos(angle) * speed * sizeRatio;
      state[f + VEL + 1] =
        (COMBAT.dieBurstUpBiasMin +
          Math.random() * (COMBAT.dieBurstUpBiasMax - COMBAT.dieBurstUpBiasMin)) *
        sizeRatio;
      state[f + VEL + 2] = Math.sin(angle) * speed * sizeRatio;
      for (let a = 0; a < 3; a++) {
        state[f + ANG + a] = (Math.random() * 2 - 1) * COMBAT.dieBurstSpin;
      }
      // First 8 chunks are stretched wood planks; the rest stay blocky iron.
      const size =
        COMBAT.dieBurstChunkMin +
        Math.random() * (COMBAT.dieBurstChunkMax - COMBAT.dieBurstChunkMin);
      if (chunk < 8) {
        state[f + SCALE] = size * 1.8;
        state[f + SCALE + 1] = size * 0.45;
        state[f + SCALE + 2] = size * (0.8 + Math.random() * 0.4);
      } else {
        state[f + SCALE] = size;
        state[f + SCALE + 1] = size;
        state[f + SCALE + 2] = size;
      }
      state[f + POS] = (Math.random() * 2 - 1) * 0.05 * sizeRatio;
      state[f + POS + 1] = Math.random() * 0.05 * sizeRatio;
      state[f + POS + 2] = (Math.random() * 2 - 1) * 0.05 * sizeRatio;
      for (let a = 0; a < 3; a++) {
        state[f + EUL + a] = Math.random() * Math.PI * 2;
      }
      this.chunkAlive[slot * COMBAT.dieBurstChunkCount + chunk] = 1;
      const palette =
        chunk < 8 ? COMBAT.dieBurstWoodColors : COMBAT.dieBurstIronColors;
      mesh.setColorAt(
        chunk,
        this.color.setHex(palette[Math.floor(Math.random() * palette.length)]),
      );
      this.writeChunkMatrix(mesh, slot, chunk, sizeRatio, 1);
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.instanceMatrix.needsUpdate = true;
  }

  private writeChunkMatrix(
    mesh: InstancedMesh,
    slot: number,
    chunk: number,
    sizeRatio: number,
    globalScale: number,
  ): void {
    const alive = this.chunkAlive[slot * COMBAT.dieBurstChunkCount + chunk];
    if (alive === 0) {
      this.matrix.makeScale(0, 0, 0);
      mesh.setMatrixAt(chunk, this.matrix);
      return;
    }
    const f =
      slot * COMBAT.dieBurstChunkCount * CHUNK_FLOATS + chunk * CHUNK_FLOATS;
    const state = this.chunkState;
    this.position.set(state[f + POS], state[f + POS + 1], state[f + POS + 2]);
    this.euler.set(state[f + EUL], state[f + EUL + 1], state[f + EUL + 2]);
    this.quaternion.setFromEuler(this.euler);
    const s = sizeRatio * globalScale;
    this.chunkScale.set(state[f + SCALE] * s, state[f + SCALE + 1] * s, state[f + SCALE + 2] * s);
    this.matrix.compose(this.position, this.quaternion, this.chunkScale);
    mesh.setMatrixAt(chunk, this.matrix);
  }

  update(delta: number): void {
    if (this.paused()) return;
    this.expired.length = 0;
    for (const entity of this.queries.bursts.entities) {
      const duration = Number(entity.getValue(DieBurst, 'duration'));
      const elapsed = Number(entity.getValue(DieBurst, 'elapsed')) + delta;
      const t = Math.min(1, elapsed / duration);
      const object = entity.object3D as InstancedMesh | undefined;
      if (!object) continue;
      if (t >= 1) {
        this.expired.push(entity);
        continue;
      }
      entity.setValue(DieBurst, 'elapsed', elapsed);
      const slot = this.slots.get(entity.index);
      if (slot === undefined) continue;
      const sizeRatio = Number(entity.getValue(DieBurst, 'sizeRatio'));
      const floorY = Number(entity.getValue(DieBurst, 'floorY'));
      const bounce = Number(entity.getValue(DieBurst, 'floorBounce'));
      const remaining = duration - elapsed;
      const globalScale =
        remaining < COMBAT.dieBurstShrinkTail
          ? Math.max(0, remaining / COMBAT.dieBurstShrinkTail)
          : 1;
      const base = slot * COMBAT.dieBurstChunkCount * CHUNK_FLOATS;
      const state = this.chunkState;
      for (let chunk = 0; chunk < COMBAT.dieBurstChunkCount; chunk++) {
        const aliveIndex = slot * COMBAT.dieBurstChunkCount + chunk;
        if (this.chunkAlive[aliveIndex] === 0) continue;
        const f = base + chunk * CHUNK_FLOATS;
        if (this.chunkAlive[aliveIndex] === 2) {
          state[f + POS + 1] = floorY;
          const friction = Math.max(0, 1 - 5 * delta);
          state[f + VEL] *= friction;
          state[f + VEL + 2] *= friction;
          for (let a = 0; a < 3; a++) state[f + ANG + a] *= friction;
        } else {
          state[f + VEL + 1] -= COMBAT.dieBurstGravity * delta;
          state[f + POS] += state[f + VEL] * delta;
          state[f + POS + 1] += state[f + VEL + 1] * delta;
          state[f + POS + 2] += state[f + VEL + 2] * delta;
          // The bounce floor only covers the wall; past its sea or land face
          // the chunk free-falls to just under the water line. Local floor =
          // world floor − origin y.
          let floor = floorY;
          let rebound = bounce;
          if (bounce > 0) {
            const worldZ = object.position.z + state[f + POS + 2];
            if (
              worldZ < WALL_SEA_FACE_Z ||
              worldZ > WALL_LAND_FACE_Z
            ) {
              floor = OCEAN.surfaceY - 0.05 - object.position.y;
              rebound = 0;
            }
          }
          if (state[f + POS + 1] < floor) {
            if (rebound > 0) {
              state[f + POS + 1] = floor;
              state[f + VEL + 1] = -state[f + VEL + 1] * rebound;
              if (state[f + VEL + 1] < 0.25) {
                state[f + VEL + 1] = 0;
                this.chunkAlive[aliveIndex] = 2;
              } else {
                state[f + VEL] *= 0.7;
                state[f + VEL + 2] *= 0.7;
                for (let a = 0; a < 3; a++) state[f + ANG + a] *= 0.7;
              }
            } else {
              this.chunkAlive[aliveIndex] = 0;
              this.matrix.makeScale(0, 0, 0);
              object.setMatrixAt(chunk, this.matrix);
              continue;
            }
          }
        }
        for (let a = 0; a < 3; a++) {
          state[f + EUL + a] += state[f + ANG + a] * delta;
        }
        this.writeChunkMatrix(object, slot, chunk, sizeRatio, globalScale);
      }
      object.instanceMatrix.needsUpdate = true;
    }
    // Recycle, never dispose(): pooled entities return to the free list.
    for (const entity of this.expired) {
      entity.removeComponent(DieBurst);
      if (entity.object3D) entity.object3D.visible = false;
    }
  }

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
      entity.removeComponent(DieBurst);
      if (entity.object3D) entity.object3D.visible = false;
    }
  }
}
