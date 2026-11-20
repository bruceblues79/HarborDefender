import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * HarborDefender 城防港加农炮 v2（低模版）。
 * 契约：根节点 rotation.y = yaw；gun_rotate.rotation.x = pitch（正值抬炮口）；
 * muzzle 在世界 -Z 方向；hit_core 可命中。单位：米。
 *
 * 性能：整车 ≤2000 tri，2 个 Mesh = 2 draw call；木/铁/青铜/黄铜/膛线共用一张 1024 图集。
 */

const SEED = 20261013;

/** 炮身半径整体系数：参考图里炮管更修长，避免短粗感。 */
const BARREL_R = 0.76;

const DIM = {
  wheelR: 0.036,
  wheelW: 0.03,
  trackX: 0.097,
  wheelZ: 0.108,
  axleY: 0.0371,
  cheekX: 0.069,
  cheekT: 0.022,
  pivotY: 0.156,
  barrelFront: -0.185,
  barrelLength: 0.295,
  trunnionZ: 0.005,
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

function normalFrom(albedo: HTMLCanvasElement, strength: number): HTMLCanvasElement {
  const size = albedo.width;
  const src = albedo.getContext('2d')!.getImageData(0, 0, size, size).data;
  const [canvas, ctx] = makeCanvas(size);
  const image = ctx.createImageData(size, size);
  const lum = (x: number, y: number) => {
    const i = ((((y % size) + size) % size) * size + (((x % size) + size) % size)) * 4;
    return (src[i] * 0.299 + src[i + 1] * 0.587 + src[i + 2] * 0.114) / 255;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (lum(x - 1, y) - lum(x + 1, y)) * strength;
      const dy = (lum(x, y - 1) - lum(x, y + 1)) * strength;
      const inv = 1 / Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      image.data[i] = (dx * inv * 0.5 + 0.5) * 255;
      image.data[i + 1] = (dy * inv * 0.5 + 0.5) * 255;
      image.data[i + 2] = (inv * 0.5 + 0.5) * 255;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

const ATLAS = 1024;
/** 粗糙度+金属度与法线用 512 图集，颜色仍为 1024。 */
const AUX_ATLAS = ATLAS >> 1;

/** 图集分格（像素坐标，canvas 左上为原点）。改这里必须同步 uvRect。 */
const CELL = {
  wood: { x: 0, y: 0, size: 512 },
  bronze: { x: 512, y: 0, size: 512 },
  iron: { x: 0, y: 512, size: 256 },
  brass: { x: 256, y: 512, size: 256 },
  bore: { x: 512, y: 512, size: 128 },
} as const;

type CellName = keyof typeof CELL;

type CellMaps = {
  color: HTMLCanvasElement;
  /** G = roughness，B = metalness，共用一张贴图 */
  rm: HTMLCanvasElement;
  normal: HTMLCanvasElement;
};

function solidCell(
  size: number,
  color: readonly [number, number, number],
  rough: readonly [number, number],
  metal: number,
  variation: number,
  seed: number,
): CellMaps {
  const [albedo, ctx] = makeCanvas(size);
  const [rm, rctx] = makeCanvas(size);
  const noise = makeNoise(seed);
  const image = ctx.createImageData(size, size);
  const rimage = rctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(noise, x * 0.045, y * 0.045, 3);
      const i = (y * size + x) * 4;
      const k = 1 + (n - 0.5) * variation;
      image.data[i] = THREE.MathUtils.clamp(color[0] * k, 0, 1) * 255;
      image.data[i + 1] = THREE.MathUtils.clamp(color[1] * k, 0, 1) * 255;
      image.data[i + 2] = THREE.MathUtils.clamp(color[2] * k, 0, 1) * 255;
      image.data[i + 3] = 255;
      const r = THREE.MathUtils.clamp(rough[0] + (rough[1] - rough[0]) * n, 0, 1);
      rimage.data[i] = 128;
      rimage.data[i + 1] = r * 255;
      rimage.data[i + 2] = metal * 255;
      rimage.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  rctx.putImageData(rimage, 0, 0);

  const [normal, nctx] = makeCanvas(size);
  nctx.fillStyle = 'rgb(128,128,255)';
  nctx.fillRect(0, 0, size, size);
  return { color: albedo, rm, normal };
}

function plankSeam(y: number, plankHeight: number): number {
  const local = ((y % plankHeight) + plankHeight) % plankHeight;
  if (local < 2.5) return 0.42;
  if (local < 4.5) return 1.25;
  return 1;
}

function buildWoodCell(): CellMaps {
  const size = 512;
  const [albedo, ctx] = makeCanvas(size);
  const [rm, rctx] = makeCanvas(size);
  const grainNoise = makeNoise(SEED + 11);
  const fiberNoise = makeNoise(SEED + 29);
  const crackNoise = makeNoise(SEED + 47);
  const image = ctx.createImageData(size, size);
  const rimage = rctx.createImageData(size, size);
  const plankHeight = size / 6;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fiber = fbm(fiberNoise, x * 0.006, y * 0.16, 3);
      const grain = fbm(grainNoise, x * 0.016, y * 0.05, 4);
      const crack = crackNoise(x * 0.09, y * 0.012);
      let l = 0.115 + 0.1 * fiber + 0.115 * grain + 0.02 * crack;
      const seam = plankSeam(y, plankHeight);
      l *= seam;
      if (l > 0.46) l = 0.46;
      const warm = 0.9 + 0.25 * fiber;
      const i = (y * size + x) * 4;
      image.data[i] = l * 255 * 1.3 * warm;
      image.data[i + 1] = l * 255 * 1.02 * warm;
      image.data[i + 2] = l * 255 * 0.8 * warm;
      image.data[i + 3] = 255;

      const r = THREE.MathUtils.clamp(0.74 + 0.18 * grain - 0.25 * (seam - 1) + 0.05 * crack, 0.4, 0.98);
      rimage.data[i] = 128;
      rimage.data[i + 1] = r * 255;
      rimage.data[i + 2] = 5;
      rimage.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  rctx.putImageData(rimage, 0, 0);

  // 板缝里的暗色霉斑与铁件渗锈
  const rnd = mulberry32(SEED + 71);
  ctx.globalAlpha = 0.18;
  for (let i = 0; i < 26; i++) {
    const x = rnd() * size;
    const y = Math.floor(rnd() * 6) * plankHeight + rnd() * plankHeight;
    const radius = 12 + rnd() * 46;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, radius);
    grad.addColorStop(0, rnd() > 0.5 ? '#1a120b' : '#5a4a34');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  }
  ctx.globalAlpha = 1;

  return { color: albedo, rm, normal: normalFrom(albedo, 2.4) };
}

function drawBarrelOrnament(ctx: CanvasRenderingContext2D, size: number, color: string, alpha: number, rough = false) {
  const bands = [0.13, 0.44, 0.74, 0.9];
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  for (const v of bands) {
    const y = (1 - v) * size;
    ctx.fillRect(0, y - 3, size, 2);
    ctx.fillRect(0, y + 3, size, 2);
    if (rough) continue;
    for (let i = 0; i < 64; i++) ctx.fillRect(i * 8 + 2, y - 9, 3.5, 5);
    for (let i = 0; i < 16; i++) {
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(i * 32 + 16, y + 13, 8, 0.3, Math.PI * 1.45);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(i * 32 + 16, y - 13, 6, Math.PI * 1.1, Math.PI * 2.3);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function buildBronzeCell(): CellMaps {
  const size = 512;
  const [albedo, ctx] = makeCanvas(size);
  const [rm, rctx] = makeCanvas(size);
  const patinaNoise = makeNoise(SEED + 101);
  const blotchNoise = makeNoise(SEED + 131);
  const pitNoise = makeNoise(SEED + 157);
  const image = ctx.createImageData(size, size);
  const rimage = rctx.createImageData(size, size);

  const bronze = [0.40, 0.30, 0.15];
  const patina = [0.16, 0.28, 0.23];
  const deep = [0.09, 0.14, 0.12];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const blotch = fbm(blotchNoise, x * 0.012, y * 0.012, 4);
      const fine = fbm(patinaNoise, x * 0.06, y * 0.06, 3);
      const pit = pitNoise(x * 0.22, y * 0.22);
      let mask = THREE.MathUtils.smoothstep(blotch * 0.7 + fine * 0.45, 0.29, 0.61);
      if (pit > 0.8) mask = Math.min(1, mask + 0.35);
      const wear = THREE.MathUtils.smoothstep(fine, 0.68, 0.95) * (1 - mask);

      let r = bronze[0] + (patina[0] - bronze[0]) * mask;
      let g = bronze[1] + (patina[1] - bronze[1]) * mask;
      let b = bronze[2] + (patina[2] - bronze[2]) * mask;
      if (mask > 0.82) {
        const k = (mask - 0.82) / 0.18;
        r += (deep[0] - r) * k * 0.7;
        g += (deep[1] - g) * k * 0.7;
        b += (deep[2] - b) * k * 0.7;
      }
      r += (0.62 - r) * wear * 0.32;
      g += (0.48 - g) * wear * 0.32;
      b += (0.22 - b) * wear * 0.32;

      const i = (y * size + x) * 4;
      image.data[i] = THREE.MathUtils.clamp(r, 0, 1) * 255;
      image.data[i + 1] = THREE.MathUtils.clamp(g, 0, 1) * 255;
      image.data[i + 2] = THREE.MathUtils.clamp(b, 0, 1) * 255;
      image.data[i + 3] = 255;

      const roughness = THREE.MathUtils.clamp(0.34 + 0.44 * mask + 0.06 * pit, 0, 1);
      const metalness = THREE.MathUtils.clamp(0.94 - 0.8 * mask, 0, 1);
      rimage.data[i] = 128;
      rimage.data[i + 1] = roughness * 255;
      rimage.data[i + 2] = metalness * 255;
      rimage.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  rctx.putImageData(rimage, 0, 0);

  drawBarrelOrnament(ctx, size, '#2a2110', 0.5);
  drawBarrelOrnament(ctx, size, '#c9a85c', 0.28);
  drawBarrelOrnament(rctx, size, '#3a3a3a', 0.55, true);

  return { color: albedo, rm, normal: normalFrom(albedo, 1.6) };
}

/** 把各分格拼进三张图集：颜色 1024、roughness+metalness（G/B）与法线 512。 */
function buildAtlas() {
  const [colorCanvas, colorCtx] = makeCanvas(ATLAS);
  const [rmCanvas, rmCtx] = makeCanvas(AUX_ATLAS);
  const [normalCanvas, normalCtx] = makeCanvas(AUX_ATLAS);

  const builders: Record<CellName, () => CellMaps> = {
    wood: buildWoodCell,
    bronze: buildBronzeCell,
    iron: () => solidCell(256, [0.15, 0.13, 0.115], [0.46, 0.62], 0.85, 0.3, SEED + 211),
    brass: () => solidCell(256, [0.61, 0.49, 0.275], [0.34, 0.5], 1, 0.16, SEED + 233),
    bore: () => solidCell(128, [0.055, 0.05, 0.045], [0.55, 0.65], 0.5, 0.12, SEED + 251),
  };

  for (const name of Object.keys(CELL) as CellName[]) {
    const cell = CELL[name];
    const maps = builders[name]();
    colorCtx.drawImage(maps.color, cell.x, cell.y);
    // 辅助图集半尺寸，分格坐标与尺寸同步减半
    rmCtx.drawImage(maps.rm, cell.x >> 1, cell.y >> 1, cell.size >> 1, cell.size >> 1);
    normalCtx.drawImage(maps.normal, cell.x >> 1, cell.y >> 1, cell.size >> 1, cell.size >> 1);
  }

  return {
    map: texture(colorCanvas, true),
    rm: texture(rmCanvas, false),
    normalMap: texture(normalCanvas, false),
  };
}

// ---------------------------------------------------------------- materials

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
    }),
  };
  return cache;
}

// ---------------------------------------------------------------- geometry helpers

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

function cylinderX(radius: number, length: number, x: number, y: number, z: number, segments: number, inward = false) {
  const geo = new THREE.CylinderGeometry(radius, radius, length, segments, 1, true);
  geo.rotateZ(Math.PI / 2);
  if (inward) {
    // 镜像翻绕序让正面朝向轴心，但 applyMatrix4 的法线是逆转置、不处理负行列式，
    // 法线仍朝外；不取反就会以背光面着色。
    geo.scale(1, -1, 1);
    const normal = geo.getAttribute('normal') as THREE.BufferAttribute;
    for (let i = 0; i < normal.count; i++) {
      normal.setXYZ(i, -normal.getX(i), -normal.getY(i), -normal.getZ(i));
    }
    normal.needsUpdate = true;
  }
  geo.translate(x, y, z);
  return geo;
}

function ringFace(inner: number, outer: number, segments: number, x: number, y: number, z: number, ry: number) {
  return transform(new THREE.RingGeometry(inner, outer, segments), x, y, z, 0, ry, 0);
}

function torusZ(radius: number, tube: number, z: number, radial = 3, tubular = 10) {
  return transform(new THREE.TorusGeometry(radius, tube, radial, tubular), 0, 0, z);
}

// ---------------------------------------------------------------- wheel

function buildWheel(cx: number, cz: number, out: THREE.BufferGeometry[]) {
  const { wheelR: R, wheelW: W, axleY: A } = DIM;
  const rimInner = R - 0.0065;
  const seg = 10;

  // 轮圈：整体铁质（外壁 + 内壁 + 两侧环面），单层结构避免共面闪烁
  out.push(mapCell(cylinderX(R, W, cx, A, cz, seg), 'iron'));
  out.push(mapCell(cylinderX(rimInner, W, cx, A, cz, seg, true), 'iron'));
  out.push(mapCell(ringFace(rimInner, R, seg, cx - W / 2, A, cz, -Math.PI / 2), 'iron'));
  out.push(mapCell(ringFace(rimInner, R, seg, cx + W / 2, A, cz, Math.PI / 2), 'iron'));

  // 轮辐
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2;
    const r = 0.0195;
    out.push(mapCell(box(0.013, 0.023, 0.008, cx, A + Math.cos(angle) * r, cz + Math.sin(angle) * r, angle), 'wood'));
  }

  // 轮毂 + 轴帽（轮圈整体木质，去掉铁皮套壳避免移动时共面闪烁）
  out.push(mapCell(cylinderX(0.0125, 0.033, cx, A, cz, 6), 'wood'));
  out.push(mapCell(cylinderX(0.0133, 0.008, cx + Math.sign(cx) * W * 0.3, A, cz, 6), 'iron'));
}

// ---------------------------------------------------------------- barrel profile

function barrelProfile(): THREE.Vector2[] {
  const raw: Array<[number, number]> = [
    [0.0455, 0.0],
    [0.0495, 0.009],
    [0.0448, 0.03],
    [0.0450, 0.09],
    [0.0470, 0.155],
    [0.0530, 0.245],
    [0.0562, 0.272],
    [0.0430, 0.288],
    [0.0240, 0.300],
    [0.0280, 0.309],
    [0.0000, 0.320],
  ];
  const scale = DIM.barrelLength / raw[raw.length - 1][1];
  return raw.map(([r, y]) => new THREE.Vector2(r * BARREL_R, y * scale));
}

function mergeAll(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const flat = list.map((geo) => (geo.index ? geo.toNonIndexed() : geo));
  const merged = mergeGeometries(flat);
  if (!merged) throw new Error('cannon geometry merge failed');
  return merged;
}

// ---------------------------------------------------------------- factory

export function createCannon(): THREE.Group {
  const mats = materials();
  const root = new THREE.Group();
  root.name = 'cannon';

  const staticGeo: THREE.BufferGeometry[] = [];
  const gunGeo: THREE.BufferGeometry[] = [];
  const addStatic = (geo: THREE.BufferGeometry, cell: CellName) => staticGeo.push(mapCell(geo, cell));
  const addGun = (geo: THREE.BufferGeometry, cell: CellName) => gunGeo.push(mapCell(geo, cell));

  const { trackX: TX, wheelZ: WZ, axleY: A, cheekX: CX, cheekT: CT, pivotY } = DIM;

  // 侧颊：前低 / 中高（炮耳座）/ 后低，形成参考图的阶梯轮廓
  const cheekSections: Array<[number, number, number]> = [
    [-0.155, -0.05, 0.122],
    [-0.05, 0.032, 0.142],
    [0.032, 0.14, 0.112],
  ];
  for (const side of [-1, 1]) {
    for (const [z0, z1, top] of cheekSections) {
      addStatic(box(CT, top - 0.05, z1 - z0, side * CX, (top + 0.05) / 2, (z0 + z1) / 2), 'wood');
    }
    // 炮耳轴承木块 + 上下铁箍
    addStatic(box(0.032, 0.058, 0.066, side * 0.084, 0.133, 0), 'wood');
    addStatic(box(0.036, 0.008, 0.07, side * 0.084, 0.160, 0), 'iron');
    addStatic(box(0.036, 0.008, 0.07, side * 0.084, 0.106, 0), 'iron');
    // 角铁包角
    addStatic(box(0.003, 0.052, 0.012, side * (CX + CT / 2 + 0.001), 0.08, 0.135), 'iron');
    addStatic(box(0.003, 0.052, 0.012, side * (CX + CT / 2 + 0.001), 0.08, -0.149), 'iron');
    // 铆钉（六边形薄片，贴面）
    for (const z of [-0.13, 0.0, 0.11]) {
      for (const y of [0.072, 0.098]) {
        addStatic(
          transform(
            new THREE.CircleGeometry(0.0044, 6),
            side * (CX + CT / 2 + 0.0012),
            y,
            z,
            0,
            side * Math.PI / 2,
            0,
          ),
          'iron',
        );
      }
    }
  }

  // 前后横梁 + 前段炮床（后段留给抬炮时的炮尾摆动空间，避免穿插）
  addStatic(box(0.156, 0.052, 0.046, 0, A, WZ), 'wood');
  addStatic(box(0.156, 0.052, 0.046, 0, A, -WZ), 'wood');
  addStatic(box(0.096, 0.03, 0.115, 0, 0.066, -0.073), 'wood');
  addStatic(box(0.07, 0.03, 0.03, 0, 0.05, -0.166), 'wood');
  addStatic(box(0.07, 0.028, 0.03, 0, 0.048, 0.15), 'wood');
  // 轴
  addStatic(cylinderX(0.012, 0.206, 0, A, WZ, 6), 'wood');
  addStatic(cylinderX(0.012, 0.206, 0, A, -WZ, 6), 'wood');
  addStatic(cylinderX(0.0078, 0.012, 0.108, A, WZ, 6), 'iron');
  addStatic(cylinderX(0.0078, 0.012, -0.108, A, WZ, 6), 'iron');
  addStatic(cylinderX(0.0078, 0.012, 0.108, A, -WZ, 6), 'iron');
  addStatic(cylinderX(0.0078, 0.012, -0.108, A, -WZ, 6), 'iron');

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      buildWheel(sx * TX, sz * WZ, staticGeo);
    }
  }

  // ---- 炮身（车削回转体）
  const gun = new THREE.Group();
  gun.name = 'gun_rotate';
  gun.position.set(0, pivotY, 0);

  const lathe = new THREE.LatheGeometry(barrelProfile(), 14);
  lathe.rotateX(Math.PI / 2);
  lathe.translate(0, 0, DIM.barrelFront);
  addGun(lathe, 'bronze');

  // 炮口端面
  addGun(ringFace(0.0265 * BARREL_R, 0.0455 * BARREL_R, 16, 0, 0, DIM.barrelFront + 0.0004, Math.PI), 'bronze');

  // 炮耳
  addGun(cylinderX(0.0115 * BARREL_R, 0.19, 0, 0, DIM.trunnionZ, 8), 'bronze');

  // 金色凸箍（参考图的高光边）
  const bands: Array<[number, number]> = [
    [-0.180, 0.0492],
    [-0.139, 0.0462],
    [-0.042, 0.0468],
    [0.057, 0.0558],
  ];
  for (const [z, r] of bands) addGun(torusZ(r * BARREL_R + 0.0014, 0.0032, z), 'brass');

  // 炮口封死：单个深色圆盘嵌在炮口，避免炮膛内筒正反面套叠
  const boreDisc = new THREE.CircleGeometry(0.0265 * BARREL_R, 16);
  boreDisc.rotateY(Math.PI);
  boreDisc.translate(0, 0, DIM.barrelFront + 0.0015);
  addGun(boreDisc, 'bore');

  const muzzle = new THREE.Object3D();
  muzzle.name = 'muzzle';
  muzzle.position.set(0, 0, DIM.barrelFront);
  gun.add(muzzle);

  const gunMesh = new THREE.Mesh(mergeAll(gunGeo), mats.atlas);
  gunMesh.name = 'cannon-barrel';
  gun.add(gunMesh);

  const carriageMesh = new THREE.Mesh(mergeAll(staticGeo), mats.atlas);
  carriageMesh.name = 'cannon-carriage';
  root.add(carriageMesh);
  root.add(gun);

  for (const mesh of [carriageMesh, gunMesh]) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  }

  root.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(root);
  const center = bounds.getCenter(new THREE.Vector3());
  const hitCore = new THREE.Object3D();
  hitCore.name = 'hit_core';
  hitCore.position.copy(center);
  root.add(hitCore);

  return root;
}
