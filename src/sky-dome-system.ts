/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { Visibility, createSystem } from '@iwsdk/core';
import type { Entity, ShaderMaterial, WebGLCubeRenderTarget } from '@iwsdk/core';
import { createSkyDomeMesh } from './scene-assets/sky-dome.scene-asset.js';
import { loadSkyCube } from './sky-cube.js';

/**
 * Owns the sky portal: creates the hemisphere and hands it the shared sky
 * cube. There is nothing to sync per frame — colour and brightness come from
 * the same constants the ocean shader uses, so the two cannot drift apart.
 *
 * There is no session-dependent branch — the mesh edge is the whole mask, in XR
 * and on the flat screen alike.
 */
export class SkyDomeSystem extends createSystem({}) {
  private material: ShaderMaterial | null = null;
  private cubeRT: WebGLCubeRenderTarget | null = null;
  private domeEntity: Entity | null = null;

  init(): void {
    const dome = createSkyDomeMesh();
    this.material = dome.material as ShaderMaterial;
    this.domeEntity = this.world.createTransformEntity(dome);

    // Ends up being the same texture the ocean reflects (see sky-cube.ts), so
    // the horizon join has no colour or brightness step.
    loadSkyCube(this.world).then((cubeRT) => {
      // Hold the render target, not just its texture, or the GPU copy is freed.
      this.cubeRT = cubeRT;
      if (this.material) this.material.uniforms.uSkyCube.value = cubeRT.texture;
      // Visibility is an ECS component (the object starts hidden); writing the
      // object alone would be overwritten by VisibilitySystem each frame.
      if (this.domeEntity) {
        this.domeEntity.setValue(Visibility, 'isVisible', true);
      }
    });
  }
}
