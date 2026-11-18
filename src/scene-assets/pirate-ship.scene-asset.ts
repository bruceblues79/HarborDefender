import * as THREE from 'three';

/**
 * HarborDefender 海盗船（程序化，loading 阶段生成原型，运行时 clone）。
 * 契约：原点是水线中心；船头朝局部 -Z；gun_rotate 是船首炮偏航枢轴，
 * muzzle 由 decorateShipPrototype 挂在炮口；hit_core 在包围盒中心。
 * 顶点色烘焙，材质固有色纯白；两个 draw call（船体 + 舰炮）。单位：米。
 */

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

/**
 * Fill a geometry's COLOR attribute. Base colour is an sRGB hex value run
 * through Color (r181 stores its r/g/b in linear space); every vertex gets a
 * deterministic low-contrast mottle around it.
 */
function paint(
  geo: THREE.BufferGeometry,
  hex: number,
  jitter: number,
  rand: () => number,
): void {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const base = new THREE.Color(hex);
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const f = 1 + (rand() * 2 - 1) * jitter;
    colors[i * 3 + 0] = Math.min(1, base.r * f);
    colors[i * 3 + 1] = Math.min(1, base.g * f);
    colors[i * 3 + 2] = Math.min(1, base.b * f);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

/** Override the colour of vertices matching a predicate (flat, no mottle). */
function paintWhere(
  geo: THREE.BufferGeometry,
  hex: number,
  match: (x: number, y: number, z: number) => boolean,
): void {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const colorAttr = geo.attributes.color as THREE.BufferAttribute;
  const c = new THREE.Color(hex);
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
function mergeParts(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
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

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  merged.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  merged.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

// Iron colours (dark gunmetal)
const BARREL_COLOR = 0x494e54;
const BORE_COLOR = 0x0b0c0e;

/** Warm, low-contrast ship palette (planking, deck, canvas, rigging). */
const HULL_COLOR = 0x5c4430;
const DECK_COLOR = 0x8a6c49;
const CABIN_COLOR = 0x6b4f34;
const MAST_COLOR = 0x74583a;
const SAIL_COLOR = 0x2a0808;
const FLAG_COLOR = 0xd40000;

/**
 * Iron barrel assembly in gun_rotate-local space: the lathed barrel
 * profile (muzzle swell, two astragal rings, reinforced breech,
 * cascabel), side trunnions and cascabel knob. The trunnion axis runs
 * through local origin (0, 0, 0), which is the elevation pivot.
 */
function buildBarrel(rand: () => number): THREE.BufferGeometry {
  // Lathe profile as (radius, y); after rotateX(+90deg) y maps to world z,
  // so negative y becomes the -Z muzzle end.
  const profile: THREE.Vector2[] = [
    new THREE.Vector2(0.0, -0.2), // muzzle face centre (faked bore)
    new THREE.Vector2(0.03, -0.2),
    new THREE.Vector2(0.036, -0.193), // muzzle swell
    new THREE.Vector2(0.033, -0.185),
    new THREE.Vector2(0.027, -0.178),
    new THREE.Vector2(0.025, -0.15),
    new THREE.Vector2(0.024, -0.08),
    new THREE.Vector2(0.029, -0.072), // astragal ring 1
    new THREE.Vector2(0.029, -0.062),
    new THREE.Vector2(0.024, -0.054),
    new THREE.Vector2(0.024, 0.02),
    new THREE.Vector2(0.03, 0.028), // astragal ring 2
    new THREE.Vector2(0.03, 0.04),
    new THREE.Vector2(0.026, 0.048),
    new THREE.Vector2(0.033, 0.075), // reinforced breech
    new THREE.Vector2(0.034, 0.11),
    new THREE.Vector2(0.03, 0.135),
    new THREE.Vector2(0.018, 0.146),
    new THREE.Vector2(0.01, 0.152),
    new THREE.Vector2(0.0, 0.154), // sealed breech face
  ];
  const barrelGeo = new THREE.LatheGeometry(profile, 24);
  barrelGeo.rotateX(Math.PI / 2);
  paint(barrelGeo, BARREL_COLOR, 0.03, rand);
  // Flat muzzle disc reads as the dark bore from the front.
  paintWhere(barrelGeo, BORE_COLOR, (_x, _y, z) => z <= -0.199);

  // Trunnions on the pivot axis, resting on the cheek brackets.
  const trunnionGeo = new THREE.CylinderGeometry(0.008, 0.008, 0.06, 10);
  trunnionGeo.rotateZ(Math.PI / 2);
  const trunnionPlus = trunnionGeo.clone();
  trunnionPlus.translate(0.06, 0, 0.045);
  const trunnionMinus = trunnionGeo.clone();
  trunnionMinus.translate(-0.06, 0, 0.045);
  paint(trunnionPlus, BARREL_COLOR, 0.03, rand);
  paint(trunnionMinus, BARREL_COLOR, 0.03, rand);

  // Cascabel knob at the breech end.
  const cascabelGeo = new THREE.SphereGeometry(0.015, 12, 8);
  cascabelGeo.translate(0, 0, 0.158);
  paint(cascabelGeo, BARREL_COLOR, 0.03, rand);

  return mergeParts([barrelGeo, trunnionPlus, trunnionMinus, cascabelGeo]);
}

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

const _vA = new THREE.Vector3();
const _vB = new THREE.Vector3();
const _vC = new THREE.Vector3();
const _edgeAB = new THREE.Vector3();
const _edgeAC = new THREE.Vector3();
const _faceN = new THREE.Vector3();
const _faceMid = new THREE.Vector3();
const _centroid = new THREE.Vector3();

/**
 * Flip triangles whose face normal points toward the vertex centroid, so
 * the hand-lofted hull is watertight-outward regardless of ring winding.
 */
function ensureOutward(geo: THREE.BufferGeometry): void {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const col = geo.attributes.color as THREE.BufferAttribute | undefined;
  const swap = (attr: THREE.BufferAttribute, a: number, b: number): void => {
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
function loftHull(
  stations: HullStation[],
  plankingColor: number,
  deckColor: number,
  rand: () => number,
): THREE.BufferGeometry {
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
  const base = new THREE.Color();
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

  const geo = new THREE.BufferGeometry();
  geo.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array(positions), 3),
  );
  geo.setAttribute(
    'color',
    new THREE.BufferAttribute(new Float32Array(colors), 3),
  );
  ensureOutward(geo);
  geo.computeVertexNormals();
  return geo;
}

/** The stock pirate raider hull: the shared loft at its authored stations. */
function buildHull(rand: () => number): THREE.BufferGeometry {
  return loftHull(HULL_STATIONS, HULL_COLOR, DECK_COLOR, rand);
}

/**
 * Deck furniture, rigging and sail — merged into the hull mesh so the whole
 * ship body stays one draw call. Heights reference the interpolated sheer
 * line so every piece lands flush on the deck.
 */
function buildShipSuperstructure(rand: () => number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  // Forecastle deck block carrying the bow gun (top face at y = 0.223).
  const foreDeck = new THREE.BoxGeometry(0.3, 0.06, 0.3);
  foreDeck.translate(0, 0.193, -0.38);
  paint(foreDeck, DECK_COLOR, 0.03, rand);
  parts.push(foreDeck);

  // Fixed cast-iron gun pedestal on the forecastle; the gun's rotating
  // turntable rides on its top face (y = 0.293) and yaws around the column's
  // central axis (x = 0, z = -0.38). Merged into the hull mesh: the pedestal
  // never rotates, so it stays part of the ship's single draw call.
  const pedestal = new THREE.CylinderGeometry(0.07, 0.085, 0.07, 14);
  pedestal.translate(0, 0.258, -0.38);
  paint(pedestal, BARREL_COLOR, 0.02, rand);
  parts.push(pedestal);

  // Raised stern cabin.
  const cabin = new THREE.BoxGeometry(0.22, 0.09, 0.3);
  cabin.translate(0, 0.211, 0.42);
  paint(cabin, CABIN_COLOR, 0.035, rand);
  parts.push(cabin);

  // Mast (bottom on deck at z = -0.05) and its yard.
  const mast = new THREE.CylinderGeometry(0.011, 0.015, 0.74, 8);
  mast.translate(0, 0.5, -0.05);
  paint(mast, MAST_COLOR, 0.03, rand);
  parts.push(mast);

  const yard = new THREE.CylinderGeometry(0.007, 0.007, 0.54, 6);
  yard.rotateZ(Math.PI / 2);
  yard.translate(0, 0.76, -0.05);
  paint(yard, MAST_COLOR, 0.03, rand);
  parts.push(yard);

  // Square sail hung high on the mast, bellying toward the bow (-Z): a
  // horizontal arc eases to the yard/sheet edges while the vertical
  // profile keeps the mid-height fullest, so it reads as wind-filled.
  const sailW = 0.5;
  const sailH = 0.36;
  const sail = new THREE.PlaneGeometry(sailW, sailH, 5, 4);
  const sailPos = sail.attributes.position as THREE.BufferAttribute;
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
  const flag = new THREE.PlaneGeometry(0.11, 0.055);
  flag.translate(0.075, 0.85, -0.05);
  paint(flag, FLAG_COLOR, 0.02, rand);
  parts.push(flag);

  // Bowsprit leaning up-forward from the stem. Shortened to 1/4 of the
  // original 0.3 m (now 0.075 m); the centre is shifted toward the base
  // before rotation so the stem-anchored root stays put and only the tip
  // recedes.
  const bowsprit = new THREE.CylinderGeometry(0.007, 0.011, 0.075, 6);
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
export function createPirateShip(): THREE.Object3D {
  const rand = makeRandom(20261014);

  const hullMaterial = new THREE.MeshStandardMaterial({
    name: 'ship-hull',
    color: 0xffffff,
    roughness: 0.6,
    metalness: 0,
    vertexColors: true,
    // The hull is a closed solid, but the sail and pennant are thin planes:
    // double-sided keeps them visible from any heading the ship is placed at.
    side: THREE.DoubleSide,
  });
  const ironMaterial = new THREE.MeshStandardMaterial({
    name: 'cannon-iron',
    color: 0xffffff,
    roughness: 0.5,
    metalness: 1,
    vertexColors: true,
  });

  const hullMesh = new THREE.Mesh(
    mergeParts([buildHull(rand), buildShipSuperstructure(rand)]),
    hullMaterial,
  );
  hullMesh.name = 'ship-hull';

  // Turntable + cheek plates in gun_rotate-local space: the disc rides on
  // the fixed pedestal (top face y = 0.293 -> local -0.052), the plates cap
  // the barrel trunnion ends (outer faces at x = +/-0.09) so the pivot reads
  // as held, and the whole assembly yaws with the barrel.
  const turntable = new THREE.CylinderGeometry(0.105, 0.11, 0.012, 20);
  turntable.translate(0, -0.046, 0);
  paint(turntable, BARREL_COLOR, 0.02, rand);
  const cheek = new THREE.BoxGeometry(0.012, 0.048, 0.05);
  const cheekPlus = cheek.clone();
  cheekPlus.translate(0.096, -0.016, 0.045);
  const cheekMinus = cheek.clone();
  cheekMinus.translate(-0.096, -0.016, 0.045);
  paint(cheekPlus, BARREL_COLOR, 0.02, rand);
  paint(cheekMinus, BARREL_COLOR, 0.02, rand);

  const barrelMesh = new THREE.Mesh(
    mergeParts([buildBarrel(rand), turntable, cheekPlus, cheekMinus]),
    ironMaterial,
  );
  barrelMesh.name = 'ship-barrel';

  const gunRotate = new THREE.Object3D();
  gunRotate.name = 'gun_rotate';
  // Pivot ON the pedestal central axis (yaw centre = cylinder centre); the
  // barrel bottom (~local -0.03 at the trunnion zone) clears the turntable
  // top (local -0.04).
  gunRotate.position.set(0, 0.345, -0.38);
  gunRotate.add(barrelMesh);

  const root = new THREE.Object3D();
  root.name = 'pirate-ship';
  root.add(hullMesh);
  root.add(gunRotate);

  return root;
}
