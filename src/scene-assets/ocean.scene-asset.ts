/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { ShaderMaterial, UniformsLib, UniformsUtils, Vector3 } from '@iwsdk/core';

/**
 * Shader uniform array cap for simultaneous wake sources — the single source
 * of truth, imported by OceanSystem. 12 covers six sailing ships plus a
 * volley of cannonball splashes with margin.
 */
export const MAX_WAKE = 12;

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
const vec2 MASK_CENTER = vec2(0.5, 0.47);

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
    color = mix(color, vec3(0.30, 0.52, 0.72), 0.18);
  } else {
    // Sides / bottom: deep water body color, no env mapping
    color = vec3(0.06, 0.11, 0.18);
  }

  // Darken by the shadow mask (receiveShadow-gated by the renderer). The
  // fake-reflection surface is unlit — no ambient term to fall back on —
  // so remap the mask (0 in umbra) to a floor that keeps some water colour;
  // without this the ship's shadow would read pitch black on the sea.
  color *= mix(0.5, 1.0, getShadowMask());

  float d = distance(vUv, MASK_CENTER);
  float mask = 1.0 - smoothstep(MASK_RADIUS - MASK_FADE, MASK_RADIUS, d);
  if (mask <= 0.001) discard;

  color *= brightness;
  gl_FragColor = vec4(linearToSRGB(color), mask);
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
 * Fake-reflection material for the solidified ocean plane
 * (gltf/ocean-body.glb, exported by scripts/export-assets.ts). The GLB
 * carries a single flat quad; this shader supplies the cubemap reflection
 * with its noise and wake perturbation, applied to the loaded mesh at game
 * start. The quad is masked to a centred disc in UV space: opaque inside,
 * fading at the rim, discarded outside.
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
        envMap: { value: null },
        reflectivity: { value: 1.0 },
        brightness: { value: noise.brightness ?? 1.0 },
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
