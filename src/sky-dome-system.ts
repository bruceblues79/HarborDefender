/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { ShaderMaterial, createSystem } from '@iwsdk/core';
import type { Entity, Mesh, Object3D, Texture } from '@iwsdk/core';
import { SceneFade, SkyDome } from './components.js';
import { createSkyDomeMesh } from './scene-assets/sky-dome.scene-asset.js';

const DEG2RAD = Math.PI / 180;

type UniformMap = { [name: string]: { value: unknown } };
type NumberUniform = { value: number };

/**
 * Owns the sky dome: creates the mesh entity (hidden), accepts the procedural
 * sky map from the boot pass, and mirrors the SkyDome inspector fields into
 * the shader.
 *
 * The dome is the shared backdrop for the whole page: the boot pass feeds it
 * the procedural sky map, reveals it and ramps its alpha in over the dark
 * page colour; it then stays visible through the welcome screen, battle and
 * MAIN-menu returns. Its passthrough mask is gated separately: in an XR
 * session with alpha-blend passthrough it becomes the partial-immersion disc,
 * head-locked per eye so the rim keeps its place in the view; with no session
 * (or an opaque session) the mask is off and the sphere covers the whole sky.
 */
export class SkyDomeSystem extends createSystem({
  domes: { required: [SkyDome] },
}) {
  private maskOn = false;
  private dome: Mesh | null = null;
  private domeEntity: Entity | null = null;

  init(): void {
    const dome = createSkyDomeMesh();
    // Hidden until the boot pass has the sky map and is ready to fade it in.
    dome.visible = false;
    this.dome = dome;
    this.domeEntity = this.world.createTransformEntity(dome);
    this.domeEntity.addComponent(SkyDome);

    const sync = (): void => this.syncSessionState();
    this.xrManager.addEventListener('sessionstart', sync);
    this.xrManager.addEventListener('sessionend', sync);
    this.cleanupFuncs.push(() => {
      this.xrManager.removeEventListener('sessionstart', sync);
      this.xrManager.removeEventListener('sessionend', sync);
    });
    this.syncSessionState();
  }

  /** Hand the freshly generated sky map to the dome shader. */
  setSkyTexture(texture: Texture): void {
    const material = this.dome?.material as ShaderMaterial | undefined;
    if (!material) return;
    material.uniforms.uSkyMap.value = texture;
    material.needsUpdate = true;
  }

  /**
   * Reveal the dome and ramp its alpha in from 0 over `duration` seconds.
   * Called once by the boot pass, right as the loading panel hands over to
   * the welcome screen; later re-entries keep the settled alpha of 1.
   */
  fadeIn(duration: number): void {
    if (!this.dome || !this.domeEntity) return;
    (this.dome.material as ShaderMaterial).uniforms.uFade.value = 0;
    this.dome.visible = true;
    this.domeEntity.addComponent(SceneFade, { duration });
  }

  update(_delta: number, _time: number): void {
    const maskOn = this.maskOn ? 1 : 0;
    for (const entity of this.queries.domes.entities) {
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
        (u.uPitch as NumberUniform).value = pitch;
        (u.uIntensity as NumberUniform).value = Number(
          entity.getValue(SkyDome, 'skyIntensity'),
        );
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
