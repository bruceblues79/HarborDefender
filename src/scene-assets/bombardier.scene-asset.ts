import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * HarborDefender 海盗轰炸机（低模，参考 IMG_bombardier.jpeg）。
 * 与海盗船、扑翼机一致：loading 阶段在代码中构建，不再固化 GLB。
 * 契约：
 *   - 根节点名 bombardier，机头本地 -Z，原点为飞行姿态中心；
 *   - propellers → 子旋翼节点绕自身 +Y 旋转（PROP 8 rad/s）；
 *   - muzzle = 机腹投弹口 (0, -0.1785, -0.102)；
 *   - 顶部（桅帽尖）y = 0.359，健康条 barY 沿用该高度；
 *   - hit_core = 包围盒中心。
 *
 * 性能：整机 ≤1500 tri，机身 1 Mesh + 旋翼 1 Mesh = 2 draw call / 1 材质；
 * 颜色 512 图集，粗糙度+金属度与法线各 256 图集。
 */

const SEED = 20261120;

const ATLAS = 512;
const AUX_ATLAS = 256;

const DIM = {
  muzzleY: -0.1785,
  muzzleZ: -0.102,
  rotorY: 0.296,
  rotorZ: 0.04,
  rotorRadius: 0.69,
} as const;

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
    return (src[i] * 0.3 + src[i + 1] * 0.59 + src[i + 2] * 0.11) / 255;
  };
  for (let y = 0; y < outSize; y++) {
    for (let x = 0; x < outSize; x++) {
      const dx = lum(x + 1, y) - lum(x - 1, y);
      const dy = lum(x, y + 1) - lum(x, y - 1);
      const nx = -dx * strength;
      const ny = dy * strength;
      const len = Math.hypot(nx, ny, 1);
      const i = (y * outSize + x) * 4;
      image.data[i] = ((nx / len) * 0.5 + 0.5) * 255;
      image.data[i + 1] = ((ny / len) * 0.5 + 0.5) * 255;
      image.data[i + 2] = (1 / len) * 0.5 * 255 + 127.5;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/** 图集分格（像素坐标，canvas 左上为原点）。改这里必须同步 uvRect。 */
const CELL = {
  hull: { x: 0, y: 0, size: 256 },
  spar: { x: 256, y: 0, size: 128 },
  iron: { x: 384, y: 0, size: 128 },
  paintRed: { x: 256, y: 128, size: 64 },
  paintBlue: { x: 320, y: 128, size: 64 },
  canvas: { x: 384, y: 128, size: 128 },
  dark: { x: 256, y: 192, size: 64 },
  rope: { x: 320, y: 192, size: 64 },
  skull: { x: 0, y: 256, size: 128 },
  shield: { x: 128, y: 256, size: 64 },
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

function buildPlankCell(size: number, base: number, tint: readonly [number, number, number], seed: number): CellMaps {
  const [albedo, ctx] = makeCanvas(size);
  const [rm, rctx] = makeCanvas(size);
  const grainN = makeNoise(seed + 11);
  const stainN = makeNoise(seed + 29);
  const image = ctx.createImageData(size, size);
  const rimage = rctx.createImageData(size, size);
  const plank = size / 6;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const local = ((x % plank) + plank) % plank;
      const seam = local < 2 ? 0.42 : local < 3.5 ? 1.14 : 1;
      const grain = fbm(grainN, x * 0.02, y * 0.1, 3);
      const stain = fbm(stainN, x * 0.012, y * 0.01, 2);
      let l = base + 0.085 * grain + 0.05 * (stain - 0.5);
      l = Math.max(0.08, l * seam);
      const i = (y * size + x) * 4;
      image.data[i] = THREE.MathUtils.clamp(l * tint[0], 0, 1) * 255;
      image.data[i + 1] = THREE.MathUtils.clamp(l * tint[1], 0, 1) * 255;
      image.data[i + 2] = THREE.MathUtils.clamp(l * tint[2], 0, 1) * 255;
      image.data[i + 3] = 255;
      rimage.data[i] = 128;
      rimage.data[i + 1] = THREE.MathUtils.clamp(0.58 + 0.2 * grain, 0, 1) * 255;
      rimage.data[i + 2] = 6;
      rimage.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  rctx.putImageData(rimage, 0, 0);
  return { color: albedo, rm };
}

function buildIronCell(): CellMaps {
  const size = 128;
  const [albedo, ctx] = makeCanvas(size);
  const noise = makeNoise(SEED + 167);
  const image = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(noise, x * 0.07, y * 0.07, 3);
      const l = 0.15 + 0.055 * n;
      const i = (y * size + x) * 4;
      image.data[i] = THREE.MathUtils.clamp(l, 0, 1) * 255;
      image.data[i + 1] = THREE.MathUtils.clamp(l * 1.04, 0, 1) * 255;
      image.data[i + 2] = THREE.MathUtils.clamp(l * 1.12, 0, 1) * 255;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return { color: albedo, rm: solidRm(size, [0.45, 0.63], 0.9, 0.08, SEED + 181) };
}

function buildPaintCell(
  size: number,
  tint: readonly [number, number, number],
  rough: readonly [number, number],
  seed: number,
): CellMaps {
  const [albedo, ctx] = makeCanvas(size);
  const noise = makeNoise(seed);
  const image = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(noise, x * 0.09, y * 0.09, 3);
      const l = 0.82 + 0.18 * n;
      const i = (y * size + x) * 4;
      image.data[i] = THREE.MathUtils.clamp(tint[0] * l, 0, 1) * 255;
      image.data[i + 1] = THREE.MathUtils.clamp(tint[1] * l, 0, 1) * 255;
      image.data[i + 2] = THREE.MathUtils.clamp(tint[2] * l, 0, 1) * 255;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return { color: albedo, rm: solidRm(size, rough, 0.05, 0.04, seed + 17) };
}

function buildCanvasCell(): CellMaps {
  const size = 128;
  const [albedo, ctx] = makeCanvas(size);
  const stainN = makeNoise(SEED + 71);
  const weaveN = makeNoise(SEED + 89);
  const image = ctx.createImageData(size, size);
  const freq = (Math.PI * 2) / 3;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const stain = fbm(stainN, x * 0.016, y * 0.012, 2);
      const weave = fbm(weaveN, x * 0.16, y * 0.16, 2);
      const thread = Math.sin(x * freq) * Math.sin(y * freq);
      const seamX = x % 32 < 2 ? 0.82 : 1;
      const seamY = y % 64 < 2 ? 0.86 : 1;
      let l = 0.33 + 0.09 * (stain - 0.5) + 0.12 * thread + 0.05 * (weave - 0.5);
      l *= seamX * seamY;
      const i = (y * size + x) * 4;
      image.data[i] = THREE.MathUtils.clamp(l * 1.03, 0, 1) * 255;
      image.data[i + 1] = THREE.MathUtils.clamp(l * 0.99, 0, 1) * 255;
      image.data[i + 2] = THREE.MathUtils.clamp(l * 0.9, 0, 1) * 255;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return { color: albedo, rm: solidRm(size, [0.88, 0.97], 0, 0.03, SEED + 101) };
}

function buildDarkCell(): CellMaps {
  const size = 64;
  const [albedo, ctx] = makeCanvas(size);
  ctx.fillStyle = '#121010';
  ctx.fillRect(0, 0, size, size);
  return { color: albedo, rm: solidRm(size, [0.78, 0.9], 0.08, 0.04, SEED + 199) };
}

function buildRopeCell(): CellMaps {
  const size = 64;
  const [albedo, ctx] = makeCanvas(size);
  const noise = makeNoise(SEED + 203);
  const image = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const twist = ((x + y) % 6) < 2 ? 0.78 : 1;
      const n = fbm(noise, x * 0.12, y * 0.12, 2);
      const l = (0.5 + 0.13 * n) * twist;
      const i = (y * size + x) * 4;
      image.data[i] = THREE.MathUtils.clamp(l * 1.05, 0, 1) * 255;
      image.data[i + 1] = THREE.MathUtils.clamp(l * 0.88, 0, 1) * 255;
      image.data[i + 2] = THREE.MathUtils.clamp(l * 0.66, 0, 1) * 255;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return { color: albedo, rm: solidRm(size, [0.8, 0.92], 0, 0.03, SEED + 211) };
}

/** 船首骷髅圆牌：铁牌底 + 骨白骷髅，用贴图表现，不做几何。 */
function buildSkullCell(): CellMaps {
  const size = 128;
  const [albedo, ctx] = makeCanvas(size);
  ctx.fillStyle = '#1b1714';
  ctx.fillRect(0, 0, size, size);

  ctx.fillStyle = '#d9d0ba';
  ctx.beginPath();
  ctx.ellipse(64, 54, 26, 30, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(64, 88, 17, 0, Math.PI);
  ctx.fill();
  ctx.fillRect(47, 78, 34, 12);

  ctx.fillStyle = '#121010';
  ctx.beginPath();
  ctx.arc(53, 52, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(75, 52, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(64, 62);
  ctx.lineTo(59, 73);
  ctx.lineTo(69, 73);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = '#121010';
  ctx.lineWidth = 2;
  for (const x of [55, 60, 65, 70, 75]) {
    ctx.beginPath();
    ctx.moveTo(x, 82);
    ctx.lineTo(x, 90);
    ctx.stroke();
  }
  return { color: albedo, rm: solidRm(size, [0.55, 0.7], 0.25, 0.05, SEED + 233) };
}

/** 舷侧小盾徽：红底 + 铁边，几何只是一片薄盾牌。 */
function buildShieldCell(): CellMaps {
  const size = 64;
  const [albedo, ctx] = makeCanvas(size);
  ctx.fillStyle = '#7a1e18';
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = '#3c2f22';
  ctx.lineWidth = 6;
  ctx.strokeRect(4, 4, size - 8, size - 8);
  ctx.fillStyle = '#c8a05a';
  ctx.fillRect(29, 10, 6, 44);
  ctx.fillRect(16, 28, 32, 6);
  return { color: albedo, rm: solidRm(size, [0.52, 0.66], 0.15, 0.05, SEED + 241) };
}

function buildAtlas() {
  const [colorCanvas, colorCtx] = makeCanvas(ATLAS);
  const [rmCanvas, rmCtx] = makeCanvas(AUX_ATLAS);

  const builders: Record<CellName, () => CellMaps> = {
    hull: () => buildPlankCell(256, 0.38, [1.07, 0.8, 0.58], SEED + 3),
    spar: () => buildPlankCell(128, 0.5, [1.08, 0.87, 0.66], SEED + 41),
    iron: buildIronCell,
    paintRed: () => buildPaintCell(64, [0.56, 0.13, 0.11], [0.5, 0.64], SEED + 53),
    paintBlue: () => buildPaintCell(64, [0.11, 0.15, 0.24], [0.5, 0.64], SEED + 67),
    canvas: buildCanvasCell,
    dark: buildDarkCell,
    rope: buildRopeCell,
    skull: buildSkullCell,
    shield: buildShieldCell,
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
    normalMap: texture(normalFrom(colorCanvas, 1.8, AUX_ATLAS), false),
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

function quadGeometry(a: Vec3, b: Vec3, c: Vec3, d: Vec3, flip = false): THREE.BufferGeometry {
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
  if (!merged) throw new Error('bombardier geometry merge failed');
  return merged;
}

// ---------------------------------------------------------------- hull

const HULL_SEG = 12;

/** 投弹口所在的站位（HULL[3] → HULL[4]），正对 muzzle z = -0.102。 */
const HATCH_K = 3;

type Station = {
  z: number;
  rx: number;
  top: number;
  bottom: number;
  cy: number;
};

/** 船头 -Z；中段饱满的桶形船体，尾部上翘收细。 */
const HULL: Station[] = [
  { z: -0.255, rx: 0.022, top: 0.026, bottom: 0.03, cy: -0.01 },
  { z: -0.238, rx: 0.062, top: 0.062, bottom: 0.075, cy: -0.005 },
  { z: -0.2, rx: 0.105, top: 0.1, bottom: 0.12, cy: 0 },
  { z: -0.13, rx: 0.142, top: 0.128, bottom: 0.17, cy: 0 },
  { z: -0.03, rx: 0.158, top: 0.14, bottom: 0.2, cy: 0 },
  { z: 0.08, rx: 0.155, top: 0.148, bottom: 0.195, cy: 0.002 },
  { z: 0.18, rx: 0.14, top: 0.145, bottom: 0.175, cy: 0.006 },
  { z: 0.27, rx: 0.112, top: 0.14, bottom: 0.125, cy: 0.012 },
  { z: 0.33, rx: 0.075, top: 0.12, bottom: 0.09, cy: 0.02 },
  { z: 0.38, rx: 0.038, top: 0.078, bottom: 0.045, cy: 0.03 },
  { z: 0.405, rx: 0.0015, top: 0.003, bottom: 0.002, cy: 0.04 },
];

function section(st: Station, offsetY = 0, scale = 1): Vec3[] {
  const points: Vec3[] = [];
  for (let i = 0; i < HULL_SEG; i++) {
    // 接缝放在船底最低点，平滑后不会在背脊留下折痕
    const angle = Math.PI + (i / HULL_SEG) * Math.PI * 2;
    const cos = Math.cos(angle);
    const y = cos >= 0 ? cos * st.top : cos * st.bottom;
    points.push([Math.sin(angle) * st.rx * scale, y * scale + st.cy + offsetY, st.z]);
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
      // 机腹投弹口：挖掉腹部两片面片，由 hatch 内衬补齐
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
  const noseCenter: Vec3 = [0, nose.cy, nose.z];
  const noseRing = rings[0];
  for (let i = 0; i < HULL_SEG; i++) {
    triUV(positions, uvs, noseCenter, noseRing[i], noseRing[(i + 1) % HULL_SEG], [0.5, 0.5], [0.5, 0.5], [0.5, 0.5]);
  }

  // 尾部直接收成尖点，不再补端盖（避免贴合小片）

  return fromArrays(positions, uvs);
}

/** 壳体顶点焊接 + 平滑法线，正交视图轮廓更圆。 */
function smoothHull(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  geo.deleteAttribute('normal');
  const merged = mergeVertices(geo, 1e-4);
  merged.computeVertexNormals();
  return merged;
}

function hullHoops(): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  // 铁箍：外侧凸出船体，内侧压进壳体内，做出实体木条厚度
  const bands: Array<[number, number]> = [
    [-0.165, 1.03],
    [0.005, 1.025],
    [0.205, 1.032],
  ];
  for (const [z, scale] of bands) {
    const st = HULL.reduce((best, cur) => (Math.abs(cur.z - z) < Math.abs(best.z - z) ? cur : best));
    const outerA = section({ ...st, z: z - 0.009 }, 0, scale);
    const outerB = section({ ...st, z: z + 0.009 }, 0, scale);
    const innerA = section({ ...st, z: z - 0.009 }, 0, 0.968);
    const innerB = section({ ...st, z: z + 0.009 }, 0, 0.968);
    for (let i = 0; i < HULL_SEG; i++) {
      const j = (i + 1) % HULL_SEG;
      quadUV(positions, uvs, outerA[i], outerB[i], outerB[j], outerA[j], [0, 0], [0, 1], [1, 1], [1, 0]);
      quadUV(positions, uvs, outerA[i], outerA[j], innerA[j], innerA[i], [0, 0], [1, 0], [1, 1], [0, 1]);
      quadUV(positions, uvs, innerB[i], innerB[j], outerB[j], outerB[i], [0, 0], [1, 0], [1, 1], [0, 1]);
    }
  }
  return fromArrays(positions, uvs);
}

function stationAt(z: number): Station {
  for (let i = 0; i < HULL.length - 1; i++) {
    const a = HULL[i];
    const b = HULL[i + 1];
    if (z >= a.z && z <= b.z) {
      const t = (z - a.z) / (b.z - a.z);
      return {
        z,
        rx: a.rx + (b.rx - a.rx) * t,
        top: a.top + (b.top - a.top) * t,
        bottom: a.bottom + (b.bottom - a.bottom) * t,
        cy: a.cy + (b.cy - a.cy) * t,
      };
    }
  }
  return HULL[HULL.length - 1];
}

/** 船体表面在 (z, y) 处的半宽，用于把贴面件压在外壳上。 */
function hullXAt(z: number, y: number): number {
  const st = stationAt(z);
  const vertical = y >= st.cy ? st.top : st.bottom;
  const local = Math.abs(y - st.cy) / Math.max(vertical, 0.001);
  return st.rx * Math.sqrt(Math.max(0.02, 1 - local * local));
}

/** 甲板边缘（船体上表面）在 (z, x) 处的高度，栏杆立柱按此落地。 */
function hullTopYAt(z: number, x: number): number {
  const st = stationAt(z);
  const t = Math.min(1, Math.abs(x) / Math.max(st.rx, 0.001));
  return st.cy + st.top * Math.sqrt(Math.max(0, 1 - t * t));
}

/** 船底在 (z, x) 处的高度，雪橇撑杆按此接到壳体。 */
function hullBottomYAt(z: number, x: number): number {
  const st = stationAt(z);
  const t = Math.min(1, Math.abs(x) / Math.max(st.rx, 0.001));
  return st.cy - st.bottom * Math.sqrt(Math.max(0, 1 - t * t));
}

/** 舷侧饰条：红/蓝条纹贴着壳体走，沿 z 分站折出弧度。 */
function hullStripe(y0: number, y1: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const ks = [3, 4, 5, 6, 7, 8];
  for (const side of [-1, 1] as const) {
    for (let n = 0; n < ks.length - 1; n++) {
      const a = HULL[ks[n]];
      const b = HULL[ks[n + 1]];
      const ax0 = side * hullXAt(a.z, y0) * 1.012;
      const ax1 = side * hullXAt(a.z, y1) * 1.012;
      const bx0 = side * hullXAt(b.z, y0) * 1.012;
      const bx1 = side * hullXAt(b.z, y1) * 1.012;
      quadUV(
        positions,
        uvs,
        [ax0, y0, a.z],
        [bx0, y0, b.z],
        [bx1, y1, b.z],
        [ax1, y1, a.z],
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      );
    }
  }
  return fromArrays(positions, uvs);
}

// ---------------------------------------------------------------- cabin / details

/** 中前部半桶形木舱顶，两道铁箍。 */
function cabinRoof(parts: THREE.BufferGeometry[]): void {
  const radius = 0.096;
  const baseY = 0.098;
  const z0 = -0.095;
  const z1 = 0.11;
  const arch = (z: number, scale = 1) => {
    const pts: Vec3[] = [];
    for (let i = 0; i <= 6; i++) {
      const a = (i / 6) * Math.PI;
      pts.push([Math.cos(a) * radius * scale, baseY + Math.sin(a) * radius * scale, z]);
    }
    return pts;
  };
  const a = arch(z0);
  const b = arch(z1);
  const positions: number[] = [];
  const uvs: number[] = [];
  for (let i = 0; i < 6; i++) {
    quadUV(positions, uvs, a[i], b[i], b[i + 1], a[i + 1], [i / 6, 0], [i / 6, 1], [(i + 1) / 6, 1], [(i + 1) / 6, 0]);
  }
  parts.push(mapCell(fromArrays(positions, uvs), 'spar'));

  // 舱顶两端封板
  for (const [z, ring] of [
    [z0, a],
    [z1, b],
  ] as Array<[number, Vec3[]]>) {
    const capP: number[] = [];
    const capUv: number[] = [];
    for (let i = 0; i < 6; i++) {
      triUV(capP, capUv, [0, baseY, z], ring[i], ring[i + 1], [0.5, 0], [0, 1], [1, 1]);
    }
    parts.push(mapCell(fromArrays(capP, capUv), 'spar'));
  }

  // 铁箍
  for (const z of [-0.04, 0.06]) {
    const p0 = arch(z - 0.007, 1.035);
    const p1 = arch(z + 0.007, 1.035);
    const bp: number[] = [];
    const buv: number[] = [];
    for (let i = 0; i < 6; i++) {
      quadUV(bp, buv, p0[i], p1[i], p1[i + 1], p0[i + 1], [0, 0], [0, 1], [1, 1], [1, 0]);
    }
    parts.push(mapCell(fromArrays(bp, buv), 'iron'));
  }
}

function portholes(parts: THREE.BufferGeometry[]): void {
  for (const side of [-1, 1] as const) {
    const x = side * (hullXAt(-0.055, 0.085) * 1.01 + 0.004);
    const ring = new THREE.RingGeometry(0.0165, 0.024, 8);
    ring.rotateY(side > 0 ? Math.PI / 2 : -Math.PI / 2);
    ring.translate(x, 0.085, -0.055);
    parts.push(mapCell(ring, 'iron'));

    const glass = new THREE.CircleGeometry(0.0165, 8);
    glass.rotateY(side > 0 ? Math.PI / 2 : -Math.PI / 2);
    glass.translate(x, 0.085, -0.055);
    parts.push(mapCell(glass, 'dark'));
  }
}

/** 船首骷髅圆牌。 */
function hullBadges(parts: THREE.BufferGeometry[]): void {
  // 两舷骷髅圆牌
  for (const side of [-1, 1] as const) {
    const disc = new THREE.CircleGeometry(0.022, 8);
    disc.rotateY(side > 0 ? Math.PI / 2 : -Math.PI / 2);
    disc.translate(side * (hullXAt(-0.145, 0.05) * 1.01 + 0.003), 0.05, -0.145);
    parts.push(mapCell(disc, 'skull'));
  }
  // 右舷小盾徽
  const shield = new THREE.PlaneGeometry(0.05, 0.06);
  shield.rotateY(Math.PI / 2);
  shield.translate(hullXAt(0.03, 0.085) * 1.01 + 0.004, 0.085, 0.03);
  parts.push(mapCell(shield, 'shield'));
}

// ---------------------------------------------------------------- belly hatch

/** 投弹口：腹部挖开，仅保留一道舱门，向后下方敞开；内部机构省略。 */
function bellyHatch(parts: THREE.BufferGeometry[]): void {
  // 口沿：前后横档 + 两侧纵档，随船底斜度倾斜
  parts.push(mapCell(box(0.134, 0.008, 0.012, 0, -0.174, -0.13), 'iron'));
  parts.push(mapCell(box(0.134, 0.008, 0.012, 0, -0.199, -0.032), 'iron'));
  for (const side of [-1, 1] as const) {
    parts.push(mapCell(box(0.01, 0.008, 0.1, side * 0.066, -0.186, -0.081, 0.3), 'iron'));
  }
  // 单层舱门：铰在后沿，向前下方打开约 46°
  const door = new THREE.BoxGeometry(0.124, 0.006, 0.072);
  door.translate(0, 0, -0.036);
  door.rotateX(-0.8);
  door.translate(0, -0.176, -0.032);
  parts.push(mapCell(door, 'hull'));
}

// ---------------------------------------------------------------- skids

/** 沿 z 的矩形截面弯梁（雪橇滑板）。 */
function skidRunner(x: number): THREE.BufferGeometry {
  const profile: Array<[number, number]> = [
    [-0.055, -0.198],
    [-0.028, -0.219],
    [0.235, -0.219],
    [0.265, -0.196],
  ];
  const halfW = 0.011;
  const halfH = 0.007;
  const positions: number[] = [];
  const uvs: number[] = [];
  const ring = (z: number, y: number): Vec3[] => [
    [x + halfW, y + halfH, z],
    [x - halfW, y + halfH, z],
    [x - halfW, y - halfH, z],
    [x + halfW, y - halfH, z],
  ];
  const rings = profile.map(([z, y]) => ring(z, y));
  for (let k = 0; k < rings.length - 1; k++) {
    const a = rings[k];
    const b = rings[k + 1];
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      quadUV(positions, uvs, a[i], b[i], b[j], a[j], [0, k / 3], [0, (k + 1) / 3], [1, (k + 1) / 3], [1, k / 3]);
    }
  }
  // 两端封口
  for (const r of [rings[0], rings[rings.length - 1]]) {
    quadUV(positions, uvs, r[0], r[1], r[2], r[3], [0, 0], [1, 0], [1, 1], [0, 1]);
  }
  return fromArrays(positions, uvs);
}

function skids(parts: THREE.BufferGeometry[]): void {
  for (const side of [-1, 1] as const) {
    const x = side * 0.108;
    parts.push(mapCell(skidRunner(x), 'spar'));
    parts.push(mapCell(box(0.022, 0.006, 0.264, x, -0.2245, 0.104), 'iron'));
    parts.push(
      mapCell(
        strut([side * 0.062, hullBottomYAt(-0.012, 0.062) + 0.008, -0.012], [x, -0.206, -0.012], 0.005, 3),
        'iron',
      ),
    );
    parts.push(
      mapCell(
        strut([side * 0.062, hullBottomYAt(0.198, 0.062) + 0.008, 0.198], [x, -0.206, 0.198], 0.005, 3),
        'iron',
      ),
    );
    parts.push(
      mapCell(
        strut([side * 0.05, hullBottomYAt(0.232, 0.05) + 0.008, 0.232], [x, -0.209, 0.052], 0.0045, 3),
        'iron',
      ),
    );
  }
  parts.push(mapCell(box(0.19, 0.008, 0.008, 0, -0.203, 0.104), 'iron'));
}

// ---------------------------------------------------------------- rotor

/** 单片木质桨叶：沿 +X 伸展，3 段折出下垂弧度。 */
function rotorBlade(): THREE.BufferGeometry {
  const st: Array<{ r: number; c: number; y: number }> = [
    { r: 0.042, c: 0.024, y: 0 },
    { r: 0.225, c: 0.038, y: -0.004 },
    { r: 0.48, c: 0.034, y: -0.018 },
    { r: DIM.rotorRadius, c: 0.018, y: -0.042 },
  ];
  const t = 0.0055;
  const positions: number[] = [];
  const uvs: number[] = [];
  const top = (s: { r: number; c: number; y: number }): Vec3[] => [
    [s.r, s.y + t, -s.c],
    [s.r, s.y + t, s.c],
    [s.r, s.y - t, s.c],
    [s.r, s.y - t, -s.c],
  ];
  const rings = st.map(top);
  for (let k = 0; k < rings.length - 1; k++) {
    const a = rings[k];
    const b = rings[k + 1];
    const v0 = k / (rings.length - 1);
    const v1 = (k + 1) / (rings.length - 1);
    // 上下面
    quadUV(positions, uvs, a[0], b[0], b[1], a[1], [0, v0], [0, v1], [1, v1], [1, v0]);
    quadUV(positions, uvs, a[3], a[2], b[2], b[3], [0, v0], [1, v0], [1, v1], [0, v1]);
    // 前后缘
    quadUV(positions, uvs, a[0], a[3], b[3], b[0], [0, v0], [1, v0], [1, v1], [0, v1]);
    quadUV(positions, uvs, a[1], a[2], b[2], b[1], [0, v0], [1, v0], [1, v1], [0, v1]);
  }
  // 翼尖封口
  const tip = rings[rings.length - 1];
  quadUV(positions, uvs, tip[0], tip[1], tip[2], tip[3], [0, 0], [1, 0], [1, 1], [0, 1]);
  return fromArrays(positions, uvs);
}

function rotorBlades(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 4; i++) {
    const angle = (i * Math.PI) / 2;
    const blade = rotorBlade();
    blade.rotateX(0.1);
    blade.rotateY(angle);
    parts.push(mapCell(blade, 'spar'));

    // 根部绳绑
    const wrap = new THREE.BoxGeometry(0.05, 0.026, 0.016);
    wrap.translate(0.052, 0, 0);
    wrap.rotateY(angle);
    parts.push(mapCell(wrap, 'rope'));
  }
  return mergeAll(parts);
}

/** 桅杆、箍环、桨毂、桅帽；桨叶单独成 Mesh 以便旋转。 */
function rotorMast(parts: THREE.BufferGeometry[]): void {
  const mast = new THREE.CylinderGeometry(0.015, 0.018, 0.115, 6, 1, true);
  mast.translate(0, 0.235, DIM.rotorZ);
  parts.push(mapCell(mast, 'spar'));

  for (const y of [0.205, 0.24, 0.275]) {
    const collar = new THREE.CylinderGeometry(0.021, 0.021, 0.012, 6, 1, true);
    collar.translate(0, y, DIM.rotorZ);
    parts.push(mapCell(collar, 'iron'));
  }

  const hub = new THREE.CylinderGeometry(0.026, 0.026, 0.034, 8);
  hub.translate(0, DIM.rotorY, DIM.rotorZ);
  parts.push(mapCell(hub, 'iron'));

  const cap = new THREE.CylinderGeometry(0.001, 0.018, 0.047, 6);
  cap.translate(0, 0.3355, DIM.rotorZ);
  parts.push(mapCell(cap, 'spar'));
}

function rotorGuys(parts: THREE.BufferGeometry[]): void {
  const top: Vec3 = [0, 0.215, DIM.rotorZ];
  for (const [x, y, z] of [
    [-0.105, 0.1, -0.08],
    [0.105, 0.1, -0.08],
    [-0.09, 0.115, 0.16],
    [0.09, 0.115, 0.16],
  ] as Array<[number, number, number]>) {
    parts.push(mapCell(strut(top, [x, y, z], 0.0025, 3), 'rope'));
  }
}

// ---------------------------------------------------------------- stern

function stern(parts: THREE.BufferGeometry[]): void {
  // 尾栏杆：三对立柱 + 两道扶手，立柱落在船体上表面
  const railX = 0.06;
  for (const side of [-1, 1] as const) {
    const tops: Vec3[] = [];
    for (const z of [0.2, 0.26, 0.32]) {
      const base = hullTopYAt(z, railX);
      const bottom: Vec3 = [side * railX, base, z];
      const top: Vec3 = [side * railX, base + 0.045, z];
      tops.push(top);
      parts.push(mapCell(strut(bottom, top, 0.004, 3), 'spar'));
    }
    for (let i = 0; i < tops.length - 1; i++) {
      parts.push(mapCell(strut(tops[i], tops[i + 1], 0.004, 3), 'spar'));
    }
  }

  // 尾桅 + 横桁 + 破帆（压低于桨盘，避免大半径桨叶扫到桅顶）
  parts.push(mapCell(strut([0, 0.125, 0.345], [0, 0.26, 0.345], 0.008, 5), 'spar'));
  parts.push(mapCell(strut([-0.078, 0.24, 0.345], [0.078, 0.24, 0.345], 0.004, 4), 'spar'));
  parts.push(
    mapCell(
      quadGeometry(
        [-0.072, 0.237, 0.346],
        [0.072, 0.237, 0.346],
        [0.05, 0.135, 0.342],
        [-0.045, 0.125, 0.342],
      ),
      'canvas',
    ),
  );
  parts.push(mapCell(strut([0, 0.26, 0.345], [0, 0.095, 0.44], 0.0025, 3), 'rope'));

  // 尾梁 + 铁箍
  parts.push(mapCell(strut([0, 0.065, 0.325], [0, 0.095, 0.445], 0.01, 5), 'spar'));
  parts.push(mapCell(strut([0, 0.09, 0.425], [0, 0.095, 0.445], 0.0115, 5), 'iron'));
}

// ---------------------------------------------------------------- factory

export function createBombardier(): THREE.Group {
  const mats = materials();
  const root = new THREE.Group();
  root.name = 'bombardier';

  const bodyParts: THREE.BufferGeometry[] = [
    mapCell(smoothHull(hullShell()), 'hull'),
    mapCell(hullHoops(), 'iron'),
    mapCell(hullStripe(0.062, 0.09), 'paintRed'),
    mapCell(hullStripe(0.042, 0.062), 'paintBlue'),
  ];

  cabinRoof(bodyParts);
  portholes(bodyParts);
  bellyHatch(bodyParts);
  skids(bodyParts);
  rotorMast(bodyParts);
  rotorGuys(bodyParts);
  hullBadges(bodyParts);
  stern(bodyParts);

  const bodyMesh = new THREE.Mesh(mergeAll(bodyParts), mats.atlas);
  bodyMesh.name = 'bombardier-body';
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;
  root.add(bodyMesh);

  // 旋翼：兄弟项目遍历 propellers.children，逐个绕本地 +Y 旋转
  const propellers = new THREE.Group();
  propellers.name = 'propellers';
  propellers.position.set(0, DIM.rotorY, DIM.rotorZ);
  const main = new THREE.Group();
  main.name = 'propeller-main';
  const blades = new THREE.Mesh(rotorBlades(), mats.atlas);
  blades.name = 'bombardier-rotor';
  blades.castShadow = true;
  blades.receiveShadow = true;
  main.add(blades);
  propellers.add(main);
  root.add(propellers);

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
