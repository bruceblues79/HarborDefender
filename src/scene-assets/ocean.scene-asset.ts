/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { ShaderMaterial, UniformsLib, UniformsUtils } from '@iwsdk/core';

const vertexShader = `
#include <common>
#include <shadowmap_pars_vertex>

uniform float time;
uniform float noiseSpeed;     // metres/second, disturbance drifts toward +z
uniform float noiseFrequency; // noise cells per metre
uniform float noiseIntensity; // master disturbance strength
varying vec3 vWorldNormal;
varying vec3 vLocalNormal;
varying vec3 vWorldPosition;

// Hash-based value noise (2D), smooth-interpolated
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
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

void main() {
  vec3 pos = position;

  // Low-poly waves on the top surface only (y > 0 in local box space)
  if (pos.y > 0.0) {
    float wave1 = sin(pos.x * 3.75 + time * 1.2) * 0.02;
    float wave2 = sin(pos.z * 5.25 + time * 0.9) * 0.0125;
    float wave3 = sin((pos.x + pos.z) * 2.25 + time * 0.6) * 0.0075;
    pos.y += wave1 + wave2 + wave3;

    // Surge toward the wall: noise crests travel toward +z, rise the
    // surface and lean forward so the sea feels like it is piling up
    // against the harbour wall. Kept small to preserve the low-poly read.
    float surge = flowingNoise(
      vec2(pos.x * noiseFrequency, pos.z * noiseFrequency),
      time * noiseSpeed
    );
    pos.y += surge * noiseIntensity * 0.25;
    pos.z += max(surge, 0.0) * noiseIntensity * 0.15;
  }

  vec4 worldPos = modelMatrix * vec4(pos, 1.0);
  vWorldPosition = worldPos.xyz;
  // mat3(modelMatrix) keeps the normal in world space; the renderer's
  // normalMatrix is view-space, which made the cubemap reflection roll with
  // head roll in XR. Uniform scale only (GLB placed at scale 1).
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  vLocalNormal = normal;

  // Shadow-map lookups follow the wave-displaced world position; the
  // shadowmap_vertex chunk expects the standard-material locals below.
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
varying vec3 vWorldNormal;
varying vec3 vLocalNormal;
varying vec3 vWorldPosition;

// Hash-based value noise (2D), smooth-interpolated
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
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

    color = textureCube(envMap, reflDir).rgb * reflectivity;
    color = mix(color, vec3(0.30, 0.52, 0.72), 0.18);
  } else {
    // Sides / bottom: deep water body color, no env mapping
    color = vec3(0.06, 0.11, 0.18);
  }

  // Darken by the shadow mask (receiveShadow-gated by the renderer), so a
  // ship's shadow lands on the fake-reflection surface like a real one.
  color *= getShadowMask();

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
 * Wave + fake-reflection material for the solidified ocean body
 * (gltf/ocean-body.glb, exported by scripts/export-assets.ts). The GLB
 * carries the geometry; this shader supplies vertex waves and the cubemap
 * reflection, applied to the loaded mesh at game start.
 *
 * `lights: true` plus the merged UniformsLib.lights lets the renderer feed
 * the shadow-map uniforms, so the surface can receive cast shadows while
 * staying unlit (the shadow mask only darkens the fake-reflection colour).
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
        noiseSpeed: { value: noise.speed ?? 0.8 },
        noiseFrequency: { value: noise.frequency ?? 3.0 },
        noiseIntensity: { value: noise.intensity ?? 0.015 },
      },
    ]),
    lights: true,
    vertexShader,
    fragmentShader,
  });
}
