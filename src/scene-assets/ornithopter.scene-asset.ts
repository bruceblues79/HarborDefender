import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * HarborDefender 海盗扑翼飞行器 v2（定翼滑翔机，参考 IMG_ornithopter_v2.jpeg）。
 * 与海盗船、轰炸机一致：loading 阶段在代码中构建，不再固化 GLB。
 * 契约：
 *   - 根节点名 ornithopter，船头本地 -Z，原点为飞行姿态中心；
 *   - 机头螺旋桨 propellers → propeller-main 绕本地 +Y 旋转（PROPELLER_SPIN_RAD）；
 *   - muzzle = 机腹投石口 (0, -0.176, 0.042)；
 *   - 螺旋桨盘顶 y = 0.24，健康条 barY 沿用该高度；
 *   - hit_core = 包围盒中心；
 *   - 新设计取消扑翼，不提供 wing_left / wing_right 节点。
 *
 * 性能：整机 ≤1500 tri，机身 1 Mesh + 螺旋桨 1 Mesh = 2 draw call / 1 材质；
 * 颜色 512 图集，粗糙度+金属度与法线各 256 图集。
 */

const SEED = 20261121;

const ATLAS = 512;
const AUX_ATLAS = 256;

const DIM = {
  muzzleY: -0.158,
  muzzleZ: 0.042,
  propY: 0.005,
  propZ: -0.318,
  propRadius: 0.235,
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
  canvas: { x: 384, y: 0, size: 128 },
  window: { x: 256, y: 128, size: 64 },
  gear: { x: 320, y: 128, size: 64 },
  iron: { x: 0, y: 256, size: 128 },
  brass: { x: 128, y: 256, size: 64 },
  dark: { x: 192, y: 256, size: 64 },
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

/** 脏污帆布：去掉高频织纹，只用低频云状污渍与柔和接缝，避免缩小后摩尔纹。 */
function buildCanvasCell(): CellMaps {
  const size = 128;
  const [albedo, ctx] = makeCanvas(size);
  const fadeN = makeNoise(SEED + 71);
  const grimeN = makeNoise(SEED + 79);
  const fiberN = makeNoise(SEED + 89);
  const image = ctx.createImageData(size, size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 低频褪色 + 成片污渍
      const fade = fbm(fadeN, x * 0.011, y * 0.009, 2);
      const grime = fbm(grimeN, x * 0.032, y * 0.028, 3);
      const dirt = THREE.MathUtils.smoothstep(grime, 0.36, 0.66);
      // 极弱的各向异性布丝，只提供一点手感，不形成规则纹路
      const fiber = fbm(fiberN, x * 0.22, y * 0.055, 1);

      let l = 0.555 + 0.075 * (fade - 0.5) + 0.022 * (fiber - 0.5) - 0.085 * dirt;

      // 两道位置不完全对称的软接缝，不做清晰直线
      const seam = Math.min(Math.abs(x - 64), Math.min(x, size - x));
      if (seam < 3.5) l *= 0.84 + 0.05 * (seam / 3.5);

      // 布边积灰
      const edge = Math.min(x, y, size - 1 - x, size - 1 - y);
      if (edge < 6) l *= 0.9 + 0.018 * edge;

      // 零星深污斑
      const spot = fbm(grimeN, x * 0.085 + 17, y * 0.075 + 5, 2);
      if (spot > 0.66) l *= 0.9;

      const i = (y * size + x) * 4;
      image.data[i] = THREE.MathUtils.clamp(l * 1.02 + dirt * 0.015, 0, 1) * 255;
      image.data[i + 1] = THREE.MathUtils.clamp(l * 0.965, 0, 1) * 255;
      image.data[i + 2] = THREE.MathUtils.clamp(l * 0.855 - dirt * 0.02, 0, 1) * 255;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return { color: albedo, rm: solidRm(size, [0.9, 0.98], 0, 0.02, SEED + 101) };
}

/** 舷窗 / 座舱风挡：深色玻璃 + 铜框，全部由贴图造假。 */
function buildWindowCell(): CellMaps {
  const size = 64;
  const [albedo, ctx] = makeCanvas(size);
  ctx.fillStyle = '#6a4e2c';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#8c6c3e';
  ctx.fillRect(0, 0, size, 4);
  ctx.fillRect(0, size - 4, size, 4);
  ctx.fillRect(0, 0, 4, size);
  ctx.fillRect(size - 4, 0, 4, size);
  ctx.fillStyle = '#171512';
  ctx.fillRect(4, 4, size - 8, size - 8);
  const glass = ctx.createLinearGradient(8, 8, size - 8, size - 8);
  glass.addColorStop(0, '#4e5d5b');
  glass.addColorStop(0.45, '#2a3534');
  glass.addColorStop(1, '#151a19');
  ctx.fillStyle = glass;
  ctx.fillRect(6, 6, size - 12, size - 12);
  ctx.strokeStyle = 'rgba(210, 220, 210, 0.55)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(12, 34);
  ctx.lineTo(30, 12);
  ctx.stroke();
  ctx.strokeStyle = '#3b2c1a';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(size / 2, 4);
  ctx.lineTo(size / 2, size - 4);
  ctx.stroke();
  return { color: albedo, rm: solidRm(size, [0.2, 0.34], 0.12, 0.05, SEED + 217) };
}

/** 齿轮仅用贴图表现。 */
function buildGearCell(): CellMaps {
  const size = 64;
  const [albedo, ctx] = makeCanvas(size);
  ctx.fillStyle = '#4a3720';
  ctx.fillRect(0, 0, size, size);
  const cx = 32;
  const cy = 32;
  const teeth = 10;
  ctx.fillStyle = '#8a6a3a';
  ctx.beginPath();
  for (let i = 0; i < teeth * 2; i++) {
    const a = (i / (teeth * 2)) * Math.PI * 2;
    const r = i % 2 === 0 ? 28 : 22;
    ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#3a2a16';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = '#c8a75e';
  ctx.beginPath();
  ctx.arc(cx, cy, 16, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#4a3720';
  ctx.beginPath();
  ctx.arc(cx, cy, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#6f5427';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, cy, 11.5, 0, Math.PI * 2);
  ctx.stroke();
  return { color: albedo, rm: solidRm(size, [0.35, 0.5], 1, 0.04, SEED + 229) };
}

function buildBrassCell(): CellMaps {
  const size = 64;
  const [albedo, ctx] = makeCanvas(size);
  ctx.fillStyle = '#8a6c3a';
  ctx.fillRect(0, 0, size, size);
  return { color: albedo, rm: solidRm(size, [0.33, 0.46], 1, 0.05, SEED + 251) };
}

function buildDarkCell(): CellMaps {
  const size = 64;
  const [albedo, ctx] = makeCanvas(size);
  ctx.fillStyle = '#141110';
  ctx.fillRect(0, 0, size, size);
  return { color: albedo, rm: solidRm(size, [0.8, 0.92], 0.05, 0.04, SEED + 263) };
}

function buildAtlas() {
  const [colorCanvas, colorCtx] = makeCanvas(ATLAS);
  const [rmCanvas, rmCtx] = makeCanvas(AUX_ATLAS);

  const builders: Record<CellName, () => CellMaps> = {
    hull: () => buildPlankCell(256, 0.37, [1.08, 0.82, 0.6], SEED + 3),
    spar: () => buildPlankCell(128, 0.5, [1.07, 0.87, 0.66], SEED + 41),
    canvas: buildCanvasCell,
    window: buildWindowCell,
    gear: buildGearCell,
    iron: buildIronCell,
    brass: buildBrassCell,
    dark: buildDarkCell,
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

function triGeometry(a: Vec3, b: Vec3, c: Vec3, flip = false): THREE.BufferGeometry {
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
  // 细杆两端基本被接头遮住，省掉端盖三角面
  const geo = new THREE.CylinderGeometry(radius, radius, length, segments, 1, true);
  geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize()));
  geo.translate((start.x + end.x) / 2, (start.y + end.y) / 2, (start.z + end.z) / 2);
  return geo;
}

function cylZ(radius: number, length: number, x: number, y: number, z: number, segments: number): THREE.BufferGeometry {
  const geo = new THREE.CylinderGeometry(radius, radius, length, segments, 1);
  geo.rotateX(Math.PI / 2);
  geo.translate(x, y, z);
  return geo;
}

function mergeAll(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const flat = list.map((geo) => (geo.index ? geo.toNonIndexed() : geo));
  const merged = mergeGeometries(flat);
  if (!merged) throw new Error('ornithopter geometry merge failed');
  return merged;
}

// ---------------------------------------------------------------- hull

const HULL_SEG = 12;

type Station = {
  z: number;
  rx: number;
  top: number;
  bottom: number;
  cy: number;
};

/** 船头 -Z；饱满木桶形机身，尾部收细上翘。 */
const HULL: Station[] = [
  { z: -0.3, rx: 0.011, top: 0.011, bottom: 0.012, cy: 0.005 },
  { z: -0.285, rx: 0.053, top: 0.053, bottom: 0.062, cy: 0.002 },
  { z: -0.25, rx: 0.092, top: 0.088, bottom: 0.106, cy: 0 },
  { z: -0.17, rx: 0.123, top: 0.119, bottom: 0.136, cy: 0 },
  { z: -0.06, rx: 0.139, top: 0.132, bottom: 0.151, cy: 0 },
  { z: 0.06, rx: 0.136, top: 0.134, bottom: 0.15, cy: 0.002 },
  { z: 0.16, rx: 0.125, top: 0.128, bottom: 0.136, cy: 0.004 },
  { z: 0.25, rx: 0.104, top: 0.114, bottom: 0.113, cy: 0.008 },
  { z: 0.32, rx: 0.077, top: 0.092, bottom: 0.086, cy: 0.012 },
  { z: 0.38, rx: 0.044, top: 0.066, bottom: 0.053, cy: 0.016 },
  { z: 0.42, rx: 0.012, top: 0.026, bottom: 0.018, cy: 0.02 },
];

function section(st: Station, offsetY = 0, scale = 1): Vec3[] {
  const points: Vec3[] = [];
  for (let i = 0; i < HULL_SEG; i++) {
    // 接缝放在机腹最低点，平滑后不会在背脊留下折痕
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

  const tail = HULL[count - 1];
  const tailCenter: Vec3 = [0, tail.cy, tail.z];
  const tailRing = rings[count - 1];
  for (let i = 0; i < HULL_SEG; i++) {
    triUV(positions, uvs, tailCenter, tailRing[(i + 1) % HULL_SEG], tailRing[i], [0.5, 0.5], [0.5, 0.5], [0.5, 0.5]);
  }

  return fromArrays(positions, uvs);
}

/** 壳体焊接 + 平滑法线，正交视图轮廓更圆。 */
function smoothHull(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  geo.deleteAttribute('normal');
  const merged = mergeVertices(geo, 1e-4);
  merged.computeVertexNormals();
  return merged;
}

function hullHoops(): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  // 铁箍：外侧凸出机体，内侧压进壳体内，做出实体箍条厚度
  const bands: Array<[number, number]> = [
    [-0.262, 1.06],
    [-0.005, 1.025],
    [0.185, 1.032],
  ];
  for (const [z, scale] of bands) {
    const st = HULL.reduce((best, cur) => (Math.abs(cur.z - z) < Math.abs(best.z - z) ? cur : best));
    const outerA = section({ ...st, z: z - 0.009 }, 0, scale);
    const outerB = section({ ...st, z: z + 0.009 }, 0, scale);
    const innerA = section({ ...st, z: z - 0.009 }, 0, 0.965);
    const innerB = section({ ...st, z: z + 0.009 }, 0, 0.965);
    for (let i = 0; i < HULL_SEG; i++) {
      const j = (i + 1) % HULL_SEG;
      quadUV(positions, uvs, outerA[i], outerB[i], outerB[j], outerA[j], [0, 0], [0, 1], [1, 1], [1, 0]);
      quadUV(positions, uvs, outerA[i], outerA[j], innerA[j], innerA[i], [0, 0], [1, 0], [1, 1], [0, 1]);
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

function hullXAt(z: number, y: number): number {
  const st = stationAt(z);
  const vertical = y >= st.cy ? st.top : st.bottom;
  const local = Math.abs(y - st.cy) / Math.max(vertical, 0.001);
  return st.rx * Math.sqrt(Math.max(0.02, 1 - local * local));
}

function hullTopYAt(z: number, x: number): number {
  const st = stationAt(z);
  const t = Math.min(1, Math.abs(x) / Math.max(st.rx, 0.001));
  return st.cy + st.top * Math.sqrt(Math.max(0, 1 - t * t));
}

function hullBottomYAt(z: number, x: number): number {
  const st = stationAt(z);
  const t = Math.min(1, Math.abs(x) / Math.max(st.rx, 0.001));
  return st.cy - st.bottom * Math.sqrt(Math.max(0, 1 - t * t));
}

// ---------------------------------------------------------------- windows / gears

/** 前部风挡：贴着机背曲率铺两排假窗，全部贴图。 */
function windshield(parts: THREE.BufferGeometry[]): void {
  const zs = [-0.236, -0.184];
  const xs = [-0.062, 0, 0.062];
  for (let i = 0; i < zs.length - 1; i++) {
    for (let j = 0; j < xs.length - 1; j++) {
      const p = (z: number, x: number): Vec3 => [x, hullTopYAt(z, x) + 0.004, z];
      parts.push(
        mapCell(
          quadGeometry(p(zs[i], xs[j]), p(zs[i], xs[j + 1]), p(zs[i + 1], xs[j + 1]), p(zs[i + 1], xs[j])),
          'window',
        ),
      );
    }
  }
  // 风挡前檐压条
  parts.push(mapCell(box(0.136, 0.006, 0.008, 0, hullTopYAt(-0.238, 0.05) + 0.005, -0.238), 'brass'));
}

function portholes(parts: THREE.BufferGeometry[]): void {
  for (const side of [-1, 1] as const) {
    for (const z of [-0.128, -0.018, 0.092, 0.196]) {
      const y = 0.062;
      const x = side * (hullXAt(z, y) * 1.006 + 0.002);
      const disc = new THREE.CircleGeometry(0.019, 6);
      disc.rotateY(side > 0 ? Math.PI / 2 : -Math.PI / 2);
      disc.translate(x, y, z);
      parts.push(mapCell(disc, 'window'));
    }
  }
}

/** 侧面外露齿轮（右舷）：薄圆盘 + 齿轮贴图。 */
function gears(parts: THREE.BufferGeometry[]): void {
  const defs: Array<[number, number, number]> = [
    [-0.005, 0.088, 0.034],
    [0.072, 0.1, 0.024],
  ];
  for (const [z, y, r] of defs) {
    const x = hullXAt(z, y) * 1.005 + 0.003;
    const disc = new THREE.CircleGeometry(r, 8);
    disc.rotateY(Math.PI / 2);
    disc.translate(x, y, z);
    parts.push(mapCell(disc, 'gear'));
  }
}

// ---------------------------------------------------------------- belly outlet

/** 机腹投石口：口沿铁框 + 深色内衬 + 向后下方翻开的舱门。 */
function bellyOutlet(parts: THREE.BufferGeometry[]): void {
  const z0 = 0.0;
  const z1 = 0.085;
  const y = hullBottomYAt(0.042, 0) - 0.002;

  parts.push(mapCell(box(0.112, 0.008, 0.012, 0, y, z0 - 0.002), 'iron'));
  parts.push(mapCell(box(0.112, 0.008, 0.012, 0, y, z1 + 0.002), 'iron'));
  for (const side of [-1, 1] as const) {
    parts.push(mapCell(box(0.012, 0.008, 0.09, side * 0.05, y, 0.042), 'iron'));
  }

  // 深色内衬：贴着开口，略高于框面
  const recess = quadGeometry(
    [-0.05, y + 0.002, z0],
    [0.05, y + 0.002, z0],
    [0.05, y + 0.002, z1],
    [-0.05, y + 0.002, z1],
    true,
  );
  parts.push(mapCell(recess, 'dark'));

  // 舱门：铰在后沿，向后下方翻开约 55°
  const door = new THREE.BoxGeometry(0.1, 0.006, 0.076);
  door.translate(0, 0, 0.038);
  door.rotateX(-0.95);
  door.translate(0, y - 0.001, z1);
  parts.push(mapCell(door, 'spar'));
}

// ---------------------------------------------------------------- wings

function mid(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** 单侧大展弦膜翼：木质前缘龙骨 + 翼肋 + 帆布翼面 + 翼尖灯笼。 */
function wingParts(side: 1 | -1): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  const flip = side < 0;
  const p = (x: number, y: number, z: number): Vec3 => [side * x, y, z];

  const L0 = p(0.085, 0.098, -0.145);
  const L1 = p(0.391, 0.142, -0.118);
  const L2 = p(0.697, 0.188, 0.008);
  const T0 = p(0.106, 0.094, 0.235);
  const T1 = p(0.378, 0.138, 0.176);
  const T2 = p(0.68, 0.184, 0.126);

  // 帆布翼面
  parts.push(mapCell(quadGeometry(L0, L1, T1, T0, flip), 'canvas'));
  parts.push(mapCell(quadGeometry(L1, L2, T2, T1, flip), 'canvas'));

  // 前缘龙骨两段
  parts.push(mapCell(strut(L0, L1, 0.0125, 4), 'spar'));
  parts.push(mapCell(strut(L1, L2, 0.0095, 4), 'spar'));
  // 后缘
  parts.push(mapCell(strut(T0, T1, 0.0055, 3), 'spar'));
  parts.push(mapCell(strut(T1, T2, 0.005, 3), 'spar'));
  // 翼肋
  parts.push(mapCell(strut(L1, T1, 0.005, 3), 'spar'));
  parts.push(mapCell(strut(mid(L1, L2, 0.5), mid(T1, T2, 0.5), 0.0045, 3), 'spar'));
  parts.push(mapCell(strut(L2, T2, 0.0045, 3), 'spar'));

  // 翼根短梁：接机身肩座
  const root: Vec3 = p(0.076, 0.095, -0.02);
  parts.push(mapCell(strut(root, L0, 0.009, 3), 'spar'));
  parts.push(mapCell(strut(root, T0, 0.007, 3), 'spar'));

  // 斜撑：机身肩部到翼后段
  parts.push(mapCell(strut(p(0.076, 0.052, 0.11), p(0.366, 0.13, 0.166), 0.0055, 3), 'spar'));

  return parts;
}

// ---------------------------------------------------------------- tail

/** 尾翼：水平安定面 + 单片垂尾，无桅杆、无旗。 */
function tail(parts: THREE.BufferGeometry[]): void {
  for (const side of [-1, 1] as const) {
    const rootF: Vec3 = [0, 0.055, 0.312];
    const rootB: Vec3 = [0, 0.048, 0.392];
    const tipF: Vec3 = [side * 0.2, 0.07, 0.4];
    const tipB: Vec3 = [side * 0.18, 0.064, 0.446];
    parts.push(mapCell(quadGeometry(rootF, tipF, tipB, rootB, side < 0), 'canvas'));
    parts.push(mapCell(strut(rootF, tipF, 0.0045, 3), 'spar'));
    parts.push(mapCell(strut(rootB, tipB, 0.0035, 3), 'spar'));
    parts.push(mapCell(strut(tipF, tipB, 0.0035, 3), 'spar'));
  }

  const finRoot: Vec3 = [0, 0.052, 0.33];
  const finBack: Vec3 = [0, 0.05, 0.432];
  const finTip: Vec3 = [0, 0.185, 0.432];
  parts.push(mapCell(triGeometry(finRoot, finBack, finTip), 'canvas'));
  parts.push(mapCell(strut(finRoot, finTip, 0.005, 3), 'spar'));
  parts.push(mapCell(strut(finTip, finBack, 0.005, 3), 'spar'));
}

// ---------------------------------------------------------------- propeller

/** 单片木质桨叶：沿 +X 伸展，三段折出扭转与下垂。 */
function propBlade(): THREE.BufferGeometry {
  const st: Array<{ r: number; c: number; y: number }> = [
    { r: 0.024, c: 0.026, y: 0 },
    { r: 0.12, c: 0.05, y: 0.002 },
    { r: DIM.propRadius, c: 0.03, y: 0.006 },
  ];
  const t = 0.0055;
  const positions: number[] = [];
  const uvs: number[] = [];
  const ring = (s: { r: number; c: number; y: number }): Vec3[] => [
    [s.r, s.y + t, -s.c],
    [s.r, s.y + t, s.c],
    [s.r, s.y - t, s.c],
    [s.r, s.y - t, -s.c],
  ];
  const rings = st.map(ring);
  for (let k = 0; k < rings.length - 1; k++) {
    const a = rings[k];
    const b = rings[k + 1];
    const v0 = k / (rings.length - 1);
    const v1 = (k + 1) / (rings.length - 1);
    quadUV(positions, uvs, a[0], b[0], b[1], a[1], [0, v0], [0, v1], [1, v1], [1, v0]);
    quadUV(positions, uvs, a[3], a[2], b[2], b[3], [0, v0], [1, v0], [1, v1], [0, v1]);
    quadUV(positions, uvs, a[0], a[3], b[3], b[0], [0, v0], [1, v0], [1, v1], [0, v1]);
    quadUV(positions, uvs, a[1], a[2], b[2], b[1], [0, v0], [1, v0], [1, v1], [0, v1]);
  }
  const tip = rings[rings.length - 1];
  quadUV(positions, uvs, tip[0], tip[1], tip[2], tip[3], [0, 0], [1, 0], [1, 1], [0, 1]);
  const hub = rings[0];
  quadUV(positions, uvs, hub[0], hub[1], hub[2], hub[3], [0, 0], [1, 0], [1, 1], [0, 1]);
  return fromArrays(positions, uvs);
}

/** 四叶木桨 + 桨毂 + 铜箍，整组绕本地 +Y 自转。 */
function propeller(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 4; i++) {
    const blade = propBlade();
    blade.rotateX(0.16);
    blade.rotateY((i * Math.PI) / 2);
    parts.push(mapCell(blade, 'spar'));
  }
  const hub = new THREE.CylinderGeometry(0.03, 0.03, 0.052, 8);
  parts.push(mapCell(hub, 'brass'));
  const spinner = new THREE.CylinderGeometry(0.004, 0.026, 0.05, 8);
  spinner.translate(0, 0.05, 0);
  parts.push(mapCell(spinner, 'iron'));
  const collar = new THREE.CylinderGeometry(0.032, 0.032, 0.012, 8);
  collar.translate(0, -0.03, 0);
  parts.push(mapCell(collar, 'brass'));
  return mergeAll(parts);
}

// ---------------------------------------------------------------- factory

export function createOrnithopter(): THREE.Group {
  const mats = materials();
  const root = new THREE.Group();
  root.name = 'ornithopter';

  const bodyParts: THREE.BufferGeometry[] = [
    mapCell(smoothHull(hullShell()), 'hull'),
    mapCell(hullHoops(), 'iron'),
  ];

  // 机头桨毂座
  bodyParts.push(mapCell(cylZ(0.045, 0.05, 0, DIM.propY, -0.292, 8), 'brass'));
  bodyParts.push(mapCell(cylZ(0.028, 0.02, 0, DIM.propY, -0.304, 8), 'dark'));

  // 肩座
  for (const side of [-1, 1] as const) {
    bodyParts.push(mapCell(box(0.04, 0.058, 0.128, side * 0.105, 0.095, -0.018), 'spar'));
  }

  windshield(bodyParts);
  portholes(bodyParts);
  gears(bodyParts);
  bellyOutlet(bodyParts);
  tail(bodyParts);

  for (const side of [-1, 1] as const) {
    bodyParts.push(...wingParts(side));
  }

  const bodyMesh = new THREE.Mesh(mergeAll(bodyParts), mats.atlas);
  bodyMesh.name = 'ornithopter-body';
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;
  root.add(bodyMesh);

  // 螺旋桨：propellers 的子节点绕本地 +Y 旋转；整组绕 X 转 90° 把 +Y 对到机头轴线。
  const propellers = new THREE.Group();
  propellers.name = 'propellers';
  propellers.position.set(0, DIM.propY, DIM.propZ);
  propellers.rotation.x = -Math.PI / 2;

  const main = new THREE.Group();
  main.name = 'propeller-main';
  const blades = new THREE.Mesh(propeller(), mats.atlas);
  blades.name = 'ornithopter-prop';
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
