/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { AssetManager, HalfFloatType, WebGLCubeRenderTarget } from '@iwsdk/core';
import type { World } from '@iwsdk/core';

let pending: Promise<WebGLCubeRenderTarget> | null = null;

/**
 * The sky cube, built once from the environment HDR and shared by the ocean
 * material and the sky portal. Sharing it is the whole point: the water's
 * reflection and the sky overhead then carry identical radiance, so the horizon
 * join has no brightness step.
 *
 * The cube is raw equirect -> cube (no PMREM blur), so it stays a usable sky
 * while still avoiding the pole stretching of equirect sampling.
 */
export function loadSkyCube(world: World): Promise<WebGLCubeRenderTarget> {
  if (!pending) {
    pending = AssetManager.loadHDRTextureById('ocean-env.hdr').then((hdr) => {
      const cubeRT = new WebGLCubeRenderTarget(256, { type: HalfFloatType });
      cubeRT.fromEquirectangularTexture(world.renderer, hdr);
      return cubeRT;
    });
  }
  return pending;
}
