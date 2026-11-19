import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * HarborDefender 海盗船 v3（低模版，参考 IMG_ship.jpeg 三视图）。
 * 契约：原点在水线面中心，龙骨 y = -0.12；船头朝本地 -Z；
 * cannon_mount → gun_rotate → muzzle 提供水平瞄准与炮口；
 * 桅顶/帆顶保持 y = 0.8775，沿用兄弟项目 barY = 0.9975。
 *
 * 性能：整船 ≤2000 tri，2 个 Mesh = 2 draw call；所有表面共用一张 512 颜色图集，
 * 粗糙度/金属度与法线各用一张 256 图集。
 */

const SEED = 20261118;

const ATLAS = 512;
const AUX_ATLAS = 256;

/** 主炮枢轴（与现役 GLB 一致）：炮口节点局部 z = -0.2。 */
const GUN_PIVOT = { x: 0, y: 0.345, z: -0.38 } as const;
const MUZZLE_Z = -0.2;

const DIM = {
  length: 1.2,
  beam: 0.47,
  keel: -0.12,
  mastTop: 0.8775,
  mastZ: -0.02,
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

function hash01(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
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

/** 从颜色图集按亮度梯度生成法线图，输出可低于源尺寸。 */
function normalFrom(albedo: HTMLCanvasElement, strength: number, outSize: number): HTMLCanvasElement {
  const src = albedo.getContext('2d')!.getImageData(0, 0, albedo.width, albedo.height).data;
  const [canvas, ctx] = makeCanvas(outSize);
  const image = ctx.createImageData(outSize, outSize);
  const scale = albedo.width / outSize;
  const lum = (x: number, y: number) => {
    const sx = Math.min(albedo.width - 1, Math.max(0, Math.round(x * scale)));
    const sy = Math.min(albedo.height - 1, Math.max(0, Math.round(y * scale)));
    const i = (sy * albedo.width + sx) * 4;
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
  sail: { x: 256, y: 0, size: 256 },
  wood: { x: 0, y: 256, size: 128 },
  iron: { x: 128, y: 256, size: 128 },
  barrel: { x: 256, y: 256, size: 64 },
  window: { x: 320, y: 256, size: 64 },
  rope: { x: 384, y: 256, size: 64 },
  bore: { x: 448, y: 256, size: 32 },
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
      const r = THREE.MathUtils.clamp(rough[0] + (rough[1] - rough[0]) * n, 0, 1);
      image.data[i] = 128;
      image.data[i + 1] = r * 255;
      image.data[i + 2] = (metal + (n - 0.5) * variation) * 255;
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
  const fiberN = makeNoise(SEED + 11);
  const grainN = makeNoise(SEED + 29);
  const stainN = makeNoise(SEED + 47);
  const image = ctx.createImageData(size, size);
  const rimage = rctx.createImageData(size, size);
  const planks = 7;
  const plankH = size / planks;
  const buttSeeds = [0.17, 0.46, 0.79];

  for (let y = 0; y < size; y++) {
    const local = y % plankH;
    const plank = Math.floor(y / plankH);
    const hp = hash01(plank + 3);
    const seam = local < 2 ? 0.34 : local < 4 ? 1.32 : 1;
    for (let x = 0; x < size; x++) {
      const fiber = fbm(fiberN, x * 0.01, y * 0.2, 3);
      const grain = fbm(grainN, x * 0.026, y * 0.07, 4);
      let l = 0.13 + 0.075 * hp + 0.075 * fiber + 0.07 * grain;
      // 板端接缝
      for (const b of buttSeeds) {
        const bx = (b + hp * 0.12) * size;
        if (Math.abs(x - bx) < 1.2) l *= 0.38;
      }
      l *= seam;
      l = Math.min(0.47, l);

      let r = l * 1.48;
      let g = l * 1.08;
      let b = l * 0.76;
      // 水线以下的青苔与盐渍（贴图底部 = 龙骨）
      const wl = THREE.MathUtils.smoothstep(y, size * 0.66, size * 0.98);
      const algae = fbm(stainN, x * 0.018, y * 0.018, 3);
      r = mix(r, 0.085 + 0.03 * algae, wl * 0.78);
      g = mix(g, 0.145 + 0.045 * algae, wl * 0.74);
      b = mix(b, 0.135 + 0.035 * algae, wl * 0.72);
      // 少量浅色擦痕
      if (hash01(x * 7 + y * 13) > 0.9975) {
        r += 0.16;
        g += 0.14;
        b += 0.11;
      }

      const i = (y * size + x) * 4;
      image.data[i] = THREE.MathUtils.clamp(r, 0, 1) * 255;
      image.data[i + 1] = THREE.MathUtils.clamp(g, 0, 1) * 255;
      image.data[i + 2] = THREE.MathUtils.clamp(b, 0, 1) * 255;
      image.data[i + 3] = 255;

      const rough = THREE.MathUtils.clamp(0.78 + 0.14 * grain - 0.22 * (seam - 1), 0.45, 0.98);
      rimage.data[i] = 128;
      rimage.data[i + 1] = rough * 255;
      rimage.data[i + 2] = 4;
      rimage.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  rctx.putImageData(rimage, 0, 0);
  return { color: albedo, rm };
}

function buildWoodCell(): CellMaps {
  const size = 128;
  const [albedo, ctx] = makeCanvas(size);
  const fiberN = makeNoise(SEED + 71);
  const grainN = makeNoise(SEED + 89);
  const image = ctx.createImageData(size, size);
  const planks = 5;
  const plankH = size / planks;

  for (let y = 0; y < size; y++) {
    const local = y % plankH;
    const hp = hash01(Math.floor(y / plankH) + 5);
    const seam = local < 1 ? 0.4 : local < 2 ? 1.25 : 1;
    for (let x = 0; x < size; x++) {
      const fiber = fbm(fiberN, x * 0.02, y * 0.16, 3);
      const grain = fbm(grainN, x * 0.05, y * 0.09, 3);
      let l = (0.16 + 0.07 * hp + 0.07 * fiber + 0.06 * grain) * seam;
      l = Math.min(0.48, l);
      const i = (y * size + x) * 4;
      image.data[i] = l * 1.5 * 255;
      image.data[i + 1] = l * 1.1 * 255;
      image.data[i + 2] = l * 0.78 * 255;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return { color: albedo, rm: solidRm(size, [0.72, 0.94], 0, 0.06, SEED + 97) };
}

function drawSkull(ctx: CanvasRenderingContext2D): void {
  ctx.save();
  ctx.translate(128, 112);
  ctx.lineCap = 'round';
  // 交叉骨
  ctx.strokeStyle = '#d7d1c2';
  ctx.lineWidth = 13;
  ctx.beginPath();
  ctx.moveTo(-50, 34);
  ctx.lineTo(50, -34);
  ctx.moveTo(-50, -34);
  ctx.lineTo(50, 34);
  ctx.stroke();
  // 骨端球头
  ctx.fillStyle = '#d7d1c2';
  for (const [x, y] of [
    [-50, 34],
    [50, -34],
    [-50, -34],
    [50, 34],
  ]) {
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fill();
  }
  // 头骨
  ctx.fillStyle = '#e0dacb';
  ctx.beginPath();
  ctx.ellipse(0, -10, 33, 37, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(-21, 18, 42, 16);
  // 下颌阴影
  ctx.fillStyle = '#b9b2a2';
  ctx.beginPath();
  ctx.ellipse(0, 22, 21, 12, 0, 0, Math.PI);
  ctx.fill();
  // 眼窝与鼻腔
  ctx.fillStyle = '#19151c';
  ctx.beginPath();
  ctx.ellipse(-14, -13, 10, 12, -0.18, 0, Math.PI * 2);
  ctx.ellipse(14, -13, 10, 12, 0.18, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(0, 3);
  ctx.lineTo(-6, 14);
  ctx.lineTo(6, 14);
  ctx.closePath();
  ctx.fill();
  // 牙缝
  ctx.strokeStyle = '#8e8778';
  ctx.lineWidth = 2;
  for (const x of [-14, -7, 0, 7, 14]) {
    ctx.beginPath();
    ctx.moveTo(x, 25);
    ctx.lineTo(x, 33);
    ctx.stroke();
  }
  // 头骨裂纹
  ctx.strokeStyle = '#a39c8c';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(-24, -30);
  ctx.lineTo(-18, -20);
  ctx.lineTo(-22, -12);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(20, -34);
  ctx.lineTo(26, -24);
  ctx.stroke();
  ctx.restore();
}

function buildSailCell(): CellMaps {
  const size = 256;
  const [albedo, ctx] = makeCanvas(size);
  ctx.fillStyle = '#171419';
  ctx.fillRect(0, 0, size, size);

  // 帆布编织与磨损
  const rnd = mulberry32(SEED + 131);
  for (let i = 0; i < 520; i++) {
    const x = rnd() * size;
    const y = rnd() * size;
    const len = 4 + rnd() * 18;
    ctx.strokeStyle = rnd() > 0.5 ? 'rgba(255,255,255,0.022)' : 'rgba(0,0,0,0.16)';
    ctx.lineWidth = 0.8 + rnd();
    ctx.beginPath();
    if (rnd() > 0.5) {
      ctx.moveTo(x, y);
      ctx.lineTo(x + len, y);
    } else {
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + len);
    }
    ctx.stroke();
  }
  // 拼帆缝线
  ctx.strokeStyle = 'rgba(120,110,100,0.16)';
  ctx.lineWidth = 1.4;
  for (const x of [64, 128, 192]) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, size);
    ctx.stroke();
  }
  for (const y of [44, 214]) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(size, y);
    ctx.stroke();
  }
  // 补丁
  ctx.fillStyle = '#221d24';
  ctx.fillRect(168, 168, 34, 30);
  ctx.strokeStyle = 'rgba(170,158,142,0.35)';
  ctx.lineWidth = 1.2;
  ctx.setLineDash([3, 4]);
  ctx.strokeRect(170.5, 170.5, 29, 25);
  ctx.setLineDash([]);

  drawSkull(ctx);

  // 破洞：alpha 直接挖空
  const hole = (cx: number, cy: number, radius: number, seed: number) => {
    const n = makeNoise(seed);
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    for (let i = 0; i <= 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const r = radius * (0.62 + 0.62 * n(Math.cos(a) * 2 + 4, Math.sin(a) * 2 + 4));
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  };
  hole(40, 66, 14, SEED + 151);
  hole(202, 116, 20, SEED + 157);
  hole(156, 44, 9, SEED + 163);
  hole(112, 240, 8, SEED + 167);
  hole(224, 206, 7, SEED + 173);

  // 边缘撕裂
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  ctx.moveTo(0, 140);
  ctx.lineTo(16, 148);
  ctx.lineTo(4, 162);
  ctx.lineTo(0, 158);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  return { color: albedo, rm: solidRm(size, [0.88, 0.97], 0, 0.03, SEED + 179) };
}

function buildIronCell(): CellMaps {
  const size = 128;
  const [albedo, ctx] = makeCanvas(size);
  const noise = makeNoise(SEED + 211);
  const scratch = makeNoise(SEED + 223);
  const image = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(noise, x * 0.06, y * 0.06, 4);
      const s = scratch(x * 0.35, y * 0.04);
      let l = 0.115 + 0.055 * n + 0.035 * s;
      if (hash01(x * 5 + y * 11) > 0.996) l += 0.1;
      const i = (y * size + x) * 4;
      image.data[i] = l * 255;
      image.data[i + 1] = l * 1.02 * 255;
      image.data[i + 2] = l * 1.08 * 255;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return { color: albedo, rm: solidRm(size, [0.42, 0.66], 0.9, 0.08, SEED + 227) };
}

function buildBarrelCell(): CellMaps {
  const size = 64;
  const [albedo, ctx] = makeCanvas(size);
  const noise = makeNoise(SEED + 241);
  const image = ctx.createImageData(size, size);
  const staves = 6;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const stave = Math.floor((x / size) * staves);
      const local = (x / size) * staves - stave;
      const seam = local < 0.06 || local > 0.94 ? 0.55 : 1;
      const n = fbm(noise, x * 0.08, y * 0.02, 3);
      let l = (0.17 + 0.09 * hash01(stave + 9) + 0.06 * n) * seam;
      const i = (y * size + x) * 4;
      image.data[i] = l * 1.55 * 255;
      image.data[i + 1] = l * 1.12 * 255;
      image.data[i + 2] = l * 0.78 * 255;
      image.data[i + 3] = 255;
    }
  }
  // 三道铁箍（必须先写回像素，否则会被 putImageData 覆盖）
  ctx.putImageData(image, 0, 0);
  ctx.fillStyle = '#2b2f33';
  for (const y of [10, 28, 48]) ctx.fillRect(0, y, size, 4);
  return { color: albedo, rm: solidRm(size, [0.62, 0.9], 0, 0.06, SEED + 251) };
}

function buildWindowCell(): CellMaps {
  const size = 64;
  const [albedo, ctx] = makeCanvas(size);
  ctx.fillStyle = '#8a6a35';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#0a1014';
  ctx.fillRect(4, 4, size - 8, size - 8);
  const grad = ctx.createLinearGradient(10, 56, 54, 8);
  grad.addColorStop(0, 'rgba(190,215,225,0.02)');
  grad.addColorStop(0.48, 'rgba(200,225,235,0.38)');
  grad.addColorStop(0.56, 'rgba(200,225,235,0.05)');
  grad.addColorStop(1, 'rgba(190,215,225,0.01)');
  ctx.fillStyle = grad;
  ctx.fillRect(4, 4, size - 8, size - 8);
  return { color: albedo, rm: solidRm(size, [0.12, 0.3], 0.4, 0.05, SEED + 263) };
}

function buildRopeCell(): CellMaps {
  const size = 64;
  const [albedo, ctx] = makeCanvas(size);
  ctx.fillStyle = '#a58c64';
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = 'rgba(62,48,30,0.38)';
  ctx.lineWidth = 2;
  for (let i = -size; i < size * 2; i += 6) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + 22, size);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(230,214,180,0.22)';
  ctx.lineWidth = 1;
  for (let i = -size; i < size * 2; i += 6) {
    ctx.beginPath();
    ctx.moveTo(i + 2, 0);
    ctx.lineTo(i + 24, size);
    ctx.stroke();
  }
  return { color: albedo, rm: solidRm(size, [0.9, 0.98], 0, 0.02, SEED + 269) };
}

function buildBoreCell(): CellMaps {
  const size = 32;
  const [albedo, ctx] = makeCanvas(size);
  ctx.fillStyle = '#050608';
  ctx.fillRect(0, 0, size, size);
  return { color: albedo, rm: solidRm(size, [0.5, 0.62], 0.35, 0.05, SEED + 293) };
}

/** 把各分格拼进三张图集：颜色 512、roughness+metalness（G/B）与法线 256。 */
function buildAtlas() {
  const [colorCanvas, colorCtx] = makeCanvas(ATLAS);
  const [rmCanvas, rmCtx] = makeCanvas(AUX_ATLAS);

  const builders: Record<CellName, () => CellMaps> = {
    hull: buildHullCell,
    sail: buildSailCell,
    wood: buildWoodCell,
    iron: buildIronCell,
    barrel: buildBarrelCell,
    window: buildWindowCell,
    rope: buildRopeCell,
    bore: buildBoreCell,
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
    normalMap: texture(normalFrom(colorCanvas, 2.2, AUX_ATLAS), false),
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
      // 帆面破洞由颜色图集的 alpha 挖空；其余分格 alpha 全为 1。
      alphaTest: 0.5,
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

function cylY(
  radiusTop: number,
  radiusBottom: number,
  height: number,
  x: number,
  y: number,
  z: number,
  segments: number,
  openEnded = false,
) {
  return transform(new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments, 1, openEnded), x, y, z);
}

function cylX(radius: number, length: number, x: number, y: number, z: number, segments: number, openEnded = false) {
  const geo = new THREE.CylinderGeometry(radius, radius, length, segments, 1, openEnded);
  geo.rotateZ(Math.PI / 2);
  return transform(geo, x, y, z);
}

function strut(a: THREE.Vector3, b: THREE.Vector3, radius: number, segments = 3): THREE.BufferGeometry {
  const geo = new THREE.CylinderGeometry(radius, radius, 1, segments, 1, true);
  const dir = new THREE.Vector3().subVectors(b, a);
  const length = dir.length();
  geo.scale(1, length, 1);
  geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize()));
  geo.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return geo;
}

function plane(w: number, h: number, x: number, y: number, z: number, ry = 0) {
  return transform(new THREE.PlaneGeometry(w, h), x, y, z, 0, ry, 0);
}

type Vec3 = [number, number, number];

function quadPush(
  positions: number[],
  uvs: number[],
  a: Vec3,
  b: Vec3,
  c: Vec3,
  d: Vec3,
  ua: [number, number][],
) {
  const push = (p: Vec3, uv: [number, number]) => {
    positions.push(p[0], p[1], p[2]);
    uvs.push(uv[0], uv[1]);
  };
  push(a, ua[0]);
  push(b, ua[1]);
  push(c, ua[2]);
  push(a, ua[0]);
  push(c, ua[2]);
  push(d, ua[3]);
}

function triPush(
  positions: number[],
  uvs: number[],
  a: Vec3,
  b: Vec3,
  c: Vec3,
  uvA: [number, number],
  uvB: [number, number],
  uvC: [number, number],
) {
  positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  uvs.push(uvA[0], uvA[1], uvB[0], uvB[1], uvC[0], uvC[1]);
}

function fromArrays(positions: number[], uvs: number[]): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  return geo;
}

/**
 * 上窄下宽的六面棱台（跳过不可见的底面）。
 * 底部矩形 x0..x1 / z0..z1 位于 y0，顶部矩形位于 y1。
 */
function prism(
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  y0: number,
  tx0: number,
  tx1: number,
  tz0: number,
  tz1: number,
  y1: number,
): THREE.BufferGeometry {
  const b: Vec3[] = [
    [x0, y0, z0],
    [x1, y0, z0],
    [x1, y0, z1],
    [x0, y0, z1],
  ];
  const t: Vec3[] = [
    [tx0, y1, tz0],
    [tx1, y1, tz0],
    [tx1, y1, tz1],
    [tx0, y1, tz1],
  ];
  const positions: number[] = [];
  const uvs: number[] = [];
  const face = (a: Vec3, bb: Vec3, c: Vec3, d: Vec3) => {
    quadPush(positions, uvs, a, bb, c, d, [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]);
  };
  face(t[0], t[3], t[2], t[1]); // 顶
  face(b[0], b[1], t[1], t[0]); // 前
  face(b[1], b[2], t[2], t[1]); // 右
  face(b[2], b[3], t[3], t[2]); // 后
  face(b[3], b[0], t[0], t[3]); // 左
  return fromArrays(positions, uvs);
}

function mergeAll(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const flat = list.map((geo) => (geo.index ? geo.toNonIndexed() : geo));
  const merged = mergeGeometries(flat);
  if (!merged) throw new Error('pirate-ship geometry merge failed');
  return merged;
}

// ---------------------------------------------------------------- hull

interface Station {
  z: number;
  halfW: number;
  keel: number;
  deck: number;
  sheer: number;
}

/** 艉 (+0.6) → 艏 (-0.6)。中段低舷、首尾抬高的轻快单桅船型。 */
const STATIONS: Station[] = [
  { z: 0.6, halfW: 0.14, keel: -0.055, deck: 0.185, sheer: 0.245 },
  { z: 0.52, halfW: 0.185, keel: -0.095, deck: 0.172, sheer: 0.228 },
  { z: 0.42, halfW: 0.215, keel: -0.115, deck: 0.158, sheer: 0.212 },
  { z: 0.28, halfW: 0.232, keel: -0.12, deck: 0.146, sheer: 0.197 },
  { z: 0.12, halfW: 0.235, keel: -0.12, deck: 0.14, sheer: 0.189 },
  { z: -0.04, halfW: 0.228, keel: -0.12, deck: 0.139, sheer: 0.19 },
  { z: -0.2, halfW: 0.208, keel: -0.115, deck: 0.145, sheer: 0.2 },
  { z: -0.34, halfW: 0.178, keel: -0.105, deck: 0.158, sheer: 0.218 },
  { z: -0.46, halfW: 0.135, keel: -0.085, deck: 0.175, sheer: 0.242 },
  { z: -0.54, halfW: 0.085, keel: -0.06, deck: 0.195, sheer: 0.265 },
  { z: -0.6, halfW: 0.025, keel: -0.015, deck: 0.22, sheer: 0.29 },
];

/** 舷墙压条上的锚点，保证绳索端点落在船体上。 */
function railPoint(z: number, side: -1 | 1): THREE.Vector3 {
  let a = STATIONS[0];
  let b = STATIONS[1];
  for (let i = 0; i < STATIONS.length - 1; i++) {
    if (z <= STATIONS[i].z && z >= STATIONS[i + 1].z) {
      a = STATIONS[i];
      b = STATIONS[i + 1];
      break;
    }
  }
  const t = THREE.MathUtils.clamp((a.z - z) / (a.z - b.z), 0, 1);
  const halfW = a.halfW + (b.halfW - a.halfW) * t;
  const sheer = a.sheer + (b.sheer - a.sheer) * t;
  return new THREE.Vector3(side * halfW * 0.925, sheer + 0.006, z);
}

/** 横剖面：右舷顶 → 龙骨中心 → 左舷顶，共 11 个点。 */
function sectionPoints(st: Station): Vec3[] {
  const h = st.deck - st.keel;
  const w = st.halfW;
  const p = (fx: number, fy: number): Vec3 => [fx * w, st.keel + fy * h, st.z];
  return [
    p(0.94, 1.0),
    p(0.985, 0.82),
    p(1.0, 0.56),
    p(0.88, 0.28),
    p(0.5, 0.06),
    p(0, 0),
    p(-0.5, 0.06),
    p(-0.88, 0.28),
    p(-1.0, 0.56),
    p(-0.985, 0.82),
    p(-0.94, 1.0),
  ];
}

function buildHullShell(): THREE.BufferGeometry {
  const rings = STATIONS.map(sectionPoints);
  const positions: number[] = [];
  const uvs: number[] = [];
  const rect = uvRect('hull');
  const uAt = (st: Station) => (0.6 - st.z) / DIM.length;
  const vAt = (st: Station, y: number) => (y - st.keel) / (st.deck - st.keel);
  const uv = (u: number, v: number): [number, number] => [
    rect.u0 + u * (rect.u1 - rect.u0),
    rect.v0 + v * (rect.v1 - rect.v0),
  ];

  for (let i = 0; i < STATIONS.length - 1; i++) {
    const a = STATIONS[i];
    const b = STATIONS[i + 1];
    const ra = rings[i];
    const rb = rings[i + 1];
    const ua = uAt(a);
    const ub = uAt(b);
    for (let k = 0; k < ra.length - 1; k++) {
      const a0 = ra[k];
      const a1 = ra[k + 1];
      const b0 = rb[k];
      const b1 = rb[k + 1];
      quadPush(positions, uvs, a0, a1, b1, b0, [
        uv(ua, vAt(a, a0[1])),
        uv(ua, vAt(a, a1[1])),
        uv(ub, vAt(b, b1[1])),
        uv(ub, vAt(b, b0[1])),
      ]);
    }
  }

  // 艏艉端面：从剖面中心做扇形封口
  for (const end of [0, STATIONS.length - 1]) {
    const st = STATIONS[end];
    const ring = rings[end];
    const centre: Vec3 = [0, (st.keel + st.deck) / 2, st.z];
    const u = uAt(st);
    for (let k = 0; k < ring.length - 1; k++) {
      const a = ring[k];
      const b = ring[k + 1];
      triPush(positions, uvs, centre, a, b, uv(u, 0.5), uv(u, vAt(st, a[1])), uv(u, vAt(st, b[1])));
    }
  }

  return fromArrays(positions, uvs);
}

function buildDeck(): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const rect = uvRect('wood');
  for (let i = 0; i < STATIONS.length - 1; i++) {
    const a = STATIONS[i];
    const b = STATIONS[i + 1];
    const ua = (0.6 - a.z) / DIM.length;
    const ub = (0.6 - b.z) / DIM.length;
    for (const side of [-1, 1]) {
      const aEdge: Vec3 = [side * a.halfW * 0.94, a.deck, a.z];
      const bEdge: Vec3 = [side * b.halfW * 0.94, b.deck, b.z];
      const aCentre: Vec3 = [0, a.deck + 0.008, a.z];
      const bCentre: Vec3 = [0, b.deck + 0.008, b.z];
      const vEdge = side > 0 ? 0.98 : 0.02;
      const vCentre = 0.5;
      quadPush(positions, uvs, aEdge, bEdge, bCentre, aCentre, [
        [rect.u0 + ua * (rect.u1 - rect.u0), rect.v0 + vEdge * (rect.v1 - rect.v0)],
        [rect.u0 + ub * (rect.u1 - rect.u0), rect.v0 + vEdge * (rect.v1 - rect.v0)],
        [rect.u0 + ub * (rect.u1 - rect.u0), rect.v0 + vCentre * (rect.v1 - rect.v0)],
        [rect.u0 + ua * (rect.u1 - rect.u0), rect.v0 + vCentre * (rect.v1 - rect.v0)],
      ]);
    }
  }
  return fromArrays(positions, uvs);
}

function buildBulwarks(): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const rect = uvRect('wood');
  const uv = (u: number, v: number): [number, number] => [
    rect.u0 + u * (rect.u1 - rect.u0),
    rect.v0 + v * (rect.v1 - rect.v0),
  ];
  for (let i = 0; i < STATIONS.length - 1; i++) {
    const a = STATIONS[i];
    const b = STATIONS[i + 1];
    const ua = (0.6 - a.z) / DIM.length;
    const ub = (0.6 - b.z) / DIM.length;
    for (const side of [-1, 1]) {
      const aBot: Vec3 = [side * a.halfW * 0.94, a.deck, a.z];
      const bBot: Vec3 = [side * b.halfW * 0.94, b.deck, b.z];
      const aTop: Vec3 = [side * a.halfW * 0.925, a.sheer, a.z];
      const bTop: Vec3 = [side * b.halfW * 0.925, b.sheer, b.z];
      // 内外两面共用一条带（材质 DoubleSide）
      quadPush(positions, uvs, aBot, bBot, bTop, aTop, [
        uv(ua, 0.02),
        uv(ub, 0.02),
        uv(ub, 0.19),
        uv(ua, 0.19),
      ]);
      // 顶缘压条
      const aOut: Vec3 = [side * a.halfW * 0.945, a.sheer + 0.002, a.z];
      const bOut: Vec3 = [side * b.halfW * 0.945, b.sheer + 0.002, b.z];
      const aIn: Vec3 = [side * a.halfW * 0.905, a.sheer + 0.006, a.z];
      const bIn: Vec3 = [side * b.halfW * 0.905, b.sheer + 0.006, b.z];
      quadPush(positions, uvs, aOut, bOut, bIn, aIn, [
        uv(ua, 0.2),
        uv(ub, 0.2),
        uv(ub, 0.26),
        uv(ua, 0.26),
      ]);
    }
  }
  return fromArrays(positions, uvs);
}

// ---------------------------------------------------------------- superstructure

function buildSuperstructure(parts: THREE.BufferGeometry[]): void {
  const add = (geo: THREE.BufferGeometry, cell: CellName) => parts.push(mapCell(geo, cell));

  // 艏楼：两段棱台贴合船体收窄
  add(prism(-0.155, 0.155, -0.58, -0.44, 0.145, -0.1, 0.1, -0.575, -0.45, 0.225), 'wood');
  add(prism(-0.16, 0.16, -0.44, -0.31, 0.145, -0.145, 0.145, -0.45, -0.33, 0.225), 'wood');

  // 艉楼 / 船长室
  add(prism(-0.2, 0.2, 0.3, 0.44, 0.142, -0.185, 0.185, 0.31, 0.44, 0.265), 'wood');
  add(prism(-0.178, 0.178, 0.44, 0.56, 0.15, -0.16, 0.16, 0.45, 0.555, 0.265), 'wood');
  add(box(0.42, 0.014, 0.28, 0, 0.272, 0.43), 'wood'); // 舱顶压板

  // 艉窗（3 扇）与舱侧窗（每侧 2 扇）
  for (const x of [-0.075, 0, 0.075]) {
    parts.push(mapCell(plane(0.042, 0.052, x, 0.208, 0.561), 'window'));
  }
  for (const side of [-1, 1]) {
    for (const z of [0.34, 0.41]) {
      parts.push(mapCell(plane(0.04, 0.046, side * 0.187, 0.207, z, side * Math.PI / 2), 'window'));
    }
  }

  // 艉楼护栏
  for (const side of [-1, 1]) {
    add(box(0.012, 0.012, 0.27, side * 0.185, 0.325, 0.43), 'wood');
    for (const z of [0.32, 0.55]) {
      add(box(0.012, 0.062, 0.012, side * 0.185, 0.294, z), 'wood');
    }
  }

  // 艏楼护栏
  for (const side of [-1, 1]) {
    add(box(0.011, 0.011, 0.15, side * 0.108, 0.276, -0.45), 'wood');
    for (const z of [-0.52, -0.38]) {
      add(box(0.011, 0.052, 0.011, side * 0.108, 0.25, z), 'wood');
    }
  }

  // 主炮固定炮座（不随机炮旋转）
  add(cylY(0.05, 0.058, 0.07, GUN_PIVOT.x, 0.26, GUN_PIVOT.z, 8), 'iron');

  // 甲板水桶
  add(cylY(0.03, 0.033, 0.075, -0.06, 0.178, 0.1, 8), 'barrel');
  add(cylY(0.028, 0.031, 0.07, 0.075, 0.175, 0.02, 8), 'barrel');

  // 舱口盖
  add(box(0.13, 0.012, 0.1, 0.01, 0.148, 0.22), 'wood');

  // 甲板上的缆绳
  const ropeA = new THREE.Vector3(-0.11, 0.152, 0.15);
  const ropeB = new THREE.Vector3(0.13, 0.152, 0.11);
  const ropeMid = new THREE.Vector3(0.015, 0.135, 0.13);
  parts.push(mapCell(strut(ropeA, ropeMid, 0.0055, 3), 'rope'));
  parts.push(mapCell(strut(ropeMid, ropeB, 0.0055, 3), 'rope'));
}

// ---------------------------------------------------------------- mast / rigging

function buildRigging(parts: THREE.BufferGeometry[]): void {
  const add = (geo: THREE.BufferGeometry, cell: CellName) => parts.push(mapCell(geo, cell));

  // 桅杆：底端落在甲板，顶端精确 0.8775
  const mastH = DIM.mastTop - 0.14;
  add(cylY(0.009, 0.014, mastH, 0, 0.14 + mastH / 2, DIM.mastZ, 6), 'wood');
  add(box(0.028, 0.018, 0.028, 0, DIM.mastTop - 0.009, DIM.mastZ), 'wood');

  // 横桁
  add(cylX(0.0055, 0.54, 0, 0.79, DIM.mastZ, 6, true), 'wood');

  // 帆：顶边贴横桁，向船头方向鼓起
  const sailW = 0.5;
  const sailH = 0.34;
  const sail = new THREE.PlaneGeometry(sailW, sailH, 8, 5);
  const pos = sail.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const u = pos.getX(i) / (sailW / 2);
    const v = pos.getY(i) / (sailH / 2);
    const belly = 0.045 * (1 - u * u) * Math.sqrt(Math.max(0, 1 - v * v));
    pos.setZ(i, -belly);
  }
  sail.computeVertexNormals();
  sail.translate(0, 0.615, DIM.mastZ - 0.015);
  parts.push(mapCell(sail, 'sail'));

  // 支索
  const head = new THREE.Vector3(0, 0.868, DIM.mastZ);
  const ropes: Array<[THREE.Vector3, THREE.Vector3]> = [
    // 两根艏支索分列帆面两侧，端点落在舷墙压条上
    [head, railPoint(-0.5, -1)],
    [head, railPoint(-0.5, 1)],
    [head, new THREE.Vector3(0, 0.282, 0.565)],
    [head, railPoint(0.02, -1)],
    [head, railPoint(0.02, 1)],
    [new THREE.Vector3(-0.268, 0.79, DIM.mastZ), railPoint(0.5, -1)],
    [new THREE.Vector3(0.268, 0.79, DIM.mastZ), railPoint(0.5, 1)],
  ];
  for (const [a, b] of ropes) add(strut(a, b, 0.0032, 3), 'rope');
}

// ---------------------------------------------------------------- bow / stern

function buildEnds(parts: THREE.BufferGeometry[]): void {
  const add = (geo: THREE.BufferGeometry, cell: CellName) => parts.push(mapCell(geo, cell));

  // 艏柱
  add(prism(-0.012, 0.012, -0.6, -0.565, -0.03, -0.009, 0.009, -0.645, -0.615, 0.315), 'wood');

  // 短艏斜桁
  add(strut(new THREE.Vector3(0, 0.21, -0.56), new THREE.Vector3(0, 0.285, -0.7), 0.0075, 6), 'wood');

  // 艉舵
  add(prism(-0.009, 0.009, 0.6, 0.648, -0.06, -0.009, 0.009, 0.615, 0.65, 0.17), 'wood');
}

// ---------------------------------------------------------------- gun

function buildGunMount(parts: THREE.BufferGeometry[]): void {
  const add = (geo: THREE.BufferGeometry, cell: CellName) => parts.push(mapCell(geo, cell));

  // 旋转炮盘
  add(cylY(0.055, 0.06, 0.012, 0, -0.045, 0, 8), 'iron');

  // 两侧炮耳夹板：后撤搭在炮盘上，前端夹住炮耳轴
  for (const side of [-1, 1]) {
    add(box(0.009, 0.07, 0.062, side * 0.034, -0.008, -0.02), 'iron');
  }

  // 炮耳轴
  add(cylX(0.008, 0.085, 0, -0.002, -0.045, 6, true), 'iron');
}

function buildGunBarrel(parts: THREE.BufferGeometry[]): void {
  const add = (geo: THREE.BufferGeometry, cell: CellName) => parts.push(mapCell(geo, cell));

  // 短粗炮身：炮口局部 z = -0.2
  const profile: Array<[number, number]> = [
    [0.0, -0.2],
    [0.03, -0.2],
    [0.034, -0.192],
    [0.028, -0.178],
    [0.024, -0.09],
    [0.028, -0.045],
    [0.026, 0.02],
    [0.032, 0.055],
    [0.0, 0.065],
  ];
  const lathe = new THREE.LatheGeometry(
    profile.map(([r, z]) => new THREE.Vector2(r, z)),
    8,
  );
  lathe.rotateX(Math.PI / 2);
  add(lathe, 'iron');

  // 炮膛
  const bore = new THREE.CircleGeometry(0.021, 8);
  bore.rotateY(Math.PI);
  bore.translate(0, 0, -0.2005);
  add(bore, 'bore');
}

// ---------------------------------------------------------------- factory

export function createPirateShip(): THREE.Group {
  const mats = materials();
  const root = new THREE.Group();
  root.name = 'pirate-ship';

  const hullParts: THREE.BufferGeometry[] = [
    buildHullShell(),
    buildDeck(),
    buildBulwarks(),
  ];
  buildSuperstructure(hullParts);
  buildRigging(hullParts);
  buildEnds(hullParts);

  const gunMountParts: THREE.BufferGeometry[] = [];
  buildGunMount(gunMountParts);
  const barrelParts: THREE.BufferGeometry[] = [];
  buildGunBarrel(barrelParts);

  const hullMesh = new THREE.Mesh(mergeAll(hullParts), mats.atlas);
  hullMesh.name = 'ship-hull';

  const mount = new THREE.Group();
  mount.name = 'cannon_mount';
  mount.position.set(GUN_PIVOT.x, GUN_PIVOT.y, GUN_PIVOT.z);

  // 炮盘/夹板随 cannon_mount 水平旋转，不随 gun_rotate 俯仰
  const gunMountMesh = new THREE.Mesh(mergeAll(gunMountParts), mats.atlas);
  gunMountMesh.name = 'gun-mount';

  const gun = new THREE.Group();
  gun.name = 'gun_rotate';

  const gunMesh = new THREE.Mesh(mergeAll(barrelParts), mats.atlas);
  gunMesh.name = 'ship-barrel';

  const muzzle = new THREE.Object3D();
  muzzle.name = 'muzzle';
  muzzle.position.set(0, 0, MUZZLE_Z);

  gun.add(gunMesh, muzzle);
  mount.add(gunMountMesh, gun);
  root.add(hullMesh, mount);

  for (const mesh of [hullMesh, gunMountMesh, gunMesh]) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  }

  root.updateMatrixWorld(true);
  const center = new THREE.Box3().setFromObject(root).getCenter(new THREE.Vector3());
  const hitCore = new THREE.Object3D();
  hitCore.name = 'hit_core';
  hitCore.position.copy(center);
  root.add(hitCore);

  return root;
}
