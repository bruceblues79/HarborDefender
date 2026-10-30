/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { BackSide, Mesh, ShaderMaterial, SphereGeometry } from '@iwsdk/core';

/**
 * Partial-immersion AR sky dome (部分沉浸穹顶). WebXR on Quest exposes no
 * passthrough-blend control, so this BackSide sphere restores one in
 * content — deliberately dumb: it unlit-pastes the shared sky HDR by view
 * direction (the HDR's own ocean below its horizon comes along for free and
 * meets the live ocean mesh at the far edge), masked to a DISC pointed at
 * the player's facing axis, world -z:
 *
 *   inside the disc       -> alpha `uMaxAlpha`, the HDR sky (and its ocean)
 *   approaching the rim   -> smoothstep across a `uFadeWidthDeg` band
 *   past `uEdgeDeg`       -> alpha 0, pure video see-through
 *
 * The rim band is broken up by STATIC procedural value noise (no animation)
 * so the boundary never reads as a clean geometric circle; both the band
 * width and the noise amplitude are inspector fields. Outside the rim the
 * mask collapses to exactly 0 — everything past the disc is passthrough.
 */

export const SKY_DOME_RADIUS = 150;

const vertexShader = /* glsl */ `
varying vec3 vWorldPosition;

void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPosition = worldPos.xyz;
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const fragmentShader = /* glsl */ `
uniform samplerCube uEnvMap;
uniform float uEnvLoaded;
uniform float uMaxAlpha;
uniform float uEdgeCos;
uniform float uFadeCos;
uniform float uEdgeNoise;
uniform float uNoiseScale;
uniform float uSkyIntensity;
uniform float uAxisY;
uniform float uAxisZ;
varying vec3 vWorldPosition;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
             u.y);
}

vec3 linearToSRGB(vec3 c) {
  return pow(c, vec3(0.4545));
}

void main() {
  // HDR not wired yet (or session gone): discard, passthrough stays clean.
  if (uEnvLoaded < 0.5) discard;

  // View ray through this fragment: the dome hugs the world origin and the
  // player stays within a few metres of it.
  vec3 dir = normalize(vWorldPosition - cameraPosition);

  // Mask first, sample later — the fillrate guard. Fragments past the rim
  // discard immediately (no cube fetch, no noise, no blend write), so the
  // invisible majority of the sphere costs a dot and a smoothstep. Noise
  // runs only inside the rim band; elsewhere it collapses to neutral 0.5
  // and the mask is exact: uMaxAlpha inside, exactly 0 outside. The disc
  // axis is world -z raised by pitchUpDeg: (0, uAxisY, uAxisZ).
  float d = dot(dir, vec3(0.0, uAxisY, uAxisZ));
  float m = smoothstep(uEdgeCos, uFadeCos, d);
  if (m <= 0.001) discard;

  float band = m * (1.0 - m) * 4.0;
  float n = 0.5;
  if (band > 0.001) {
    vec2 np = dir.xy / (dir.z + 1.4) * uNoiseScale;
    n = valueNoise(np) * 0.6 + valueNoise(np * 2.3) * 0.4;
  }
  float alpha = uMaxAlpha * clamp(m + (n - 0.5) * uEdgeNoise * band, 0.0, 1.0);

  vec3 sky = textureCube(uEnvMap, dir).rgb * uSkyIntensity;
  gl_FragColor = vec4(linearToSRGB(sky), alpha);
}
`;

export function createSkyDomeMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uEnvMap: { value: null },
      uEnvLoaded: { value: 0 },
      uMaxAlpha: { value: 1.0 },
      uEdgeCos: { value: Math.cos((45 * Math.PI) / 180) },
      uFadeCos: { value: Math.cos((20 * Math.PI) / 180) },
      uEdgeNoise: { value: 0.4 },
      uNoiseScale: { value: 2.5 },
      uSkyIntensity: { value: 0.85 },
      uAxisY: { value: Math.sin((7.5 * Math.PI) / 180) },
      uAxisZ: { value: -Math.cos((7.5 * Math.PI) / 180) },
    },
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    side: BackSide,
  });
}

export function createSkyDomeMesh(): Mesh {
  const mesh = new Mesh(new SphereGeometry(SKY_DOME_RADIUS, 48, 32), createSkyDomeMaterial());
  // Backdrop: first in the transparent queue, depth-tested so every opaque
  // and nearer transparent object stays in front; the camera lives inside
  // the sphere, so culling is disabled.
  mesh.renderOrder = -1e9;
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return mesh;
}
