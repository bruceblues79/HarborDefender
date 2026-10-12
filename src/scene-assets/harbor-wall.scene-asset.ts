/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  BoxGeometry,
  DataTexture,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  RepeatWrapping,
  SRGBColorSpace,
} from '@iwsdk/core';

const TEX_SIZE = 256;

// mulberry32 — deterministic so the asset manifest stays realm-safe
// (assets.ts is evaluated twice, in the app and the editor).
function makeRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smooth = (t: number): number => t * t * (3 - 2 * t);

/** Accumulate one octave of tileable value noise (wrapped lattice). */
function noiseOctave(
  rand: () => number,
  grid: number,
  size: number,
  out: Float32Array,
  amplitude: number,
): void {
  const lattice = new Float32Array(grid * grid);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rand();
  const scale = grid / size;
  for (let y = 0; y < size; y++) {
    const gy = y * scale;
    const y0 = Math.floor(gy) % grid;
    const y1 = (y0 + 1) % grid;
    const fy = smooth(gy - Math.floor(gy));
    for (let x = 0; x < size; x++) {
      const gx = x * scale;
      const x0 = Math.floor(gx) % grid;
      const x1 = (x0 + 1) % grid;
      const fx = smooth(gx - Math.floor(gx));
      const top = lattice[y0 * grid + x0] * (1 - fx) + lattice[y0 * grid + x1] * fx;
      const bottom = lattice[y1 * grid + x0] * (1 - fx) + lattice[y1 * grid + x1] * fx;
      out[y * size + x] += (top * (1 - fy) + bottom * fy) * amplitude;
    }
  }
}

interface WallMaps {
  albedo: DataTexture;
  roughness: DataTexture;
  normal: DataTexture;
}

/**
 * Procedural mottled-stone PBR maps: fractal value noise plus soft dark
 * stains for the weathered, blotchy look of a harbor wall. All three maps
 * are generated from one height field so they stay consistent.
 */
function generateWallMaps(): WallMaps {
  const size = TEX_SIZE;
  const rand = makeRandom(20261012);

  // 1. Tileable height field, 4 octaves, normalised to ~0..1
  const height = new Float32Array(size * size);
  noiseOctave(rand, 4, size, height, 1.0);
  noiseOctave(rand, 8, size, height, 0.5);
  noiseOctave(rand, 16, size, height, 0.25);
  noiseOctave(rand, 32, size, height, 0.125);
  for (let i = 0; i < height.length; i++) height[i] /= 1.875;

  // 2. Soft blotches (toroidal distance keeps the maps tileable)
  const stain = new Float32Array(size * size);
  const BLOTCHES = 42;
  for (let b = 0; b < BLOTCHES; b++) {
    const cx = rand() * size;
    const cy = rand() * size;
    const radius = size * (0.03 + rand() * 0.09);
    const strength = 0.35 + rand() * 0.45;
    const r2 = radius * radius;
    for (let y = 0; y < size; y++) {
      let dy = Math.abs(y - cy);
      dy = Math.min(dy, size - dy);
      for (let x = 0; x < size; x++) {
        let dx = Math.abs(x - cx);
        dx = Math.min(dx, size - dx);
        const d2 = dx * dx + dy * dy;
        if (d2 < r2) {
          const t = Math.sqrt(d2) / radius;
          // Hard cell edge: full strength inside 80%, narrow 20% rim
          const f = t < 0.8 ? 1 : 1 - (t - 0.8) / 0.2;
          const v = f * strength;
          const idx = y * size + x;
          if (v > stain[idx]) stain[idx] = v;
        }
      }
    }
  }

  // 3. Bake albedo / roughness / normal
  const albedoData = new Uint8Array(size * size * 4);
  const roughnessData = new Uint8Array(size * size * 4);
  const normalData = new Uint8Array(size * size * 4);
  const BUMP = 1.6;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = y * size + x;
      const h = height[idx];
      const s = stain[idx];
      const jitter = (rand() - 0.5) * 0.05;

      // Albedo: neutral grey stone; stains stay close to the base colour
      const brightness = 0.82 + h * 0.24 + jitter;
      const stainShade = 1 - s * 0.14;
      const r = 0.56 * brightness * stainShade;
      const g = 0.56 * brightness * stainShade;
      const bCol = 0.55 * brightness * stainShade;
      albedoData[idx * 4 + 0] = Math.round(Math.min(1, Math.max(0, r)) * 255);
      albedoData[idx * 4 + 1] = Math.min(255, Math.max(0, Math.round(g * 255)));
      albedoData[idx * 4 + 2] = Math.min(255, Math.max(0, Math.round(bCol * 255)));
      albedoData[idx * 4 + 3] = 255;

      // Roughness: high base, stains slightly rougher (three.js reads G)
      const rough = Math.min(1, Math.max(0, 0.86 + (h - 0.5) * 0.12 + s * 0.04));
      const rb = Math.round(rough * 255);
      roughnessData[idx * 4 + 0] = rb;
      roughnessData[idx * 4 + 1] = rb;
      roughnessData[idx * 4 + 2] = rb;
      roughnessData[idx * 4 + 3] = 255;

      // Normal: central differences on the wrapped height field
      const hx = (height[y * size + ((x + 1) % size)] - height[y * size + ((x - 1 + size) % size)]) * 0.5 * BUMP;
      const hy = (height[((y + 1) % size) * size + x] - height[((y - 1 + size) % size) * size + x]) * 0.5 * BUMP;
      const invLen = 1 / Math.sqrt(hx * hx + hy * hy + 1);
      normalData[idx * 4 + 0] = Math.round((-hx * invLen * 0.5 + 0.5) * 255);
      normalData[idx * 4 + 1] = Math.round((-hy * invLen * 0.5 + 0.5) * 255);
      normalData[idx * 4 + 2] = Math.round((invLen * 0.5 + 0.5) * 255);
      normalData[idx * 4 + 3] = 255;
    }
  }

  const albedo = new DataTexture(albedoData, size, size);
  albedo.colorSpace = SRGBColorSpace;
  const roughness = new DataTexture(roughnessData, size, size);
  const normal = new DataTexture(normalData, size, size);

  for (const tex of [albedo, roughness, normal]) {
    tex.wrapS = RepeatWrapping;
    tex.wrapT = RepeatWrapping;
    tex.needsUpdate = true;
  }

  return { albedo, roughness, normal };
}

/**
 * Harbor wall: a 3.4 × 0.5 × 0.4 m block of weathered stone.
 * Origin is the box centre (same convention as ocean-body); the flat
 * +Y top face is the placement surface for harbour-side content.
 */
export function createHarborWall(): Object3D {
  // Extra segments allow the slight irregularity below
  const geometry = new BoxGeometry(3.4, 0.5, 0.4, 16, 4, 3);

  // Slight irregularity: position-derived offsets. Identical positions get
  // identical offsets, so split corner verts stay welded (no cracks).
  const pos = geometry.attributes.position;
  const AMP_XZ = 0.01;
  const AMP_Y = 0.005; // keep the +Y placement surface near-flat
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const ox = Math.sin(y * 9.1 + z * 5.3) * Math.sin(z * 7.7 + x * 3.1);
    const oy = Math.sin(z * 8.3 + x * 4.9) * Math.sin(x * 6.1 + y * 5.7);
    const oz = Math.sin(x * 7.9 + y * 6.3) * Math.sin(y * 8.7 + z * 4.1);
    pos.setXYZ(i, x + ox * AMP_XZ, y + oy * AMP_Y, z + oz * AMP_XZ);
  }
  geometry.computeVertexNormals();

  // Box-projected UVs at a fixed world scale: uniform texel density on
  // every face, no stretching between the 3.4 m and 0.5 m faces.
  const nor = geometry.attributes.normal;
  const uv = geometry.attributes.uv;
  const TILE = 0.5; // metres per texture repeat
  for (let i = 0; i < pos.count; i++) {
    const anx = Math.abs(nor.getX(i));
    const any = Math.abs(nor.getY(i));
    const anz = Math.abs(nor.getZ(i));
    const px = pos.getX(i);
    const py = pos.getY(i);
    const pz = pos.getZ(i);
    let u: number;
    let v: number;
    if (anx >= any && anx >= anz) {
      u = pz;
      v = py;
    } else if (any >= anz) {
      u = px;
      v = pz;
    } else {
      u = px;
      v = py;
    }
    uv.setXY(i, u / TILE, v / TILE);
  }
  uv.needsUpdate = true;

  const maps = generateWallMaps();

  const material = new MeshStandardMaterial({
    map: maps.albedo,
    roughnessMap: maps.roughness,
    normalMap: maps.normal,
    roughness: 1.0,
    metalness: 0,
  });

  const mesh = new Mesh(geometry, material);
  mesh.name = 'harbor-wall-mesh';

  const root = new Object3D();
  root.name = 'harbor-wall';
  root.add(mesh);

  return root;
}
