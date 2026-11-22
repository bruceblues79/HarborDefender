/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  AdditiveBlending,
  createSystem,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  Vector3,
} from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';
import {
  GamePaused,
  LevelDirector,
  MuzzleFlash,
  MuzzleFlashTag,
} from './components.js';
import { COMBAT } from './level-config.js';
import { rawSrgbColor } from './hit-flash-system.js';

/**
 * Owns the shared muzzle-flash pool.
 *
 * Pool: `COMBAT.muzzleFlashPoolSize` billboard quads created once at init,
 * all sharing one geometry; a quad is free exactly while it does NOT carry
 * `MuzzleFlash` (the fire systems claim one by adding that component). Each
 * quad keeps its own ShaderMaterial so the per-flash opacity fade never leaks
 * between concurrent shots. Recycling removes the component and hides the
 * mesh — nothing is ever disposed, mirroring the shell and hit-flash pools.
 *
 * Animation: the flare blooms from `muzzleFlashStartScale` to full size while
 * its opacity falls to zero over `muzzleFlashDuration` (a tenth of a second
 * or so) — a flash, not a lingering bloom.
 */
export class MuzzleFlashSystem extends createSystem({
  flashes: { required: [MuzzleFlash] },
  directors: { required: [LevelDirector] },
}) {
  /** Flashes that reached zero this frame; recycled after the sweep. */
  private readonly expired: Entity[] = [];
  /** Snapshot buffer for bulk recall; allocated once, reused per call. */
  private readonly retiring: Entity[] = [];

  init(): void {
    const geometry = new PlaneGeometry(1, 1);
    for (let i = 0; i < COMBAT.muzzleFlashPoolSize; i++) {
      const material = new ShaderMaterial({
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            // Billboard: keep the quad's centre on the muzzle and apply the
            // object's scale on the view-space X/Y axes, so it always faces
            // the eye without any per-frame CPU camera math.
            vec4 center = modelMatrix * vec4(0.0, 0.0, 0.0, 1.0);
            vec3 scale = vec3(
              length(modelMatrix[0].xyz),
              length(modelMatrix[1].xyz),
              1.0
            );
            vec4 mvPosition = viewMatrix * center;
            mvPosition.xy += position.xy * scale.xy;
            gl_Position = projectionMatrix * mvPosition;
          }
        `,
        fragmentShader: /* glsl */ `
          uniform float uOpacity;
          uniform vec3 uCoreColor;
          uniform vec3 uEdgeColor;
          varying vec2 vUv;
          void main() {
            vec2 p = (vUv - 0.5) * 2.0;
            float r = length(p);
            // Round bloom body: solid centre, soft rim.
            float body = smoothstep(1.0, 0.0, r);
            // Four-point star: bright only along the two axes, fading out.
            float rays = pow(1.0 - min(abs(p.x), abs(p.y)), 14.0);
            rays *= smoothstep(1.0, 0.1, r);
            float intensity = clamp(body * 0.9 + rays * 0.8, 0.0, 1.0);
            // White-hot core, warm orange rim; the star keeps the core tint.
            float core = smoothstep(0.55, 0.0, r);
            vec3 color = mix(
              uEdgeColor,
              uCoreColor,
              clamp(core + rays * 0.5, 0.0, 1.0)
            );
            gl_FragColor = vec4(color, intensity * uOpacity);
          }
        `,
        uniforms: {
          uOpacity: { value: 0 },
          uCoreColor: { value: rawSrgbColor(COMBAT.muzzleFlashCoreColor) },
          uEdgeColor: { value: rawSrgbColor(COMBAT.muzzleFlashEdgeColor) },
        },
        transparent: true,
        // Additive light on top of the scene, never occluding: the same
        // transient-glow treatment as the hit flash and impact embers.
        blending: AdditiveBlending,
        depthWrite: false,
      });
      const mesh = new Mesh(geometry, material);
      mesh.visible = false;
      // Draw after every default-order transparent object (hull spawn fades
      // are alpha-blended; additive light must land on top of them).
      mesh.renderOrder = 10;
      this.world.createTransformEntity(mesh).addComponent(MuzzleFlashTag);
    }
  }

  update(delta: number): void {
    if (this.paused()) return;
    this.expired.length = 0;
    for (const entity of this.queries.flashes.entities) {
      const duration = Number(entity.getValue(MuzzleFlash, 'duration'));
      const elapsed = Number(entity.getValue(MuzzleFlash, 'elapsed')) + delta;
      const t = Math.min(1, elapsed / duration);
      const ease = 1 - (1 - t) ** 3; // EaseOutCubic
      const object = entity.object3D;
      if (object) {
        object.scale.setScalar(
          COMBAT.muzzleFlashSize *
            (COMBAT.muzzleFlashStartScale +
              (1 - COMBAT.muzzleFlashStartScale) * ease),
        );
        const material = (object as Mesh).material as ShaderMaterial;
        material.uniforms.uOpacity.value = (1 - t) ** 2;
      }
      if (t >= 1) this.expired.push(entity);
      else entity.setValue(MuzzleFlash, 'elapsed', elapsed);
    }
    // Recycle, never dispose(): pooled entities return to the free list.
    for (const entity of this.expired) {
      entity.removeComponent(MuzzleFlash);
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

  /** Recall every playing flash to the pool (RESTART / MAIN reset). */
  recycleAll(): void {
    this.retiring.length = 0;
    for (const entity of this.queries.flashes.entities) {
      this.retiring.push(entity);
    }
    for (const entity of this.retiring) {
      entity.removeComponent(MuzzleFlash);
      if (entity.object3D) entity.object3D.visible = false;
    }
  }
}

/**
 * Claim a free pooled flash and plant it just ahead of the muzzle along the
 * shot direction (`dir` need not be normalised). This is the thin spawn
 * command every fire system shares: position, start scale, visible, then the
 * `MuzzleFlash` component that hands animation to MuzzleFlashSystem. Pool
 * empty: skip silently — a busy volley loses the odd flare, never a shot.
 */
export function spawnMuzzleFlash(
  freeFlashes: ReadonlySet<Entity>,
  position: Vector3,
  dirX: number,
  dirY: number,
  dirZ: number,
): void {
  const length = Math.hypot(dirX, dirY, dirZ) || 1;
  const offset = COMBAT.muzzleFlashOffset / length;
  for (const flash of freeFlashes) {
    // Live guard: another fire system may have claimed it this frame, since
    // the free-flash query only refreshes next frame.
    if (flash.hasComponent(MuzzleFlash)) continue;
    const object = flash.object3D;
    if (!object) return;
    object.position.set(
      position.x + dirX * offset,
      position.y + dirY * offset,
      position.z + dirZ * offset,
    );
    object.scale.setScalar(COMBAT.muzzleFlashSize * COMBAT.muzzleFlashStartScale);
    object.visible = true;
    flash.addComponent(MuzzleFlash, {
      duration: COMBAT.muzzleFlashDuration,
      elapsed: 0,
    });
    return;
  }
}
