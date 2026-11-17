/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  BoxGeometry,
  BufferAttribute,
  Color,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  SRGBColorSpace,
} from '@iwsdk/core';

// mulberry32 — deterministic, so every session builds the identical wall.
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

/** Stateless 3D lattice hash — deterministic across runs and realms. */
function hash3(x: number, y: number, z: number): number {
  let h =
    (Math.imul(x, 374761393) ^
      Math.imul(y, 668265263) ^
      Math.imul(z, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function valueNoise3(x: number, y: number, z: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const u = smooth(x - xi);
  const v = smooth(y - yi);
  const w = smooth(z - zi);
  let acc = 0;
  for (let dz = 0; dz <= 1; dz++) {
    for (let dy = 0; dy <= 1; dy++) {
      for (let dx = 0; dx <= 1; dx++) {
        const weight = (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w);
        acc += hash3(xi + dx, yi + dy, zi + dz) * weight;
      }
    }
  }
  return acc;
}

interface Blotch {
  cx: number;
  cy: number;
  cz: number;
  radius: number;
  strength: number;
}

/**
 * Harbor wall: a 3.4 × 0.5 × 0.4 m block of weathered stone.
 * Origin is the box centre; the flat +Y top face is the placement surface.
 *
 * Mottling is baked into vertex colours (no textures): a 3D fractal value
 * noise field plus a handful of large soft blotches sampled at each vertex.
 * Segments are 48×8×6 (~2.9k triangles) so the blotch blocks stay broad and
 * low-poly rather than finely speckled.
 */
export function createHarborWall(): Object3D {
  const geometry = new BoxGeometry(3.4, 0.5, 0.4, 48, 8, 6);

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

  // Large soft blotches scattered through the wall volume (toroidal-free:
  // vertex colours have no seams to wrap across).
  const rand = makeRandom(20261012);
  const blotches: Blotch[] = [];
  const BLOTCHES = 26;
  for (let b = 0; b < BLOTCHES; b++) {
    blotches.push({
      cx: (rand() - 0.5) * 3.6,
      cy: (rand() - 0.5) * 0.62,
      cz: (rand() - 0.5) * 0.52,
      radius: 0.08 + rand() * 0.14,
      strength: 0.3 + rand() * 0.3,
    });
  }

  const colors = new Float32Array(pos.count * 3);
  const color = new Color();
  for (let i = 0; i < pos.count; i++) {
    const px = pos.getX(i);
    const py = pos.getY(i);
    const pz = pos.getZ(i);

    // Fractal grain, normalised to ~0..1
    const h =
      (valueNoise3(px * 3, py * 3, pz * 3) * 0.55 +
        valueNoise3(px * 7, py * 7, pz * 7) * 0.3 +
        valueNoise3(px * 15, py * 15, pz * 15) * 0.15) /
      1.0;

    // Strongest blotch wins; hard cell edge with a narrow rim
    let stain = 0;
    for (const b of blotches) {
      const dx = px - b.cx;
      const dy = py - b.cy;
      const dz = pz - b.cz;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < b.radius) {
        const t = d / b.radius;
        const f = t < 0.75 ? 1 : 1 - (t - 0.75) / 0.25;
        const v = f * b.strength;
        if (v > stain) stain = v;
      }
    }

    const jitter = (rand() - 0.5) * 0.05;
    const brightness = 0.82 + h * 0.24 + jitter;
    const stainShade = 1 - stain * 0.14;
    color.setRGB(
      0.56 * brightness * stainShade,
      0.56 * brightness * stainShade,
      0.55 * brightness * stainShade,
      SRGBColorSpace,
    );
    colors[i * 3 + 0] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  geometry.setAttribute('color', new BufferAttribute(colors, 3));

  const material = new MeshStandardMaterial({
    name: 'harbor-wall-stone',
    color: 0xffffff,
    roughness: 0.75,
    metalness: 0,
    vertexColors: true,
  });

  const mesh = new Mesh(geometry, material);
  mesh.name = 'harbor-wall-mesh';

  const root = new Object3D();
  root.name = 'harbor-wall';
  root.add(mesh);
  return root;
}
