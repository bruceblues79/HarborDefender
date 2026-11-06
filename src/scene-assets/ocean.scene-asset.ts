/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { ShaderMaterial, UniformsLib, UniformsUtils, Vector3 } from '@iwsdk/core';

/** Shader uniform cap for simultaneous wake sources; imported by OceanSystem.
 * 12 covers six ships plus cannonball volleys with margin. */
export const MAX_WAKE = 12;

const vertexShader = `
#include <common>
#include <shadowmap_pars_vertex>

uniform float time;
uniform float noiseSpeed;     // metres/second, disturbance drifts toward +z
uniform float noiseFrequency; // noise cells per metre
uniform float noiseIntensity; // master disturbance strength
uniform int wakeCount;
uniform vec3 wakePos[${MAX_WAKE}];    // x, packed radius, z
uniform vec3 wakeParams[${MAX_WAKE}]; // amplitude, frequency, speed
varying vec3 vWorldNormal;
varying vec3 vLocalNormal;
varying vec3 vWorldPosition;

// Quintic-interpolated (C2-continuous) value noise: no derivative creases at cell edges.
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

// Two octaves, roughly -1..1; sampling (p.y - t) drifts the pattern toward +z.
float flowingNoise(vec2 p, float t) {
  vec2 q = vec2(p.x, p.y - t);
  float n = valueNoise(q) * 0.65 + valueNoise(q * 2.3 + 7.7) * 0.35;
  return n * 2.0 - 1.0;
}

void main() {
  vec3 pos = position;

  // Low-poly waves on the top surface only (y > 0 in local box space)
  if (pos.y > 0.0) {
    float wave1 = sin(pos.x * 3.75 + time * 1.2) * 0.02;
    float wave2 = sin(pos.z * 5.25 + time * 0.9) * 0.0125;
    float wave3 = sin((pos.x + pos.z) * 2.25 + time * 0.6) * 0.0075;
    pos.y += wave1 + wave2 + wave3;

    // Crests travel toward +z and lean forward so the sea piles against the wall;
    // kept small to preserve the low-poly read.
    float surge = flowingNoise(
      vec2(pos.x * noiseFrequency, pos.z * noiseFrequency),
      time * noiseSpeed
    );
    pos.y += surge * noiseIntensity * 0.25;
    pos.z += max(surge, 0.0) * noiseIntensity * 0.15;

    // Wake ripples: concentric rings expanding outward from each source.
    vec4 worldPos = modelMatrix * vec4(pos, 1.0);
    for (int i = 0; i < ${MAX_WAKE}; i++) {
      if (i >= wakeCount) break;
      vec2 diff = worldPos.xz - wakePos[i].xz;
      float dist = length(diff);
      float radius = wakePos[i].y;
      float amp = wakeParams[i].x;
      float freq = wakeParams[i].y;
      float speed = wakeParams[i].z;
      float atten = smoothstep(radius, 0.0, dist);
      pos.y += sin(dist * freq - time * speed) * amp * atten;
    }
  }

  vec4 worldPos = modelMatrix * vec4(pos, 1.0);
  vWorldPosition = worldPos.xyz;
  // World-space normal: normalMatrix is view-space, which rolled reflections with head
  // roll. Assumes uniform scale (GLB placed at scale 1).
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  vLocalNormal = normal;

  // shadowmap_vertex expects the standard-material locals below; lookups use the
  // wave-displaced world position.
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

// Quintic-interpolated (C2-continuous) value noise: no derivative creases at cell edges.
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

// Two octaves, roughly -1..1; sampling (p.y - t) drifts the pattern toward +z.
float flowingNoise(vec2 p, float t) {
  vec2 q = vec2(p.x, p.y - t);
  float n = valueNoise(q) * 0.65 + valueNoise(q * 2.3 + 7.7) * 0.35;
  return n * 2.0 - 1.0;
}

// ShaderMaterial bypasses the renderer's linear -> sRGB output (outputColorSpace is sRGB),
// so convert manually here.
vec3 linearToSRGB(vec3 c) {
  c = max(c, vec3(0.0));
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec3 color;

  // Fake reflection on the +y water top only; the cubemap avoids equirect pole stretching.
  if (vLocalNormal.y > 0.5) {
    vec3 viewDir = normalize(vWorldPosition - cameraPosition);
    vec3 reflDir = reflect(viewDir, normalize(vWorldNormal));

    // Noise-perturbed reflection direction: fine ripples without touching geometry.
    float n1 = flowingNoise(vWorldPosition.xz * noiseFrequency, time * noiseSpeed);
    float n2 = flowingNoise(vWorldPosition.zx * noiseFrequency + 19.3, time * noiseSpeed * 0.8);
    reflDir = normalize(reflDir + vec3(n1, 0.0, n2) * noiseIntensity);

    // Wake gradient tilts the reflection toward each ring centre (lensing wobble).
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
      vec2 dir = diff / max(dist, 0.001);
      wakeGrad += dir * d;
    }
    reflDir = normalize(reflDir + vec3(wakeGrad.x, 0.0, wakeGrad.y) * 0.5);

    color = textureCube(envMap, reflDir).rgb * reflectivity;
    color = mix(color, vec3(0.30, 0.52, 0.72), 0.18);
  } else {
    color = vec3(0.06, 0.11, 0.18);
  }

  // Remap the shadow mask (0 in umbra) to a 0.5 floor: the unlit fake-reflection
  // surface would otherwise read pitch black under a ship's shadow.
  color *= mix(0.5, 1.0, getShadowMask());

  gl_FragColor = vec4(linearToSRGB(color), 1.0);
}
`;

export interface OceanNoiseParams {
  /** Metres/second — how fast the disturbance drifts toward +z. */
  speed?: number;
  /** Noise cells per metre — spatial size of the surge/wobble. */
  frequency?: number;
  /** Master strength: vertex surge amplitude and reflection wobble. */
  intensity?: number;
}

/**
 * Wave + fake-reflection material for the solidified ocean body (gltf/ocean-body.glb,
 * exported by scripts/export-assets.ts); the GLB carries the geometry.
 *
 * `lights: true` plus the merged UniformsLib.lights feeds the shadow-map uniforms, so
 * the unlit surface still receives cast shadows. OceanSystem writes up to MAX_WAKE
 * wake sources per frame through the wakePos / wakeParams uniform arrays.
 */
export function createOceanMaterial(noise: OceanNoiseParams = {}): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: UniformsUtils.merge([
      UniformsLib.lights,
      {
        time: { value: 0 },
        envMap: { value: null },
        reflectivity: { value: 1.0 },
        noiseSpeed: { value: noise.speed ?? 0.8 },
        noiseFrequency: { value: noise.frequency ?? 3.0 },
        noiseIntensity: { value: noise.intensity ?? 0.015 },
        wakeCount: { value: 0 },
        wakePos: { value: Array.from({ length: MAX_WAKE }, () => new Vector3()) },
        wakeParams: { value: Array.from({ length: MAX_WAKE }, () => new Vector3()) },
      },
    ]),
    lights: true,
    vertexShader,
    fragmentShader,
  });
}
