import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * HarborDefender 怒岛号 boss（参考 IMG_boss-islewrath.jpeg）。
 * 与海盗船、轰炸机一致：loading 阶段在代码中构建，不再固化 GLB。
 * 契约（level-wave-system 硬依赖，禁止改名）：
 *   - 根节点 boss_islewrath；船头/炮口朝本地 -Z，+Z 为后侧；
 *   - gun_t1..4 各含 gun_rotate_N / muzzle_N / hit_core_N；
 *   - laser_turret 含 gun_rotate_laser / muzzle_laser / hit_core_laser；
 *   - hit_core_hull = 整体包围盒中心。
 * 后二炮台基座高于前二（0.94 vs 0.66），后炮越顶射击不会穿过前炮台。
 *
 * 性能：约 5.8k tri，静态船体 1 Mesh + 四座炮管 + 激光炮 + 发光件 = 7 draw call；
 * 颜色 1024 图集，粗糙度+金属度与法线共用 512 图集。
 */

const SEED = 20261119;

const ATLAS = 1024;
const AUX = ATLAS >> 1;

const DIM = {
  deckY: 0.46,
  rimY: 0.6,
  hullR: 0.95,
  /** 水下锥形段在 y=0.05 处收口，深度较 v3 缩短 30%（1.16 → 0.812） */
  bottomY: -0.762,
  frontPivotY: 0.66,
  rearPivotY: 0.94,
  turretX: 0.62,
  frontZ: -0.46,
  rearZ: 0.48,
  laserPivotY: 1.32,
  laserZ: 0.05,
  laserMuzzleZ: -0.95,
  turretMuzzleZ: -0.34,
  gunScale: 0.75,
  laserScale: 0.675,
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

// ---------------------------------------------------------------- canvas

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

/** 图集分格（像素坐标，canvas 左上为原点）。改这里必须同步 uvRect。 */
const CELL = {
  iron: { x: 0, y: 0, size: 256 },
  red: { x: 256, y: 0, size: 256 },
  wood: { x: 512, y: 0, size: 256 },
  woodDark: { x: 768, y: 0, size: 128 },
  rust: { x: 896, y: 0, size: 128 },
  bone: { x: 768, y: 128, size: 128 },
  bore: { x: 896, y: 128, size: 128 },
  skull: { x: 0, y: 256, size: 256 },
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
      rimage.data[i] = 128;
      rimage.data[i + 1] = THREE.MathUtils.clamp(rough[0] + (rough[1] - rough[0]) * n, 0, 1) * 255;
      rimage.data[i + 2] = THREE.MathUtils.clamp(metal + (n - 0.5) * 0.12, 0, 1) * 255;
      rimage.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  rctx.putImageData(rimage, 0, 0);
  return { color: albedo, rm, normal: normalFrom(albedo, 1.1) };
}

/** 铁板 / 红漆装甲：竖向板缝、横缝、铆钉、锈迹，红漆另带剥落。 */
function plateCell(
  size: number,
  base: readonly [number, number, number],
  rough: readonly [number, number],
  metal: number,
  seed: number,
  painted: boolean,
): CellMaps {
  const [albedo, ctx] = makeCanvas(size);
  const [rm, rctx] = makeCanvas(size);
  const fine = makeNoise(seed);
  const blotch = makeNoise(seed + 13);
  const chipNoise = makeNoise(seed + 37);
  const image = ctx.createImageData(size, size);
  const rimage = rctx.createImageData(size, size);
  const bare: [number, number, number] = [0.16, 0.15, 0.135];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const f = fbm(fine, x * 0.06, y * 0.06, 3);
      const b = fbm(blotch, x * 0.011, y * 0.011, 3);
      const c = fbm(chipNoise, x * 0.035, y * 0.035, 2);
      const seamX = x % 64;
      const seamY = y % 128;
      let seam = 1;
      if (seamX < 3 || seamY < 3) seam = 0.4;
      else if (seamX < 5 || seamY < 5) seam = 0.72;
      const chip = painted ? THREE.MathUtils.smoothstep(c * 0.75 + b * 0.45, 0.55, 0.7) : 0;
      const k = (0.82 + 0.36 * f) * seam;
      let r = base[0] * k;
      let g = base[1] * k;
      let bl = base[2] * k;
      r += (bare[0] - r) * chip;
      g += (bare[1] - g) * chip;
      bl += (bare[2] - bl) * chip;
      const rust = painted ? Math.max(0, b - 0.58) * 1.4 : Math.max(0, b - 0.5) * 0.9;
      r = r * (1 - rust) + 0.27 * rust;
      g = g * (1 - rust) + 0.12 * rust;
      bl = bl * (1 - rust) + 0.06 * rust;

      const i = (y * size + x) * 4;
      image.data[i] = THREE.MathUtils.clamp(r, 0, 1) * 255;
      image.data[i + 1] = THREE.MathUtils.clamp(g, 0, 1) * 255;
      image.data[i + 2] = THREE.MathUtils.clamp(bl, 0, 1) * 255;
      image.data[i + 3] = 255;

      const roughness = THREE.MathUtils.clamp(
        rough[0] + (rough[1] - rough[0]) * f + chip * 0.1 + rust * 0.25 + (1 - seam) * 0.15,
        0,
        1,
      );
      const metalness = THREE.MathUtils.clamp(metal + chip * (0.92 - metal) - rust * 0.5, 0, 1);
      rimage.data[i] = 128;
      rimage.data[i + 1] = roughness * 255;
      rimage.data[i + 2] = metalness * 255;
      rimage.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  rctx.putImageData(rimage, 0, 0);

  // 铆钉：板缝两侧成排
  for (let px = 32; px < size; px += 64) {
    for (let py = 14; py < size; py += 64) {
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.beginPath();
      ctx.arc(px, py + 1.5, 2.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(190,180,160,0.35)';
      ctx.beginPath();
      ctx.arc(px - 0.6, py - 0.8, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 铆钉下方的锈水竖痕
  const rnd = mulberry32(seed + 71);
  for (let i = 0; i < 14; i++) {
    const x = 10 + rnd() * (size - 20);
    const y = 8 + rnd() * (size - 60);
    const h = 20 + rnd() * 46;
    const grad = ctx.createLinearGradient(0, y, 0, y + h);
    grad.addColorStop(0, 'rgba(58,28,12,0.5)');
    grad.addColorStop(1, 'rgba(58,28,12,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, 2 + rnd() * 2.5, h);
  }

  return { color: albedo, rm, normal: normalFrom(albedo, 1.8) };
}

function woodCell(size: number, base: readonly [number, number, number], seed: number): CellMaps {
  const [albedo, ctx] = makeCanvas(size);
  const [rm, rctx] = makeCanvas(size);
  const fiber = makeNoise(seed);
  const grain = makeNoise(seed + 17);
  const image = ctx.createImageData(size, size);
  const rimage = rctx.createImageData(size, size);
  const plank = size / 8;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const f = fbm(fiber, x * 0.008, y * 0.16, 3);
      const g = fbm(grain, x * 0.05, y * 0.03, 3);
      const local = y % plank;
      const seam = local < 2 ? 0.38 : local < 4 ? 0.78 : 1;
      const wet = Math.max(0, fbm(grain, x * 0.01, y * 0.01, 2) - 0.55) * 0.8;
      const k = (0.7 + 0.55 * f + 0.25 * g) * seam * (1 - wet * 0.35);
      const i = (y * size + x) * 4;
      image.data[i] = THREE.MathUtils.clamp(base[0] * k, 0, 1) * 255;
      image.data[i + 1] = THREE.MathUtils.clamp(base[1] * k, 0, 1) * 255;
      image.data[i + 2] = THREE.MathUtils.clamp(base[2] * k, 0, 1) * 255;
      image.data[i + 3] = 255;
      rimage.data[i] = 128;
      rimage.data[i + 1] = THREE.MathUtils.clamp(0.82 + 0.14 * g - 0.3 * (1 - seam) - wet * 0.18, 0.3, 1) * 255;
      rimage.data[i + 2] = 4;
      rimage.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  rctx.putImageData(rimage, 0, 0);
  return { color: albedo, rm, normal: normalFrom(albedo, 2.2) };
}

/** 首领骷髅徽记：铁底板 + 骨白骷髅，映射到激光炮侧前装甲的薄片。 */
function skullCell(): CellMaps {
  const size = 256;
  const [albedo, ctx] = makeCanvas(size);
  const noise = makeNoise(SEED + 401);
  const image = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(noise, x * 0.04, y * 0.04, 3);
      const k = 0.55 + 0.5 * n;
      const i = (y * size + x) * 4;
      image.data[i] = 58 * k;
      image.data[i + 1] = 50 * k;
      image.data[i + 2] = 44 * k;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);

  ctx.save();
  ctx.translate(128, 124);
  ctx.fillStyle = '#d8d1bd';
  ctx.beginPath();
  ctx.ellipse(0, -6, 56, 50, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-36, 24);
  ctx.lineTo(-30, 66);
  ctx.quadraticCurveTo(0, 82, 30, 66);
  ctx.lineTo(36, 24);
  ctx.closePath();
  ctx.fill();
  // 眼窝与鼻腔
  ctx.fillStyle = '#100c0a';
  for (const sx of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(sx * 23, -8, 18, 20, sx * 0.18, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.beginPath();
  ctx.moveTo(0, 14);
  ctx.lineTo(-9, 33);
  ctx.lineTo(9, 33);
  ctx.closePath();
  ctx.fill();
  // 牙缝
  ctx.strokeStyle = '#2a231b';
  ctx.lineWidth = 3;
  for (let i = -2; i <= 2; i++) {
    ctx.beginPath();
    ctx.moveTo(i * 10, 44);
    ctx.lineTo(i * 10, 68);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(60,48,34,0.7)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-30, -34);
  ctx.lineTo(-12, -16);
  ctx.lineTo(-20, 2);
  ctx.moveTo(34, -30);
  ctx.lineTo(18, -12);
  ctx.stroke();
  ctx.restore();

  // 污渍
  const rnd = mulberry32(SEED + 409);
  ctx.globalAlpha = 0.25;
  for (let i = 0; i < 12; i++) {
    ctx.fillStyle = rnd() > 0.5 ? '#26160d' : '#6b5c42';
    ctx.beginPath();
    ctx.arc(rnd() * size, rnd() * size, 8 + rnd() * 22, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  const [rm, rctx] = makeCanvas(size);
  const rimage = rctx.createImageData(size, size);
  const src = ctx.getImageData(0, 0, size, size).data;
  for (let i = 0; i < src.length; i += 4) {
    const lum = (src[i] * 0.299 + src[i + 1] * 0.587 + src[i + 2] * 0.114) / 255;
    const boneLike = THREE.MathUtils.smoothstep(lum, 0.38, 0.6);
    rimage.data[i] = 128;
    rimage.data[i + 1] = (0.62 + 0.16 * (1 - boneLike)) * 255;
    rimage.data[i + 2] = (0.12 + 0.68 * (1 - boneLike)) * 255;
    rimage.data[i + 3] = 255;
  }
  rctx.putImageData(rimage, 0, 0);
  return { color: albedo, rm, normal: normalFrom(albedo, 1.4) };
}

/** 把各分格拼进三张图集：颜色 1024、roughness+metalness（G/B）与法线 512。 */
function buildAtlas() {
  const [colorCanvas, colorCtx] = makeCanvas(ATLAS);
  const [rmCanvas, rmCtx] = makeCanvas(AUX);
  const [normalCanvas, normalCtx] = makeCanvas(AUX);

  const builders: Record<CellName, () => CellMaps> = {
    iron: () => plateCell(256, [0.19, 0.185, 0.175], [0.44, 0.72], 0.86, SEED + 11, false),
    red: () => plateCell(256, [0.34, 0.058, 0.045], [0.52, 0.78], 0.24, SEED + 23, true),
    wood: () => woodCell(256, [0.15, 0.112, 0.078], SEED + 41),
    woodDark: () => solidCell(128, [0.085, 0.064, 0.046], [0.76, 0.9], 0.02, 0.3, SEED + 53),
    rust: () => solidCell(128, [0.23, 0.11, 0.055], [0.82, 0.96], 0.12, 0.45, SEED + 67),
    bone: () => solidCell(128, [0.72, 0.68, 0.56], [0.6, 0.78], 0.04, 0.2, SEED + 79),
    bore: () => solidCell(128, [0.05, 0.045, 0.042], [0.46, 0.6], 0.62, 0.12, SEED + 83),
    skull: skullCell,
  };

  for (const name of Object.keys(CELL) as CellName[]) {
    const cell = CELL[name];
    const maps = builders[name]();
    colorCtx.drawImage(maps.color, cell.x, cell.y);
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

let cache: { atlas: THREE.MeshStandardMaterial; glow: THREE.MeshBasicMaterial } | null = null;

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
    glow: new THREE.MeshBasicMaterial({ color: 0xff2a16, toneMapped: false }),
  };
  return cache;
}

// ---------------------------------------------------------------- geometry helpers

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

function cylinderY(radiusTop: number, radiusBottom: number, height: number, x: number, y: number, z: number, segments: number) {
  return transform(new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments), x, y + height / 2, z);
}

function cylinderX(radius: number, length: number, x: number, y: number, z: number, segments: number) {
  const geo = new THREE.CylinderGeometry(radius, radius, length, segments, 1, true);
  geo.rotateZ(Math.PI / 2);
  geo.translate(x, y, z);
  return geo;
}

function ringFace(inner: number, outer: number, segments: number, x: number, y: number, z: number, ry: number) {
  return transform(new THREE.RingGeometry(inner, outer, segments), x, y, z, 0, ry, 0);
}

function torus(radius: number, tube: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, radial = 3, tubular = 20) {
  return transform(new THREE.TorusGeometry(radius, tube, radial, tubular), x, y, z, rx, ry, rz);
}

function lathe(points: Array<[number, number]>, segments: number): THREE.BufferGeometry {
  return new THREE.LatheGeometry(
    points.map(([r, y]) => new THREE.Vector2(Math.max(r, 0), y)),
    segments,
  );
}

function mergeAll(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const flat = list.map((geo) => (geo.index ? geo.toNonIndexed() : geo));
  const merged = mergeGeometries(flat);
  if (!merged) throw new Error('boss islewrath geometry merge failed');
  return merged;
}

/** 内向圆柱面（甲板内侧壁），负缩放后手动翻转法线。 */
function inwardCylinder(radius: number, y0: number, y1: number, segments: number) {
  const geo = new THREE.CylinderGeometry(radius, radius, y1 - y0, segments, 1, true);
  geo.scale(1, -1, 1);
  const normal = geo.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < normal.count; i++) {
    normal.setXYZ(i, -normal.getX(i), -normal.getY(i), -normal.getZ(i));
  }
  normal.needsUpdate = true;
  geo.translate(0, (y0 + y1) / 2, 0);
  return geo;
}

// ---------------------------------------------------------------- factory

export function createBossIslewrath(): THREE.Group {
  const mats = materials();
  const root = new THREE.Group();
  root.name = 'boss_islewrath';

  const staticGeo: THREE.BufferGeometry[] = [];
  const addStatic = (geo: THREE.BufferGeometry, cell: CellName) => staticGeo.push(mapCell(geo, cell));

  const { deckY, rimY, bottomY, laserPivotY } = DIM;
  const HULL_SEG = 36;

  // ---- 船体：水线以下用低面数锥形封底
  addStatic(
    lathe(
      [
        [0.06, bottomY],
        [0.45, -0.37],
        [0.8, 0.05],
        [0.94, 0.3],
      ],
      HULL_SEG,
    ),
    'iron',
  );
  addStatic(
    lathe(
      [
        [0.94, 0.3],
        [0.95, 0.42],
        [0.945, 0.52],
        [0.935, rimY],
      ],
      HULL_SEG,
    ),
    'red',
  );
  const bottomCap = new THREE.CircleGeometry(0.06, 8);
  bottomCap.rotateX(Math.PI / 2);
  addStatic(transform(bottomCap, 0, bottomY, 0), 'iron');

  // 甲板与内侧壁
  const deck = new THREE.CircleGeometry(0.932, HULL_SEG);
  deck.rotateX(-Math.PI / 2);
  addStatic(transform(deck, 0, deckY, 0), 'wood');
  addStatic(inwardCylinder(0.932, deckY, rimY, HULL_SEG), 'red');

  // 上下甲板包边
  addStatic(torus(0.945, 0.018, 0, 0.3, 0, Math.PI / 2, 0, 0, 3, 28), 'rust');
  addStatic(torus(0.938, 0.016, 0, rimY, 0, Math.PI / 2, 0, 0, 3, 28), 'rust');

  // 红漆带竖向铁肋
  const RIBS = 14;
  for (let i = 0; i < RIBS; i++) {
    const a = (i / RIBS) * Math.PI * 2 + 0.11;
    addStatic(
      box(0.055, 0.27, 0.028, Math.cos(a) * 0.943, 0.44, Math.sin(a) * 0.943, 0, Math.PI / 2 - a, 0),
      'iron',
    );
  }

  // ---- 甲板栏杆（避开四座炮台）
  const BLOCK_ANGLES = [
    Math.atan2(-0.46, -0.62),
    Math.atan2(-0.46, 0.62),
    Math.atan2(0.48, 0.6),
    Math.atan2(0.48, -0.6),
    0,
    Math.PI,
  ];
  const POSTS = 24;
  const postOk: boolean[] = [];
  const postXZ: Array<[number, number]> = [];
  for (let i = 0; i < POSTS; i++) {
    const a = (i / POSTS) * Math.PI * 2;
    const blocked = Math.sin(a) < 0 || BLOCK_ANGLES.some((t) => Math.abs(Math.atan2(Math.sin(a - t), Math.cos(a - t))) < 0.36);
    postOk.push(!blocked);
    postXZ.push([Math.cos(a) * 0.86, Math.sin(a) * 0.86]);
    if (blocked) continue;
    addStatic(box(0.022, 0.18, 0.022, Math.cos(a) * 0.86, rimY + 0.09, Math.sin(a) * 0.86), 'iron');
  }
  for (let i = 0; i < POSTS; i++) {
    const j = (i + 1) % POSTS;
    if (!postOk[i] || !postOk[j]) continue;
    const [x0, z0] = postXZ[i];
    const [x1, z1] = postXZ[j];
    const mx = (x0 + x1) / 2;
    const mz = (z0 + z1) / 2;
    const len = Math.hypot(x1 - x0, z1 - z0);
    const ry = -Math.atan2(z1 - z0, x1 - x0);
    for (const dy of [0.16, 0.09]) {
      addStatic(box(len, 0.018, 0.02, mx, rimY + dy, mz, 0, ry, 0), 'iron');
    }
  }

  // ---- 侧面舷梯
  for (const [idx, x] of [0.33, 0.45].entries()) {
    addStatic(box(0.022, 0.52, 0.022, x, 0.36, -0.856 + idx * 0.012), 'iron');
  }
  for (let i = 0; i < 5; i++) {
    addStatic(box(0.14, 0.018, 0.02, 0.39, 0.16 + i * 0.105, -0.85), 'iron');
  }

  // ---- 甲板杂物：舱盖、格栅
  addStatic(box(0.2, 0.014, 0.16, 0.1, deckY + 0.007, -0.62), 'woodDark');
  addStatic(box(0.24, 0.01, 0.18, -0.12, deckY + 0.005, 0.6), 'bore');

  // ---- 木棚与旗杆
  addStatic(box(0.26, 0.2, 0.26, -0.72, deckY + 0.1, 0.02), 'woodDark');
  addStatic(box(0.18, 0.022, 0.3, -0.79, deckY + 0.23, 0.02, 0, 0, 0.55), 'wood');
  addStatic(box(0.18, 0.022, 0.3, -0.65, deckY + 0.23, 0.02, 0, 0, -0.55), 'wood');
  addStatic(box(0.012, 0.14, 0.11, -0.588, deckY + 0.1, 0.02), 'wood');
  // ---- 中央炮塔基座：三层梯田收分，顶层缩到激光炮底座尺寸
  const TOWER = [
    { y0: deckY, y1: 0.74, r0: 0.46, r1: 0.44 },
    { y0: 0.74, y1: 0.96, r0: 0.385, r1: 0.365 },
    { y0: 0.96, y1: 1.16, r0: 0.315, r1: 0.27 },
  ];
  for (const t of TOWER) {
    addStatic(
      lathe(
        [
          [t.r0, t.y0],
          [t.r0 + 0.004, (t.y0 + t.y1) * 0.5],
          [t.r1, t.y1],
        ],
        20,
      ),
      'red',
    );
    // 每层顶沿一圈铁箍
    addStatic(torus(t.r1 + 0.003, 0.011, 0, t.y1 - 0.015, 0, Math.PI / 2, 0, 0, 3, 20), 'rust');
  }
  // 台阶顶面封板（环形，避开上层）
  for (let i = 1; i < TOWER.length; i++) {
    const lower = TOWER[i - 1];
    const ledge = new THREE.RingGeometry(TOWER[i].r0 - 0.012, lower.r1 + 0.003, 20);
    ledge.rotateX(-Math.PI / 2);
    addStatic(transform(ledge, 0, lower.y1, 0), 'iron');
  }
  const towerCap = new THREE.CircleGeometry(TOWER[2].r1, 20);
  towerCap.rotateX(-Math.PI / 2);
  addStatic(transform(towerCap, 0, TOWER[2].y1, 0), 'iron');
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 + 0.15;
    addStatic(
      box(0.05, 0.24, 0.026, Math.cos(a) * 0.449, 0.6, Math.sin(a) * 0.449, 0, Math.PI / 2 - a, 0),
      'iron',
    );
  }

  // ---- 四座炮台（基座与装甲罩静态，炮管随 gun_rotate_N 俯仰）
  const turrets = [
    { id: 1, x: -0.62, z: -0.46, pivotY: 0.66, drumTop: 0.58 },
    { id: 2, x: 0.62, z: -0.46, pivotY: 0.66, drumTop: 0.58 },
    { id: 3, x: 0.6, z: 0.48, pivotY: 0.94, drumTop: 0.86 },
    { id: 4, x: -0.6, z: 0.48, pivotY: 0.94, drumTop: 0.86 },
  ];

  const barrelProfile: Array<[number, number]> = [
    [0.052, 0.0],
    [0.058, 0.02],
    [0.052, 0.06],
    [0.058, 0.15],
    [0.072, 0.25],
    [0.085, 0.36],
    [0.07, 0.39],
    [0.0, 0.395],
  ];

  const s = DIM.gunScale;
  for (const t of turrets) {
    // 炮座鼓包
    addStatic(cylinderY(0.275 * s, 0.29 * s, t.drumTop - deckY, t.x, deckY, t.z, 16), 'iron');
    addStatic(torus(0.277 * s, 0.013, t.x, t.drumTop, t.z, Math.PI / 2, 0, 0, 3, 16), 'rust');
    // 装甲罩
    addStatic(
      transform(
        lathe(
          [
            [0.25 * s, 0.0],
            [0.255 * s, 0.055 * s],
            [0.238 * s, 0.125 * s],
            [0.19 * s, 0.18 * s],
            [0.1 * s, 0.21 * s],
            [0.0, 0.215 * s],
          ],
          16,
        ),
        t.x,
        t.drumTop,
        t.z,
      ),
      'red',
    );
    // 炮盾
    addStatic(box(0.22 * s, 0.17 * s, 0.09 * s, t.x, t.drumTop + 0.09 * s, t.z - 0.2 * s, -0.12, 0, 0), 'iron');

    const group = new THREE.Group();
    group.name = `gun_t${t.id}`;
    group.position.set(t.x, t.pivotY, t.z);

    const rotate = new THREE.Group();
    rotate.name = `gun_rotate_${t.id}`;
    rotate.scale.setScalar(s);

    const gunGeo: THREE.BufferGeometry[] = [];
    const barrel = lathe(barrelProfile, 12);
    barrel.rotateX(Math.PI / 2);
    barrel.translate(0, 0, -0.34);
    gunGeo.push(mapCell(barrel, 'iron'));
    gunGeo.push(mapCell(torus(0.062, 0.014, 0, 0, -0.336, 0, 0, 0, 3, 12), 'rust'));
    const mouth = new THREE.CircleGeometry(0.042, 12);
    mouth.rotateY(Math.PI);
    gunGeo.push(mapCell(transform(mouth, 0, 0, -0.343), 'bore'));

    const gunMesh = new THREE.Mesh(mergeAll(gunGeo), mats.atlas);
    gunMesh.name = `turret-barrel-${t.id}`;
    gunMesh.castShadow = true;
    gunMesh.receiveShadow = true;
    rotate.add(gunMesh);

    const muzzle = new THREE.Object3D();
    muzzle.name = `muzzle_${t.id}`;
    muzzle.position.set(0, 0, DIM.turretMuzzleZ);
    rotate.add(muzzle);

    const hitCore = new THREE.Object3D();
    hitCore.name = `hit_core_${t.id}`;
    hitCore.position.set(0, 0.1 * s, 0);
    group.add(hitCore);

    group.add(rotate);
    root.add(group);
  }

  // ---- 中央激光炮
  const laser = new THREE.Group();
  laser.name = 'laser_turret';
  laser.position.set(0, laserPivotY, DIM.laserZ);

  const laserRotate = new THREE.Group();
  laserRotate.name = 'gun_rotate_laser';
  laserRotate.scale.setScalar(DIM.laserScale);

  const laserGeo: THREE.BufferGeometry[] = [];
  /** 能量包沿炮轴前移，使壳体居中于炮座（炮管与 muzzle 不动） */
  const packShift = -0.2;
  const housing = lathe(
    [
      [0.03, -0.26],
      [0.16, -0.22],
      [0.24, -0.12],
      [0.285, 0.02],
      [0.29, 0.16],
      [0.25, 0.28],
      [0.17, 0.36],
      [0.0, 0.4],
    ],
    20,
  );
  housing.rotateX(Math.PI / 2);
  housing.translate(0, 0, 0.06 + packShift);
  laserGeo.push(mapCell(housing, 'red'));
  laserGeo.push(mapCell(torus(0.292, 0.018, 0, 0, 0.08 + packShift, 0, 0, 0, 3, 20), 'iron'));
  laserGeo.push(mapCell(torus(0.268, 0.016, 0, 0, 0.32 + packShift, 0, 0, 0, 3, 20), 'iron'));

  const laserBarrel = lathe(
    [
      [0.115, 0.0],
      [0.125, 0.05],
      [0.118, 0.14],
      [0.15, 0.3],
      [0.17, 0.45],
      [0.195, 0.6],
      [0.21, 0.75],
    ],
    18,
  );
  laserBarrel.rotateX(Math.PI / 2);
  // 炮管口退让 1 cm，让红芯探出（muzzle 节点位置不变）
  laserBarrel.translate(0, 0, DIM.laserMuzzleZ + 0.01);
  laserGeo.push(mapCell(laserBarrel, 'iron'));
  laserGeo.push(mapCell(torus(0.168, 0.018, 0, 0, DIM.laserMuzzleZ + 0.23, 0, 0, 0, 3, 18), 'rust'));
  laserGeo.push(mapCell(torus(0.188, 0.018, 0, 0, DIM.laserMuzzleZ + 0.45, 0, 0, 0, 3, 18), 'rust'));
  laserGeo.push(mapCell(transform(new THREE.CircleGeometry(0.21, 18), 0, 0, -0.2), 'bore'));
  // 炮口端面（填住红芯外圈，避免看穿炮管）
  const mouthFace = new THREE.RingGeometry(0.086, 0.116, 18);
  mouthFace.rotateY(Math.PI);
  laserGeo.push(mapCell(transform(mouthFace, 0, 0, DIM.laserMuzzleZ + 0.011), 'bore'));

  // 侧前装甲上的骷髅徽记
  const skull = new THREE.PlaneGeometry(0.22, 0.22);
  laserGeo.push(mapCell(transform(skull, -0.297, 0.06, 0.12 + packShift, 0, -Math.PI / 2, 0), 'skull'));

  const laserMesh = new THREE.Mesh(mergeAll(laserGeo), mats.atlas);
  laserMesh.name = 'laser-cannon';
  laserMesh.castShadow = true;
  laserMesh.receiveShadow = true;
  laserRotate.add(laserMesh);

  // 炮口红芯（Ø0.104 × 90 mm，前脸探出 1 cm）与炮口红环（替代原锈环，避免双环近共面闪烁）
  const glowGeo: THREE.BufferGeometry[] = [];
  const lens = new THREE.CylinderGeometry(0.104, 0.104, 0.09, 18);
  lens.rotateX(Math.PI / 2);
  glowGeo.push(transform(lens, 0, 0, DIM.laserMuzzleZ + 0.045));
  glowGeo.push(torus(0.126, 0.024, 0, 0, DIM.laserMuzzleZ + 0.015, 0, 0, 0, 3, 18));
  glowGeo.push(torus(0.294, 0.014, 0, 0, 0.11 + packShift, 0, 0, 0, 3, 20));
  const glowMesh = new THREE.Mesh(mergeAll(glowGeo), mats.glow);
  glowMesh.name = 'laser-core';
  laserRotate.add(glowMesh);

  const muzzleLaser = new THREE.Object3D();
  muzzleLaser.name = 'muzzle_laser';
  muzzleLaser.position.set(0, 0, DIM.laserMuzzleZ);
  laserRotate.add(muzzleLaser);

  const hitLaser = new THREE.Object3D();
  hitLaser.name = 'hit_core_laser';
  hitLaser.position.set(0, 0.06 * DIM.laserScale, 0.08 * DIM.laserScale);
  laser.add(hitLaser);
  laser.add(laserRotate);
  root.add(laser);

  // ---- 合批与包围盒
  const hullMesh = new THREE.Mesh(mergeAll(staticGeo), mats.atlas);
  hullMesh.name = 'boss-hull';
  hullMesh.castShadow = true;
  hullMesh.receiveShadow = true;
  root.add(hullMesh);

  root.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(root);
  const hitHull = new THREE.Object3D();
  hitHull.name = 'hit_core_hull';
  hitHull.position.copy(bounds.getCenter(new THREE.Vector3()));
  root.add(hitHull);

  return root;
}
