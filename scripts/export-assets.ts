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
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  ExtrudeGeometry,
  IcosahedronGeometry,
  LatheGeometry,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Path,
  PlaneGeometry,
  Quaternion,
  Shape,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
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
  // 3 m wide, 0.25 m thick, 10 m long (was 6 m, extended by 2/3); 10×1×33
  // segments keep the same ~3.3/m vertex density so the wave look is unchanged.
  const geometry = new BoxGeometry(3, 0.25, 10, 10, 1, 33);
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
const SAIL_COLOR = 0x2a0808;
const FLAG_COLOR = 0xd40000;

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
 * Parameterized so the boss island-ship reuses the exact loft technique.
 */
function loftHull(
  stations: HullStation[],
  plankingColor: number,
  deckColor: number,
  rand: () => number,
): BufferGeometry {
  const HULL_STATIONS = stations;
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
      base.set(pt.deck ? deckColor : plankingColor);
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

/** The stock pirate raider hull: the shared loft at its authored stations. */
function buildHull(rand: () => number): BufferGeometry {
  return loftHull(HULL_STATIONS, HULL_COLOR, DECK_COLOR, rand);
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

  // Fixed cast-iron gun pedestal on the forecastle; the gun's rotating
  // turntable rides on its top face (y = 0.293) and yaws around the column's
  // central axis (x = 0, z = -0.38). Merged into the hull mesh: the pedestal
  // never rotates, so it stays part of the ship's single draw call.
  const pedestal = new CylinderGeometry(0.07, 0.085, 0.07, 14);
  pedestal.translate(0, 0.258, -0.38);
  paint(pedestal, BARREL_COLOR, 0.02, rand);
  parts.push(pedestal);

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

  // Bowsprit leaning up-forward from the stem. Shortened to 1/4 of the
  // original 0.3 m (now 0.075 m); the centre is shifted toward the base
  // before rotation so the stem-anchored root stays put and only the tip
  // recedes.
  const bowsprit = new CylinderGeometry(0.007, 0.011, 0.075, 6);
  bowsprit.translate(0, -0.1125, 0);
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
 * - `gun_rotate` is the bow-gun yaw pivot, sitting ON the fixed pedestal's
 *   central axis (x = 0, z = -0.38) so the whole gun — turntable, cheek
 *   plates and barrel — swings around its own mount, never around the hull
 *   origin. Identical yaw semantics to the runtime cannon_mount wrapper.
 * - Two draw calls: merged hull/superstructure/pedestal, merged turntable/
 *   yoke/iron barrel. All colour is vertex-baked; base colour is white.
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

  // Turntable + cheek plates in gun_rotate-local space: the disc rides on
  // the fixed pedestal (top face y = 0.293 -> local -0.052), the plates cap
  // the barrel trunnion ends (outer faces at x = +/-0.09) so the pivot reads
  // as held, and the whole assembly yaws with the barrel.
  const turntable = new CylinderGeometry(0.105, 0.11, 0.012, 20);
  turntable.translate(0, -0.046, 0);
  paint(turntable, BARREL_COLOR, 0.02, rand);
  const cheek = new BoxGeometry(0.012, 0.048, 0.05);
  const cheekPlus = cheek.clone();
  cheekPlus.translate(0.096, -0.016, 0.045);
  const cheekMinus = cheek.clone();
  cheekMinus.translate(-0.096, -0.016, 0.045);
  paint(cheekPlus, BARREL_COLOR, 0.02, rand);
  paint(cheekMinus, BARREL_COLOR, 0.02, rand);

  const barrelMesh = new Mesh(
    mergeParts([buildBarrel(rand), turntable, cheekPlus, cheekMinus]),
    ironMaterial,
  );
  barrelMesh.name = 'ship-barrel';

  const gunRotate = new Object3D();
  gunRotate.name = 'gun_rotate';
  // Pivot ON the pedestal central axis (yaw centre = cylinder centre); the
  // barrel bottom (~local -0.03 at the trunnion zone) clears the turntable
  // top (local -0.04).
  gunRotate.position.set(0, 0.345, -0.38);
  gunRotate.add(barrelMesh);

  const root = new Object3D();
  root.name = 'pirate-ship';
  root.add(hullMesh);
  root.add(gunRotate);

  return root;
}

// ---------------------------------------------------------------------------
// Sky ballista (anti-air ballista on a swivel post)
// ---------------------------------------------------------------------------

// Sky-ballista palette: shares the cannon wood/iron families, adds hemp
// string and pale fletching tints.
const STRING_COLOR = 0x9a8a6a;
const FLETCHING_COLOR = 0xcfc4a6;
const BOLT_SHAFT_COLOR = 0x8a6a45;

/**
 * Fixed pedestal in root space: the disc base, tapered post and the iron
 * collar the yoke straddles. y = 0 is the placement floor; footprint is the
 * 0.23 m disc, inside the cannon carriage's 0.25 × 0.31 m envelope.
 */
function buildBallistaBase(rand: () => number): BufferGeometry {
  const parts: BufferGeometry[] = [];

  const disc = new CylinderGeometry(0.1, 0.115, 0.03, 20);
  disc.translate(0, 0.015, 0);
  paint(disc, WHEEL_COLOR, 0.04, rand);
  parts.push(disc);

  const post = new CylinderGeometry(0.034, 0.05, 0.07, 12);
  post.translate(0, 0.065, 0);
  paint(post, CHEEK_COLOR, 0.04, rand);
  parts.push(post);

  const collar = new CylinderGeometry(0.048, 0.048, 0.02, 12);
  collar.translate(0, 0.11, 0);
  paint(collar, BARREL_COLOR, 0.03, rand);
  parts.push(collar);

  return mergeParts(parts);
}

/**
 * Rotating assembly in gun_rotate-local space (origin = the trunnion axis,
 * mounted 0.19 m above the floor). At 0° elevation the bolt points -Z; the
 * CannonAim pitch lifts the whole yoke-and-beam assembly. Sized so the tiller
 * tail, winch and yoke clear the fixed collar through the full 60-75°
 * elevation sweep and ±45° yaw.
 */
function buildBallistaAssembly(rand: () => number): BufferGeometry {
  const parts: BufferGeometry[] = [];

  // Swivel yoke: two cheek plates descending from the trunnion axis,
  // straddling the fixed collar (cheek inner faces at x = ±0.052).
  const cheek = new BoxGeometry(0.016, 0.075, 0.05);
  const cheekPlus = cheek.clone();
  cheekPlus.translate(0.06, -0.0375, 0);
  const cheekMinus = cheek.clone();
  cheekMinus.translate(-0.06, -0.0375, 0);
  paint(cheekPlus, CHEEK_COLOR, 0.04, rand);
  paint(cheekMinus, CHEEK_COLOR, 0.04, rand);
  parts.push(cheekPlus, cheekMinus);

  // Trunnion through the yoke tops, capped by iron washers.
  const trunnion = new CylinderGeometry(0.009, 0.009, 0.15, 8);
  trunnion.rotateZ(Math.PI / 2);
  paint(trunnion, BARREL_COLOR, 0.03, rand);
  parts.push(trunnion);
  for (const sx of [-1, 1]) {
    const washer = new CylinderGeometry(0.016, 0.016, 0.006, 10);
    washer.rotateZ(Math.PI / 2);
    washer.translate(sx * 0.072, 0, 0);
    paint(washer, BARREL_COLOR, 0.03, rand);
    parts.push(washer);
  }

  // Main tiller beam, nose toward -Z, riding above the trunnion axis.
  const beam = new BoxGeometry(0.035, 0.035, 0.19);
  beam.translate(0, 0.025, -0.02);
  paint(beam, CHEEK_COLOR, 0.04, rand);
  parts.push(beam);

  // Bolt-groove rails on the beam top, cradling the loaded bolt. Height is
  // 2 mm shy of the torsion block's top face (0.0465 + 0.004 = 0.0505 vs
  // 0.0525): the rails' z-run crosses the block, and equal top faces used to
  // coplanar z-fight there. Bottom stays flush on the beam top (0.0425).
  for (const sx of [-1, 1]) {
    const rail = new BoxGeometry(0.008, 0.008, 0.13);
    rail.translate(sx * 0.0135, 0.0465, -0.035);
    paint(rail, TRANSOM_COLOR, 0.035, rand);
    parts.push(rail);
  }

  // Torsion block housing the prod centre at the beam nose.
  const block = new BoxGeometry(0.075, 0.055, 0.045);
  block.translate(0, 0.025, -0.115);
  paint(block, BARREL_COLOR, 0.03, rand);
  parts.push(block);

  // Twin prod arms: one -Z half-torus lying flat, tips swept out to ±0.105.
  const prod = new TorusGeometry(0.105, 0.009, 8, 14, Math.PI);
  prod.rotateX(-Math.PI / 2);
  prod.translate(0, 0.025, -0.045);
  paint(prod, BARREL_COLOR, 0.03, rand);
  parts.push(prod);

  // Drawn string: V from both prod tips back to the nut on the beam.
  const nut = new BoxGeometry(0.018, 0.016, 0.014);
  nut.translate(0, 0.04, 0.028);
  paint(nut, BARREL_COLOR, 0.03, rand);
  parts.push(nut);
  for (const sx of [-1, 1]) {
    const string = strut(
      new Vector3(sx * 0.105, 0.025, -0.045),
      new Vector3(0, 0.04, 0.028),
      0.0022,
    );
    paint(string, STRING_COLOR, 0.02, rand);
    parts.push(string);
  }

  // Loaded bolt: shaft in the groove, iron head overhanging the nose,
  // crossed fletching at the tail.
  const shaft = new CylinderGeometry(0.005, 0.005, 0.13, 6);
  shaft.rotateX(Math.PI / 2);
  shaft.translate(0, 0.0525, -0.04);
  paint(shaft, BOLT_SHAFT_COLOR, 0.03, rand);
  parts.push(shaft);

  const head = new ConeGeometry(0.009, 0.026, 8);
  head.rotateX(-Math.PI / 2);
  head.translate(0, 0.0525, -0.118);
  paint(head, BARREL_COLOR, 0.03, rand);
  parts.push(head);

  const finAcross = new BoxGeometry(0.024, 0.0025, 0.038);
  finAcross.translate(0, 0.0525, 0.01);
  paint(finAcross, FLETCHING_COLOR, 0.02, rand);
  parts.push(finAcross);
  const finUpright = new BoxGeometry(0.0025, 0.024, 0.038);
  finUpright.translate(0, 0.0525, 0.01);
  paint(finUpright, FLETCHING_COLOR, 0.02, rand);
  parts.push(finUpright);

  // Windlass at the tiller end: iron drum on the beam top with a crank
  // arm and handle peg per side.
  const drum = new CylinderGeometry(0.013, 0.013, 0.055, 8);
  drum.rotateZ(Math.PI / 2);
  drum.translate(0, 0.05, 0.05);
  paint(drum, BARREL_COLOR, 0.03, rand);
  parts.push(drum);
  for (const sx of [-1, 1]) {
    const arm = strut(
      new Vector3(sx * 0.0275, 0.05, 0.05),
      new Vector3(sx * 0.046, 0.038, 0.05),
      0.003,
    );
    paint(arm, BARREL_COLOR, 0.03, rand);
    parts.push(arm);
    const handle = new CylinderGeometry(0.003, 0.003, 0.014, 6);
    handle.rotateZ(Math.PI / 2);
    handle.translate(sx * 0.05, 0.038, 0.05);
    paint(handle, BARREL_COLOR, 0.03, rand);
    parts.push(handle);
  }

  return mergeParts(parts);
}

/**
 * Medieval harbour anti-air ballista.
 *
 * - Origin: centre of the disc base; y = 0 is the floor (wall top).
 * - Forward: the bolt points -Z at 0 elevation (cannon muzzle convention);
 *   CannonAim's default 75° elevation points it up and slightly seaward.
 * - `gun_rotate` is the elevation pivot at the trunnion axis (0, 0.21, 0),
 *   the same node-name contract as the cannon and ship gun; the swivel
 *   assembly under it is scaled 1.2x about that axis.
 * - Two draw calls: merged fixed pedestal, merged swivel assembly. All
 *   colour is vertex-baked onto one white roughness-0.75 dielectric material.
 */
function createSkyBallistaExport(): Object3D {
  const rand = makeRandom(20261020);

  const material = new MeshStandardMaterial({
    name: 'sky-ballista',
    color: 0xffffff,
    roughness: 0.75,
    metalness: 0,
    vertexColors: true,
  });

  const baseMesh = new Mesh(buildBallistaBase(rand), material);
  baseMesh.name = 'sky-ballista-base';

  const assemblyMesh = new Mesh(buildBallistaAssembly(rand), material);
  assemblyMesh.name = 'sky-ballista-assembly';
  // Upper body enlarged 1.2x about the trunnion (scale origin = pivot): the
  // base and the fulcrum relationship stay untouched, the mount keeps its
  // balance. The pivot rises 0.19 -> 0.21 so the deeper yoke straddle seats
  // flush on the collar top and the tiller tail keeps collar clearance
  // through the full 60-75 degree sweep.
  assemblyMesh.scale.setScalar(1.2);

  const gunRotate = new Object3D();
  gunRotate.name = 'gun_rotate';
  gunRotate.position.set(0, 0.21, 0);
  gunRotate.add(assemblyMesh);

  const root = new Object3D();
  root.name = 'sky-ballista';
  root.add(baseMesh);
  root.add(gunRotate);

  return root;
}

// ---------------------------------------------------------------------------
// Bombardier (mechanical bomb-carrying flyer, single main rotor + goblin pilot)
// ---------------------------------------------------------------------------

/** Goblin skin — the whimsical little pilot reads at a glance from afar. */
const GOBLIN_COLOR = 0x6a9944;

/**
 * Gondola side profile: shape local x is the length axis with the bow at
 * +x, y is height. Extruded across the beam, then rotated so the bow lands
 * on world -Z — the shared forward convention of ships and guns. Deliberately
 * stubby: the flyer reads as a compact machine, roughly two-thirds the
 * pirate hull's length.
 */
function buildBombardierGondola(rand: () => number): BufferGeometry {
  const shape = new Shape();
  shape.moveTo(-0.3, -0.1);
  shape.lineTo(0.3, -0.1);
  shape.lineTo(0.3, 0.06);
  shape.lineTo(0.1, 0.11);
  shape.lineTo(-0.3, 0.11);
  shape.closePath();
  const geo = new ExtrudeGeometry(shape, { depth: 0.34, bevelEnabled: false });
  geo.rotateY(Math.PI / 2);
  geo.translate(-0.17, 0, 0);
  paint(geo, HULL_COLOR, 0.04, rand);
  return geo;
}

/**
 * Airframe in root space (y = 0 at the gondola mid): wooden hull with a
 * planked deck, iron straps, a stubby tail boom with red canvas fins, a
 * winch whose rope runs down to the bomb rack, one central rotor mast, and
 * the goblin pilot sitting aft with his paws on the stick — the medieval
 * "machine" story. The mast stays static here; the hub and blades live
 * under the `propellers` node.
 */
function buildBombardierBody(rand: () => number): BufferGeometry {
  const parts: BufferGeometry[] = [];

  parts.push(buildBombardierGondola(rand));

  // Deck planking across the flat sheer run, capped by iron straps that
  // read as bands clinching the hull.
  const deck = new BoxGeometry(0.32, 0.012, 0.36);
  deck.translate(0, 0.116, 0.04);
  paint(deck, DECK_COLOR, 0.03, rand);
  parts.push(deck);
  for (const z of [-0.12, 0.06, 0.24]) {
    const strap = new BoxGeometry(0.38, 0.018, 0.03);
    strap.translate(0, 0.131, z);
    paint(strap, BARREL_COLOR, 0.03, rand);
    parts.push(strap);
  }

  // Stubby tail boom with a vertical fin and horizontal stabiliser in red
  // canvas — kept short so the whole machine stays compact.
  const boom = new CylinderGeometry(0.016, 0.022, 0.2, 6);
  boom.rotateX(Math.PI / 2);
  boom.translate(0, 0.085, 0.39);
  paint(boom, MAST_COLOR, 0.03, rand);
  parts.push(boom);
  const fin = new BoxGeometry(0.014, 0.14, 0.12);
  fin.translate(0, 0.16, 0.47);
  paint(fin, FLAG_COLOR, 0.02, rand);
  parts.push(fin);
  const stabiliser = new BoxGeometry(0.24, 0.014, 0.12);
  stabiliser.translate(0, 0.1, 0.47);
  paint(stabiliser, FLAG_COLOR, 0.02, rand);
  parts.push(stabiliser);

  // Winch amidships: iron drum in an A-frame, one crank per side, and the
  // hemp rope running from the drum down to the bomb rack.
  const drum = new CylinderGeometry(0.026, 0.026, 0.15, 8);
  drum.rotateZ(Math.PI / 2);
  drum.translate(0, 0.16, 0.02);
  paint(drum, BARREL_COLOR, 0.03, rand);
  parts.push(drum);
  for (const sx of [-1, 1]) {
    for (const dz of [-0.04, 0.04]) {
      const leg = strut(
        new Vector3(sx * 0.05, 0.12, 0.02 + dz),
        new Vector3(sx * 0.075, 0.16, 0.02),
        0.004,
      );
      paint(leg, CHEEK_COLOR, 0.04, rand);
      parts.push(leg);
    }
    const arm = strut(
      new Vector3(sx * 0.075, 0.16, 0.02),
      new Vector3(sx * 0.1, 0.175, 0.02),
      0.003,
    );
    paint(arm, BARREL_COLOR, 0.03, rand);
    parts.push(arm);
    const handle = new CylinderGeometry(0.004, 0.004, 0.03, 6);
    handle.rotateX(Math.PI / 2);
    handle.translate(sx * 0.1, 0.175, 0.005);
    paint(handle, WHEEL_COLOR, 0.03, rand);
    parts.push(handle);
  }
  const rope = strut(
    new Vector3(0, 0.14, 0.02),
    new Vector3(0, -0.155, -0.12),
    0.0025,
  );
  paint(rope, STRING_COLOR, 0.02, rand);
  parts.push(rope);

  // Bomb rack slung under the bow: crossbar on two hangers, carrying a round
  // black-iron bomb with a short fuze cap.
  const crossbar = new CylinderGeometry(0.008, 0.008, 0.18, 6);
  crossbar.rotateZ(Math.PI / 2);
  crossbar.translate(0, -0.16, -0.12);
  paint(crossbar, BARREL_COLOR, 0.03, rand);
  parts.push(crossbar);
  for (const sx of [-1, 1]) {
    const hanger = strut(
      new Vector3(sx * 0.07, -0.105, -0.12),
      new Vector3(sx * 0.07, -0.16, -0.12),
      0.005,
    );
    paint(hanger, BARREL_COLOR, 0.03, rand);
    parts.push(hanger);
  }
  const bomb = new SphereGeometry(0.055, 8, 6);
  bomb.translate(0, -0.21, -0.12);
  paint(bomb, BARREL_COLOR, 0.03, rand);
  parts.push(bomb);
  const fuze = new CylinderGeometry(0.012, 0.012, 0.03, 6);
  fuze.translate(0, -0.145, -0.12);
  paint(fuze, BORE_COLOR, 0.02, rand);
  parts.push(fuze);

  // Single central rotor mast with four guy struts fanning to the deck; the
  // spinning hub lives in the `propellers` node above it.
  const mast = new CylinderGeometry(0.018, 0.026, 0.26, 6);
  mast.translate(0, 0.24, 0);
  paint(mast, MAST_COLOR, 0.03, rand);
  parts.push(mast);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const guy = strut(
        new Vector3(sx * 0.14, 0.115, 0.02 + sz * 0.14),
        new Vector3(0, 0.355, 0),
        0.005,
      );
      paint(guy, CHEEK_COLOR, 0.04, rand);
      parts.push(guy);
    }
  }

  // Control stick rising from the deck between the pilot's knees.
  const stick = strut(
    new Vector3(0, 0.12, 0.05),
    new Vector3(0, 0.185, 0.045),
    0.004,
  );
  paint(stick, BARREL_COLOR, 0.03, rand);
  parts.push(stick);

  return mergeParts(parts);
}

/**
 * The goblin pilot in body-space (same frame as the machine): sitting aft
 * with his paws on the control stick — thighs out of the open cockpit,
 * leather tunic, big green head with pointed ears, round nose, bead eyes
 * and a red scarf. Kept as its own mesh so the machine can shrink without
 * shrinking its driver.
 */
function buildBombardierPilot(rand: () => number): BufferGeometry {
  const parts: BufferGeometry[] = [];

  for (const sx of [-1, 1]) {
    const thigh = new BoxGeometry(0.04, 0.03, 0.09);
    thigh.translate(sx * 0.03, 0.135, 0.09);
    paint(thigh, CHEEK_COLOR, 0.04, rand);
    parts.push(thigh);
  }
  const torso = new BoxGeometry(0.09, 0.1, 0.06);
  torso.translate(0, 0.17, 0.14);
  paint(torso, CHEEK_COLOR, 0.04, rand);
  parts.push(torso);
  for (const sx of [-1, 1]) {
    const arm = strut(
      new Vector3(sx * 0.045, 0.2, 0.12),
      new Vector3(sx * 0.015, 0.185, 0.05),
      0.006,
    );
    paint(arm, GOBLIN_COLOR, 0.03, rand);
    parts.push(arm);
  }
  const head = new SphereGeometry(0.045, 8, 6);
  head.translate(0, 0.265, 0.13);
  paint(head, GOBLIN_COLOR, 0.03, rand);
  parts.push(head);
  for (const sx of [-1, 1]) {
    const ear = new ConeGeometry(0.016, 0.06, 5);
    ear.rotateZ((sx * Math.PI) / 2.2);
    ear.rotateY(sx * 0.5);
    ear.translate(sx * 0.055, 0.27, 0.15);
    paint(ear, GOBLIN_COLOR, 0.03, rand);
    parts.push(ear);
  }
  const nose = new SphereGeometry(0.012, 6, 4);
  nose.translate(0, 0.255, 0.088);
  paint(nose, GOBLIN_COLOR, 0.03, rand);
  parts.push(nose);
  for (const sx of [-1, 1]) {
    const eye = new SphereGeometry(0.008, 6, 4);
    eye.translate(sx * 0.018, 0.272, 0.098);
    paint(eye, BORE_COLOR, 0.02, rand);
    parts.push(eye);
  }
  const scarf = new BoxGeometry(0.07, 0.016, 0.06);
  scarf.translate(0, 0.223, 0.125);
  paint(scarf, FLAG_COLOR, 0.02, rand);
  parts.push(scarf);
  const scarfTail = new BoxGeometry(0.02, 0.008, 0.08);
  scarfTail.rotateY(0.3);
  scarfTail.translate(0.03, 0.222, 0.2);
  paint(scarfTail, FLAG_COLOR, 0.02, rand);
  parts.push(scarfTail);

  return mergeParts(parts);
}

/**
 * The lift rotor in propeller-node-local space (origin on the mast axis at
 * hub height): iron hub plus four flat wooden blades pitched ~11° about
 * their radial axis. The disc deliberately overhangs the 0.4 m hull — one
 * big chinook-style rotor is the flyer's silhouette.
 */
function buildBombardierRotor(rand: () => number): BufferGeometry {
  const parts: BufferGeometry[] = [];

  const hub = new CylinderGeometry(0.024, 0.024, 0.04, 8);
  paint(hub, BARREL_COLOR, 0.03, rand);
  parts.push(hub);

  for (let k = 0; k < 4; k++) {
    const blade = new BoxGeometry(0.225, 0.007, 0.034);
    blade.translate(0.145, 0, 0);
    blade.rotateX(0.2);
    blade.rotateY((k * Math.PI) / 2);
    paint(blade, WHEEL_COLOR, 0.03, rand);
    parts.push(blade);
  }

  const rotor = mergeParts(parts);
  // The rotor is the flyer's silhouette — scaled up 1.25x about the hub
  // axis (the propeller node's origin), baked into the geometry so the
  // node itself stays unscaled. Blade tips reach r ≈ 0.32.
  rotor.scale(1.25, 1.25, 1.25);
  return rotor;
}

/**
 * Medieval mechanical bomb-carrying flyer — the whimsical goblin-piloted
 * raider of the skies, sized against the pirate hull it fights beside:
 *
 * - Origin: gondola mid at the unit's cruise altitude. The machine group is
 *   scaled to 0.85 so the airframe runs about 0.65 m bow to tail and the
 *   bomb hangs to ≈ -0.23; the goblin keeps his full size in a separate
 *   unscaled mesh, dropped onto the scaled deck. The rotor disc tops out
 *   around +0.37.
 * - Forward: bow on local -Z (ship/cannon convention), so the spawn yaw
 *   math is shared untouched.
 * - `propellers` holds a single child node `propeller-main` on the central
 *   mast axis (hub resting on the scaled mast top); PropellerSpinSystem
 *   spins each child about its local +Y, so one big rotor is just one child.
 * - Three draw calls: merged machine, merged pilot, merged rotor. All
 *   colour is vertex-baked onto one white roughness-0.75 dielectric material.
 */
function createBombardierExport(): Object3D {
  const rand = makeRandom(20261021);

  const material = new MeshStandardMaterial({
    name: 'bombardier',
    color: 0xffffff,
    roughness: 0.75,
    metalness: 0,
    vertexColors: true,
    // The canvas fins and their thin planes read from both sides, like the
    // ship's sail in its hull material.
    side: DoubleSide,
  });

  // The machine shrinks to 0.85 while the pilot keeps his size — so the
  // goblin rides in his own mesh, nudged down onto the scaled deck (deck
  // top 0.122 → 0.104, hence the -0.018 offset).
  const machine = new Object3D();
  machine.name = 'bombardier-machine';
  machine.scale.setScalar(0.85);
  machine.add(new Mesh(buildBombardierBody(rand), material));

  // Bomb-release anchor baked into the GLB at the slung bomb's centroid
  // (machine-local: the merged bomb sphere sits at (0, -0.21, -0.12)).
  // PirateFireSystem launches shells from the `muzzle` node, and
  // decorateShipPrototype adopts a GLB-borne muzzle over its bounding-box
  // bottom-centre fallback, so the drop spawns exactly where the bomb hangs.
  const muzzle = new Object3D();
  muzzle.name = 'muzzle';
  muzzle.position.set(0, -0.21, -0.12);
  machine.add(muzzle);

  const pilotMesh = new Mesh(buildBombardierPilot(rand), material);
  pilotMesh.name = 'bombardier-pilot';
  pilotMesh.position.y = -0.018;

  const propellers = new Object3D();
  propellers.name = 'propellers';
  // Hub rests on the scaled mast top: 0.37 · 0.85 + half the hub height.
  propellers.position.set(0, 0.334, 0);
  const rotorMain = new Object3D();
  rotorMain.name = 'propeller-main';
  rotorMain.add(new Mesh(buildBombardierRotor(rand), material));
  propellers.add(rotorMain);

  const root = new Object3D();
  root.name = 'bombardier';
  root.add(machine);
  root.add(pilotMesh);
  root.add(propellers);

  return root;
}

// ---------------------------------------------------------------------------
// Defense buttons (flat wall-mounted control marks, build = mallet, repair =
// wrench) — mechanical silhouettes with colour zones baked into vertex colors
// ---------------------------------------------------------------------------

// Shares the cannon/ballista palette (brass, steel, dark iron) plus the two
// identity tints the HUD already used: brass for build, camo olive for
// repair. Flat crisp zones — jitter stays far below the unit mottle.
const BTN_BRASS = 0xd1a249;
const BTN_STEEL = 0x737b84;
const BTN_STEEL_LIGHT = 0x9aa2aa;
const BTN_IRON_DARK = 0x474c53;
/** Camouflage olive — the wrench's identity green, naturally darker. */
const BTN_GREEN = 0x556b2f;

/** Base plate thickness (m); the front face lands at z = +0.0065. */
const BUTTON_PLATE_DEPTH = 0.013;

function buttonRect(xMin: number, yMin: number, xMax: number, yMax: number): Shape {
  const s = new Shape();
  s.moveTo(xMin, yMin);
  s.lineTo(xMax, yMin);
  s.lineTo(xMax, yMax);
  s.lineTo(xMin, yMax);
  s.closePath();
  return s;
}

function chamferedRect(
  xMin: number,
  yMin: number,
  xMax: number,
  yMax: number,
  c: number,
): Shape {
  const s = new Shape();
  s.moveTo(xMin + c, yMin);
  s.lineTo(xMax - c, yMin);
  s.lineTo(xMax, yMin + c);
  s.lineTo(xMax, yMax - c);
  s.lineTo(xMax - c, yMax);
  s.lineTo(xMin + c, yMax);
  s.lineTo(xMin, yMax - c);
  s.lineTo(xMin, yMin + c);
  s.closePath();
  return s;
}

/** Thin plate from a 2D outline, centred on z = 0 with a machined edge bevel. */
function buttonPlate(shape: Shape, depth = BUTTON_PLATE_DEPTH, bevel = 0.0015): BufferGeometry {
  const geo = new ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 1,
  });
  geo.translate(0, 0, -depth / 2);
  return geo;
}

/** Accent plate raised proud of the base plate front (spans z 0.006..0.011). */
function proudPlate(shape: Shape): BufferGeometry {
  const geo = new ExtrudeGeometry(shape, {
    depth: 0.005,
    bevelEnabled: false,
  });
  geo.translate(0, 0, 0.006);
  return geo;
}

/** Front-face boss: solid prism (innerR null) or annular ring, standing proud. */
function frontBoss(
  x: number,
  y: number,
  outerR: number,
  innerR: number | null,
  segments: number,
  hex: number,
  rand: () => number,
): BufferGeometry {
  let geo: BufferGeometry;
  if (innerR !== null) {
    const shape = new Shape();
    shape.absarc(0, 0, outerR, 0, Math.PI * 2, false);
    const hole = new Path();
    hole.absarc(0, 0, innerR, 0, Math.PI * 2, true);
    shape.holes.push(hole);
    geo = new ExtrudeGeometry(shape, { depth: 0.005, bevelEnabled: false });
    geo.translate(x, y, 0.006);
  } else {
    geo = new CylinderGeometry(outerR, outerR, 0.006, segments);
    geo.rotateX(Math.PI / 2);
    geo.translate(x, y, 0.008);
  }
  paint(geo, hex, 0.015, rand);
  return geo;
}

/** One white dielectric material carrying the baked vertex colors. */
function buttonRoot(name: string, geometry: BufferGeometry): Object3D {
  const material = new MeshStandardMaterial({
    name,
    color: 0xffffff,
    roughness: 0.5,
    metalness: 0,
    vertexColors: true,
  });
  const mesh = new Mesh(geometry, material);
  mesh.name = 'button-icon';
  const root = new Object3D();
  root.name = name;
  root.add(mesh);
  return root;
}

/**
 * Build mark — a siege mallet, brass accent family:
 * chamfered steel head, lighter striking-face caps, brass rivets, brass
 * collar and grip strap over a dark iron tapered handle.
 *
 * - Origin: icon centre on the wall plane; the glyph faces +Z (land face).
 * - Envelope ~0.161 × 0.151 m (1.2x baked in), one merged mesh, one draw call.
 */
function createDefenseButtonBuildExport(): Object3D {
  const rand = makeRandom(20261023);
  const parts: BufferGeometry[] = [];

  const head = buttonPlate(chamferedRect(-0.055, 0.006, 0.055, 0.06, 0.014));
  paint(head, BTN_STEEL, 0.015, rand);
  parts.push(head);

  const capPlus = proudPlate(buttonRect(0.055, 0.006, 0.067, 0.06));
  paint(capPlus, BTN_STEEL_LIGHT, 0.015, rand);
  parts.push(capPlus);
  const capMinus = proudPlate(buttonRect(-0.067, 0.006, -0.055, 0.06));
  paint(capMinus, BTN_STEEL_LIGHT, 0.015, rand);
  parts.push(capMinus);

  parts.push(frontBoss(-0.028, 0.033, 0.0075, null, 8, BTN_BRASS, rand));
  parts.push(frontBoss(0.028, 0.033, 0.0075, null, 8, BTN_BRASS, rand));

  const collar = proudPlate(buttonRect(-0.024, -0.002, 0.024, 0.01));
  paint(collar, BTN_BRASS, 0.015, rand);
  parts.push(collar);

  const handle = new Shape();
  handle.moveTo(-0.013, 0.004);
  handle.lineTo(0.013, 0.004);
  handle.lineTo(0.019, -0.058);
  handle.lineTo(0.011, -0.066);
  handle.lineTo(-0.011, -0.066);
  handle.lineTo(-0.019, -0.058);
  handle.closePath();
  const handleGeo = buttonPlate(handle);
  paint(handleGeo, BTN_IRON_DARK, 0.015, rand);
  parts.push(handleGeo);

  const grip = proudPlate(buttonRect(-0.0215, -0.044, 0.0215, -0.03));
  paint(grip, BTN_BRASS, 0.015, rand);
  parts.push(grip);

  // 1.2x presence baked into the geometry (not a node scale — the runtime
  // state system writes the icon node's scale every frame).
  const merged = mergeParts(parts);
  merged.scale(1.2, 1.2, 1.2);
  return buttonRoot('defense-button-build', merged);
}

/**
 * Repair mark — a service wrench, camo-olive identity family: olive body
 * with a chamfered open-end jaw, waisted shaft and ring foot, a proud steel
 * collar reinforcing the ring, and a brass hex boss on the shaft.
 *
 * - Origin: icon centre on the wall plane; the glyph faces +Z (land face).
 * - Envelope ~0.082 × 0.162 m (1.2x baked in), one merged mesh, one draw call.
 */
function createDefenseButtonRepairExport(): Object3D {
  const rand = makeRandom(20261023);
  const parts: BufferGeometry[] = [];

  const body = new Shape();
  body.moveTo(0.02, 0.024);
  body.lineTo(0.034, 0.024);
  body.lineTo(0.034, 0.056);
  body.lineTo(0.026, 0.064);
  body.lineTo(0.016, 0.064);
  body.lineTo(0, 0.038);
  body.lineTo(-0.016, 0.064);
  body.lineTo(-0.026, 0.064);
  body.lineTo(-0.034, 0.056);
  body.lineTo(-0.034, 0.024);
  body.lineTo(-0.02, 0.024);
  body.lineTo(-0.0125, -0.012);
  body.lineTo(-0.014, -0.03);
  // Ring foot: sweep CCW around the bottom back to the right flare.
  body.absarc(0, -0.047, 0.0235, Math.PI - 0.88, 0.88, false);
  body.lineTo(0.0125, -0.012);
  body.closePath();
  const hole = new Path();
  hole.absarc(0, -0.047, 0.0105, 0, Math.PI * 2, true);
  body.holes.push(hole);
  const bodyGeo = buttonPlate(body);
  paint(bodyGeo, BTN_GREEN, 0.015, rand);
  parts.push(bodyGeo);

  parts.push(frontBoss(0, -0.047, 0.0195, 0.0125, 24, BTN_STEEL, rand));
  parts.push(frontBoss(0, 0.006, 0.009, null, 6, BTN_BRASS, rand));

  // 1.2x presence baked into the geometry (see the build mark).
  const merged = mergeParts(parts);
  merged.scale(1.2, 1.2, 1.2);
  return buttonRoot('defense-button-repair', merged);
}

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
// Ornithopter (da Vinci mechanical flapper: canvas double wings + belly hopper)
// ---------------------------------------------------------------------------

/** Deep red canvas for wings and tail fins — the enemy flyer family tint. */
const CANVAS_COLOR = 0xa03828;
/** Grey stone load for the belly hopper (matches the runtime stone pool). */
const STONE_COLOR = 0x8a8a86;

// Wing profile shared by the membrane and the rib skeleton (u = span fraction
// 0..1 from the wing root; all values in wing-local metres).
const WING_SPAN = 0.5;
const wingY = (u: number): number => -0.02 + 0.09 * u; // baked-in dihedral
const wingLE = (u: number): number => -0.07 + 0.09 * u; // leading edge, swept back
const wingChord = (u: number): number => 0.22 * (1 - u) + 0.07 * u;
// Bat-wing finger scallops along the trailing edge.
const wingScallop = (u: number): number =>
  0.85 + 0.15 * Math.cos(u * Math.PI * 2.5);

/**
 * Wing membrane as a parametric grid in wing-local space: span rows along the
 * outward X axis, chord columns from leading to trailing edge. The trailing
 * edge scallops between fingers and the cloth billows down mid-chord; the
 * whole wing flaps rigidly about its root axle, so no skinning vertices are
 * needed — the flap node's rotation.z carries the animation.
 */
function buildWingMembrane(rand: () => number, side: number): BufferGeometry {
  const ROWS = 10;
  const COLS = 4;
  const positions: number[] = [];
  const colors: number[] = [];
  const base = new Color();

  const point = (u: number, v: number): [number, number, number] => {
    const tr = wingLE(u) + wingChord(u) * wingScallop(u);
    return [
      side * u * WING_SPAN,
      wingY(u) - 0.018 * Math.sin(Math.PI * v) * (1 - u * 0.5),
      wingLE(u) + (tr - wingLE(u)) * v,
    ];
  };

  const pushTri = (
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number],
  ): void => {
    for (const p of [a, b, c]) {
      positions.push(p[0], p[1], p[2]);
      const f = 1 + (rand() * 2 - 1) * 0.025;
      base.set(CANVAS_COLOR);
      colors.push(
        Math.min(1, base.r * f),
        Math.min(1, base.g * f),
        Math.min(1, base.b * f),
      );
    }
  };

  for (let r = 0; r < ROWS - 1; r++) {
    for (let c = 0; c < COLS - 1; c++) {
      const u0 = r / (ROWS - 1);
      const u1 = (r + 1) / (ROWS - 1);
      const v0 = c / (COLS - 1);
      const v1 = (c + 1) / (COLS - 1);
      const p00 = point(u0, v0);
      const p01 = point(u0, v1);
      const p10 = point(u1, v0);
      const p11 = point(u1, v1);
      pushTri(p00, p01, p10);
      pushTri(p01, p11, p10);
    }
  }

  const geo = new BufferGeometry();
  geo.setAttribute(
    'position',
    new BufferAttribute(new Float32Array(positions), 3),
  );
  geo.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
  geo.computeVertexNormals();
  return geo;
}

/**
 * Wing skeleton under the membrane: a leading-edge spar plus four rib struts
 * that read as the da Vinci finger bones. Straight low-segment cylinders keep
 * the rib cost trivial; they sit just under the sagging cloth.
 */
function buildWingFrame(rand: () => number, side: number): BufferGeometry {
  const parts: BufferGeometry[] = [];

  const spar = strut(
    new Vector3(0, wingY(0), wingLE(0)),
    new Vector3(side * WING_SPAN, wingY(1), wingLE(1)),
    0.004,
  );
  paint(spar, WHEEL_COLOR, 0.04, rand);
  parts.push(spar);

  for (const u of [0.2, 0.45, 0.7, 0.95]) {
    const y = wingY(u) - 0.001;
    const le = wingLE(u);
    const tr = le + wingChord(u) * wingScallop(u);
    const rib = strut(
      new Vector3(side * u * WING_SPAN, y, le),
      new Vector3(side * u * WING_SPAN, y, tr),
      0.003,
      4,
    );
    paint(rib, WHEEL_COLOR, 0.04, rand);
    parts.push(rib);
  }

  return mergeParts(parts);
}

/**
 * Hull, deck, wing mount, tail and belly hopper in root space (y = 0 at the
 * pod's cruise centre): an extruded boat pod with a planked deck and iron
 * straps, shoulder posts carrying the wing axle, a stubby tail boom with red
 * canvas fins, and an open slat basket holding the grey stone load.
 */
function buildOrnithopterBody(rand: () => number): BufferGeometry {
  const parts: BufferGeometry[] = [];

  // Boat pod: side profile extruded across the beam (bow lands on -Z).
  const podShape = new Shape();
  podShape.moveTo(-0.24, -0.045);
  podShape.lineTo(0.22, -0.045);
  podShape.lineTo(0.27, 0.01);
  podShape.lineTo(0.14, 0.05);
  podShape.lineTo(-0.24, 0.05);
  podShape.closePath();
  const pod = new ExtrudeGeometry(podShape, {
    depth: 0.15,
    bevelEnabled: true,
    bevelThickness: 0.004,
    bevelSize: 0.004,
    bevelSegments: 1,
  });
  pod.rotateY(Math.PI / 2);
  pod.translate(-0.075, 0, 0);
  paint(pod, HULL_COLOR, 0.04, rand);
  parts.push(pod);

  // Planked deck capping the pod rim, clinched by three iron straps.
  const deck = new BoxGeometry(0.19, 0.012, 0.44);
  deck.translate(0, 0.056, 0);
  paint(deck, DECK_COLOR, 0.03, rand);
  parts.push(deck);
  for (const z of [-0.18, 0.0, 0.16]) {
    const strap = new BoxGeometry(0.21, 0.016, 0.024);
    strap.translate(0, 0.056, z);
    paint(strap, BARREL_COLOR, 0.03, rand);
    parts.push(strap);
  }

  // Shoulder posts and the wing axle: the flap pivot the wings swing on.
  for (const sx of [-1, 1]) {
    const post = strut(
      new Vector3(sx * 0.05, 0.055, -0.02),
      new Vector3(sx * 0.065, 0.085, -0.02),
      0.006,
    );
    paint(post, CHEEK_COLOR, 0.04, rand);
    parts.push(post);
  }
  const axle = new CylinderGeometry(0.007, 0.007, 0.2, 8);
  axle.rotateZ(Math.PI / 2);
  axle.translate(0, 0.085, -0.02);
  paint(axle, BARREL_COLOR, 0.03, rand);
  parts.push(axle);

  // Tail boom with braced red canvas fins.
  const boom = new CylinderGeometry(0.008, 0.013, 0.24, 6);
  boom.rotateX(Math.PI / 2);
  boom.translate(0, 0.035, 0.34);
  paint(boom, MAST_COLOR, 0.03, rand);
  parts.push(boom);
  for (const sx of [-1, 1]) {
    const brace = strut(
      new Vector3(sx * 0.07, 0.055, 0.16),
      new Vector3(0, 0.035, 0.32),
      0.004,
    );
    paint(brace, CHEEK_COLOR, 0.04, rand);
    parts.push(brace);
  }
  const fin = new BoxGeometry(0.012, 0.13, 0.11);
  fin.translate(0, 0.1, 0.41);
  paint(fin, CANVAS_COLOR, 0.025, rand);
  parts.push(fin);
  const stabiliser = new BoxGeometry(0.26, 0.012, 0.11);
  stabiliser.translate(0, 0.045, 0.41);
  paint(stabiliser, CANVAS_COLOR, 0.025, rand);
  parts.push(stabiliser);

  // Belly hopper: four hangers drop an open slat basket from the pod; the
  // grey stone load heaped inside is what the muzzle throws.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const hanger = strut(
        new Vector3(sx * 0.03, -0.03, sz * 0.035),
        new Vector3(sx * 0.045, -0.115, sz * 0.045),
        0.0035,
      );
      paint(hanger, TRANSOM_COLOR, 0.035, rand);
      parts.push(hanger);
    }
  }
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const corner = strut(
        new Vector3(sx * 0.045, -0.115, sz * 0.045),
        new Vector3(sx * 0.03, -0.195, sz * 0.03),
        0.003,
        4,
      );
      paint(corner, TRANSOM_COLOR, 0.035, rand);
      parts.push(corner);
    }
  }
  for (const [r, y] of [
    [0.045, -0.115],
    [0.03, -0.195],
  ] as const) {
    for (const sz of [-1, 1]) {
      const edgeZ = strut(
        new Vector3(-r, y, sz * r),
        new Vector3(r, y, sz * r),
        0.003,
        4,
      );
      paint(edgeZ, TRANSOM_COLOR, 0.035, rand);
      parts.push(edgeZ);
      const edgeX = strut(
        new Vector3(sz * r, y, -r),
        new Vector3(sz * r, y, r),
        0.003,
        4,
      );
      paint(edgeX, TRANSOM_COLOR, 0.035, rand);
      parts.push(edgeX);
    }
  }
  const stoneSpots: Array<[number, number, number, number]> = [
    [0, -0.16, 0, 0.042],
    [0.028, -0.135, 0.012, 0.03],
    [-0.026, -0.14, -0.012, 0.032],
  ];
  for (const [x, y, z, r] of stoneSpots) {
    const stone = new IcosahedronGeometry(r, 0);
    stone.translate(x, y, z);
    paint(stone, STONE_COLOR, 0.06, rand);
    parts.push(stone);
  }

  return mergeParts(parts);
}

/**
 * Medieval mechanical flapper — the da Vinci workshop raider of the middle
 * air band, sized between the pirate ship and the bombardier:
 *
 * - Origin: pod centre at the unit's cruise altitude; the pod runs z
 *   -0.27..0.24, the wings reach x ±0.565, the hopper hangs to y -0.21.
 * - Forward: bow on local -Z (ship/cannon convention), shared spawn yaw math.
 * - No `gun_rotate`: PirateFireSystem yaws the whole machine at its aim
 *   branch, and decorateShipPrototype adopts the GLB-borne `muzzle` at the
 *   hopper's stone centroid for the stone release point.
 * - `wing_left` / `wing_right` are unscaled flap pivots on the shoulder
 *   axle; each carries one merged membrane+skeleton mesh. WingFlapSystem
 *   swings them with mirrored rotation.z — pure scalar sine, no physics.
 * - Three draw calls: merged body, merged left wing, merged right wing. All
 *   colour is vertex-baked onto one white roughness-0.75 dielectric material
 *   (canvas membranes read from both sides).
 */
function createOrnithopterExport(): Object3D {
  const rand = makeRandom(20261025);

  const material = new MeshStandardMaterial({
    name: 'ornithopter',
    color: 0xffffff,
    roughness: 0.75,
    metalness: 0,
    vertexColors: true,
    // The canvas wings and tail fins are thin slabs that must read from both
    // sides, like the flyer canvas in the bombardier material.
    side: DoubleSide,
  });

  const bodyMesh = new Mesh(buildOrnithopterBody(rand), material);
  bodyMesh.name = 'ornithopter-body';

  // Flap pivots sit on the shoulder axle, 1 cm buried inside the pod walls so
  // the membrane root edges never show a gap to the hull.
  const wingLeft = new Object3D();
  wingLeft.name = 'wing_left';
  wingLeft.position.set(-0.065, 0.085, -0.02);
  const leftMesh = new Mesh(
    mergeParts([buildWingMembrane(rand, -1), buildWingFrame(rand, -1)]),
    material,
  );
  leftMesh.name = 'ornithopter-wing-left';
  wingLeft.add(leftMesh);

  const wingRight = new Object3D();
  wingRight.name = 'wing_right';
  wingRight.position.set(0.065, 0.085, -0.02);
  const rightMesh = new Mesh(
    mergeParts([buildWingMembrane(rand, 1), buildWingFrame(rand, 1)]),
    material,
  );
  rightMesh.name = 'ornithopter-wing-right';
  wingRight.add(rightMesh);

  // Stone-release anchor at the hopper load's centroid; PirateFireSystem
  // launches shells from this node.
  const muzzle = new Object3D();
  muzzle.name = 'muzzle';
  muzzle.position.set(0, -0.16, 0);

  const root = new Object3D();
  root.name = 'ornithopter';
  root.add(bodyMesh);
  root.add(wingLeft);
  root.add(wingRight);
  root.add(muzzle);

  return root;
}

// ---------------------------------------------------------------------------
// Boss Islewrath — the island-ship (task 028)
// ---------------------------------------------------------------------------

/**
 * Oppressive palette: basalt rock over blackened timber, dark iron guns,
 * moss staining and ember-red trim on the laser citadel. Everything reads
 * heavier and colder than the warm raider palette above.
 */
const BOSS_TIMBER_COLOR = 0x241f1c;
const BOSS_DECK_COLOR = 0x2f2a24;
const BOSS_ROCK_COLOR = 0x3a3632;
const BOSS_ROCK_DEEP_COLOR = 0x2e2b28;
const BOSS_IRON_COLOR = 0x2b2f33;
const BOSS_EMBER_COLOR = 0x8a1400;
const BOSS_BANNER_COLOR = 0x5c0f0f;
/** Signature red of the boss's identity parts — the bow ram and the laser. */
const BOSS_RED_COLOR = 0xb01616;

/**
 * Island-ship hull stations: ~1.7 m long, 1.5 m beam (3-4x the raider), deep
 * draught and a high, wall-like sheer — the waterline hull of a floating
 * fortress. Same station semantics as the raider loft.
 */
const BOSS_HULL_STATIONS: HullStation[] = [
  { z: 0.85, halfW: 0.42, keel: -0.14, sheer: 0.42 },
  { z: 0.6, halfW: 0.62, keel: -0.2, sheer: 0.34 },
  { z: 0.3, halfW: 0.72, keel: -0.24, sheer: 0.3 },
  { z: 0, halfW: 0.75, keel: -0.25, sheer: 0.29 },
  { z: -0.3, halfW: 0.7, keel: -0.23, sheer: 0.3 },
  { z: -0.55, halfW: 0.55, keel: -0.18, sheer: 0.33 },
  { z: -0.75, halfW: 0.3, keel: -0.1, sheer: 0.38 },
  { z: -0.85, halfW: 0.05, keel: -0.02, sheer: 0.46 },
];

/**
 * Craggy rock displacement. The jitter comes from a position hash, not the
 * sequential rand, so side and cap rim vertices at identical positions move
 * identically — the cylinder seams never tear. Deterministic across runs.
 */
function crag(geo: BufferGeometry, amount: number): void {
  const pos = geo.attributes.position as BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const r = Math.hypot(x, z);
    if (r < 1e-5) continue;
    const k =
      1 +
      (hash3(Math.round(x * 64), Math.round(y * 64), Math.round(z * 64)) * 2 -
        1) *
        amount;
    pos.setX(i, x * k);
    pos.setZ(i, z * k);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
}

/**
 * The static island mass: basalt mesa (two craggy frustums), the central
 * citadel tower with its ember crown, the four gun-bastion seats (the
 * turrets are separate yaw pivots — when one is destroyed its empty stone
 * seat stays behind, the wreck IS the design; the rear pair steps one
 * terrace higher), ember-red war banners on the bow flank and the stern
 * mast with its tattered banner. One merged mesh.
 */
function buildBossIsland(rand: () => number): BufferGeometry {
  const parts: BufferGeometry[] = [];

  // Basalt mesa: two stacked frustums, alternating tones, crag-jittered.
  const mesa: Array<[number, number, number, number, number]> = [
    // rTop, rBottom, height, yBase, color
    [0.6, 0.72, 0.34, 0.28, BOSS_ROCK_COLOR],
    [0.44, 0.56, 0.3, 0.62, BOSS_ROCK_DEEP_COLOR],
  ];
  for (const [rTop, rBottom, h, yBase, color] of mesa) {
    const tier = new CylinderGeometry(rTop, rBottom, h, 9);
    crag(tier, 0.09);
    tier.translate(0, yBase + h / 2, 0);
    paint(tier, color, 0.05, rand);
    parts.push(tier);
  }

  // Citadel tower above the mesa top (y 0.92) + ember crown band. The tower
  // drum is half its v0.1.179 height (0.26 -> 0.13) — a low stub under the
  // crown so the laser cannon hugs the berm instead of perching on a stalk.
  // The laser pivot rides the crown top at y 1.12.
  const tower = new CylinderGeometry(0.2, 0.26, 0.13, 9);
  crag(tower, 0.07);
  tower.translate(0, 0.985, 0);
  paint(tower, BOSS_ROCK_DEEP_COLOR, 0.05, rand);
  parts.push(tower);
  const crown = new CylinderGeometry(0.23, 0.2, 0.06, 9);
  crown.translate(0, 1.08, 0);
  paint(crown, BOSS_EMBER_COLOR, 0.03, rand);
  parts.push(crown);

  // Gun-bastion seats (static): stone drums half-embedded in the mesa
  // flanks. Front pair tops flush at y 0.64, rear pair stepped up to y 0.84
  // — the staggered battery height the boss reads by. The turret pivots sit
  // exactly on the seat tops.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const rear = sz > 0;
      const seat = new CylinderGeometry(
        rear ? 0.19 : 0.17,
        rear ? 0.21 : 0.19,
        rear ? 0.6 : 0.4,
        10,
      );
      crag(seat, 0.06);
      seat.translate(sx * 0.6, rear ? 0.54 : 0.44, sz * 0.45);
      paint(seat, BOSS_ROCK_DEEP_COLOR, 0.05, rand);
      parts.push(seat);
    }
  }

  // Ember-red trim ring at the tower base, then the bow itself: one large
  // red ram cone seated mid-hull at the stem (station keel -0.02 / sheer
  // 0.46), tip jutting past it — a solid aggressive prow instead of banner
  // cloth, readable from the harbour at full berth distance.
  const trim = new CylinderGeometry(0.27, 0.27, 0.035, 9);
  trim.translate(0, 0.935, 0);
  paint(trim, BOSS_EMBER_COLOR, 0.02, rand);
  parts.push(trim);
  const ram = new ConeGeometry(0.45, 1.245, 9);
  crag(ram, 0.05);
  ram.rotateX(-Math.PI / 2); // point local -Z — the bow direction
  ram.translate(0, 0.28, -1.2);
  paint(ram, BOSS_RED_COLOR, 0.03, rand);
  parts.push(ram);

  // Low dark bulwark strips along the deck rim (aggressive low silhouette).
  for (const [x, z, w, rotY] of [
    [0, -0.62, 1.1, 0],
    [0, 0.62, 1.1, 0],
    [-0.66, 0, 0.9, Math.PI / 2],
    [0.66, 0, 0.9, Math.PI / 2],
  ] as Array<[number, number, number, number]>) {
    const rail = new BoxGeometry(w, 0.07, 0.05);
    rail.rotateY(rotY);
    rail.translate(x, 0.33, z);
    paint(rail, BOSS_TIMBER_COLOR, 0.04, rand);
    parts.push(rail);
  }

  // Stern mast + tattered banner (thin plane, double-sided hull material).
  const mast = new CylinderGeometry(0.018, 0.026, 0.55, 8);
  mast.translate(0, 0.98, 0.55);
  paint(mast, BOSS_TIMBER_COLOR, 0.04, rand);
  parts.push(mast);
  const banner = new PlaneGeometry(0.2, 0.13, 2, 1);
  const bannerPos = banner.attributes.position as BufferAttribute;
  for (let i = 0; i < bannerPos.count; i++) {
    // Tear the fly end into two points so the cloth reads battle-worn.
    if (bannerPos.getX(i) > 0.05) {
      bannerPos.setZ(i, bannerPos.getZ(i) + (bannerPos.getY(i) > 0 ? 0.02 : -0.03));
    }
  }
  banner.computeVertexNormals();
  banner.translate(0.11, 1.2, 0.55);
  paint(banner, BOSS_BANNER_COLOR, 0.03, rand);
  parts.push(banner);

  return mergeParts(parts);
}

/**
 * One gun bastion turret, built in gun_tN-local space (origin = yaw pivot on
 * the bastion seat top). Heavy iron naval gun: turntable, carriage, tapered
 * barrel with an ember chase ring and a knobby breech. Built ONCE — all four
 * pivots share the geometry; the GLB exports it once and references it.
 * Upscaled from the v0.1.176 block (~1.3x): at the boss's 8.5 m berth the
 * old block read as a stud — the turrets are the boss's hittable plates and
 * must carry their own silhouette.
 */
function buildBossGunTurret(rand: () => number): BufferGeometry {
  const parts: BufferGeometry[] = [];

  const turntable = new CylinderGeometry(0.15, 0.17, 0.04, 12);
  turntable.translate(0, 0.01, 0);
  paint(turntable, BOSS_IRON_COLOR, 0.03, rand);
  parts.push(turntable);

  const carriage = new BoxGeometry(0.19, 0.08, 0.22);
  carriage.translate(0, 0.06, 0.01);
  paint(carriage, BOSS_TIMBER_COLOR, 0.04, rand);
  parts.push(carriage);

  const barrel = new CylinderGeometry(0.044, 0.066, 0.46, 10);
  barrel.rotateX(-Math.PI / 2);
  barrel.translate(0, 0.11, -0.2);
  paint(barrel, BOSS_IRON_COLOR, 0.03, rand);
  parts.push(barrel);

  // Ember chase ring near the muzzle — the guns read hot even before firing.
  const ring = new CylinderGeometry(0.058, 0.058, 0.025, 10);
  ring.rotateX(-Math.PI / 2);
  ring.translate(0, 0.11, -0.36);
  paint(ring, BOSS_EMBER_COLOR, 0.02, rand);
  parts.push(ring);

  const breech = new SphereGeometry(0.064, 6, 4);
  breech.translate(0, 0.11, 0.06);
  paint(breech, BOSS_IRON_COLOR, 0.03, rand);
  parts.push(breech);

  return mergeParts(parts);
}

/**
 * The laser citadel gun, built in laser_turret-local space (origin = yaw
 * pivot on the crown top). Shape-first iteration (v0.1.180): the charged
 * attack is removed for now and the cannon is a giant faceted emitter —
 * an 8-sided breech drum, a 6-flute barrel with iron rib bands, and a
 * chamfered diamond tip. Every surface is a flat facet meeting its
 * neighbour at a hard ridge (楞), ends step down through short tapered
 * collars (导角). It faces local -Z, which is world +Z toward the harbour
 * wall at the boss's berthed yaw.
 */
function buildBossLaserTurret(rand: () => number): BufferGeometry {
  const parts: BufferGeometry[] = [];

  // Low 8-sided seat collar — the chamfered break from the crown into the
  // breech.
  const collar = new CylinderGeometry(0.2, 0.24, 0.06, 8);
  collar.translate(0, 0.03, 0);
  paint(collar, BOSS_IRON_COLOR, 0.03, rand);
  parts.push(collar);

  // Breech: a giant 8-facet drum — the visual mass of the weapon.
  const breech = new CylinderGeometry(0.21, 0.21, 0.2, 8);
  breech.translate(0, 0.16, 0.02);
  paint(breech, BOSS_RED_COLOR, 0.03, rand);
  parts.push(breech);

  // Barrel: a 6-flute tapered prism — six flat facets with hard ridge
  // lines (the 楞 read), tapering toward the muzzle (spans z -0.1..-0.6).
  const barrel = new CylinderGeometry(0.13, 0.17, 0.5, 6);
  barrel.rotateX(-Math.PI / 2);
  barrel.translate(0, 0.16, -0.35);
  paint(barrel, BOSS_RED_COLOR, 0.03, rand);
  parts.push(barrel);

  // Iron rib bands cinch the flutes — segmented, loaded, angular.
  for (const z of [-0.24, -0.46]) {
    const band = new CylinderGeometry(0.15, 0.15, 0.04, 6);
    band.rotateX(-Math.PI / 2);
    band.translate(0, 0.16, z);
    paint(band, BOSS_IRON_COLOR, 0.02, rand);
    parts.push(band);
  }

  // Muzzle collar, then the chamfered diamond emitter tip (apex -0.74).
  const muzzleRing = new CylinderGeometry(0.16, 0.16, 0.05, 8);
  muzzleRing.rotateX(-Math.PI / 2);
  muzzleRing.translate(0, 0.16, -0.58);
  paint(muzzleRing, BOSS_IRON_COLOR, 0.02, rand);
  parts.push(muzzleRing);
  const tip = new ConeGeometry(0.1, 0.16, 4);
  tip.rotateX(-Math.PI / 2);
  tip.rotateY(Math.PI / 4);
  tip.translate(0, 0.16, -0.66);
  paint(tip, BOSS_EMBER_COLOR, 0.03, rand);
  parts.push(tip);

  // Rear counterweight: a short 4-facet taper off the breech.
  const rear = new ConeGeometry(0.13, 0.14, 4);
  rear.rotateX(Math.PI / 2);
  rear.rotateY(Math.PI / 4);
  rear.translate(0, 0.16, 0.19);
  paint(rear, BOSS_IRON_COLOR, 0.03, rand);
  parts.push(rear);

  return mergeParts(parts);
}

/**
 * Boss Islewrath (怒岛号) — the island-ship warlord.
 *
 * - Origin: centre of the waterline plane; y = 0 is the local waterline,
 *   the keel reaches -0.25 and the hull rises to the sheer line. Bow -Z.
 * - Node contract (consumed by the boss systems, never by the generic ship
 *   decorate path): `gun_t1..gun_t4` yaw pivots on the four bastion seats,
 *   `laser_turret` yaw pivot on the citadel crown. Each pivot subtree
 *   carries its merged gun mesh, a `muzzle` (barrel tip) and a `hit_core`
 *   (part centre) — the per-pivot `hit_core`/`muzzle` names make
 *   decorateShipPrototype's root-level additions inert (its lookups find
 *   the subtree nodes first), and no node is named `gun_rotate`, so no
 *   cannon_mount wrapper is ever built for the boss.
 * - Two materials: the island body at roughness 0.6 (weathered basalt), the
 *   guns at roughness 0.35 / metalness 0.9 (polished dark iron).
 */
function createBossIslewrathExport(): Object3D {
  const rand = makeRandom(20261026);

  const islandMaterial = new MeshStandardMaterial({
    name: 'boss-island',
    color: 0xffffff,
    roughness: 0.6,
    metalness: 0,
    vertexColors: true,
    // The tattered banner is a thin plane and must read from both sides.
    side: DoubleSide,
  });
  const gunMaterial = new MeshStandardMaterial({
    name: 'boss-gun',
    color: 0xffffff,
    roughness: 0.35,
    metalness: 0.9,
    vertexColors: true,
  });

  const islandMesh = new Mesh(buildBossIsland(rand), islandMaterial);
  islandMesh.name = 'boss-island-mesh';

  const gunGeometry = buildBossGunTurret(rand);
  // Front pair (bow side, -Z) low on its seats, rear pair stepped one
  // terrace higher — the staggered battery silhouette.
  const gunPivots: Array<[string, number, number, number]> = [
    ['gun_t1', -0.6, -0.45, 0.64],
    ['gun_t2', 0.6, -0.45, 0.64],
    ['gun_t3', -0.6, 0.45, 0.84],
    ['gun_t4', 0.6, 0.45, 0.84],
  ];

  const root = new Object3D();
  root.name = 'boss_islewrath';
  root.add(islandMesh);
  for (const [name, x, z, y] of gunPivots) {
    const pivot = new Object3D();
    pivot.name = name;
    pivot.position.set(x, y, z);
    const gunMesh = new Mesh(gunGeometry, gunMaterial);
    gunMesh.name = `boss-gun-mesh-${name}`;
    pivot.add(gunMesh);
    const muzzle = new Object3D();
    muzzle.name = 'muzzle';
    muzzle.position.set(0, 0.11, -0.46);
    pivot.add(muzzle);
    const hitCore = new Object3D();
    hitCore.name = 'hit_core';
    hitCore.position.set(0, 0.07, -0.02);
    pivot.add(hitCore);
    root.add(pivot);
  }

  const laserPivot = new Object3D();
  laserPivot.name = 'laser_turret';
  laserPivot.position.set(0, 1.12, -0.08);
  const laserMesh = new Mesh(buildBossLaserTurret(rand), gunMaterial);
  laserMesh.name = 'boss-laser-mesh';
  laserPivot.add(laserMesh);
  const laserMuzzle = new Object3D();
  laserMuzzle.name = 'muzzle';
  laserMuzzle.position.set(0, 0.16, -0.76);
  laserPivot.add(laserMuzzle);
  const laserCore = new Object3D();
  laserCore.name = 'hit_core';
  laserCore.position.set(0, 0.08, -0.02);
  laserPivot.add(laserCore);
  root.add(laserPivot);

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
// pirate-ship-v2: the deck gun dropped the naval wheel carriage for a
// fixed pedestal + turntable; the renamed file isolates the node-structure
// change from any stale cached GLB.
await exportGLB(createPirateShipExport(), 'pirate-ship-v2.glb');
// sky-ballista: the anti-air mount replaces the centre wall slot (task 022);
// a fresh file name keeps it isolated from any stale GLB caching.
await exportGLB(createSkyBallistaExport(), 'sky-ballista.glb');
// bombardier: the goblin-piloted flyer joins the raid (task 023); the v3
// rename isolates the new baked-in `muzzle` bomb anchor from any stale GLB.
await exportGLB(createBombardierExport(), 'bombardier-v3.glb');
// defense buttons: the wall's build/repair control marks leave the runtime
// ExtrudeGeometry shapes for designed, vertex-coloured GLB assets; fresh file
// names keep them isolated from any stale caching.
await exportGLB(createDefenseButtonBuildExport(), 'defense-button-build.glb');
await exportGLB(createDefenseButtonRepairExport(), 'defense-button-repair.glb');
// defense pads: the empty-slot pedestal discs leave runtime primitives for a
// designed, vertex-coloured GLB asset; a fresh file name keeps it isolated
// from any stale caching.
await exportGLB(createDefensePadExport(), 'defense-pad.glb');
// ornithopter: the middle-air flapper joins the raid (task 025); wings and
// muzzle are baked as named nodes for the runtime flap and stone systems.
await exportGLB(createOrnithopterExport(), 'ornithopter.glb');
// boss_islewrath: the island-ship warlord joins the raid (task 028); five
// yaw-pivot turrets (gun_t1..t4 + laser_turret) each carry muzzle/hit_core
// for the boss combat systems. A fresh file name isolates it from any stale
// GLB caching.
await exportGLB(createBossIslewrathExport(), 'boss-islewrath.glb');
console.log('\nDone. GLBs written to public/gltf/');
