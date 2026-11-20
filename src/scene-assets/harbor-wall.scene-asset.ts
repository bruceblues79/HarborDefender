import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * HarborDefender 城防港城墙 v5（低模硬边战损，程序化 PBR）。
 * 契约：原点在墙身中心；墙顶局部 y = +0.25（放置 y = 0.55 后世界 0.8）；
 * 临海面局部 z = -0.30（世界 -1.60），陆地侧 +0.20（世界 -1.10）。单位：米。
 *
 * 墙长 3.0；临海侧垛口式护墙（垛宽 0.22 / 炮位垛口宽 0.48）。战损全部用 9 cm 网格量化，
 * 断口是硬折面而不是连续曲线；墙顶只散落少量大块碎石，不再做沙包。
 * 炮位安装面（x=±0.75/0）及其 0.23 m 半径内保持绝对水平。
 * 资产只含城墙与碎石，不含炮、基座盘与海面。
 */

const SEED = 20261118;

const DIM = {
  length: 3.0,
  height: 0.5,
  depth: 0.5,
  centerZ: -0.05,
  top: 0.25,
  merlon: { height: 0.22, depth: 0.1, centerZ: -0.25 },
  uvScale: 1.6,
} as const;

/** 垛体区间（X，中心对称）：炮位处留 0.48 宽垛口，炮位间与两端各留实体垛。 */
const MERLONS: Array<[number, number]> = [
  [-1.5, -1.28],
  [-1.21, -0.99],
  [-0.51, -0.24],
  [0.24, 0.51],
  [0.99, 1.21],
  [1.28, 1.5],
];

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
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function normalFrom(
  albedo: HTMLCanvasElement,
  strength: number,
  outSize: number = albedo.width,
): HTMLCanvasElement {
  const size = albedo.width;
  const step = Math.max(1, Math.round(size / outSize));
  const src = albedo.getContext('2d')!.getImageData(0, 0, size, size).data;
  const [canvas, ctx] = makeCanvas(outSize);
  const image = ctx.createImageData(outSize, outSize);
  const lum = (x: number, y: number) => {
    const i = ((((y % size) + size) % size) * size + (((x % size) + size) % size)) * 4;
    return (src[i] * 0.299 + src[i + 1] * 0.587 + src[i + 2] * 0.114) / 255;
  };
  for (let y = 0; y < outSize; y++) {
    const sy = y * step;
    for (let x = 0; x < outSize; x++) {
      const sx = x * step;
      const dx = (lum(sx - step, sy) - lum(sx + step, sy)) * strength;
      const dy = (lum(sx, sy - step) - lum(sx, sy + step)) * strength;
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

type Maps = { map: THREE.CanvasTexture; rm: THREE.CanvasTexture; normalMap: THREE.CanvasTexture };

function mapsFrom(albedo: HTMLCanvasElement, rm: HTMLCanvasElement, normalStrength: number): Maps {
  return {
    map: texture(albedo, true),
    rm: texture(rm, false),
    normalMap: texture(normalFrom(albedo, normalStrength, albedo.width >> 1), false),
  };
}

// ---------------------------------------------------------------- stone

/**
 * 乱石砌墙：6 × 6 抖动 Voronoi 单元，约 12% 单元并给邻居形成大石，
 * 单元间隙即灰缝；石面按到缝的距离做凹凸明暗，另有苔痕、麻点与冷暖色差。
 */
function buildStoneMaps(): Maps {
  const size = 1024;
  const cells = 6;
  const cw = size / cells;
  const half = size / 2;
  const rnd = mulberry32(SEED + 59);
  const grainNoise = makeNoise(SEED + 5);
  const stainNoise = makeNoise(SEED + 23);
  const pitNoise = makeNoise(SEED + 41);
  const grimeNoise = makeNoise(SEED + 67);
  const dripNoise = makeNoise(SEED + 89);

  type Stone = { x: number; y: number; tint: number; warm: number; moss: number; exists: boolean };
  const stones: Stone[] = [];
  for (let r = 0; r < cells; r++) {
    for (let c = 0; c < cells; c++) {
      stones.push({
        x: (c + 0.5 + (rnd() - 0.5) * 0.66) * cw,
        y: (r + 0.5 + (rnd() - 0.5) * 0.66) * cw,
        tint: 0.8 + rnd() * 0.38,
        warm: rnd(),
        moss: rnd(),
        exists: rnd() > 0.14,
      });
    }
  }

  const [albedo, ctx] = makeCanvas(size);
  // 粗糙度/金属度与法线按 512 输出，颜色保留 1024
  const auxSize = size >> 1;
  const [rm, rctx] = makeCanvas(auxSize);
  const image = ctx.createImageData(size, size);
  const rimage = rctx.createImageData(auxSize, auxSize);

  for (let y = 0; y < size; y++) {
    const cy = Math.floor(y / cw);
    for (let x = 0; x < size; x++) {
      const cx = Math.floor(x / cw);
      let d1 = Infinity;
      let d2 = Infinity;
      let best: Stone | null = null;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const s = stones[((cy + oy + cells) % cells) * cells + ((cx + ox + cells) % cells)];
          if (!s.exists) continue;
          let dx = x - s.x;
          let dy = y - s.y;
          if (dx > half) dx -= size;
          else if (dx < -half) dx += size;
          if (dy > half) dy -= size;
          else if (dy < -half) dy += size;
          const d = dx * dx + dy * dy;
          if (d < d1) {
            d2 = d1;
            d1 = d;
            best = s;
          } else if (d < d2) {
            d2 = d;
          }
        }
      }

      const gap = best ? Math.sqrt(d2) - Math.sqrt(d1) : 0;
      const isJoint = !best || gap < 8;
      const grain = fbm(grainNoise, x * 0.06, y * 0.06, 3);
      const stain = fbm(stainNoise, x * 0.012, y * 0.012, 3);
      const pit = pitNoise(x * 0.5, y * 0.5);

      let r: number;
      let g: number;
      let b: number;
      let rough: number;
      if (isJoint) {
        r = 0.185 + grain * 0.06;
        g = 0.178 + grain * 0.055;
        b = 0.162 + grain * 0.05;
        rough = 0.95;
      } else {
        const bevel = Math.min(1, gap / 22);
        const relief = 0.7 + bevel * 0.3;
        const t = best!.tint;
        r = (0.35 + grain * 0.11) * t * relief + (best!.warm - 0.5) * 0.035;
        g = (0.338 + grain * 0.1) * t * relief;
        b = (0.31 + grain * 0.09) * t * relief + (0.5 - best!.warm) * 0.03;
        if (best!.moss > 0.62 && stain > 0.58) {
          const k = Math.min(0.3, (stain - 0.58) * 1.8);
          r += (0.25 - r) * k;
          g += (0.3 - g) * k;
          b += (0.235 - b) * k;
        }
        if (pit > 0.8) {
          const k = 1 - (pit - 0.8) * 0.8;
          r *= k;
          g *= k;
          b *= k;
        }
        rough = THREE.MathUtils.clamp(0.66 + grain * 0.18 + (1 - bevel) * 0.1, 0, 1);
      }

      // 污渍：块状积垢 + 竖向流痕，避免整面太干净
      const grime = fbm(grimeNoise, x * 0.014, y * 0.014, 3);
      if (grime > 0.52) {
        const k = 1 - Math.min(0.38, (grime - 0.52) * 1.5);
        r *= k;
        g *= k * 0.97;
        b *= k * 0.9;
      }
      const drip = fbm(dripNoise, x * 0.09, y * 0.006, 2);
      if (drip > 0.6) {
        const k = 1 - Math.min(0.22, (drip - 0.6) * 1.2);
        r *= k;
        g *= k * 0.98;
        b *= k * 0.94;
      }

      const i = (y * size + x) * 4;
      image.data[i] = THREE.MathUtils.clamp(r, 0, 1) * 255;
      image.data[i + 1] = THREE.MathUtils.clamp(g, 0, 1) * 255;
      image.data[i + 2] = THREE.MathUtils.clamp(b, 0, 1) * 255;
      image.data[i + 3] = 255;

      const ri = ((y >> 1) * auxSize + (x >> 1)) * 4;
      rimage.data[ri] = 128;
      rimage.data[ri + 1] = rough * 255;
      rimage.data[ri + 2] = 0;
      rimage.data[ri + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  rctx.putImageData(rimage, 0, 0);

  return mapsFrom(albedo, rm, 3.2);
}

// ---------------------------------------------------------------- materials

let cache: THREE.MeshStandardMaterial | null = null;

function stoneMaterial(): THREE.MeshStandardMaterial {
  if (cache) return cache;
  const maps = buildStoneMaps();
  cache = new THREE.MeshStandardMaterial({
    name: 'wall-stone',
    map: maps.map,
    roughnessMap: maps.rm,
    metalnessMap: maps.rm,
    normalMap: maps.normalMap,
    color: 0xffffff,
    roughness: 1,
    metalness: 1,
  });
  return cache;
}

// ---------------------------------------------------------------- geometry

/** 按主导法线给盒体铺 UV：三轴按尺寸统一纹理密度，避免拉伸。 */
function boxUV(geo: THREE.BufferGeometry, scale: number): void {
  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  const uv = geo.getAttribute('uv');
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nrm.getX(i));
    const ny = Math.abs(nrm.getY(i));
    const nz = Math.abs(nrm.getZ(i));
    if (ny >= nx && ny >= nz) uv.setXY(i, pos.getX(i) * scale, pos.getZ(i) * scale);
    else if (nx >= nz) uv.setXY(i, pos.getZ(i) * scale, pos.getY(i) * scale);
    else uv.setXY(i, pos.getX(i) * scale, pos.getY(i) * scale);
  }
  uv.needsUpdate = true;
}

/** 离散哈希：同一坐标得到同一值（盒体棱边上的重复顶点不会裂开）。 */
function hash3(a: number, b: number, c: number): number {
  const s = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * 墙身石面与战损：位移按 9 cm 网格量化，块与块之间直接错位，形成硬折面而不是连续起伏。
 * 炮位安装面（x = ±0.75 / 0，安装盘半径 0.19）附近墙顶保持 y = +0.25；
 * 垛体压住的墙顶（z < -0.08）也不削，避免垛体悬空。
 */
function chipWallBody(geo: THREE.BufferGeometry): void {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const front = DIM.centerZ - DIM.depth * 0.36;
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i);
    let y = pos.getY(i);
    let z = pos.getZ(i);
    const cellX = Math.round(x / 0.09);
    const cellY = Math.round(y / 0.09);
    const cellZ = Math.round(z / 0.08);

    x += (hash3(cellX, cellY, cellZ) - 0.5) * 0.018;
    z += (hash3(cellZ + 5, cellX + 11, cellY + 3) - 0.5) * 0.022;

    // 临海面：三处平底凿痕，边界直接断开
    if (z < front) {
      if (Math.abs(x + 0.34) < 0.14 && Math.abs(y + 0.02) < 0.13) z += 0.05;
      else if (Math.abs(x - 0.46) < 0.1 && Math.abs(y - 0.08) < 0.1) z += 0.035;
      else if (Math.abs(x + 1.13) < 0.085 && Math.abs(y - 0.14) < 0.085) z += 0.028;
    }

    // 两端撞塌：台阶式削低，只动陆侧墙顶（垛体压住的 z < -0.08 保持水平）
    const ax = Math.abs(x);
    if (ax > 1.3 && z > 0.1) {
      const step = hash3(cellZ, cellX, 17);
      const drop = 0.04 + step * 0.055 + (ax > 1.42 ? 0.03 : 0);
      if (y > 0.2) y -= drop;
      else if (y > 0.08) y -= drop * 0.4;
    }

    // 陆侧墙顶啃口：整列顶点一起下沉，得到硬边缺口
    if (z > 0.12 && y > 0.2) {
      for (const cx of [-0.37, 0.37]) {
        if (Math.abs(x - cx) < 0.075) y -= 0.055;
      }
    }

    pos.setXYZ(i, x, y, z);
  }
  geo.computeVertexNormals();
}

/** 垛体战损：顶行按块整块削低、次行轻微错位，断口是台阶；垛底 y 不动。 */
function chipMerlon(geo: THREE.BufferGeometry, damage: number, phase: number): void {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const h = THREE.MathUtils.clamp((y - DIM.top) / DIM.merlon.height, 0, 1);
    const block = Math.floor((x + 2) / 0.032) + Math.round(phase * 3);
    const r = hash3(block, phase + 3.1, 7.7);
    let ny = y;
    if (h > 0.9) ny -= damage * (0.3 + 0.7 * r);
    else if (h > 0.55) ny -= damage * 0.3 * r;
    pos.setXYZ(
      i,
      x + (hash3(block, 5.5, 1.3) - 0.5) * 0.009 * (0.3 + h),
      ny,
      z + (hash3(block, 9.2, 4.4) - 0.5) * 0.007 * (0.3 + h),
    );
  }
  geo.computeVertexNormals();
}

function mergeAll(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const flat = list.map((geo) => (geo.index ? geo.toNonIndexed() : geo));
  const merged = mergeGeometries(flat);
  if (!merged) throw new Error('wall geometry merge failed');
  return merged;
}

/** 墙顶碎石：低模二十面体压扁、顶点错位，块头比上一版更大。 */
function rubbleGeometry(rnd: () => number): THREE.BufferGeometry {
  const geo = new THREE.IcosahedronGeometry(0.075, 0);
  geo.scale(0.9 + rnd() * 0.6, 0.5 + rnd() * 0.3, 0.8 + rnd() * 0.45);
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const cell = Math.round(rnd() * 97);
  for (let i = 0; i < pos.count; i++) {
    const px = pos.getX(i);
    const py = pos.getY(i);
    const pz = pos.getZ(i);
    pos.setXYZ(
      i,
      px + (hash3(cell, Math.round(py * 140), 3) - 0.5) * 0.016,
      py,
      pz + (hash3(cell + 7, Math.round(px * 140), 11) - 0.5) * 0.016,
    );
  }
  geo.rotateY(rnd() * Math.PI * 2);
  geo.computeVertexNormals();
  return geo;
}

// ---------------------------------------------------------------- factory

export function createHarborWall(): THREE.Group {
  const material = stoneMaterial();
  const root = new THREE.Group();
  root.name = 'wall';

  const stoneParts: THREE.BufferGeometry[] = [];

  // 墙身：低模分段盒体 + 硬边战损；后沿保持旧陆地侧 -1.10，厚 0.5
  const body = new THREE.BoxGeometry(DIM.length, DIM.height, DIM.depth, 24, 4, 2);
  body.translate(0, 0, DIM.centerZ);
  boxUV(body, DIM.uvScale);
  chipWallBody(body);
  stoneParts.push(body);

  // 垛口式护墙：6 座实体垛，炮位处留 0.48 宽垛口；垛顶按块断裂
  const merlonDamage = [0.035, 0.085, 0.022, 0.075, 0.03, 0.095];
  MERLONS.forEach(([x0, x1], index) => {
    const width = x1 - x0;
    const merlon = new THREE.BoxGeometry(width, DIM.merlon.height, DIM.merlon.depth, Math.max(6, Math.round(width * 30)), 3, 1);
    merlon.translate((x0 + x1) / 2, DIM.top + DIM.merlon.height / 2, DIM.merlon.centerZ);
    boxUV(merlon, DIM.uvScale);
    chipMerlon(merlon, merlonDamage[index], index * 1.7);
    stoneParts.push(merlon);
  });

  const rnd = mulberry32(SEED + 131);

  // 墙顶碎石：数量少、块头大，落在两端空位（避开炮位安装盘）
  const rubbleSpots: Array<[number, number]> = [
    [1.2, 0.04],
    [1.33, -0.12],
    [1.12, 0.13],
    [-1.12, -0.06],
    [-1.28, 0.1],
    [-1.38, -0.12],
  ];
  for (const [x, z] of rubbleSpots) {
    const rock = rubbleGeometry(rnd);
    boxUV(rock, DIM.uvScale);
    const box = new THREE.Box3().setFromBufferAttribute(rock.getAttribute('position') as THREE.BufferAttribute);
    rock.translate(x, DIM.top - 0.006 - box.min.y, z);
    stoneParts.push(rock);
  }

  const stoneMesh = new THREE.Mesh(mergeAll(stoneParts), material);
  stoneMesh.name = 'wall-stone';
  stoneMesh.castShadow = true;
  stoneMesh.receiveShadow = true;
  root.add(stoneMesh);

  return root;
}
