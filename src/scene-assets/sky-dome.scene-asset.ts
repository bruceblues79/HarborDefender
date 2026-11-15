/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { BackSide, Mesh, ShaderMaterial, SphereGeometry } from '@iwsdk/core';
import { OCEAN, OCEAN_CENTER_Z, OCEAN_PLANE_SIZE } from '../level-config.js';
import {
  OCEAN_BRIGHTNESS,
  OCEAN_TINT,
  OCEAN_TINT_AMOUNT,
} from './ocean.scene-asset.js';

/**
 * Sky portal (天幕): the upper half of a sphere carrying the environment cube,
 * sampled by view direction. Because the cube is the same texture the ocean
 * reflects and both shaders apply the same tint mix and brightness, the sky
 * overhead and the sky in the water carry identical colour and radiance — the
 * horizon join has neither a brightness nor a hue step.
 *
 * Sampling by direction instead of by surface UV is what makes it read as sky
 * rather than as a painted shell: the image sits at infinity, so moving the
 * head slides the view across it instead of sliding the texture across the
 * geometry.
 *
 * The hemisphere's base ring IS the ocean disc's rim: same radius, same centre
 * height, same centre z as the water quad placed in battle-setup. So the sky
 * rises exactly out of the water's edge, and the water is the horizon. Seen
 * from the player, who stands outside this sphere, the two hard edges meet
 * tangentially: the disc's rim draws the lower boundary, the sphere's own
 * silhouette the upper one. Nothing outlines or fades the join — the mesh edge
 * is the boundary, which is what makes the scene read as a portal cut into the
 * real world instead of a distant sky layered over it. The shore side is the
 * one exception: the ocean clips its disc at the wall, so the near arc of the
 * ring is never drawn and the wall's top edge is that part of the join.
 *
 * Outside the sphere there is no geometry at all, so the compositor shows
 * passthrough there in AR and the clear colour in flat mode.
 */
export const SKY_PORTAL_RADIUS = OCEAN_PLANE_SIZE / 2;
/** Centre z of the water quad — see OCEAN_CENTER_Z in level-config. */
export const SKY_PORTAL_CENTER_Z: number = OCEAN_CENTER_Z;
export const SKY_PORTAL_BASE_Y = OCEAN.surfaceY;

const vertexShader = /* glsl */ `
varying vec3 vWorldPosition;

void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPosition = worldPos.xyz;
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const fragmentShader = /* glsl */ `
uniform samplerCube uSkyCube;
uniform float uIntensity;

varying vec3 vWorldPosition;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

// ShaderMaterial bypasses the renderer's linear -> sRGB output conversion, so
// encode here — exactly like the ocean shader, which keeps the two in step.
vec3 linearToSRGB(vec3 c) {
  c = max(c, vec3(0.0));
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  // Direction, not surface UV: the cube is a sky at infinity. The tint and the
  // brightness below are the ocean shader's own constants applied in the same
  // order, so sky and water are indistinguishable where they meet.
  vec3 dir = normalize(vWorldPosition - cameraPosition);
  vec3 color = textureCube(uSkyCube, dir).rgb;
  color = mix(color, vec3(${OCEAN_TINT[0]}, ${OCEAN_TINT[1]}, ${OCEAN_TINT[2]}), ${OCEAN_TINT_AMOUNT});
  color = linearToSRGB(color * uIntensity);

  // The dome magnifies the cube over a wide angle, so smooth gradients still
  // step at 8 bits; a sub-LSB dither dissolves them.
  color += (hash(gl_FragCoord.xy) - 0.5) / 255.0;

  gl_FragColor = vec4(color, 1.0);
}
`;

export function createSkyDomeMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uSkyCube: { value: null },
      uIntensity: { value: OCEAN_BRIGHTNESS },
    },
    vertexShader,
    fragmentShader,
    side: BackSide,
    depthWrite: false,
  });
}

export function createSkyDomeMesh(): Mesh {
  const geometry = new SphereGeometry(
    SKY_PORTAL_RADIUS,
    48,
    24,
    0,
    Math.PI * 2,
    0,
    Math.PI / 2,
  );
  const mesh = new Mesh(geometry, createSkyDomeMaterial());
  mesh.position.set(0, SKY_PORTAL_BASE_Y, SKY_PORTAL_CENTER_Z);
  // Backdrop: first thing drawn, but depth-write free so every real object
  // stays in front of it whatever order the renderer picks.
  mesh.renderOrder = -1e9;
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  // Hidden until the cube arrives; an unbound cube sampler draws black, which
  // would read as a hole instead of as sky.
  mesh.visible = false;
  return mesh;
}
