/**
 * One-shot asset solidification: builds the remaining procedural models
 * (same code that used to run at app runtime) and exports them as binary
 * glTF files under public/gltf/. The harbor wall and cannon are no longer
 * solidified — the app builds them in code when battle loading starts.
 *
 * Run with: npm run export-assets
 *
 * Node 24 executes this TypeScript directly (type stripping). Imports come
 * from '@iwsdk/core' so the script shares the exact three.js build the app
 * bundles with; GLTFExporter is the only piece taken from three/addons.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  Box3,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
} from '@iwsdk/core';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

const OUT_DIR = fileURLToPath(new URL('../public/gltf/', import.meta.url));

// GLTFExporter assembles the GLB through FileReader (a browser global).
// Minimal shim backed by Blob.arrayBuffer() so the exporter runs under Node.
if (typeof globalThis.FileReader === 'undefined') {
  class NodeFileReader {
    onloadend: (() => void) | null = null;
    onerror: ((err: unknown) => void) | null = null;
    result: ArrayBuffer | null = null;
    readAsArrayBuffer(blob: Blob): void {
      blob.arrayBuffer().then(
        (buf) => {
          this.result = buf;
          this.onloadend?.();
        },
        (err: unknown) => this.onerror?.(err),
      );
    }
  }
  (globalThis as Record<string, unknown>).FileReader = NodeFileReader;
}

// mulberry32 — deterministic, so re-running the export reproduces the GLBs.
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

// ---------------------------------------------------------------------------
// Ocean surface (geometry only — the reflection shader stays in the app)
// ---------------------------------------------------------------------------

function createOceanBodyExport(): Object3D {
  // One flat 15 × 15 m quad (no subdivision, no thickness). The vertex stage
  // no longer displaces it, so a single face carries the whole sea.
  const geometry = new PlaneGeometry(15, 15);
  geometry.rotateX(-Math.PI / 2);
  const colors = new Float32Array(geometry.attributes.position.count * 3).fill(1);
  geometry.setAttribute('color', new BufferAttribute(colors, 3));

  const material = new MeshStandardMaterial({
    name: 'ocean-default',
    color: 0xffffff,
    roughness: 0.9,
    metalness: 0,
    vertexColors: true,
  });

  const mesh = new Mesh(geometry, material);
  mesh.name = 'ocean-body-mesh';

  const root = new Object3D();
  root.name = 'ocean-body';
  root.add(mesh);
  return root;
}

// ---------------------------------------------------------------------------
// Harbor wall (geometry + mottled vertex colours, no textures)
// ---------------------------------------------------------------------------

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
        const weight =
          (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w);
        acc += hash3(xi + dx, yi + dy, zi + dz) * weight;
      }
    }
  }
  return acc;
}

// ---------------------------------------------------------------------------
// Cannon parts shared by the pirate ship deck gun
// ---------------------------------------------------------------------------

/**
 * Fill a geometry's COLOR attribute. Base colour is an sRGB hex value run
 * through Color (r181 stores its r/g/b in linear space); every vertex gets a
 * deterministic low-contrast mottle around it.
 */
function paint(
  geo: BufferGeometry,
  hex: number,
  jitter: number,
  rand: () => number,
): void {
  const pos = geo.attributes.position as BufferAttribute;
  const base = new Color(hex);
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const f = 1 + (rand() * 2 - 1) * jitter;
    colors[i * 3 + 0] = Math.min(1, base.r * f);
    colors[i * 3 + 1] = Math.min(1, base.g * f);
    colors[i * 3 + 2] = Math.min(1, base.b * f);
  }
  geo.setAttribute('color', new BufferAttribute(colors, 3));
}

/**
 * Concatenate a set of independently built parts into one indexed-free
 * geometry. Every input is un-indexed first, so parts never share vertices:
 * hard edges between wood/iron pieces stay faceted instead of smoothing.
 */
function mergeParts(parts: BufferGeometry[]): BufferGeometry {
  let vertexCount = 0;
  const flat = parts.map((part) => {
    const g = part.index ? part.toNonIndexed() : part;
    vertexCount += g.attributes.position.count;
    return g;
  });

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const colors = new Float32Array(vertexCount * 3);

  let offset = 0;
  for (const g of flat) {
    positions.set(g.attributes.position.array as Float32Array, offset * 3);
    normals.set(g.attributes.normal.array as Float32Array, offset * 3);
    colors.set(g.attributes.color.array as Float32Array, offset * 3);
    const uvAttr = g.attributes.uv;
    if (uvAttr) {
      uvs.set(uvAttr.array as Float32Array, offset * 2);
    }
    offset += g.attributes.position.count;
  }

  const merged = new BufferGeometry();
  merged.setAttribute('position', new BufferAttribute(positions, 3));
  merged.setAttribute('normal', new BufferAttribute(normals, 3));
  merged.setAttribute('uv', new BufferAttribute(uvs, 2));
  merged.setAttribute('color', new BufferAttribute(colors, 3));
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

/**
 * A cylinder strut spanned between two points — the rigging primitive for
 * bow strings, crank arms and any tension member that reads as a line.
 */
function strut(a: Vector3, b: Vector3, radius: number, segments = 5): BufferGeometry {
  const dir = new Vector3().subVectors(b, a);
  const length = dir.length();
  const geo = new CylinderGeometry(radius, radius, length, segments);
  const quaternion = new Quaternion().setFromUnitVectors(
    new Vector3(0, 1, 0),
    dir.normalize(),
  );
  geo.applyQuaternion(quaternion);
  geo.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return geo;
}

// Wood colours (warm, low-contrast browns)
const CHEEK_COLOR = 0x705036;
const WHEEL_COLOR = 0x835f3d;
const TRANSOM_COLOR = 0x60412a;
const QUOIN_COLOR = 0x6b4a2f;
// Iron colours (dark gunmetal)
const BARREL_COLOR = 0x494e54;
const BORE_COLOR = 0x0b0c0e;

// ---------------------------------------------------------------------------
// Shared warm palette (planking, deck, canvas, rigging)
// ---------------------------------------------------------------------------

/** Warm, low-contrast colours shared by the remaining units. */
const HULL_COLOR = 0x5c4430;
const DECK_COLOR = 0x8a6c49;
const MAST_COLOR = 0x74583a;
const FLAG_COLOR = 0xd40000;

// ---------------------------------------------------------------------------
// Defense pad (empty-slot pedestal disc under every defense slot)
// ---------------------------------------------------------------------------

/**
 * Cement-gray pedestal pad: a flat-shaded 16-sided drum, Ø0.38 × 0.04 m, no
 * bevel. One merged mesh (~64 triangles); all colour is vertex-baked mottle
 * on one white roughness-0.75 dielectric — the harbor-wall material family.
 *
 * - Origin: centre of the contact face; y = 0 sits on the wall top, so a
 *   unit stepping onto the pad stands one pad-height higher.
 * - The material bakes a full-strength warm-gold emissive: the runtime
 *   breathes empty slots by writing material.emissiveIntensity only (one
 *   shared instance across every clone, so all pads pulse in lockstep).
 */
function createDefensePadExport(): Object3D {
  const rand = makeRandom(20261024);

  // 16-sided drum. CylinderGeometry(16) is exactly 64 triangles (32 wall +
  // 32 caps) and ships exactly the 45°-auto-smooth normals we want baked:
  // wall vertices carry smooth radial normals (the 22.5° facet dihedral reads
  // as one continuous drum), caps carry their own axis normals, and wall/cap
  // vertices live in separate ranges so the 90° rim edge stays hard. Never
  // toNonIndexed + recompute here — that bakes per-face normals and the drum
  // falls apart into 16 visibly faceted bands under the tilted key light.
  const geometry = new CylinderGeometry(0.1893375, 0.1893375, 0.04, 16);
  geometry.translate(0, 0.02, 0); // y = 0 is the contact face

  // Large, low-contrast cement mottle baked into vertex colors — the wall's
  // recipe scaled to the disc: soft value-noise field plus a few big stains.
  const pos = geometry.attributes.position as BufferAttribute;
  const blotches: Blotch[] = [];
  for (let b = 0; b < 8; b++) {
    blotches.push({
      cx: (rand() - 0.5) * 0.62,
      cy: rand() * 0.26,
      cz: (rand() - 0.5) * 0.62,
      radius: 0.12 + rand() * 0.2,
      strength: 0.3 + rand() * 0.3,
    });
  }
  const colors = new Float32Array(pos.count * 3);
  const color = new Color();
  for (let i = 0; i < pos.count; i++) {
    const px = pos.getX(i);
    const py = pos.getY(i);
    const pz = pos.getZ(i);

    const h =
      valueNoise3(px * 3, py * 3, pz * 3) * 0.6 +
      valueNoise3(px * 8, py * 8, pz * 8) * 0.4;

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

    const jitter = (rand() - 0.5) * 0.04;
    const brightness = 0.84 + h * 0.16 + jitter;
    const stainShade = 1 - stain * 0.12;
    color.setRGB(
      0.62 * brightness * stainShade,
      0.62 * brightness * stainShade,
      0.61 * brightness * stainShade,
      SRGBColorSpace,
    );
    colors[i * 3 + 0] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  geometry.setAttribute('color', new BufferAttribute(colors, 3));

  const material = new MeshStandardMaterial({
    name: 'defense-pad',
    color: 0xffffff,
    roughness: 0.75,
    metalness: 0,
    vertexColors: true,
    // Empty-slot glow, baked at full strength so the runtime only ever
    // writes the one emissiveIntensity scalar.
    emissive: 0xffc46a,
    emissiveIntensity: 1,
  });

  const mesh = new Mesh(geometry, material);
  mesh.name = 'defense-pad-mesh';

  const root = new Object3D();
  root.name = 'defense-pad';
  root.add(mesh);
  return root;
}

// ---------------------------------------------------------------------------
// Export driver
// ---------------------------------------------------------------------------

function printStats(label: string, root: Object3D, bytes: number): void {
  let meshCount = 0;
  let triangles = 0;
  let hasVertexColors = false;
  const materials = new Set<string>();
  const nodeNames: string[] = [];

  root.traverse((child) => {
    nodeNames.push(child.name || '(unnamed)');
    const mesh = child as Mesh;
    if (!mesh.isMesh) return;
    meshCount++;
    const geo = mesh.geometry;
    triangles += Math.round(
      (geo.index ? geo.index.count : geo.attributes.position.count) / 3,
    );
    if (geo.attributes.color) hasVertexColors = true;
    const mat = mesh.material as MeshStandardMaterial;
    materials.add(
      `${mat.name} [roughness ${mat.roughness}, metalness ${mat.metalness}, vertexColors ${mat.vertexColors}]`,
    );
  });

  console.log(`\n${label}`);
  console.log(`  size:           ${(bytes / 1024).toFixed(1)} KiB`);
  console.log(`  hierarchy:      ${nodeNames.join(' > ')}`);
  console.log(`  meshes:         ${meshCount}`);
  console.log(`  triangles:      ${triangles}`);
  console.log(`  COLOR_0:        ${hasVertexColors ? 'yes' : 'NO — MISSING!'}`);
  console.log(`  materials:      ${[...materials].join('; ')}`);
}

async function exportGLB(root: Object3D, file: string): Promise<void> {
  const exporter = new GLTFExporter();
  const result = await exporter.parseAsync(root, { binary: true });
  const buffer = Buffer.from(result as ArrayBuffer);
  writeFileSync(OUT_DIR + file, buffer);
  printStats(file, root, buffer.length);
}

mkdirSync(OUT_DIR, { recursive: true });
await exportGLB(createOceanBodyExport(), 'ocean-body.glb');
// defense pads: the empty-slot pedestal discs leave runtime primitives for a
// designed, vertex-coloured GLB asset; a fresh file name keeps it isolated
// from any stale caching.
await exportGLB(createDefensePadExport(), 'defense-pad.glb');
console.log('\nDone. GLBs written to public/gltf/');
