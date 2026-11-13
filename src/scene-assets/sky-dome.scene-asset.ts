/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  BackSide,
  Color,
  DataTexture,
  LinearFilter,
  Mesh,
  RGBAFormat,
  RepeatWrapping,
  ShaderMaterial,
  SphereGeometry,
  UnsignedByteType,
} from '@iwsdk/core';

/**
 * Sky dome (天幕): a BackSide sphere that draws the whole sky analytically —
 * no environment texture and no cube conversion. Three colour anchors give a
 * sea -> horizon haze -> zenith gradient, and a tileable value-noise texture
 * projected onto two virtual cloud decks adds clouds that drift toward +z
 * (the player's side) and thin out as they approach the harbour. The decks sit
 * at different plane heights, so their patterns shift against each other as the
 * view turns, and the far deck is washed toward the horizon haze. Each deck is
 * shaded from a baked coarse-density gradient: slopes facing the light stay
 * bright, the opposite side falls into a cool shadow, which gives the cloud
 * bodies volume instead of a flat silhouette.
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
uniform sampler2D uCloudNoise;
uniform float uTime;

uniform float uMaskOn;
uniform float uMaxAlpha;
uniform float uEdgeCos;
uniform float uFadeCos;
uniform float uEdgeNoise;
uniform float uNoiseScale;
uniform float uAxisY;
uniform float uAxisZ;

uniform vec3 uSeaColor;
uniform vec3 uHorizonColor;
uniform vec3 uZenithColor;
uniform vec3 uCloudColor;
uniform float uIntensity;
uniform float uCloudCover;
uniform float uCloudScale;
uniform float uCloudSpeed;
uniform float uCloudMinY;
uniform float uCloudMaxY;

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
// the linear anchors below are encoded here, exactly like the ocean shader.
vec3 linearToSRGB(vec3 c) {
  c = max(c, vec3(0.0));
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

// One cloud deck: rgba = (shaded colour, alpha). R is the detailed density
// field, B the billow octaves, A the coarse density and G that same coarse
// density shifted toward the light. A - G is therefore a cheap slope estimate:
// positive where the form descends away from the light, which is the lit face.
vec4 cloudDeck(vec2 p, float cover, float band, float opacity, float shadeGain, float haze) {
  vec4 s = texture2D(uCloudNoise, p);
  float density = s.r * 0.72 + s.b * 0.28 + (s.a - 0.5) * 0.45;
  float threshold = 1.0 - cover;
  float a = smoothstep(threshold - 0.14, threshold + 0.16, density);

  float shade = clamp((s.a - s.g) * 6.0 + 0.5, 0.0, 1.0);
  shade = clamp((shade - 0.5) * shadeGain + 0.5, 0.0, 1.0);
  vec3 shadow = uCloudColor * vec3(0.62, 0.67, 0.79);
  vec3 lit = mix(shadow, uCloudColor, shade);
  lit = mix(lit, uHorizonColor, haze);

  return vec4(lit, a * band * opacity);
}

void main() {
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

  // --- sea / horizon haze / zenith ---
  float h = dir.y;
  vec3 color = mix(uSeaColor, uHorizonColor, smoothstep(-0.22, 0.0, h));
  color = mix(color, uZenithColor, smoothstep(0.0, 0.55, h));

  // --- clouds: two decks on virtual planes, drifting toward +z ---
  if (h > uCloudMinY) {
    // Dividing by the elevation compresses the pattern toward the horizon,
    // which is what sells the distance; the clamp keeps the near plane finite.
    vec2 plane = dir.xz / max(h, 0.05);
    float span = max(uCloudMaxY - uCloudMinY, 0.001);
    // The projection crushes the pattern into a dense band at the horizon, so
    // both decks fade in over the first stretch of elevation instead of
    // popping in at the band's lower edge.
    float rise = smoothstep(uCloudMinY, uCloudMinY + span * 0.28, h);

    // Far deck: higher plane, smaller cells, slower drift, washed into haze.
    vec2 farP = plane * (uCloudScale * 1.25) + vec2(0.37, 0.71);
    farP.y -= uTime * uCloudSpeed * 0.45;
    float farBand = smoothstep(uCloudMinY + span * 0.10, uCloudMinY + span * 0.34, h)
                  * (1.0 - smoothstep(uCloudMaxY - span * 0.18, uCloudMaxY, h));
    vec4 farDeck = cloudDeck(farP, uCloudCover * 0.88, farBand * rise, 0.42, 0.5, 0.4);

    // Near deck: lower plane, larger cells, full drift with a slight crosswind.
    vec2 nearP = plane * (uCloudScale * 0.62) + vec2(0.13, 0.29);
    nearP.y -= uTime * uCloudSpeed;
    nearP.x += uTime * uCloudSpeed * 0.22;
    float nearBand = smoothstep(uCloudMinY, uCloudMinY + span * 0.06, h)
                   * (1.0 - smoothstep(uCloudMaxY - span * 0.35, uCloudMaxY, h));
    vec4 nearDeck = cloudDeck(nearP, uCloudCover, nearBand * rise, 0.78, 0.7, 0.0);

    // Near deck sits in front: draw the far one first, then cover it.
    color = mix(color, farDeck.rgb, farDeck.a);
    color = mix(color, nearDeck.rgb, nearDeck.a);
  }

  color = linearToSRGB(color * uIntensity);

  // 8-bit sky gradients band badly; a sub-LSB dither dissolves the steps.
  color += (hash(gl_FragCoord.xy) - 0.5) / 255.0;

  gl_FragColor = vec4(color, alpha);
}
`;

const CLOUD_NOISE_SIZE = 128;
const CLOUD_NOISE_SEED = 7;

/** Deterministic 32-bit integer hash — no reliance on shared object identity. */
function hash2D(x: number, y: number): number {
  let h =
    Math.imul(x, 374761393) ^
    Math.imul(y, 668265263) ^
    Math.imul(CLOUD_NOISE_SEED, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Quintic value noise on a lattice that wraps every `period` cells. */
function periodicNoise(x: number, y: number, period: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
  const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
  const wrap = (n: number): number => ((n % period) + period) % period;
  const x0 = wrap(xi);
  const x1 = wrap(xi + 1);
  const y0 = wrap(yi);
  const y1 = wrap(yi + 1);
  const top = hash2D(x0, y0) + (hash2D(x1, y0) - hash2D(x0, y0)) * u;
  const bottom = hash2D(x0, y1) + (hash2D(x1, y1) - hash2D(x0, y1)) * u;
  return top + (bottom - top) * v;
}

const DETAIL_CELLS = [4, 8, 16, 32, 64];
const DETAIL_WEIGHTS = [1, 0.5, 0.25, 0.125, 0.0625];
const COARSE_CELLS = [4, 8, 16];
const COARSE_WEIGHTS = [1, 0.5, 0.25];

/** Light offset in texture space: the coarse field is sampled this far toward the light. */
const LIGHT_U = 0.03;
const LIGHT_V = 0.02;

function fbm(
  u: number,
  v: number,
  cells: number[],
  weights: number[],
  billow: boolean,
): number {
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < cells.length; i++) {
    const n = periodicNoise(u * cells[i], v * cells[i], cells[i]);
    sum += (billow ? 1 - Math.abs(n * 2 - 1) : n) * weights[i];
    norm += weights[i];
  }
  return sum / norm;
}

const detailField = (u: number, v: number): number =>
  fbm(u, v, DETAIL_CELLS, DETAIL_WEIGHTS, false);
const detailBillow = (u: number, v: number): number =>
  fbm(u, v, DETAIL_CELLS, DETAIL_WEIGHTS, true);
const coarseField = (u: number, v: number): number =>
  fbm(u, v, COARSE_CELLS, COARSE_WEIGHTS, false);

/**
 * Seamless tileable cloud texture, four channels:
 *   R  detailed density field
 *   G  coarse density shifted toward the light — A minus G shades the form
 *   B  billow octaves, which round the cloud edges into lobes
 *   A  coarse density, reused for macro coverage variation
 * Every octave's lattice divides the texture size, so shifting a sample by
 * LIGHT_U/LIGHT_V keeps the pattern periodic with `RepeatWrapping` — which also
 * means no mip chain is needed (mip generation ignores wrapping and would
 * introduce a visible seam).
 */
export function createCloudNoiseTexture(): DataTexture {
  const size = CLOUD_NOISE_SIZE;
  const data = new Uint8Array(size * size * 4);
  const toByte = (n: number): number => Math.round(Math.min(1, Math.max(0, n)) * 255);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const i = (y * size + x) * 4;
      data[i] = toByte(detailField(u, v));
      data[i + 1] = toByte(coarseField(u + LIGHT_U, v + LIGHT_V));
      data[i + 2] = toByte(detailBillow(u, v));
      data[i + 3] = toByte(coarseField(u, v));
    }
  }
  const texture = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

export function createSkyDomeMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uCloudNoise: { value: createCloudNoiseTexture() },
      uTime: { value: 0 },
      uMaskOn: { value: 0 },
      uMaxAlpha: { value: 1 },
      uEdgeCos: { value: Math.cos(56.25 * DEG2RAD) },
      uFadeCos: { value: Math.cos(31.25 * DEG2RAD) },
      uEdgeNoise: { value: 0.4 },
      uNoiseScale: { value: 2.5 },
      uAxisY: { value: Math.sin(7.5 * DEG2RAD) },
      uAxisZ: { value: -Math.cos(7.5 * DEG2RAD) },
      uSeaColor: { value: new Color(0.3, 0.52, 0.72) },
      uHorizonColor: { value: new Color(0.55, 0.72, 0.88) },
      uZenithColor: { value: new Color(0.16, 0.36, 0.7) },
      uCloudColor: { value: new Color(0.85, 0.9, 0.95) },
      uIntensity: { value: 1 },
      uCloudCover: { value: 0.45 },
      uCloudScale: { value: 0.8 },
      uCloudSpeed: { value: 0.03 },
      uCloudMinY: { value: Math.sin(8 * DEG2RAD) },
      uCloudMaxY: { value: Math.sin(30 * DEG2RAD) },
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
