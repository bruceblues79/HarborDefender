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
/** Signature red of the boss's identity parts — the bow ram and the laser. */
const BOSS_RED_COLOR = 0xb01616;

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
 * terrace higher) and the bow ram cone. One merged mesh. All banners and
 * masts are gone (v0.1.182) — the silhouette belongs to the guns.
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
 * pivot on the crown top). Three-tier stack (v0.1.182): an 8-sided base
 * drum ON the crown, a tapering neck joint, and the fluted cannon itself —
 * a single 6-facet barrel whose rear end seats over the neck top and whose
 * muzzle ends in an iron collar. The v0.1.181 rear breech cap read as a
 * little red flag in silhouette and the diamond emitter tip sat like junk
 * in the bore; both removed. It faces local -Z, which is world +Z toward
 * the harbour wall at the boss's berthed yaw.
 */
function buildBossLaserTurret(rand: () => number): BufferGeometry {
  const parts: BufferGeometry[] = [];

  // Tier 1 — base drum on the crown.
  const base = new CylinderGeometry(0.24, 0.28, 0.08, 8);
  base.translate(0, 0.04, 0);
  paint(base, BOSS_IRON_COLOR, 0.03, rand);
  parts.push(base);

  // Tier 2 — the neck joint: tapers up from the base; the barrel's belly
  // seats over its top.
  const neck = new CylinderGeometry(0.14, 0.18, 0.12, 8);
  neck.translate(0, 0.14, 0);
  paint(neck, BOSS_IRON_COLOR, 0.03, rand);
  parts.push(neck);

  // Tier 3 — the fluted cannon on axis y 0.32: a single 6-facet tapered
  // prism (the 楞 read), rear end just past the neck centre (z spans
  // -0.53..0.03) so it reads cradled in the mount.
  const barrel = new CylinderGeometry(0.11, 0.145, 0.56, 6);
  barrel.rotateX(-Math.PI / 2);
  barrel.translate(0, 0.32, -0.25);
  paint(barrel, BOSS_RED_COLOR, 0.03, rand);
  parts.push(barrel);

  // Iron muzzle collar wrapping the barrel's front face.
  const muzzleRing = new CylinderGeometry(0.125, 0.125, 0.04, 8);
  muzzleRing.rotateX(-Math.PI / 2);
  muzzleRing.translate(0, 0.32, -0.55);
  paint(muzzleRing, BOSS_IRON_COLOR, 0.02, rand);
  parts.push(muzzleRing);

  return mergeParts(parts);
}

/**
 * Boss Islewrath (怒岛号) — the island-ship warlord.
 *
 * - Origin: centre of the waterline plane; y = 0 is the local waterline,
 *   the keel reaches -0.25 and the hull rises to the sheer line. Bow -Z.
 * - Complete functional node contract, baked here so runtime systems only
 *   look nodes up (never invent them):
 *   - root `hit_core`: the hull core at the island's bounding-box centre.
 *     It is the FIRST child so a root-level `getObjectByName('hit_core')`
 *     always resolves the hull, never a part core inside a turret subtree.
 *   - `gun_t1..gun_t4` / `laser_turret`: the armour-part wrappers that
 *     BossRigSystem turns into child entities. One wrapper per hittable
 *     plate; its name identifies the plate, not the rotation axis.
 *   - inside each wrapper, `gun_rotate`: the standard articulated-gun yaw
 *     pivot (same node family as cannon / ship). The merged gun
 *     mesh, `muzzle` (barrel tip) and `hit_core` (plate centre) all ride it,
 *     so rotating this node aims the whole part.
 * - The generic decorateShipPrototype pass is skipped for boss hulls (see
 *   LevelWaveSystem): wrapping a `gun_rotate` in `cannon_mount` would break
 *   the per-plate entity hierarchy, and the root core is already baked.
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
  const gunParts: Array<[string, number, number, number]> = [
    ['gun_t1', -0.6, -0.45, 0.64],
    ['gun_t2', 0.6, -0.45, 0.64],
    ['gun_t3', -0.6, 0.45, 0.84],
    ['gun_t4', 0.6, 0.45, 0.84],
  ];

  const root = new Object3D();
  root.name = 'boss_islewrath';

  // Hull core first — root-level lookups must never hit a turret core.
  const hullCore = new Object3D();
  hullCore.name = 'hit_core';
  hullCore.position.copy(
    new Box3().setFromObject(islandMesh).getCenter(new Vector3()),
  );
  root.add(hullCore);
  root.add(islandMesh);

  for (const [name, x, z, y] of gunParts) {
    // Armour-part wrapper: the hittable plate identity (one per seat).
    const part = new Object3D();
    part.name = name;
    part.position.set(x, y, z);

    // Standard yaw pivot at the part origin; mesh, muzzle and core ride it.
    const rotor = new Object3D();
    rotor.name = 'gun_rotate';
    const gunMesh = new Mesh(gunGeometry, gunMaterial);
    gunMesh.name = `boss-gun-mesh-${name}`;
    const muzzle = new Object3D();
    muzzle.name = 'muzzle';
    muzzle.position.set(0, 0.11, -0.46);
    const hitCore = new Object3D();
    hitCore.name = 'hit_core';
    hitCore.position.set(0, 0.07, -0.02);
    rotor.add(gunMesh, muzzle, hitCore);
    part.add(rotor);
    root.add(part);
  }

  // Laser citadel: the same part -> gun_rotate two-level contract.
  const laserPart = new Object3D();
  laserPart.name = 'laser_turret';
  laserPart.position.set(0, 1.12, -0.08);
  const laserRotor = new Object3D();
  laserRotor.name = 'gun_rotate';
  const laserMesh = new Mesh(buildBossLaserTurret(rand), gunMaterial);
  laserMesh.name = 'boss-laser-mesh';
  const laserMuzzle = new Object3D();
  laserMuzzle.name = 'muzzle';
  laserMuzzle.position.set(0, 0.32, -0.6);
  const laserCore = new Object3D();
  laserCore.name = 'hit_core';
  laserCore.position.set(0, 0.08, -0.02);
  laserRotor.add(laserMesh, laserMuzzle, laserCore);
  laserPart.add(laserRotor);
  root.add(laserPart);

  return root;
}

// ---------------------------------------------------------------------------
// Pirate chief head (task 031) — the boss's phase-two summoner head
// ---------------------------------------------------------------------------

// Mechanical palette: the boss ship's dark-iron + red-accent language.
const CHIEF_IRON_COLOR = 0x33383f;
const CHIEF_IRON_DARK_COLOR = 0x21252c;
const CHIEF_RED_COLOR = 0xc23b2e;
const CHIEF_LENS_COLOR = 0xe0483a;
const CHIEF_PATCH_COLOR = 0x14161a;

/**
 * Head of the pirate warlord that rises from the boss's laser citadel once
 * every turret is gone (task 031). It exists to be shot at — and, from task
 * 03 on, to attack the wall itself with the chief death light.
 *
 * Design (v0.1.218 rework): an ANGULAR mechanical head in a samurai-kabuto
 * style — blocky plates instead of a sphere, a flared lamellar skirt
 * (shikoro), a flared helmet bowl with a front crest plate (maedate) and
 * turned-back side flares (fukigaeshi), a red visor slit, one red lens eye
 * with an eyepatch plate, and a vented jaw grill. NO neck: a flat seating
 * flange at y≈0 lets the runtime rest the head DIRECTLY on the citadel
 * drum like a bust on a plinth.
 *
 * - Origin: the seating plane, y = 0 at the flange bottom, +y to the crest.
 *   The runtime sinks it fully INSIDE the drum and rises it to sit on it,
 *   so it stays visually connected to the ship.
 * - Faces local -Z: the boss berths bow (-Z) toward the wall, so the face
 *   looks at the defenders.
 * - Baked empty nodes (unique names — GLTFLoader de-duplicates same-name
 *   siblings): `hp_blood` at the helmet top for the health bar mount,
 *   `hit_core` at the head centre (direct child, first) for shell hits.
 * - One merged vertex-coloured mesh, standard PBR (roughness 0.45, metal
 *   0.35 — machine metal close to the boss turret finish), white base.
 */
function buildPirateChief(rand: () => number): BufferGeometry {
  const parts: BufferGeometry[] = [];

  // Seating flange: the flat disc that rests on the drum — no neck. Bottom
  // face sits 0.004 above the origin plane so it never z-fights the drum
  // cap when the head is at rest.
  const flange = new CylinderGeometry(0.115, 0.115, 0.034, 8);
  flange.translate(0, 0.021, 0);
  paint(flange, CHIEF_IRON_DARK_COLOR, 0.03, rand);
  parts.push(flange);

  // Shikoro: two flared lamellar skirt rings above the flange. Kept within
  // the citadel drum's radius so the sunk pose stays hidden by the drum
  // walls (no side clipping during the rise).
  const skirtLower = new CylinderGeometry(0.1, 0.11, 0.03, 8);
  skirtLower.translate(0, 0.053, 0);
  paint(skirtLower, CHIEF_IRON_DARK_COLOR, 0.03, rand);
  parts.push(skirtLower);
  const skirtUpper = new CylinderGeometry(0.085, 0.103, 0.03, 8);
  skirtUpper.translate(0, 0.083, 0);
  paint(skirtUpper, CHIEF_IRON_DARK_COLOR, 0.03, rand);
  parts.push(skirtUpper);

  // Jaw block, then the skull block above it — the angular head mass,
  // deliberately wide and squat for a stocky read.
  const jaw = new BoxGeometry(0.18, 0.06, 0.18);
  jaw.translate(0, 0.128, 0);
  paint(jaw, CHIEF_IRON_COLOR, 0.03, rand);
  parts.push(jaw);
  const skull = new BoxGeometry(0.19, 0.085, 0.19);
  skull.translate(0, 0.2005, 0);
  paint(skull, CHIEF_IRON_COLOR, 0.03, rand);
  parts.push(skull);

  // Jaw grill: three stacked vent slats on the front of the jaw block.
  for (let i = 0; i < 3; i++) {
    const slat = new BoxGeometry(0.115 - i * 0.009, 0.014, 0.022);
    slat.translate(0, 0.14 - i * 0.026, -0.098);
    paint(slat, CHIEF_IRON_DARK_COLOR, 0.03, rand);
    parts.push(slat);
  }

  // Visor slit: the bright red "eye line" across the skull front.
  const visor = new BoxGeometry(0.135, 0.018, 0.02);
  visor.translate(0, 0.228, -0.103);
  paint(visor, CHIEF_LENS_COLOR, 0.02, rand);
  parts.push(visor);

  // The one seeing lens (chief's left, below the visor line).
  const lens = new CylinderGeometry(0.017, 0.017, 0.014, 8);
  lens.rotateX(Math.PI / 2);
  lens.translate(-0.045, 0.19, -0.103);
  paint(lens, CHIEF_LENS_COLOR, 0.02, rand);
  parts.push(lens);

  // Eyepatch plate over the other eye.
  const patch = new BoxGeometry(0.055, 0.045, 0.02);
  patch.translate(0.05, 0.195, -0.1);
  paint(patch, CHIEF_PATCH_COLOR, 0.02, rand);
  parts.push(patch);

  // Kabuto bowl: a flared funnel over the skull, capped on top.
  const bowl = new CylinderGeometry(0.085, 0.13, 0.06, 8);
  bowl.translate(0, 0.273, 0);
  paint(bowl, CHIEF_IRON_DARK_COLOR, 0.03, rand);
  parts.push(bowl);
  const bowlCap = new CylinderGeometry(0.087, 0.085, 0.022, 8);
  bowlCap.translate(0, 0.314, 0);
  paint(bowlCap, CHIEF_IRON_COLOR, 0.03, rand);
  parts.push(bowlCap);

  // Maedate: the vertical red crest plate rising from the bowl front.
  const crest = new BoxGeometry(0.02, 0.09, 0.05);
  crest.translate(0, 0.322, -0.085);
  paint(crest, CHIEF_RED_COLOR, 0.02, rand);
  parts.push(crest);

  // Fukigaeshi: the two turned-back side flares at the bowl front corners.
  const flareLeft = new BoxGeometry(0.05, 0.045, 0.014);
  flareLeft.rotateY(Math.PI / 5);
  flareLeft.translate(-0.082, 0.29, -0.07);
  paint(flareLeft, CHIEF_RED_COLOR, 0.02, rand);
  parts.push(flareLeft);
  const flareRight = new BoxGeometry(0.05, 0.045, 0.014);
  flareRight.rotateY(-Math.PI / 5);
  flareRight.translate(0.082, 0.29, -0.07);
  paint(flareRight, CHIEF_RED_COLOR, 0.02, rand);
  parts.push(flareRight);

  return mergeParts(parts);
}

/** Root contract: hit_core first, then the merged head mesh, then hp_blood. */
export function createPirateChiefExport(): Object3D {
  const rand = makeRandom(20261027);
  const material = new MeshStandardMaterial({
    name: 'pirate-chief',
    color: 0xffffff,
    roughness: 0.45,
    metalness: 0.35,
    vertexColors: true,
  });

  const root = new Object3D();
  root.name = 'pirate-chief';

  const hitCore = new Object3D();
  hitCore.name = 'hit_core';
  hitCore.position.set(0, 0.185, 0);
  root.add(hitCore);

  const mesh = new Mesh(buildPirateChief(rand), material);
  mesh.name = 'pirate-chief-mesh';
  root.add(mesh);

  const hpBlood = new Object3D();
  hpBlood.name = 'hp_blood';
  hpBlood.position.set(0, 0.375, 0);
  root.add(hpBlood);

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
// boss-islewrath-v2: the island-ship warlord now ships a complete functional
// rig — a baked hull hit_core plus gun_t1..t4/laser_turret part wrappers, each
// owning a gun_rotate yaw pivot with muzzle/hit_core. The v2 file name isolates
// the changed node hierarchy from any stale GLB caching.
await exportGLB(createBossIslewrathExport(), 'boss-islewrath-v2.glb');
// pirate-chief: the boss's phase-two summoner head (task 031); hp_blood and
// hit_core are baked as named nodes for the runtime bar and shell systems.
await exportGLB(createPirateChiefExport(), 'pirate-chief.glb');
console.log('\nDone. GLBs written to public/gltf/');
