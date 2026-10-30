/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  AssetManager,
  HalfFloatType,
  Mesh,
  Object3D,
  ShaderMaterial,
  WebGLCubeRenderTarget,
  createSystem,
} from '@iwsdk/core';
import { SkyDome } from './components.js';
import { createSkyDomeMesh } from './scene-assets/sky-dome.scene-asset.js';

const DEG2RAD = Math.PI / 180;
/** Same HDR the ocean reflects — warm AssetManager cache, one shared world. */
const DOME_HDR = 'ocean-env.hdr';

type UniformMap = { [name: string]: { value: unknown } };

/**
 * Owns the AR partial-immersion dome: creates the hidden mesh entity, wires
 * the HDR cubemap, and gates visibility to immersive-AR sessions. IWSDK's AR
 * policy nulls scene.background and hides authored gradient domes but has no
 * blend control — this system restores it in content. Uniform values mirror
 * the carrier's SkyDome fields every frame so the dome stays inspector-tunable.
 */
export class SkyDomeSystem extends createSystem({
  domes: { required: [SkyDome] },
}) {
  private arActive = false;
  private domeEnvRT: WebGLCubeRenderTarget | null = null;

  init(): void {
    const dome = createSkyDomeMesh();
    // Flat desktop keeps its authored DomeGradient background.
    dome.visible = false;
    this.world.createTransformEntity(dome).addComponent(SkyDome);

    AssetManager.loadHDRTextureById(DOME_HDR).then((hdr) => {
      const rt = new WebGLCubeRenderTarget(256, { type: HalfFloatType });
      rt.fromEquirectangularTexture(this.renderer, hdr);
      this.domeEnvRT = rt;
      for (const entity of this.queries.domes.entities) {
        this.traverseUniforms(entity.object3D, (u) => {
          const envUniform = u.uEnvMap as { value: WebGLCubeRenderTarget['texture'] | null };
          envUniform.value = rt.texture;
          (u.uEnvLoaded as { value: number }).value = 1;
        });
      }
    });

    const sync = (): void => this.syncArVisibility();
    this.xrManager.addEventListener('sessionstart', sync);
    this.xrManager.addEventListener('sessionend', sync);
    this.cleanupFuncs.push(() => {
      this.xrManager.removeEventListener('sessionstart', sync);
      this.xrManager.removeEventListener('sessionend', sync);
      this.domeEnvRT?.dispose();
    });
    this.syncArVisibility();
  }

  update(): void {
    if (!this.arActive) return;
    for (const entity of this.queries.domes.entities) {
      const maxAlpha = Number(entity.getValue(SkyDome, 'maxAlpha'));
      // Rim angles collapse to cosines once here; the shader just smoothsteps.
      const edgeCos = Math.cos(Number(entity.getValue(SkyDome, 'edgeDeg')) * DEG2RAD);
      const fadeCos = Math.cos(
        (Number(entity.getValue(SkyDome, 'edgeDeg')) -
          Number(entity.getValue(SkyDome, 'fadeWidthDeg'))) *
          DEG2RAD,
      );
      const edgeNoise = Number(entity.getValue(SkyDome, 'edgeNoise'));
      const noiseScale = Number(entity.getValue(SkyDome, 'noiseScale'));
      const skyIntensity = Number(entity.getValue(SkyDome, 'skyIntensity'));
      // Disc axis: world -z raised by pitchUpDeg.
      const pitch = Number(entity.getValue(SkyDome, 'pitchUpDeg')) * DEG2RAD;
      this.traverseUniforms(entity.object3D, (u) => {
        (u.uMaxAlpha as { value: number }).value = maxAlpha;
        (u.uEdgeCos as { value: number }).value = edgeCos;
        (u.uFadeCos as { value: number }).value = fadeCos;
        (u.uEdgeNoise as { value: number }).value = edgeNoise;
        (u.uNoiseScale as { value: number }).value = noiseScale;
        (u.uSkyIntensity as { value: number }).value = skyIntensity;
        (u.uAxisY as { value: number }).value = Math.sin(pitch);
        (u.uAxisZ as { value: number }).value = -Math.cos(pitch);
      });
    }
  }

  private syncArVisibility(): void {
    const blendMode = this.xrManager.getSession()?.environmentBlendMode;
    this.arActive = blendMode === 'alpha-blend' || blendMode === 'additive';
    for (const entity of this.queries.domes.entities) {
      if (entity.object3D) entity.object3D.visible = this.arActive;
    }
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
