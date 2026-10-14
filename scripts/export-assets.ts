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
  DoubleSide,
  ExtrudeGeometry,
  LatheGeometry,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Shape,
  SphereGeometry,
  SRGBColorSpace,
  Vector2,
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
// Pirate ship (lofted hull + bow gun on a gun_rotate pivot)
// ---------------------------------------------------------------------------

/** Warm, low-contrast ship palette (planking, deck, canvas, rigging). */
const HULL_COLOR = 0x5c4430;
const DECK_COLOR = 0x8a6c49;
const CABIN_COLOR = 0x6b4f34;
const MAST_COLOR = 0x74583a;
const SAIL_COLOR = 0xc0a279;
const FLAG_COLOR = 0x8c3b2e;

interface HullStation {
  z: number; // station position, stern +Z -> bow -Z
  halfW: number; // half width at the sheer line
  keel: number; // hull bottom y (below the local waterline)
  sheer: number; // deck edge y (rises toward bow/stern)
}

/**
 * Hull stations stern (+0.6) to bow (-0.6). Envelope: ~1.2 m long, 0.42 m
 * beam, 0.12 m draught, sheer 0.13-0.26 m — compact enough for a flotilla
 * of attackers next to the 0.4 m-wide harbour cannons.
 */
const HULL_STATIONS: HullStation[] = [
  { z: 0.6, halfW: 0.13, keel: -0.06, sheer: 0.22 },
  { z: 0.45, halfW: 0.185, keel: -0.1, sheer: 0.17 },
  { z: 0.25, halfW: 0.205, keel: -0.12, sheer: 0.14 },
  { z: 0, halfW: 0.21, keel: -0.12, sheer: 0.13 },
  { z: -0.25, halfW: 0.19, keel: -0.11, sheer: 0.14 },
  { z: -0.42, halfW: 0.135, keel: -0.08, sheer: 0.17 },
  { z: -0.54, halfW: 0.07, keel: -0.04, sheer: 0.21 },
  { z: -0.6, halfW: 0.015, keel: -0.01, sheer: 0.26 },
];

const _vA = new Vector3();
const _vB = new Vector3();
const _vC = new Vector3();
const _edgeAB = new Vector3();
const _edgeAC = new Vector3();
const _faceN = new Vector3();
const _faceMid = new Vector3();
const _centroid = new Vector3();

/**
 * Flip triangles whose face normal points toward the vertex centroid, so
 * the hand-lofted hull is watertight-outward regardless of ring winding.
 */
function ensureOutward(geo: BufferGeometry): void {
  const pos = geo.attributes.position as BufferAttribute;
  const col = geo.attributes.color as BufferAttribute | undefined;
  const swap = (attr: BufferAttribute, a: number, b: number): void => {
    const ax = attr.getX(a);
    const ay = attr.getY(a);
    const az = attr.getZ(a);
    attr.setXYZ(a, attr.getX(b), attr.getY(b), attr.getZ(b));
    attr.setXYZ(b, ax, ay, az);
  };
  _centroid.set(0, 0, 0);
  for (let i = 0; i < pos.count; i++) {
    _centroid.x += pos.getX(i);
    _centroid.y += pos.getY(i);
    _centroid.z += pos.getZ(i);
  }
  _centroid.multiplyScalar(1 / pos.count);
  for (let i = 0; i < pos.count; i += 3) {
    _vA.fromBufferAttribute(pos, i);
    _vB.fromBufferAttribute(pos, i + 1);
    _vC.fromBufferAttribute(pos, i + 2);
    _edgeAB.subVectors(_vB, _vA);
    _edgeAC.subVectors(_vC, _vA);
    _faceN.crossVectors(_edgeAB, _edgeAC);
    _faceMid.copy(_vA).add(_vB).add(_vC).multiplyScalar(1 / 3).sub(_centroid);
    if (_faceN.dot(_faceMid) < 0) {
      swap(pos, i + 1, i + 2);
      if (col) swap(col, i + 1, i + 2);
    }
  }
}

interface LoftPoint {
  x: number;
  y: number;
  z: number;
  deck: boolean;
}

/**
 * Low-poly hull as one closed surface: U-shaped sections lofted between
 * stations (stern +Z -> bow -Z), the top closed by a flat deck strip, tiny
 * transom/stem fans closing the ends. Colours separate planking from deck.
 */
function buildHull(rand: () => number): BufferGeometry {
  const RING_U = [-1, -0.5, 0, 0.5, 1];
  const DECK_MID = 0.45; // deck strip intermediate points, × halfW
  const ringCount = RING_U.length + 2;

  // Closed cross-section loop: port sheer -> keel -> starboard sheer -> deck.
  const ringPoint = (st: HullStation, k: number): LoftPoint => {
    if (k < RING_U.length) {
      const u = RING_U[k];
      return {
        x: st.halfW * Math.sin((u * Math.PI) / 2),
        y: st.keel + (st.sheer - st.keel) * Math.pow(Math.abs(u), 1.6),
        z: st.z,
        deck: false,
      };
    }
    const side = k === RING_U.length ? 1 : -1;
    return { x: side * DECK_MID * st.halfW, y: st.sheer, z: st.z, deck: true };
  };

  const positions: number[] = [];
  const colors: number[] = [];
  const base = new Color();
  const pushTri = (p: LoftPoint, q: LoftPoint, r: LoftPoint): void => {
    for (const pt of [p, q, r]) {
      positions.push(pt.x, pt.y, pt.z);
      const f = 1 + (rand() * 2 - 1) * 0.04;
      base.set(pt.deck ? DECK_COLOR : HULL_COLOR);
      colors.push(
        Math.min(1, base.r * f),
        Math.min(1, base.g * f),
        Math.min(1, base.b * f),
      );
    }
  };

  // Side + deck loft between consecutive stations.
  for (let s = 0; s < HULL_STATIONS.length - 1; s++) {
    const a = HULL_STATIONS[s];
    const b = HULL_STATIONS[s + 1];
    for (let k = 0; k < ringCount; k++) {
      const kNext = (k + 1) % ringCount;
      const p0 = ringPoint(a, k);
      const p1 = ringPoint(b, k);
      const p2 = ringPoint(b, kNext);
      const p3 = ringPoint(a, kNext);
      pushTri(p0, p1, p2);
      pushTri(p0, p2, p3);
    }
  }

  // Transom (stern) and stem (bow) caps as fans from the section centre.
  for (const end of [0, HULL_STATIONS.length - 1]) {
    const st = HULL_STATIONS[end];
    const centre: LoftPoint = {
      x: 0,
      y: (st.keel + st.sheer) / 2,
      z: st.z,
      deck: false,
    };
    for (let k = 0; k < ringCount; k++) {
      pushTri(
        centre,
        ringPoint(st, k),
        ringPoint(st, (k + 1) % ringCount),
      );
    }
  }

  const geo = new BufferGeometry();
  geo.setAttribute(
    'position',
    new BufferAttribute(new Float32Array(positions), 3),
  );
  geo.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
  ensureOutward(geo);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Deck furniture, rigging and sail — merged into the hull mesh so the whole
 * ship body stays one draw call. Heights reference the interpolated sheer
 * line so every piece lands flush on the deck.
 */
function buildShipSuperstructure(rand: () => number): BufferGeometry {
  const parts: BufferGeometry[] = [];

  // Forecastle deck block carrying the bow gun (top face at y = 0.223).
  const foreDeck = new BoxGeometry(0.3, 0.06, 0.3);
  foreDeck.translate(0, 0.193, -0.38);
  paint(foreDeck, DECK_COLOR, 0.03, rand);
  parts.push(foreDeck);

  // Raised stern cabin.
  const cabin = new BoxGeometry(0.22, 0.09, 0.3);
  cabin.translate(0, 0.211, 0.42);
  paint(cabin, CABIN_COLOR, 0.035, rand);
  parts.push(cabin);

  // Mast (bottom on deck at z = -0.05) and its yard.
  const mast = new CylinderGeometry(0.011, 0.015, 0.74, 8);
  mast.translate(0, 0.5, -0.05);
  paint(mast, MAST_COLOR, 0.03, rand);
  parts.push(mast);

  const yard = new CylinderGeometry(0.007, 0.007, 0.54, 6);
  yard.rotateZ(Math.PI / 2);
  yard.translate(0, 0.76, -0.05);
  paint(yard, MAST_COLOR, 0.03, rand);
  parts.push(yard);

  // Square sail hung high on the mast, bellying toward the bow (-Z): a
  // horizontal arc eases to the yard/sheet edges while the vertical
  // profile keeps the mid-height fullest, so it reads as wind-filled.
  const sailW = 0.5;
  const sailH = 0.36;
  const sail = new PlaneGeometry(sailW, sailH, 5, 4);
  const sailPos = sail.attributes.position as BufferAttribute;
  for (let i = 0; i < sailPos.count; i++) {
    const u = sailPos.getX(i) / (sailW / 2);
    const v = sailPos.getY(i) / (sailH / 2);
    sailPos.setZ(
      i,
      sailPos.getZ(i) -
        0.045 *
          Math.cos((u * Math.PI) / 2) *
          (0.55 + 0.45 * Math.cos((v * Math.PI) / 2)),
    );
  }
  sail.computeVertexNormals();
  sail.translate(0, 0.58, -0.06);
  paint(sail, SAIL_COLOR, 0.02, rand);
  parts.push(sail);

  // Pennant flag at the masthead; the inner edge starts just outside the
  // mast surface so the cylinder never pokes through the cloth.
  const flag = new PlaneGeometry(0.11, 0.055);
  flag.translate(0.075, 0.85, -0.05);
  paint(flag, FLAG_COLOR, 0.02, rand);
  parts.push(flag);

  // Bowsprit leaning up-forward from the stem.
  const bowsprit = new CylinderGeometry(0.007, 0.011, 0.3, 6);
  bowsprit.rotateX(-Math.PI / 5);
  bowsprit.translate(0, 0.37, -0.688);
  paint(bowsprit, MAST_COLOR, 0.03, rand);
  parts.push(bowsprit);

  return mergeParts(parts);
}

/**
 * Medieval pirate raider.
 *
 * - Origin: centre of the waterline plane; y = 0 is the local waterline,
 *   the keel reaches -0.12 and the hull sides rise to the sheer line.
 * - Forward: bow points -Z (matching the cannon muzzle convention), so the
 *   bow gun fires straight ahead without extra rotation.
 * - `gun_rotate` is the bow-gun elevation pivot, 0.15 m above the carriage
 *   origin on the forecastle deck; identical semantics to the harbour gun.
 * - Three draw calls: merged hull/superstructure, merged wood carriage,
 *   merged iron barrel. All colour is vertex-baked; base colour is white.
 */
function createPirateShipExport(): Object3D {
  const rand = makeRandom(20261014);

  const hullMaterial = new MeshStandardMaterial({
    name: 'ship-hull',
    color: 0xffffff,
    roughness: 0.6,
    metalness: 0,
    vertexColors: true,
    // The hull is a closed solid, but the sail and pennant are thin planes:
    // double-sided keeps them visible from any heading the ship is placed at.
    side: DoubleSide,
  });
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

  const hullMesh = new Mesh(
    mergeParts([buildHull(rand), buildShipSuperstructure(rand)]),
    hullMaterial,
  );
  hullMesh.name = 'ship-hull';

  const carriageMesh = new Mesh(buildCarriage(rand), woodMaterial);
  carriageMesh.name = 'ship-carriage';
  carriageMesh.position.set(0, 0.223, -0.38);

  const barrelMesh = new Mesh(buildBarrel(rand), ironMaterial);
  barrelMesh.name = 'ship-barrel';

  const gunRotate = new Object3D();
  gunRotate.name = 'gun_rotate';
  gunRotate.position.set(0, 0.373, -0.38);
  gunRotate.add(barrelMesh);

  const root = new Object3D();
  root.name = 'pirate-ship';
  root.add(hullMesh);
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
await exportGLB(createPirateShipExport(), 'pirate-ship.glb');
console.log('\nDone. GLBs written to public/gltf/');
