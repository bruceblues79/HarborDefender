/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { AssetManager, ShaderMaterial, createSystem } from '@iwsdk/core';
import type { Color, Mesh, Object3D } from '@iwsdk/core';
import { SkyDome } from './components.js';
import { createSkyDomeMesh } from './scene-assets/sky-dome.scene-asset.js';

const DEG2RAD = Math.PI / 180;

type UniformMap = { [name: string]: { value: unknown } };
type NumberUniform = { value: number };
type ColorUniform = { value: Color };

/**
 * Owns the sky dome: creates the mesh entity, feeds it the ocean's HDR sky map
 * once loaded, and mirrors the SkyDome inspector fields into the shader.
 *
 * The dome is visible in every mode; only its passthrough mask is gated. In an
 * XR session with alpha-blend passthrough it becomes the partial-immersion
 * disc; with no session (or an opaque session) the mask is off and the sphere
 * covers the whole sky.
 */
export class SkyDomeSystem extends createSystem({
  domes: { required: [SkyDome] },
}) {
  private maskOn = false;

  init(): void {
    const dome = createSkyDomeMesh();
    this.world.createTransformEntity(dome).addComponent(SkyDome);

    // Same texture the ocean reflects; the dome shows a flat fallback until it
    // arrives (the asset is preloaded at background priority).
    AssetManager.loadHDRTextureById('ocean-env.hdr').then(
      (texture) => {
        const material = dome.material as ShaderMaterial;
        material.uniforms.uSkyMap.value = texture;
        material.needsUpdate = true;
      },
      (err: unknown) => {
        console.warn('Sky dome: HDR sky map failed to load, keeping the fallback.', err);
      },
    );

    const sync = (): void => this.syncSessionState();
    this.xrManager.addEventListener('sessionstart', sync);
    this.xrManager.addEventListener('sessionend', sync);
    this.cleanupFuncs.push(() => {
      this.xrManager.removeEventListener('sessionstart', sync);
      this.xrManager.removeEventListener('sessionend', sync);
    });
    this.syncSessionState();
  }

  update(_delta: number, _time: number): void {
    const maskOn = this.maskOn ? 1 : 0;
    for (const entity of this.queries.domes.entities) {
      const sea = entity.getVectorView(SkyDome, 'seaColor');
      // Rim angles collapse to cosines once here; the shader just smoothsteps.
      const edgeCos = Math.cos(Number(entity.getValue(SkyDome, 'edgeDeg')) * DEG2RAD);
      const fadeCos = Math.cos(
        (Number(entity.getValue(SkyDome, 'edgeDeg')) -
          Number(entity.getValue(SkyDome, 'fadeWidthDeg'))) *
          DEG2RAD,
      );
      const pitch = Number(entity.getValue(SkyDome, 'pitchUpDeg')) * DEG2RAD;

      this.traverseUniforms(entity.object3D, (u) => {
        (u.uMaskOn as NumberUniform).value = maskOn;
        (u.uMaxAlpha as NumberUniform).value = Number(entity.getValue(SkyDome, 'maxAlpha'));
        (u.uEdgeCos as NumberUniform).value = edgeCos;
        (u.uFadeCos as NumberUniform).value = fadeCos;
        (u.uEdgeNoise as NumberUniform).value = Number(entity.getValue(SkyDome, 'edgeNoise'));
        (u.uNoiseScale as NumberUniform).value = Number(entity.getValue(SkyDome, 'noiseScale'));
        (u.uAxisY as NumberUniform).value = Math.sin(pitch);
        (u.uAxisZ as NumberUniform).value = -Math.cos(pitch);
        (u.uIntensity as NumberUniform).value = Number(
          entity.getValue(SkyDome, 'skyIntensity'),
        );
        (u.uSeaColor as ColorUniform).value.setRGB(sea[0], sea[1], sea[2]);
      });
    }
  }

  private syncSessionState(): void {
    const blendMode = this.xrManager.getSession()?.environmentBlendMode;
    this.maskOn = blendMode === 'alpha-blend' || blendMode === 'additive';
  }

  private traverseUniforms(
    object3D: Object3D | null | undefined,
    apply: (u: UniformMap) => void,
  ): void {
    if (!object3D) return;
    object3D.traverse((child) => {
      const mesh = child as Mesh;
      if (!mesh.isMesh) return;
      apply((mesh.material as ShaderMaterial).uniforms as UniformMap);
    });
  }
}
