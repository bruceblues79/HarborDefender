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
 * Global multiplier on the water colour. 1.0 reproduces the reflected sky
 * exactly, which is what makes the sea and the sky read as one continuous
 * surface at the horizon.
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
uniform float uExposure;      // HDR tone-mapping exposure, shared with the sky
uniform float time;
uniform float uFade;          // boot fade-in multiplier on the surface alpha
uniform float noiseSpeed;     // metres/second, perturbation drifts toward +z
uniform float noiseFrequency; // noise cells per metre
uniform float noiseIntensity; // master disturbance strength
uniform vec3 sunDir;          // unit vector toward the sun (world space)
uniform vec3 sunColor;        // linear RGB of the directional light
uniform float sunIntensity;   // authored strength of the sun glitter
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
const float MASK_FADE = 0.14;
// Feather width ramps continuously from the harbour side to the far side (see
// farness in main): the near rim keeps a wider-than-before width so the sea
// dissolves toward the camera instead of ending on a hard horizontal cut, the
// sides widen, and the far rim gets the widest, calmest dissolve — otherwise
// the grazing angle collapses that edge into a hard arc.
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

// Same ACES curve as the sky dome: the HDR reflection comes from the same
// equirect, so both surfaces must tone-map identically for the seam to vanish.
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
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

  // Deep-water body colour (linear). A deeper blue so the sea reads as water
  // rather than a second copy of the sky; it shows through wherever the view
  // gets steep enough for Fresnel to drop.
  const vec3 WATER_DEEP = vec3(0.016, 0.038, 0.072);
  vec3 color;
  vec3 specular = vec3(0.0);

  // Camera -> surface point. Reused by the reflection, the Fresnel term and
  // the rim dissolve so all three agree on the same viewing azimuth.
  vec3 toEye = normalize(vWorldPosition - cameraPosition);

  // Fake reflection only on the +y surface (the water top).
  // Cubemap sampling avoids the pole stretching of equirect UV mapping.
  if (vLocalNormal.y > 0.5) {
    vec3 viewDir = toEye;
    vec3 V = -viewDir; // surface -> eye

    // Noise + wake perturbation produces ONE slope field that drives both the
    // reflection wobble and the sun glitter, so the two never disagree.
    float n1 = flowingNoise(vWorldPosition.xz * noiseFrequency, time * noiseSpeed);
    float n2 = flowingNoise(vWorldPosition.zx * noiseFrequency + 19.3, time * noiseSpeed * 0.8);
    vec2 perturb = vec2(n1, n2) * noiseIntensity;

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
    perturb += wakeGrad * 0.5;

    vec3 reflDir = normalize(reflect(viewDir, normalize(vWorldNormal)) + vec3(perturb.x, 0.0, perturb.y));
    vec3 N = normalize(vec3(-perturb.x * 10.0, 1.0, -perturb.y * 10.0));

    // The sea mirrors the sky at grazing angles but keeps a real body up
    // close, so it stays a touch darker than the sky it reflects.
    float ndv = clamp(dot(N, V), 0.0, 1.0);
    float fresnel = 0.55 + 0.45 * pow(1.0 - ndv, 3.0);
    vec3 reflected = textureCube(envMap, reflDir).rgb * reflectivity;
    color = mix(WATER_DEEP, reflected, fresnel);

    // Sun glitter: a tight sparkle lobe over a broad sheen, broken up by a
    // high-frequency glint noise so the path reads as scattered coins instead
    // of one smooth hotspot.
    vec3 H = normalize(sunDir + V);
    float ndh = max(dot(N, H), 0.0);
    float sparkle = pow(ndh, 900.0);
    float sheen = pow(ndh, 60.0);
    float glint = valueNoise(vWorldPosition.xz * 55.0 + vec2(time * 1.7));
    specular = sunColor * sunIntensity *
      (sparkle * (0.45 + 1.4 * smoothstep(0.35, 0.85, glint)) + sheen * 0.08);
  } else {
    // Sides / bottom: deep water body color, no env mapping
    color = WATER_DEEP;
  }

  // Darken by the shadow mask (receiveShadow-gated by the renderer). The
  // fake-reflection surface is unlit — no ambient term to fall back on —
  // so remap the mask (0 in umbra) to a floor that keeps some water colour;
  // without this the ship's shadow would read pitch black on the sea.
  color *= mix(0.5, 1.0, getShadowMask());

  color *= brightness;

  // Glitter survives only where the sun is not occluded: ship and wall
  // shadows cut a clean dark lane through the golden path.
  color += specular * getShadowMask();

  // Rim dissolve: every edge of the disc fades into the sky the dome shows
  // behind that exact pixel. Sampling the view direction (not the reflected
  // one) guarantees a colour match all around, so the near fade toward the
  // camera reads as haze rather than a cut, and the far rim keeps melting into
  // the horizon.
  float rimBlend = 1.0 - mask;
  if (rimBlend > 0.001) {
    vec3 backdrop = textureCube(envMap, toEye).rgb;
    color = mix(color, backdrop * brightness, rimBlend);
  }

  gl_FragColor = vec4(linearToSRGB(aces(color * uExposure)), mask * uFade);
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
  /** World-space unit vector toward the sun — drives the glitter path. */
  sunDirection?: readonly [number, number, number];
  /** Linear RGB of the directional light. */
  sunColor?: readonly [number, number, number];
  /** Strength of the sun glitter (0 disables it). */
  sunIntensity?: number;
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
        uExposure: { value: 1.0 },
        noiseSpeed: { value: noise.speed ?? 0.8 },
        noiseFrequency: { value: noise.frequency ?? 3.0 },
        noiseIntensity: { value: noise.intensity ?? 0.015 },
        sunDir: {
          value: new Vector3(...(noise.sunDirection ?? [-0.489, 0.208, -0.847])),
        },
        sunColor: {
          value: new Vector3(...(noise.sunColor ?? [1, 0.7, 0.42])),
        },
        sunIntensity: { value: noise.sunIntensity ?? 1 },
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
