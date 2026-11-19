import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * HarborDefender 海盗扑翼飞行器（低模，参考 IMG_ornithopter.jpeg）。
 * 契约：根节点名 ornithopter；船头本地 -Z；原点为飞行姿态中心。
 * wing_left / wing_right 各自绕自身原点做 rotation.z 扑翼；
 * muzzle = 机腹货舱口 (0, -0.158, 0.032)；hit_core = 包围盒中心。
 *
 * 与海盗船一致：loading 阶段在代码中构建，不再固化 GLB。
 * 性能：整机 ≤1500 tri，3 Mesh = 3 draw call / 1 材质；
 * 颜色 512 图集，粗糙度+金属度与法线各 256 图集。
 */

const SEED = 20261119;

const ATLAS = 512;
const AUX_ATLAS = 256;

const DIM = {
  wingX: 0.166,
  wingY: 0.086,
  wingZ: -0.012,
  muzzleY: -0.158,
  muzzleZ: 0.032,
} as const;

/** 机身横截面接近正圆：x 方向基本不收窄，z 略缩，避免正视呈椭圆。 */
const BODY_SX = 0.98;
const BODY_SZ = 0.9;

// ---------------------------------------------------------------- noise

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeNoise(seed: number): (x: number, y: number) => number {
  const rnd = mulberry32(seed);
  const perm = new Uint8Array(512);
  const vals = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    perm[i] = i;
    vals[i] = rnd();
  }
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = perm[i];
    perm[i] = perm[j];
    perm[j] = t;
  }
  for (let i = 0; i < 256; i++) perm[i + 256] = perm[i];

  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const lattice = (x: number, y: number) => vals[perm[(perm[x & 255] + (y & 255)) & 511]];

  return (x, y) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const u = fade(x - xi);
    const v = fade(y - yi);
    return lerp(
      lerp(lattice(xi, yi), lattice(xi + 1, yi), u),
      lerp(lattice(xi, yi + 1), lattice(xi + 1, yi + 1), u),
      v,
    );
  };
}

function fbm(noise: (x: number, y: number) => number, x: number, y: number, octaves = 3): number {
  let value = 0;
  let amp = 0.5;
  let freq = 1;
  let total = 0;
  for (let i = 0; i < octaves; i++) {
    value += amp * noise(x * freq, y * freq);
    total += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return value / total;
}

// ---------------------------------------------------------------- atlas

function makeCanvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is unavailable');
  return [canvas, ctx];
}

function texture(canvas: HTMLCanvasElement, srgb: boolean): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 4;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 从颜色图集按亮度梯度生成法线图，输出 256。 */
function normalFrom(albedo: HTMLCanvasElement, strength: number, outSize: number): HTMLCanvasElement {
  const size = albedo.width;
  const src = albedo.getContext('2d')!.getImageData(0, 0, size, size).data;
  const [canvas, ctx] = makeCanvas(outSize);
  const image = ctx.createImageData(outSize, outSize);
  const scale = size / outSize;
  const lum = (x: number, y: number) => {
    const sx = Math.min(size - 1, Math.max(0, Math.round(x * scale)));
    const sy = Math.min(size - 1, Math.max(0, Math.round(y * scale)));
    const i = (sy * size + sx) * 4;
    return (src[i] * 0.299 + src[i + 1] * 0.587 + src[i + 2] * 0.114) / 255;
  };
  for (let y = 0; y < outSize; y++) {
    for (let x = 0; x < outSize; x++) {
      const dx = (lum(x - 1, y) - lum(x + 1, y)) * strength;
      const dy = (lum(x, y - 1) - lum(x, y + 1)) * strength;
      const inv = 1 / Math.hypot(dx, dy, 1);
      const i = (y * outSize + x) * 4;
      image.data[i] = (dx * inv * 0.5 + 0.5) * 255;
      image.data[i + 1] = (dy * inv * 0.5 + 0.5) * 255;
      image.data[i + 2] = (inv * 0.5 + 0.5) * 255;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/** 图集分格（像素坐标，canvas 左上为原点）。改这里必须同步 uvRect。 */
const CELL = {
  hull: { x: 0, y: 0, size: 256 },
  canvas: { x: 256, y: 0, size: 256 },
  spar: { x: 0, y: 256, size: 128 },
  metal: { x: 128, y: 256, size: 128 },
  hatch: { x: 256, y: 256, size: 64 },
  brass: { x: 320, y: 256, size: 64 },
} as const;

type CellName = keyof typeof CELL;

type CellMaps = {
  color: HTMLCanvasElement;
  /** G = roughness，B = metalness，共用一张贴图 */
  rm: HTMLCanvasElement;
};

function solidRm(
  size: number,
  rough: readonly [number, number],
  metal: number,
  variation: number,
  seed: number,
): HTMLCanvasElement {
  const [rm, ctx] = makeCanvas(size);
  const noise = makeNoise(seed);
  const image = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(noise, x * 0.05, y * 0.05, 3);
      const i = (y * size + x) * 4;
      image.data[i] = 128;
      image.data[i + 1] = THREE.MathUtils.clamp(rough[0] + (rough[1] - rough[0]) * n, 0, 1) * 255;
      image.data[i + 2] = THREE.MathUtils.clamp(metal + (n - 0.5) * variation, 0, 1) * 255;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return rm;
}

function buildHullCell(): CellMaps {
  const size = 256;
  const [albedo, ctx] = makeCanvas(size);
  const [rm, rctx] = makeCanvas(size);
  const grainN = makeNoise(SEED + 11);
  const stainN = makeNoise(SEED + 29);
  const image = ctx.createImageData(size, size);
  const rimage = rctx.createImageData(size, size);
  const plank = size / 6;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const local = ((x % plank) + plank) % plank;
      const seam = local < 2 ? 0.42 : local < 3.5 ? 1.14 : 1;
      const grain = fbm(grainN, x * 0.02, y * 0.1, 3);
      const stain = fbm(stainN, x * 0.012, y * 0.01, 2);
      let l = 0.4 + 0.085 * grain + 0.05 * (stain - 0.5);
      l = Math.max(0.1, l * seam);
      const i = (y * size + x) * 4;
      image.data[i] = THREE.MathUtils.clamp(l * 1.07, 0, 1) * 255;
      image.data[i + 1] = THREE.MathUtils.clamp(l * 0.82, 0, 1) * 255;
      image.data[i + 2] = THREE.MathUtils.clamp(l * 0.6, 0, 1) * 255;
      image.data[i + 3] = 255;
      rimage.data[i] = 128;
      rimage.data[i + 1] = THREE.MathUtils.clamp(0.6 + 0.2 * grain, 0, 1) * 255;
      rimage.data[i + 2] = 6;
      rimage.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  rctx.putImageData(rimage, 0, 0);
  return { color: albedo, rm };
}

function buildCanvasCell(): CellMaps {
  const size = 256;
  const [albedo, ctx] = makeCanvas(size);
  const stainN = makeNoise(SEED + 71);
  const weaveN = makeNoise(SEED + 89);
  const image = ctx.createImageData(size, size);
  // 粗麻布：4 px 经纬交织的方格，明暗对比拉大
  const freq = (Math.PI * 2) / 4;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const stain = fbm(stainN, x * 0.016, y * 0.012, 2);
      const weave = fbm(weaveN, x * 0.16, y * 0.16, 2);
      const thread = Math.sin(x * freq) * Math.sin(y * freq);
      const seamX = x % 64 < 2 ? 0.84 : 1;
      const seamY = y % 128 < 2 ? 0.88 : 1;
      let l = 0.6 + 0.12 * (stain - 0.5) + 0.2 * thread + 0.06 * (weave - 0.5);
      l *= seamX * seamY;
      const i = (y * size + x) * 4;
      image.data[i] = THREE.MathUtils.clamp(l * 1.04, 0, 1) * 255;
      image.data[i + 1] = THREE.MathUtils.clamp(l * 0.99, 0, 1) * 255;
      image.data[i + 2] = THREE.MathUtils.clamp(l * 0.88, 0, 1) * 255;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return { color: albedo, rm: solidRm(size, [0.9, 0.98], 0, 0.03, SEED + 101) };
}

function buildSparCell(): CellMaps {
  const size = 128;
  const [albedo, ctx] = makeCanvas(size);
  const grainN = makeNoise(SEED + 131);
  const image = ctx.createImageData(size, size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const grain = fbm(grainN, x * 0.03, y * 0.18, 3);
      const l = 0.46 + 0.1 * grain;
      const i = (y * size + x) * 4;
      image.data[i] = THREE.MathUtils.clamp(l * 1.05, 0, 1) * 255;
      image.data[i + 1] = THREE.MathUtils.clamp(l * 0.83, 0, 1) * 255;
      image.data[i + 2] = THREE.MathUtils.clamp(l * 0.62, 0, 1) * 255;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return { color: albedo, rm: solidRm(size, [0.55, 0.76], 0, 0.04, SEED + 149) };
}

function buildMetalCell(): CellMaps {
  const size = 128;
  const [albedo, ctx] = makeCanvas(size);
  const noise = makeNoise(SEED + 167);
  const image = ctx.createImageData(size, size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(noise, x * 0.07, y * 0.07, 3);
      const l = 0.16 + 0.05 * n;
      const i = (y * size + x) * 4;
      image.data[i] = THREE.MathUtils.clamp(l, 0, 1) * 255;
      image.data[i + 1] = THREE.MathUtils.clamp(l * 1.04, 0, 1) * 255;
      image.data[i + 2] = THREE.MathUtils.clamp(l * 1.1, 0, 1) * 255;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return { color: albedo, rm: solidRm(size, [0.44, 0.62], 0.88, 0.08, SEED + 181) };
}

function buildHatchCell(): CellMaps {
  const size = 64;
  const [albedo, ctx] = makeCanvas(size);
  ctx.fillStyle = '#141110';
  ctx.fillRect(0, 0, size, size);
  return { color: albedo, rm: solidRm(size, [0.8, 0.92], 0.05, 0.04, SEED + 199) };
}

function buildBrassCell(): CellMaps {
  const size = 64;
  const [albedo, ctx] = makeCanvas(size);
  ctx.fillStyle = '#8a6c3a';
  ctx.fillRect(0, 0, size, size);
  return { color: albedo, rm: solidRm(size, [0.36, 0.5], 1, 0.05, SEED + 211) };
}

function buildAtlas() {
  const [colorCanvas, colorCtx] = makeCanvas(ATLAS);
  const [rmCanvas, rmCtx] = makeCanvas(AUX_ATLAS);

  const builders: Record<CellName, () => CellMaps> = {
    hull: buildHullCell,
    canvas: buildCanvasCell,
    spar: buildSparCell,
    metal: buildMetalCell,
    hatch: buildHatchCell,
    brass: buildBrassCell,
  };

  for (const name of Object.keys(CELL) as CellName[]) {
    const cell = CELL[name];
    const maps = builders[name]();
    colorCtx.drawImage(maps.color, cell.x, cell.y);
    rmCtx.drawImage(maps.rm, cell.x >> 1, cell.y >> 1, cell.size >> 1, cell.size >> 1);
  }

  return {
    map: texture(colorCanvas, true),
    rm: texture(rmCanvas, false),
    normalMap: texture(normalFrom(colorCanvas, 1.9, AUX_ATLAS), false),
  };
}

// ---------------------------------------------------------------- material

let cache: { atlas: THREE.MeshStandardMaterial } | null = null;

function materials() {
  if (cache) return cache;
  const atlas = buildAtlas();
  cache = {
    atlas: new THREE.MeshStandardMaterial({
      map: atlas.map,
      roughnessMap: atlas.rm,
      metalnessMap: atlas.rm,
      normalMap: atlas.normalMap,
      color: 0xffffff,
      roughness: 1,
      metalness: 1,
      side: THREE.DoubleSide,
    }),
  };
  return cache;
}

// ---------------------------------------------------------------- UV

/** 图集分格 UV 矩形（留 2px 内缩，防 mip 溢色）。 */
function uvRect(name: CellName) {
  const cell = CELL[name];
  const pad = 2;
  return {
    u0: (cell.x + pad) / ATLAS,
    u1: (cell.x + cell.size - pad) / ATLAS,
    v0: 1 - (cell.y + cell.size - pad) / ATLAS,
    v1: 1 - (cell.y + pad) / ATLAS,
  };
}

function mapCell(geo: THREE.BufferGeometry, name: CellName): THREE.BufferGeometry {
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute | undefined;
  if (!uv) return geo;
  const { u0, u1, v0, v1 } = uvRect(name);
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
  }
  uv.needsUpdate = true;
  return geo;
}

// ---------------------------------------------------------------- geometry helpers

type Vec3 = [number, number, number];

function fromArrays(positions: number[], uvs: number[]): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  return geo;
}

function quadUV(
  positions: number[],
  uvs: number[],
  a: Vec3,
  b: Vec3,
  c: Vec3,
  d: Vec3,
  ua: [number, number],
  ub: [number, number],
  uc: [number, number],
  ud: [number, number],
) {
  const push = (p: Vec3, uv: [number, number]) => {
    positions.push(p[0], p[1], p[2]);
    uvs.push(uv[0], uv[1]);
  };
  push(a, ua);
  push(b, ub);
  push(c, uc);
  push(a, ua);
  push(c, uc);
  push(d, ud);
}

function triUV(
  positions: number[],
  uvs: number[],
  a: Vec3,
  b: Vec3,
  c: Vec3,
  ua: [number, number],
  ub: [number, number],
  uc: [number, number],
) {
  const push = (p: Vec3, uv: [number, number]) => {
    positions.push(p[0], p[1], p[2]);
    uvs.push(uv[0], uv[1]);
  };
  push(a, ua);
  push(b, ub);
  push(c, uc);
}

function quadGeometry(a: Vec3, b: Vec3, c: Vec3, d: Vec3, flip: boolean): THREE.BufferGeometry {
  const q = flip ? [a, d, c, b] : [a, b, c, d];
  const uv: Array<[number, number]> = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  const positions: number[] = [];
  const uvs: number[] = [];
  const push = (i: number) => {
    positions.push(q[i][0], q[i][1], q[i][2]);
    uvs.push(uv[i][0], uv[i][1]);
  };
  push(0);
  push(1);
  push(2);
  push(0);
  push(2);
  push(3);
  return fromArrays(positions, uvs);
}

function triGeometry(a: Vec3, b: Vec3, c: Vec3, flip: boolean): THREE.BufferGeometry {
  const t = flip ? [a, c, b] : [a, b, c];
  const positions: number[] = [];
  const uvs: number[] = [];
  const uv: Array<[number, number]> = [
    [0, 0],
    [1, 0],
    [0.5, 1],
  ];
  for (let i = 0; i < 3; i++) {
    positions.push(t[i][0], t[i][1], t[i][2]);
    uvs.push(uv[i][0], uv[i][1]);
  }
  return fromArrays(positions, uvs);
}

function transform(geo: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) {
  const matrix = new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(1, 1, 1),
  );
  geo.applyMatrix4(matrix);
  return geo;
}

function box(w: number, h: number, d: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) {
  return transform(new THREE.BoxGeometry(w, h, d), x, y, z, rx, ry, rz);
}

function strut(a: Vec3, b: Vec3, radius: number, segments = 3): THREE.BufferGeometry {
  const start = new THREE.Vector3(a[0], a[1], a[2]);
  const end = new THREE.Vector3(b[0], b[1], b[2]);
  const dir = new THREE.Vector3().subVectors(end, start);
  const length = dir.length();
  const geo = new THREE.CylinderGeometry(radius, radius, length, segments, 1);
  geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize()));
  geo.translate((start.x + end.x) / 2, (start.y + end.y) / 2, (start.z + end.z) / 2);
  return geo;
}

function mergeAll(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const flat = list.map((geo) => (geo.index ? geo.toNonIndexed() : geo));
  const merged = mergeGeometries(flat);
  if (!merged) throw new Error('ornithopter geometry merge failed');
  return merged;
}

// ---------------------------------------------------------------- hull

const HULL_SEG = 14;

/** 货舱口所在的站位（HULL[4] → HULL[5]），正对机身中部机腹。 */
const HATCH_K = 4;

type Station = {
  z: number;
  rx: number;
  top: number;
  bottom: number;
  cy: number;
};

/** 船头 -Z；每站 rx / top / bottom 接近相等，正视轮廓是圆而不是椭圆。 */
const HULL: Station[] = [
  { z: -0.3, rx: 0.016, top: 0.016, bottom: 0.018, cy: -0.04 },
  { z: -0.275, rx: 0.048, top: 0.044, bottom: 0.054, cy: -0.022 },
  { z: -0.22, rx: 0.088, top: 0.084, bottom: 0.1, cy: -0.004 },
  { z: -0.13, rx: 0.116, top: 0.116, bottom: 0.132, cy: 0 },
  { z: -0.02, rx: 0.135, top: 0.134, bottom: 0.146, cy: 0 },
  { z: 0.09, rx: 0.132, top: 0.138, bottom: 0.144, cy: 0.002 },
  { z: 0.2, rx: 0.11, top: 0.124, bottom: 0.13, cy: 0.004 },
  { z: 0.31, rx: 0.076, top: 0.106, bottom: 0.106, cy: 0.006 },
  { z: 0.39, rx: 0.042, top: 0.08, bottom: 0.062, cy: 0.008 },
  { z: 0.44, rx: 0.012, top: 0.03, bottom: 0.022, cy: 0.01 },
];

function section(st: Station, offsetY = 0, scale = 1): Vec3[] {
  const points: Vec3[] = [];
  for (let i = 0; i < HULL_SEG; i++) {
    // 接缝放在机腹最低点：平滑法线后不会在背脊正中留下折痕
    const angle = Math.PI + (i / HULL_SEG) * Math.PI * 2;
    const sin = Math.sin(angle);
    const cos = Math.cos(angle);
    const y = cos >= 0 ? cos * st.top : cos * st.bottom;
    points.push([sin * st.rx * BODY_SX * scale, y * scale + st.cy + offsetY, st.z * BODY_SZ]);
  }
  return points;
}

function hullShell(): THREE.BufferGeometry {
  const rings = HULL.map((st) => section(st));
  const count = rings.length;
  const positions: number[] = [];
  const uvs: number[] = [];

  for (let k = 0; k < count - 1; k++) {
    const v0 = k / (count - 1);
    const v1 = (k + 1) / (count - 1);
    for (let i = 0; i < HULL_SEG; i++) {
      // 机腹货舱口：挖掉腹部两片面片，缺口由 bellyHatch 内衬补齐
      if (k === HATCH_K && (i === 0 || i === HULL_SEG - 1)) continue;
      const j = (i + 1) % HULL_SEG;
      const u0 = i / HULL_SEG;
      const u1 = (i + 1) / HULL_SEG;
      quadUV(
        positions,
        uvs,
        rings[k][i],
        rings[k + 1][i],
        rings[k + 1][j],
        rings[k][j],
        [u0, v0],
        [u0, v1],
        [u1, v1],
        [u1, v0],
      );
    }
  }

  const nose = HULL[0];
  const noseCenter: Vec3 = [0, nose.cy, nose.z * BODY_SZ];
  const noseRing = rings[0];
  for (let i = 0; i < HULL_SEG; i++) {
    triUV(positions, uvs, noseCenter, noseRing[i], noseRing[(i + 1) % HULL_SEG], [0.5, 0.5], [0.46, 0.5], [0.54, 0.5]);
  }

  const tail = HULL[count - 1];
  const tailCenter: Vec3 = [0, tail.cy, tail.z * BODY_SZ];
  const tailRing = rings[count - 1];
  for (let i = 0; i < HULL_SEG; i++) {
    triUV(positions, uvs, tailCenter, tailRing[(i + 1) % HULL_SEG], tailRing[i], [0.5, 0.5], [0.54, 0.5], [0.46, 0.5]);
  }

  return fromArrays(positions, uvs);
}

function hullHoops(): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  // 箍圈改为有厚度的木条：外侧凸出机体，内侧压进壳体内
  const bands: Array<[number, number]> = [
    [-0.13, 1.045],
    [-0.02, 1.04],
    [0.2, 1.05],
  ];
  for (const [z, scale] of bands) {
    const st = HULL.reduce((best, cur) => (Math.abs(cur.z - z) < Math.abs(best.z - z) ? cur : best));
    const outerA = section({ ...st, z: z - 0.011 }, 0, scale);
    const outerB = section({ ...st, z: z + 0.011 }, 0, scale);
    const innerA = section({ ...st, z: z - 0.011 }, 0, 0.955);
    const innerB = section({ ...st, z: z + 0.011 }, 0, 0.955);
    for (let i = 0; i < HULL_SEG; i++) {
      const j = (i + 1) % HULL_SEG;
      quadUV(positions, uvs, outerA[i], outerB[i], outerB[j], outerA[j], [0, 0], [0, 1], [1, 1], [1, 0]);
      quadUV(positions, uvs, outerA[i], outerA[j], innerA[j], innerA[i], [0, 0], [1, 0], [1, 1], [0, 1]);
      quadUV(positions, uvs, innerB[i], innerB[j], outerB[j], outerB[i], [0, 0], [1, 0], [1, 1], [0, 1]);
    }
  }
  return fromArrays(positions, uvs);
}

/** 壳体做顶点焊接 + 平滑法线，正交视图轮廓更圆。 */
function smoothHull(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  geo.deleteAttribute('normal');
  const merged = mergeVertices(geo, 1e-4);
  merged.computeVertexNormals();
  return merged;
}

/**
 * 机腹货舱：挖掉的腹部洞口向内补一圈内衬（木壁 + 深色舱底），
 * 舱门铰在舱口后沿，向机头前下方翻开——真实货机是向后开，这里反向。
 */
function bellyHatch(): Array<{ geo: THREE.BufferGeometry; cell: CellName }> {
  const k = HATCH_K;
  const outerA = section(HULL[k]);
  const outerB = section(HULL[k + 1]);
  const innerA = section(HULL[k], -0.006, 0.8);
  const innerB = section(HULL[k + 1], -0.006, 0.8);
  const idx = [HULL_SEG - 1, 0, 1];

  const walls: number[] = [];
  const wallsUv: number[] = [];
  const floor: number[] = [];
  const floorUv: number[] = [];

  // 深色舱底
  for (let s = 0; s < 2; s++) {
    quadUV(floor, floorUv, innerA[idx[s]], innerB[idx[s]], innerB[idx[s + 1]], innerA[idx[s + 1]], [0, 0], [0, 1], [1, 1], [1, 0]);
  }
  // 两侧壁
  for (const i of [HULL_SEG - 1, 1]) {
    quadUV(walls, wallsUv, outerA[i], outerB[i], innerB[i], innerA[i], [0, 0], [0, 1], [1, 1], [1, 0]);
  }
  // 前后两端壁
  for (let s = 0; s < 2; s++) {
    const i = idx[s];
    const j = idx[s + 1];
    quadUV(walls, wallsUv, outerA[i], innerA[i], innerA[j], outerA[j], [0, 0], [0, 1], [1, 1], [1, 0]);
    quadUV(walls, wallsUv, outerB[j], innerB[j], innerB[i], outerB[i], [0, 0], [0, 1], [1, 1], [1, 0]);
  }

  // 舱门：铰在舱口后沿，向前下方翻开约 109°
  const len = 0.092;
  const open = 1.9;
  const hingeY = -0.147;
  const hingeZ = HULL[k + 1].z * BODY_SZ;
  const door = transform(
    box(0.104, 0.007, len, 0, 0, 0),
    0,
    hingeY - Math.sin(open) * len * 0.5,
    hingeZ + Math.cos(open) * len * 0.5,
    open,
  );

  // 合页叶片：机身腹部是两折面，平面舱门铰线到腹壳之间留出上宽下窄的三角缝，
  // 用一整片木叶把缝从铰线补到壳边，兼作舱门后挡条
  const rear = section(HULL[k + 1]);
  const pC = rear[0];
  const pPos = rear[HULL_SEG - 1];
  const pNeg = rear[1];
  const leafA: Vec3 = [-0.052, hingeY, hingeZ];
  const leafM: Vec3 = [0, hingeY, hingeZ];
  const leafB: Vec3 = [0.052, hingeY, hingeZ];
  const leaves = mergeAll([
    quadGeometry([pPos[0], pPos[1], hingeZ], pC, leafM, leafB, false),
    quadGeometry(pC, [pNeg[0], pNeg[1], hingeZ], leafA, leafM, false),
  ]);

  return [
    { geo: fromArrays(floor, floorUv), cell: 'hatch' },
    { geo: fromArrays(walls, wallsUv), cell: 'spar' },
    { geo: door, cell: 'spar' },
    { geo: box(0.116, 0.008, 0.01, 0, -0.141, HULL[k].z * BODY_SZ + 0.002), cell: 'spar' },
    { geo: box(0.01, 0.008, 0.11, -0.057, -0.137, 0.032), cell: 'spar' },
    { geo: box(0.01, 0.008, 0.11, 0.057, -0.137, 0.032), cell: 'spar' },
    { geo: leaves, cell: 'spar' },
    // 铰链销：沿舱门铰线压住木叶下沿，兼作合页轴
    { geo: strut([-0.054, hingeY, hingeZ], [0.054, hingeY, hingeZ], 0.0065, 6), cell: 'metal' },
  ];
}

/** 沿 z 轴的圆柱，用于翼根铰链。 */
function cylZ(radius: number, length: number, x: number, y: number, z: number, segments: number) {
  const geo = new THREE.CylinderGeometry(radius, radius, length, segments, 1);
  geo.rotateX(Math.PI / 2);
  geo.translate(x, y, z);
  return geo;
}

function wingParts(side: 1 | -1): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  const flip = side < 0;
  const p = (x: number, y: number, z: number): Vec3 => [side * x, y, z];
  const mid = (a: Vec3, b: Vec3, t: number): Vec3 => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
  const spar = (a: Vec3, b: Vec3, radius: number, segments = 3) => {
    parts.push(mapCell(strut(a, b, radius, segments), 'spar'));
  };

  // 单块翼面：木质两段前缘龙骨 + 后缘 + 翼肋，中间张帆布
  const L0 = p(0.014, 0.004, -0.105);
  const L1 = p(0.26, 0.018, -0.135);
  const L2 = p(0.485, 0.028, -0.075);
  const T0 = p(0.03, 0.002, 0.27);
  const T1 = p(0.27, 0.016, 0.19);
  const T2 = p(0.455, 0.026, 0.09);

  parts.push(mapCell(quadGeometry(L0, L1, T1, T0, flip), 'canvas'));
  parts.push(mapCell(quadGeometry(L1, L2, T2, T1, flip), 'canvas'));

  // 前缘龙骨：两段，加粗
  spar(L0, L1, 0.0105, 4);
  spar(L1, L2, 0.0095, 4);
  // 后缘
  spar(T0, T1, 0.0055);
  spar(T1, T2, 0.005);
  // 翼肋与翼尖封边
  spar(L1, T1, 0.0045);
  spar(mid(L1, L2, 0.5), mid(T1, T2, 0.5), 0.004);
  spar(L2, T2, 0.0045);
  // 根梁：从铰链桶向前后接到翼根
  spar([0, 0, 0], L0, 0.008);
  spar([0, 0, 0], T0, 0.006);

  // 翼根铰链桶：套在肩板伸出的黄铜轴上，随翼绕 z 轴扑动
  parts.push(mapCell(cylZ(0.022, 0.062, 0, 0, 0, 6), 'metal'));

  const merged = mergeAll(parts);
  merged.rotateZ(side * 0.087);
  return [merged];
}

// ---------------------------------------------------------------- factory

export function createOrnithopter(): THREE.Group {
  const mats = materials();
  const root = new THREE.Group();
  root.name = 'ornithopter';

  const bodyParts: THREE.BufferGeometry[] = [];
  const addBody = (geo: THREE.BufferGeometry, cell: CellName) => bodyParts.push(mapCell(geo, cell));

  addBody(smoothHull(hullShell()), 'hull');
  addBody(hullHoops(), 'spar');
  addBody(box(0.026, 0.012, 0.108, 0, 0.138, 0.054), 'spar');
  addBody(box(0.023, 0.012, 0.09, 0, 0.133, 0.162), 'spar');

  // 肩部：安装板贴在腹侧，外伸上下两条铰链叉，黄铜轴穿过翼根铰链桶
  for (const side of [-1, 1] as const) {
    addBody(box(0.036, 0.096, 0.12, side * 0.134, DIM.wingY, DIM.wingZ), 'spar');
    addBody(box(0.038, 0.012, 0.07, side * DIM.wingX, DIM.wingY + 0.033, DIM.wingZ), 'spar');
    addBody(box(0.038, 0.012, 0.07, side * DIM.wingX, DIM.wingY - 0.033, DIM.wingZ), 'spar');
    addBody(cylZ(0.006, 0.084, side * DIM.wingX, DIM.wingY, DIM.wingZ, 6), 'brass');
  }

  // 机腹货舱口：中部挖开，内衬 + 向前下方翻开的舱门
  for (const part of bellyHatch()) addBody(part.geo, part.cell);

  // 尾梁 + 单片尾翼：一根龙骨斜撑一片帆布，不左右分叉
  addBody(box(0.05, 0.03, 0.09, 0, 0.012, 0.415 * BODY_SZ), 'spar');
  const finRoot: Vec3 = [0, 0.02, 0.35 * BODY_SZ];
  const finBack: Vec3 = [0, 0, 0.44 * BODY_SZ];
  const finTip: Vec3 = [0, 0.17, 0.44 * BODY_SZ];
  addBody(triGeometry(finRoot, finBack, finTip, false), 'canvas');
  addBody(strut(finRoot, finTip, 0.006, 3), 'spar');

  const bodyMesh = new THREE.Mesh(mergeAll(bodyParts), mats.atlas);
  bodyMesh.name = 'ornithopter-body';
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;
  root.add(bodyMesh);

  for (const side of [-1, 1] as const) {
    const pivot = new THREE.Group();
    pivot.name = side < 0 ? 'wing_left' : 'wing_right';
    pivot.position.set(side * DIM.wingX, DIM.wingY, DIM.wingZ);

    const wing = new THREE.Mesh(wingParts(side)[0], mats.atlas);
    wing.name = side < 0 ? 'ornithopter-wing-left' : 'ornithopter-wing-right';
    wing.castShadow = true;
    wing.receiveShadow = true;
    pivot.add(wing);
    root.add(pivot);
  }

  const muzzle = new THREE.Object3D();
  muzzle.name = 'muzzle';
  muzzle.position.set(0, DIM.muzzleY, DIM.muzzleZ);
  root.add(muzzle);

  root.updateMatrixWorld(true);
  const center = new THREE.Box3().setFromObject(root).getCenter(new THREE.Vector3());
  const hitCore = new THREE.Object3D();
  hitCore.name = 'hit_core';
  hitCore.position.copy(center);
  root.add(hitCore);

  return root;
}
