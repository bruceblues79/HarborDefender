/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  BackSide,
  DataTexture,
  LinearFilter,
  Mesh,
  RGBAFormat,
  ShaderMaterial,
  SphereGeometry,
  UnsignedByteType,
} from '@iwsdk/core';
import type { Texture } from '@iwsdk/core';

/**
 * Sky dome (天幕): a BackSide sphere that samples the same equirectangular HDR
 * the ocean reflects, so both read the same texels for the same world
 * direction — the horizon seam disappears and the two share one sky.
 *
 * The HDR is sampled in the view direction and shown as-is: one texture, no
 * extra tint or brightness. The ocean samples the same texture through its
 * reflection cubemap, so the two surfaces share one colour source. Below the
 * horizon the lookup clamps to the horizon row, so the lower hemisphere
 * continues the sky's own horizon colour — there is no horizon line in the dome
 * at all; the water disc simply sits in front of it.
 *
 * The same mesh serves every render mode. Outside an XR session the mask is
 * off and the sphere is the scene background; in a partial-immersion session
 * the mask keeps only a DISC around the player's facing axis (world -z, raised
 * by `pitchUpDeg`), fading through a ragged noise rim into passthrough.
 */

export const SKY_DOME_RADIUS = 150;

const DEG2RAD = Math.PI / 180;

const vertexShader = /* glsl */ `
varying vec3 vWorldPosition;

void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPosition = worldPos.xyz;
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const fragmentShader = /* glsl */ `
uniform sampler2D uSkyMap;

uniform float uMaskOn;
uniform float uMaxAlpha;
uniform float uEdgeCos;
uniform float uFadeCos;
uniform float uEdgeNoise;
uniform float uNoiseScale;
uniform float uAxisY;
uniform float uAxisZ;

uniform float uIntensity;
uniform float uExposure;
uniform float uFade;       // boot fade-in multiplier on the dome alpha

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

// ShaderMaterial bypasses the renderer's linear -> sRGB output conversion, so
// the linear colour is encoded here, exactly like the ocean shader.
vec3 linearToSRGB(vec3 c) {
  c = max(c, vec3(0.0));
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

// HDR sky values routinely exceed 1.0; ACES keeps cloud highlights and the
// sun disc from clipping to flat white.
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  if (uFade <= 0.001) discard;

  // View ray through this fragment: the dome hugs the world origin and the
  // player stays within a few metres of it.
  vec3 dir = normalize(vWorldPosition - cameraPosition);

  // --- passthrough mask (session only) ---
  float alpha = uMaxAlpha;
  if (uMaskOn > 0.5) {
    // Mask first, sample later — the fillrate guard. Fragments past the rim
    // discard immediately, so the invisible majority of the sphere costs a
    // dot and a smoothstep. The disc axis is world -z raised by pitchUpDeg.
    float d = dot(dir, vec3(0.0, uAxisY, uAxisZ));
    float m = smoothstep(uEdgeCos, uFadeCos, d);
    if (m <= 0.001) discard;

    float band = m * (1.0 - m) * 4.0;
    float n = 0.5;
    if (band > 0.001) {
      vec2 np = dir.xy / (dir.z + 1.4) * uNoiseScale;
      n = valueNoise(np) * 0.6 + valueNoise(np * 2.3) * 0.4;
    }
    alpha = uMaxAlpha * clamp(m + (n - 0.5) * uEdgeNoise * band, 0.0, 1.0);
  }

  // Equirect lookup in the view direction. The formula matches three.js's
  // equirectUv, which is what builds the ocean's reflection cubemap from this
  // same texture, so both surfaces agree texel for texel. Below the horizon the
  // lookup keeps descending into the sky map's lower half (a slow darkening of
  // the horizon colour) instead of clamping: the dome wraps all the way down,
  // and the water disc simply sits in front of it. In XR the passthrough mask
  // hides the lower sphere anyway.
  vec2 uv = vec2(
    atan(dir.z, dir.x) * 0.15915494309189535 + 0.5,
    asin(clamp(dir.y, -1.0, 1.0)) * 0.3183098861837907 + 0.5
  );
  vec3 color = texture2D(uSkyMap, uv).rgb * uIntensity * uExposure;

  color = linearToSRGB(aces(color));

  // 8-bit sky gradients band badly; a sub-LSB dither dissolves the steps.
  color += (hash(gl_FragCoord.xy) - 0.5) / 255.0;

  gl_FragColor = vec4(color, alpha * uFade);
}
`;

/**
 * 1×1 texel shown until the HDR arrives (it is preloaded at `background`
 * priority, so this only covers the first frames). Mid-sky tint, not black.
 */
function createFallbackSkyTexture(): DataTexture {
  const texture = new DataTexture(
    new Uint8Array([102, 143, 191, 255]),
    1,
    1,
    RGBAFormat,
    UnsignedByteType,
  );
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

export function createSkyDomeMaterial(skyMap?: Texture): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uSkyMap: { value: skyMap ?? createFallbackSkyTexture() },
      uMaskOn: { value: 0 },
      uMaxAlpha: { value: 1 },
      uEdgeCos: { value: Math.cos(56.25 * DEG2RAD) },
      uFadeCos: { value: Math.cos(31.25 * DEG2RAD) },
      uEdgeNoise: { value: 0.4 },
      uNoiseScale: { value: 2.5 },
      uAxisY: { value: Math.sin(7.5 * DEG2RAD) },
      uAxisZ: { value: -Math.cos(7.5 * DEG2RAD) },
      uIntensity: { value: 1 },
      uExposure: { value: 1 },
      uFade: { value: 1 },
    },
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    side: BackSide,
  });
}

export function createSkyDomeMesh(skyMap?: Texture): Mesh {
  const mesh = new Mesh(
    new SphereGeometry(SKY_DOME_RADIUS, 48, 32),
    createSkyDomeMaterial(skyMap),
  );
  // Backdrop: first in the transparent queue, depth-tested so every opaque
  // and nearer transparent object stays in front; the camera lives inside
  // the sphere, so culling is disabled.
  mesh.renderOrder = -1e9;
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return mesh;
}
