/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  Vector3,
} from '@iwsdk/core';
import { OCEAN_PLANE_SIZE } from '../level-config.js';

/**
 * 海面本体：一块水平四边形，UV 与 shader 的圆盘 mask 对齐。
 * 材质由 createOceanMaterial 在战斗加载时替换；这里只提供几何。
 */
export function createOceanBody(): Mesh {
  const geometry = new PlaneGeometry(OCEAN_PLANE_SIZE, OCEAN_PLANE_SIZE);
  geometry.rotateX(-Math.PI / 2);
  const mesh = new Mesh(geometry, new MeshStandardMaterial());
  mesh.name = 'ocean-body';
  return mesh;
}

/**
 * Shader uniform array cap for simultaneous wake sources — the single source
 * of truth, imported by OceanSystem. 12 covers six sailing ships plus a
 * volley of cannonball splashes with margin.
 */
export const MAX_WAKE = 12;

/**
 * Global multiplier on the water colour. 1.0 keeps the reflected sky texture
 * exactly as the dome shows it — one texture, no colour added on top.
 */
export const WATER_BRIGHTNESS = 1;

const vertexShader = `
#include <common>
#include <shadowmap_pars_vertex>

varying vec3 vWorldNormal;
varying vec3 vLocalNormal;
varying vec3 vWorldPosition;
varying vec2 vUv;

void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPosition = worldPos.xyz;
  vUv = uv;
  // mat3(modelMatrix) keeps the normal in world space; the renderer's
  // normalMatrix is view-space, which made the cubemap reflection roll with
  // head roll in XR. Uniform scale only (GLB placed at scale 1).
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  vLocalNormal = normal;

  // The shadowmap_vertex chunk expects the standard-material locals below.
  vec4 worldPosition = worldPos;
  vec3 transformedNormal = normalMatrix * normal;
  #include <shadowmap_vertex>

  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const fragmentShader = `
#include <common>
#include <packing>
#include <lights_pars_begin>
#include <shadowmap_pars_fragment>
#include <shadowmask_pars_fragment>

uniform samplerCube envMap;
uniform float reflectivity;
uniform float brightness;
uniform float time;
uniform float uFade;          // boot fade-in multiplier on the surface alpha
uniform float noiseSpeed;     // metres/second, perturbation drifts toward +z
uniform float noiseFrequency; // noise cells per metre
uniform float noiseIntensity; // master disturbance strength
uniform int wakeCount;
uniform vec3 wakePos[${MAX_WAKE}];    // x, packed radius, z
uniform vec3 wakeParams[${MAX_WAKE}]; // amplitude, frequency, speed
varying vec3 vWorldNormal;
varying vec3 vLocalNormal;
varying vec3 vWorldPosition;
varying vec2 vUv;

// Circular surface mask in UV space: the disc stays fully opaque, the rim
// fades out, and everything outside is discarded. Centre and radius are both
// UV values, so the inscribed circle scales with the quad automatically.
const float MASK_RADIUS = 0.5;
const float MASK_FADE = 0.06;
// Feather width ramps continuously from the harbour side to the far side (see
// farness in main): the near rim keeps the narrow width that reads as a clean
// blend into the wall, the sides widen, and the far rim gets the widest, calmest
// dissolve — otherwise the grazing angle collapses that edge into a hard arc.
const float MASK_FADE_FAR = 0.32;
const vec2 MASK_CENTER = vec2(0.5, 0.4725);

// Hash-based value noise (2D), quintic-interpolated (C2-continuous) so the
// lattice shows no derivative creases at cell boundaries.
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

// Two-octave noise, roughly -1..1. Sampling (p.y - t) makes the pattern
// drift toward +z with time.
float flowingNoise(vec2 p, float t) {
  vec2 q = vec2(p.x, p.y - t);
  float n = valueNoise(q) * 0.65 + valueNoise(q * 2.3 + 7.7) * 0.35;
  return n * 2.0 - 1.0;
}

// ShaderMaterial bypasses the renderer's linear -> sRGB output conversion
// (renderer.outputColorSpace is SRGBColorSpace), so apply it manually here.
vec3 linearToSRGB(vec3 c) {
  c = max(c, vec3(0.0));
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  // Mask first: everything outside the disc is thrown away before the costly
  // noise, cubemap and shadow work runs.
  // The farther from the harbour, the flatter and wider the feather: 0 at the
  // wall side, 1 at the far rim, so the mask's fade band grows gradually
  // instead of stepping between two widths.
  vec2 maskOffset = vUv - MASK_CENTER;
  float farness = smoothstep(-0.45, 0.45, maskOffset.y);
  float fadeWidth = mix(MASK_FADE, MASK_FADE_FAR, farness);
  float d = length(maskOffset);
  float mask = 1.0 - smoothstep(MASK_RADIUS - fadeWidth, MASK_RADIUS, d);
  if (mask * uFade <= 0.001) discard;

  vec3 color;

  // Fake reflection only on the +y surface (the water top).
  // Cubemap sampling avoids the pole stretching of equirect UV mapping.
  if (vLocalNormal.y > 0.5) {
    vec3 viewDir = normalize(vWorldPosition - cameraPosition);
    vec3 reflDir = reflect(viewDir, normalize(vWorldNormal));

    // Noise perturbation of the reflection direction: the sky projection
    // wobbles as if the surface had fine ripples, without touching geometry.
    float n1 = flowingNoise(vWorldPosition.xz * noiseFrequency, time * noiseSpeed);
    float n2 = flowingNoise(vWorldPosition.zx * noiseFrequency + 19.3, time * noiseSpeed * 0.8);
    reflDir = normalize(reflDir + vec3(n1, 0.0, n2) * noiseIntensity);

    // Wake ripple perturbation: the ripple gradient tilts the reflection
    // toward the ring centre, creating a lensing wobble around each source.
    vec2 wakeGrad = vec2(0.0);
    for (int i = 0; i < ${MAX_WAKE}; i++) {
      if (i >= wakeCount) break;
      vec2 diff = vWorldPosition.xz - wakePos[i].xz;
      float dist = length(diff);
      float radius = wakePos[i].y;
      float amp = wakeParams[i].x;
      float freq = wakeParams[i].y;
      float speed = wakeParams[i].z;
      // d/d(dist) of sin(dist * freq - time * speed) * amp * smoothstep(radius,0,dist)
      float atten = smoothstep(radius, 0.0, dist);
      float phase = dist * freq - time * speed;
      float d = cos(phase) * freq * amp * atten;
      // Direction from source to fragment, normalised (gradient direction)
      vec2 dir = diff / max(dist, 0.001);
      wakeGrad += dir * d;
    }
    reflDir = normalize(reflDir + vec3(wakeGrad.x, 0.0, wakeGrad.y) * 0.5);

    color = textureCube(envMap, reflDir).rgb * reflectivity;
  } else {
    // Sides / bottom: deep water body color, no env mapping
    color = vec3(0.06, 0.11, 0.18);
  }

  // Darken by the shadow mask (receiveShadow-gated by the renderer). The
  // fake-reflection surface is unlit — no ambient term to fall back on —
  // so remap the mask (0 in umbra) to a floor that keeps some water colour;
  // without this the ship's shadow would read pitch black on the sea.
  color *= mix(0.5, 1.0, getShadowMask());

  color *= brightness;

  // Rim dissolve: the disc's far edge sits just below eye level, so the water
  // there reflects the upper hemisphere (which darkens with elevation) while
  // the dome behind it shows the horizon-tinted lower hemisphere. Fade the
  // water colour into the sky the dome shows behind that same pixel, so the
  // mask's alpha fade dissolves between two equal colours. Only the open-sea
  // side of the rim is treated: the near arc sits against the harbour wall,
  // where the pixel behind is stone, not sky — that side of the mask stays
  // untouched.
  float seaward = smoothstep(5.0, 8.0, -vWorldPosition.z);
  float rimBlend = (1.0 - mask) * seaward;
  if (rimBlend > 0.001) {
    vec3 backdrop = textureCube(envMap, normalize(vWorldPosition - cameraPosition)).rgb;
    color = mix(color, backdrop * brightness, rimBlend);
  }

  gl_FragColor = vec4(linearToSRGB(color), mask * uFade);
}
`;

export interface OceanNoiseParams {
  /** Metres/second — how fast the disturbance drifts toward +z. */
  speed?: number;
  /** Noise cells per metre — spatial size of the surge/wobble. */
  frequency?: number;
  /** Master strength: vertex surge amplitude and reflection wobble. */
  intensity?: number;
  /** Linear brightness multiplier on the final water colour. */
  brightness?: number;
}

/**
 * Fake-reflection material for the procedural ocean plane
 * (createOceanBody). This shader supplies the cubemap reflection with its
 * noise and wake perturbation on that single flat quad. The quad is masked
 * to a centred disc in UV space: opaque inside, fading at the rim, discarded
 * outside.
 *
 * `lights: true` plus the merged UniformsLib.lights lets the renderer feed
 * the shadow-map uniforms, so the surface can receive cast shadows while
 * staying unlit (the shadow mask only darkens the fake-reflection colour).
 *
 * Wake ripples: up to MAX_WAKE active sources are fed per frame by
 * OceanSystem via the wakePos / wakeParams uniform arrays. Toggle
 * WakeSource.active to turn a source's ripples on or off (sailing vs.
 * anchored, projectile splash vs. inert).
 *
 * Runtime-tunable noise interfaces. Adjust live via the material uniforms,
 * e.g. `oceanMaterial.uniforms.noiseIntensity.value = 0.3`.
 */
export function createOceanMaterial(noise: OceanNoiseParams = {}): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: UniformsUtils.merge([
      UniformsLib.lights,
      {
        time: { value: 0 },
        uFade: { value: 1 },
        envMap: { value: null },
        reflectivity: { value: 1.0 },
        brightness: { value: noise.brightness ?? WATER_BRIGHTNESS },
        noiseSpeed: { value: noise.speed ?? 0.8 },
        noiseFrequency: { value: noise.frequency ?? 3.0 },
        noiseIntensity: { value: noise.intensity ?? 0.015 },
        wakeCount: { value: 0 },
        wakePos: { value: Array.from({ length: MAX_WAKE }, () => new Vector3()) },
        wakeParams: { value: Array.from({ length: MAX_WAKE }, () => new Vector3()) },
      },
    ]),
    lights: true,
    // Blended rim only; depthWrite stays on so the surface still occludes
    // hulls below the waterline.
    transparent: true,
    vertexShader,
    fragmentShader,
  });
}
