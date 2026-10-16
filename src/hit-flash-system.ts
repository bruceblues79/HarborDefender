/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  Color,
  createSystem,
  Mesh,
  NormalBlending,
  ShaderMaterial,
  SphereGeometry,
} from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';
import { HitFlash, HitFlashTag } from './components.js';
import { COMBAT } from './level-config.js';

/**
 * Owns the shared hit-flash pool and animates every playing flash.
 *
 * Pool: `COMBAT.hitFlashPoolSize` spheres created once at init, all sharing
 * one geometry; a flash is free exactly while it does not carry `HitFlash`
 * (ShellHitSystem claims one by adding that component). Each sphere keeps its
 * own ShaderMaterial so the per-instance opacity fade never leaks between
 * concurrent flashes. Recycling removes the component and hides the mesh —
 * nothing is disposed, mirroring the shell pool.
 *
 * Animation: scale blooms from `hitFlashStartScale` (0.5) to 1.0 while
 * opacity falls 1 -> 0, both through an EaseOutCubic curve over
 * `hitFlashDuration` — fast bloom and fast initial fade, slow settle.
 */
export class HitFlashSystem extends createSystem({
  flashes: { required: [HitFlash] },
}) {
  /** Flashes that reached zero this frame; recycled after the sweep. */
  private readonly expired: Entity[] = [];

  init(): void {
    const geometry = new SphereGeometry(COMBAT.hitFlashRadius, 16, 12);
    for (let i = 0; i < COMBAT.hitFlashPoolSize; i++) {
      const material = new ShaderMaterial({
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
          uniform float uOpacity;
          uniform vec3 uCenterColor;
          uniform vec3 uEdgeColor;
          varying vec3 vNormal;
          varying vec3 vViewDir;
          void main() {
            // Fresnel: hot yellow facing the eye, dark red at grazing rims.
            float fresnel =
              pow(1.0 - abs(dot(normalize(vNormal), normalize(vViewDir))), 1.5);
            gl_FragColor = vec4(mix(uCenterColor, uEdgeColor, fresnel), uOpacity);
          }
        `,
        uniforms: {
          uOpacity: { value: 0 },
          uCenterColor: { value: rawSrgbColor(COMBAT.hitFlashCenterColor) },
          uEdgeColor: { value: rawSrgbColor(COMBAT.hitFlashEdgeColor) },
        },
        transparent: true,
        // Normal blending keeps the dark-red rim visible; additive would add
        // near-nothing for it. No depth write: a transient glow must never
        // occlude anything behind it.
        blending: NormalBlending,
        depthWrite: false,
      });
      const mesh = new Mesh(geometry, material);
      mesh.visible = false;
      this.world.createTransformEntity(mesh).addComponent(HitFlashTag);
    }
  }

  update(delta: number): void {
    this.expired.length = 0;
    for (const entity of this.queries.flashes.entities) {
      const duration = Number(entity.getValue(HitFlash, 'duration'));
      const elapsed = Number(entity.getValue(HitFlash, 'elapsed')) + delta;
      const t = Math.min(1, elapsed / duration);
      const ease = 1 - (1 - t) ** 3; // EaseOutCubic
      const object = entity.object3D;
      if (object) {
        object.scale.setScalar(
          COMBAT.hitFlashStartScale + (1 - COMBAT.hitFlashStartScale) * ease,
        );
        const material = (object as Mesh).material as ShaderMaterial;
        material.uniforms.uOpacity.value = 1 - ease;
      }
      if (t >= 1) this.expired.push(entity);
      else entity.setValue(HitFlash, 'elapsed', elapsed);
    }
    // Recycle, never dispose(): pooled entities return to the free list.
    for (const entity of this.expired) {
      entity.removeComponent(HitFlash);
      if (entity.object3D) entity.object3D.visible = false;
    }
  }
}

/**
 * Build a Color straight from sRGB hex components, bypassing three's
 * sRGB->linear conversion. The custom shader writes gl_FragColor directly
 * with no output colour-space chunk, so raw sRGB values display exactly as
 * the hex constants read.
 */
function rawSrgbColor(hex: number): Color {
  return new Color(
    ((hex >> 16) & 0xff) / 255,
    ((hex >> 8) & 0xff) / 255,
    (hex & 0xff) / 255,
  );
}
