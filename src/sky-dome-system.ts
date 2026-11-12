/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { Color, ShaderMaterial, createSystem } from '@iwsdk/core';
import type { Mesh, Object3D } from '@iwsdk/core';
import { SkyDome } from './components.js';
import { createSkyDomeMesh } from './scene-assets/sky-dome.scene-asset.js';

const DEG2RAD = Math.PI / 180;

type UniformMap = { [name: string]: { value: unknown } };
type NumberUniform = { value: number };
type ColorUniform = { value: Color };

/**
 * Owns the sky dome: creates the mesh entity and mirrors the SkyDome inspector
 * fields into the shader every frame (the cloud clock needs a per-frame write).
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

    const sync = (): void => this.syncSessionState();
    this.xrManager.addEventListener('sessionstart', sync);
    this.xrManager.addEventListener('sessionend', sync);
    this.cleanupFuncs.push(() => {
      this.xrManager.removeEventListener('sessionstart', sync);
      this.xrManager.removeEventListener('sessionend', sync);
    });
    this.syncSessionState();
  }

  update(_delta: number, time: number): void {
    const maskOn = this.maskOn ? 1 : 0;
    for (const entity of this.queries.domes.entities) {
      const sea = entity.getVectorView(SkyDome, 'seaColor');
      const horizon = entity.getVectorView(SkyDome, 'horizonColor');
      const zenith = entity.getVectorView(SkyDome, 'zenithColor');
      const cloud = entity.getVectorView(SkyDome, 'cloudColor');
      // Rim angles collapse to cosines once here; the shader just smoothsteps.
      const edgeCos = Math.cos(Number(entity.getValue(SkyDome, 'edgeDeg')) * DEG2RAD);
      const fadeCos = Math.cos(
        (Number(entity.getValue(SkyDome, 'edgeDeg')) -
          Number(entity.getValue(SkyDome, 'fadeWidthDeg'))) *
          DEG2RAD,
      );
      const pitch = Number(entity.getValue(SkyDome, 'pitchUpDeg')) * DEG2RAD;

      this.traverseUniforms(entity.object3D, (u) => {
        (u.uTime as NumberUniform).value = time;
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
        (u.uCloudCover as NumberUniform).value = Number(entity.getValue(SkyDome, 'cloudCover'));
        (u.uCloudScale as NumberUniform).value = Number(entity.getValue(SkyDome, 'cloudScale'));
        (u.uCloudSpeed as NumberUniform).value = Number(entity.getValue(SkyDome, 'cloudSpeed'));
        (u.uCloudMinY as NumberUniform).value = Math.sin(
          Number(entity.getValue(SkyDome, 'cloudMinDeg')) * DEG2RAD,
        );
        (u.uCloudMaxY as NumberUniform).value = Math.sin(
          Number(entity.getValue(SkyDome, 'cloudMaxDeg')) * DEG2RAD,
        );
        (u.uSeaColor as ColorUniform).value.setRGB(sea[0], sea[1], sea[2]);
        (u.uHorizonColor as ColorUniform).value.setRGB(horizon[0], horizon[1], horizon[2]);
        (u.uZenithColor as ColorUniform).value.setRGB(zenith[0], zenith[1], zenith[2]);
        (u.uCloudColor as ColorUniform).value.setRGB(cloud[0], cloud[1], cloud[2]);
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
