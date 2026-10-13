/**
 * One-shot asset solidification: builds the ocean body, harbor wall and
 * cannon procedurally (same code that used to run at app runtime) and
 * exports them as binary glTF files under public/gltf/.
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
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  ExtrudeGeometry,
  LatheGeometry,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Shape,
  SphereGeometry,
  SRGBColorSpace,
  Vector2,
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
// Ocean body (geometry only — the wave/reflection shader stays in the app)
// ---------------------------------------------------------------------------

function createOceanBodyExport(): Object3D {
  // 3 m wide, 0.25 m thick, 6 m long; 10×1×20 segments keep the top
  // surface visibly low-poly. White vertex colours per solidification spec.
  const geometry = new BoxGeometry(3, 0.25, 6, 10, 1, 20);
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
function createHarborWallExport(): Object3D {
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

// ---------------------------------------------------------------------------
// Cannon (verbatim move from the old runtime scene-asset)
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

/** Override the colour of vertices matching a predicate (flat, no mottle). */
function paintWhere(
  geo: BufferGeometry,
  hex: number,
  match: (x: number, y: number, z: number) => boolean,
): void {
  const pos = geo.attributes.position as BufferAttribute;
  const colorAttr = geo.attributes.color as BufferAttribute;
  const c = new Color(hex);
  for (let i = 0; i < pos.count; i++) {
    if (match(pos.getX(i), pos.getY(i), pos.getZ(i))) {
      colorAttr.setXYZ(i, c.r, c.g, c.b);
    }
  }
  colorAttr.needsUpdate = true;
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

// Wood colours (warm, low-contrast browns)
const CHEEK_COLOR = 0x705036;
const WHEEL_COLOR = 0x835f3d;
const TRANSOM_COLOR = 0x60412a;
const QUOIN_COLOR = 0x6b4a2f;
// Iron colours (dark gunmetal)
const BARREL_COLOR = 0x494e54;
const BORE_COLOR = 0x0b0c0e;

/**
 * Wooden sea-coast carriage: two sloped cheek brackets, front/rear
 * transoms, four solid truck wheels and a breeching quoin wedge.
 * Built in cannon-root space; wheel bottoms sit on the y = 0 floor.
 */
function buildCarriage(rand: () => number): BufferGeometry {
  const parts: BufferGeometry[] = [];

  // Cheek plates: trapezoid in the Z-Y plane (low at the muzzle end -Z,
  // rising toward the breech +Z), extruded along X.
  const cheekShape = new Shape();
  cheekShape.moveTo(-0.115, 0.045);
  cheekShape.lineTo(-0.115, 0.118);
  cheekShape.lineTo(0.135, 0.162);
  cheekShape.lineTo(0.135, 0.045);
  cheekShape.closePath();
  const cheekExtrude = new ExtrudeGeometry(cheekShape, {
    depth: 0.025,
    bevelEnabled: true,
    bevelThickness: 0.002,
    bevelSize: 0.002,
    bevelSegments: 1,
  });
  // Extrusion runs along shape-local +Z; swing it to world X.
  cheekExtrude.rotateY(-Math.PI / 2);
  const cheekPlus = cheekExtrude.clone();
  cheekPlus.translate(0.1, 0, 0);
  const cheekMinus = cheekExtrude.clone();
  cheekMinus.translate(-0.075, 0, 0);
  paint(cheekPlus, CHEEK_COLOR, 0.04, rand);
  paint(cheekMinus, CHEEK_COLOR, 0.04, rand);
  parts.push(cheekPlus, cheekMinus);

  // Four solid truck wheels (no independent spin required).
  const wheelGeo = new CylinderGeometry(0.052, 0.052, 0.024, 14);
  wheelGeo.rotateZ(Math.PI / 2); // cylinder axis Y -> X
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const wheel = wheelGeo.clone();
      wheel.translate(sx * 0.114, 0.052, sz * 0.1);
      paint(wheel, WHEEL_COLOR, 0.045, rand);
      parts.push(wheel);
    }
  }

  // Cross transoms tying the cheeks together, front and rear.
  const frontTransom = new BoxGeometry(0.15, 0.025, 0.03);
  frontTransom.translate(0, 0.095, -0.09);
  paint(frontTransom, TRANSOM_COLOR, 0.035, rand);
  parts.push(frontTransom);

  const rearTransom = new BoxGeometry(0.15, 0.03, 0.035);
  rearTransom.translate(0, 0.138, 0.115);
  paint(rearTransom, TRANSOM_COLOR, 0.035, rand);
  parts.push(rearTransom);

  // Quoin: wedge under the breech supporting elevation.
  const quoinShape = new Shape();
  quoinShape.moveTo(0.02, 0.128);
  quoinShape.lineTo(0.13, 0.108);
  quoinShape.lineTo(0.13, 0.075);
  quoinShape.lineTo(0.02, 0.075);
  quoinShape.closePath();
  const quoin = new ExtrudeGeometry(quoinShape, {
    depth: 0.08,
    bevelEnabled: true,
    bevelThickness: 0.002,
    bevelSize: 0.002,
    bevelSegments: 1,
  });
  quoin.rotateY(-Math.PI / 2);
  quoin.translate(0.04, 0, 0); // centre on X
  paint(quoin, QUOIN_COLOR, 0.035, rand);
  parts.push(quoin);

  return mergeParts(parts);
}

/**
 * Iron barrel assembly in gun_rotate-local space: the lathed barrel
 * profile (muzzle swell, two astragal rings, reinforced breech,
 * cascabel), side trunnions and cascabel knob. The trunnion axis runs
 * through local origin (0, 0, 0), which is the elevation pivot.
 */
function buildBarrel(rand: () => number): BufferGeometry {
  // Lathe profile as (radius, y); after rotateX(+90deg) y maps to world z,
  // so negative y becomes the -Z muzzle end.
  const profile: Vector2[] = [
    new Vector2(0.0, -0.2), // muzzle face centre (faked bore)
    new Vector2(0.03, -0.2),
    new Vector2(0.036, -0.193), // muzzle swell
    new Vector2(0.033, -0.185),
    new Vector2(0.027, -0.178),
    new Vector2(0.025, -0.15),
    new Vector2(0.024, -0.08),
    new Vector2(0.029, -0.072), // astragal ring 1
    new Vector2(0.029, -0.062),
    new Vector2(0.024, -0.054),
    new Vector2(0.024, 0.02),
    new Vector2(0.03, 0.028), // astragal ring 2
    new Vector2(0.03, 0.04),
    new Vector2(0.026, 0.048),
    new Vector2(0.033, 0.075), // reinforced breech
    new Vector2(0.034, 0.11),
    new Vector2(0.03, 0.135),
    new Vector2(0.018, 0.146),
    new Vector2(0.01, 0.152),
    new Vector2(0.0, 0.154), // sealed breech face
  ];
  const barrelGeo = new LatheGeometry(profile, 24);
  barrelGeo.rotateX(Math.PI / 2);
  paint(barrelGeo, BARREL_COLOR, 0.03, rand);
  // Flat muzzle disc reads as the dark bore from the front.
  paintWhere(barrelGeo, BORE_COLOR, (_x, _y, z) => z <= -0.199);

  // Trunnions on the pivot axis, resting on the cheek brackets.
  const trunnionGeo = new CylinderGeometry(0.008, 0.008, 0.06, 10);
  trunnionGeo.rotateZ(Math.PI / 2);
  const trunnionPlus = trunnionGeo.clone();
  trunnionPlus.translate(0.06, 0, 0.045);
  const trunnionMinus = trunnionGeo.clone();
  trunnionMinus.translate(-0.06, 0, 0.045);
  paint(trunnionPlus, BARREL_COLOR, 0.03, rand);
  paint(trunnionMinus, BARREL_COLOR, 0.03, rand);

  // Cascabel knob at the breech end.
  const cascabelGeo = new SphereGeometry(0.015, 12, 8);
  cascabelGeo.translate(0, 0, 0.158);
  paint(cascabelGeo, BARREL_COLOR, 0.03, rand);

  return mergeParts([barrelGeo, trunnionPlus, trunnionMinus, cascabelGeo]);
}

/**
 * Medieval harbour-defence cannon.
 *
 * - Origin: centre of the wheel contact rectangle; y = 0 is the floor.
 * - Forward: muzzle points -Z (toward the sea), breech toward +Z.
 * - `gun_rotate` is the elevation pivot at the trunnion axis
 *   (0, 0.15, 0). Positive rotation.x lifts the muzzle; the barrel mesh
 *   is its only child so future aim systems rotate this node directly.
 * - Two draw calls: one merged wood carriage, one merged iron barrel.
 *   All colour comes from vertex colors; material base colour is white.
 */
function createCannonExport(): Object3D {
  const rand = makeRandom(20261013);

  const woodMaterial = new MeshStandardMaterial({
    name: 'cannon-wood',
    color: 0xffffff,
    roughness: 0.7,
    metalness: 0,
    vertexColors: true,
  });
  const ironMaterial = new MeshStandardMaterial({
    name: 'cannon-iron',
    color: 0xffffff,
    roughness: 0.5,
    metalness: 1,
    vertexColors: true,
  });

  const carriageMesh = new Mesh(buildCarriage(rand), woodMaterial);
  carriageMesh.name = 'cannon-carriage';

  const barrelMesh = new Mesh(buildBarrel(rand), ironMaterial);
  barrelMesh.name = 'cannon-barrel';

  const gunRotate = new Object3D();
  gunRotate.name = 'gun_rotate';
  gunRotate.position.set(0, 0.15, 0);
  gunRotate.add(barrelMesh);

  const root = new Object3D();
  root.name = 'cannon';
  root.add(carriageMesh);
  root.add(gunRotate);

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
await exportGLB(createHarborWallExport(), 'harbor-wall.glb');
await exportGLB(createCannonExport(), 'cannon.glb');
console.log('\nDone. GLBs written to public/gltf/');
