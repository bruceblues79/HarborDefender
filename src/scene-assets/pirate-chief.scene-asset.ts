import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * HarborDefender 海盗船长头颅（boss 二阶段从激光塔顶升起）。
 * 与海盗船、轰炸机一致：loading 阶段在代码中构建，不再固化 GLB。
 * 契约（boss-chief-system 硬依赖，禁止改名）：
 *   - 根节点 pirate-chief；坐垫平面为原点 y=0，面部朝本地 -Z；
 *   - 直接子节点顺序：hit_core（头骨中心）、pirate-chief-mesh（合并网格）、hp_blood（帽顶血条挂点）。
 * 造型：机械铁骷髅 + 三角帽 + 单红眼 + 铁面口罩，红黑配色，无牙齿。
 * 性能：约 1.4k tri；静态件 1 Mesh + 发光件 1 Mesh = 2 draw call；512 图集。
 */

const SEED = 20261120;
const ATLAS = 512;

type CellRect = { x: number; y: number; size: number };

/** 图集分格（像素坐标，canvas 左上为原点）。改这里必须同步 uvInto。 */
const CELL = {
  iron: { x: 0, y: 0, size: 192 },
  red: { x: 192, y: 0, size: 192 },
  dark: { x: 384, y: 0, size: 64 },
  bone: { x: 448, y: 0, size: 64 },
  bore: { x: 384, y: 64, size: 64 },
  rust: { x: 448, y: 64, size: 64 },
} as const;

type CellName = keyof typeof CELL;

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
      const n = fbm(noise, x * 0.07, y * 0.07, 3);
      const i = (y * size + x) * 4;
      const k = 1 + (n - 0.5) * variation;
      image.data[i] = THREE.MathUtils.clamp(color[0] * k, 0, 1) * 255;
      image.data[i + 1] = THREE.MathUtils.clamp(color[1] * k, 0, 1) * 255;
      image.data[i + 2] = THREE.MathUtils.clamp(color[2] * k, 0, 1) * 255;
      image.data[i + 3] = 255;
      rimage.data[i] = 128;
      rimage.data[i + 1] = THREE.MathUtils.clamp(rough[0] + (rough[1] - rough[0]) * n, 0, 1) * 255;
      rimage.data[i + 2] = THREE.MathUtils.clamp(metal + (n - 0.5) * 0.1, 0, 1) * 255;
      rimage.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  rctx.putImageData(rimage, 0, 0);
  return { color: albedo, rm, normal: normalFrom(albedo, 1.1) };
}

/** 铁板 / 红漆装甲：板缝、铆钉、锈迹，红漆另带剥落。 */
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
  const bare: [number, number, number] = [0.15, 0.15, 0.145];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const f = fbm(fine, x * 0.07, y * 0.07, 3);
      const b = fbm(blotch, x * 0.014, y * 0.014, 3);
      const c = chipNoise(x * 0.045, y * 0.045);
      const seamX = x % 64;
      const seamY = y % 64;
      let seam = 1;
      if (seamX < 3 || seamY < 3) seam = 0.4;
      else if (seamX < 5 || seamY < 5) seam = 0.72;
      const chip = painted ? THREE.MathUtils.smoothstep(c * 0.7 + b * 0.5, 0.55, 0.72) : 0;
      const k = (0.82 + 0.36 * f) * seam;
      const rust = painted ? Math.max(0, b - 0.58) * 1.2 : Math.max(0, b - 0.52) * 0.8;
      const i = (y * size + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        let v = base[ch] * k;
        v += (bare[ch] - v) * chip;
        v = v * (1 - rust) + [0.26, 0.12, 0.06][ch] * rust;
        image.data[i + ch] = THREE.MathUtils.clamp(v, 0, 1) * 255;
      }
      image.data[i + 3] = 255;

      rimage.data[i] = 128;
      rimage.data[i + 1] =
        THREE.MathUtils.clamp(
          rough[0] + (rough[1] - rough[0]) * f + chip * 0.1 + rust * 0.25 + (1 - seam) * 0.15,
          0,
          1,
        ) * 255;
      rimage.data[i + 2] = THREE.MathUtils.clamp(metal + chip * (0.92 - metal) - rust * 0.5, 0, 1) * 255;
      rimage.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  rctx.putImageData(rimage, 0, 0);

  // 铆钉：板缝角点成排
  for (let px = 32; px < size; px += 64) {
    for (let py = 14; py < size; py += 64) {
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.beginPath();
      ctx.arc(px, py + 1.5, 2.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(190,180,160,0.32)';
      ctx.beginPath();
      ctx.arc(px - 0.6, py - 0.8, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  return { color: albedo, rm, normal: normalFrom(albedo, 1.7) };
}

// ---------------------------------------------------------------- atlas

type MaterialSet = {
  atlas: THREE.MeshStandardMaterial;
  glow: THREE.MeshBasicMaterial;
};

function buildAtlas(): MaterialSet {
  const [color, ctx] = makeCanvas(ATLAS);
  const [rm, rctx] = makeCanvas(ATLAS);
  const [normal, nctx] = makeCanvas(ATLAS);

  const maps: Record<CellName, CellMaps> = {
    iron: plateCell(192, [0.21, 0.22, 0.23], [0.4, 0.6], 0.8, SEED + 1, false),
    red: plateCell(192, [0.5, 0.11, 0.08], [0.4, 0.6], 0.5, SEED + 2, true),
    dark: solidCell(64, [0.1, 0.11, 0.12], [0.45, 0.65], 0.75, 0.3, SEED + 3),
    bone: solidCell(64, [0.6, 0.56, 0.47], [0.5, 0.7], 0.15, 0.35, SEED + 4),
    bore: solidCell(64, [0.02, 0.02, 0.025], [0.55, 0.78], 0.2, 0.2, SEED + 5),
    rust: solidCell(64, [0.28, 0.14, 0.08], [0.6, 0.85], 0.55, 0.45, SEED + 6),
  };

  for (const name of Object.keys(CELL) as CellName[]) {
    const cell = CELL[name];
    const src = maps[name];
    ctx.drawImage(src.color, cell.x, cell.y);
    rctx.drawImage(src.rm, cell.x, cell.y);
    nctx.drawImage(src.normal, cell.x, cell.y);
  }

  return {
    atlas: new THREE.MeshStandardMaterial({
      map: texture(color, true),
      roughnessMap: texture(rm, false),
      metalnessMap: texture(rm, false),
      normalMap: texture(normal, false),
      color: 0xffffff,
      roughness: 1,
      metalness: 1,
    }),
    glow: new THREE.MeshBasicMaterial({ color: 0xff2a16, toneMapped: false }),
  };
}

let materialCache: MaterialSet | null = null;

function materials(): MaterialSet {
  if (!materialCache) materialCache = buildAtlas();
  return materialCache;
}

// ---------------------------------------------------------------- geometry

/** 把 0..1 的 UV 映射进图集分格（内缩 2 px 防溢色）。 */
function uvInto(geo: THREE.BufferGeometry, cell: CellRect): THREE.BufferGeometry {
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  const u0 = (cell.x + 2) / ATLAS;
  const u1 = (cell.x + cell.size - 2) / ATLAS;
  const v1 = 1 - (cell.y + 2) / ATLAS;
  const v0 = 1 - (cell.y + cell.size - 2) / ATLAS;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
  }
  uv.needsUpdate = true;
  return geo;
}

function box(w: number, h: number, d: number, cell: CellRect): THREE.BufferGeometry {
  return uvInto(new THREE.BoxGeometry(w, h, d), cell);
}

function cylinderY(
  rTop: number,
  rBottom: number,
  h: number,
  x: number,
  y: number,
  z: number,
  seg: number,
  cell: CellRect,
): THREE.BufferGeometry {
  const geo = new THREE.CylinderGeometry(rTop, rBottom, h, seg);
  geo.translate(x, y, z);
  return uvInto(geo, cell);
}

/** 轴向为 Z 的圆柱（眼睛、圆盘）。 */
function cylinderZ(r: number, h: number, x: number, y: number, z: number, seg: number, cell: CellRect): THREE.BufferGeometry {
  const geo = new THREE.CylinderGeometry(r, r, h, seg);
  geo.rotateX(Math.PI / 2);
  geo.translate(x, y, z);
  return uvInto(geo, cell);
}

/** 绕 Y 轴的环。 */
function torusY(radius: number, tube: number, x: number, y: number, z: number, radial: number, tubular: number, cell: CellRect): THREE.BufferGeometry {
  const geo = new THREE.TorusGeometry(radius, tube, radial, tubular);
  geo.rotateX(Math.PI / 2);
  geo.translate(x, y, z);
  return uvInto(geo, cell);
}

/** 绕 Z 轴的环（炮口/镜筒外圈）。 */
function torusZ(radius: number, tube: number, x: number, y: number, z: number, radial: number, tubular: number, cell: CellRect): THREE.BufferGeometry {
  const geo = new THREE.TorusGeometry(radius, tube, radial, tubular);
  geo.translate(x, y, z);
  return uvInto(geo, cell);
}

function latheY(points: readonly (readonly [number, number])[], seg: number, cell: CellRect): THREE.BufferGeometry {
  const geo = new THREE.LatheGeometry(points.map(([r, y]) => new THREE.Vector2(r, y)), seg);
  return uvInto(geo, cell);
}

function circleDown(r: number, seg: number, x: number, y: number, z: number, cell: CellRect): THREE.BufferGeometry {
  const geo = new THREE.CircleGeometry(r, seg);
  geo.rotateX(Math.PI / 2);
  geo.translate(x, y, z);
  return uvInto(geo, cell);
}

/**
 * 三角帽帽檐：顶部、底面、外沿、内沿四条带首尾相连的封闭厚壳。
 * 内沿固定在 innerY 上与帽冠底圈贴合，抬升量沿半径按 t² 增长，外沿最高。
 * lift(a) 给出该角度的外沿抬升量，绕 Y 轴按 seg 段采样。
 */
function brimGeometry(
  innerR: number,
  outerR: number,
  innerY: number,
  thick: number,
  seg: number,
  lift: (a: number) => number,
  topCell: CellRect,
  rimCell: CellRect,
  underCell: CellRect,
): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const rect = (cell: CellRect) => ({
    u0: (cell.x + 2) / ATLAS,
    u1: (cell.x + cell.size - 2) / ATLAS,
    v0: 1 - (cell.y + cell.size - 2) / ATLAS,
    v1: 1 - (cell.y + 2) / ATLAS,
  });
  const addQuad = (
    a: readonly number[],
    b: readonly number[],
    c: readonly number[],
    d: readonly number[],
    cell: CellRect,
    uvs: readonly (readonly [number, number])[],
  ) => {
    const r = rect(cell);
    const corners = [a, b, c, d];
    for (const idx of [0, 2, 1, 0, 3, 2]) {
      pos.push(corners[idx][0], corners[idx][1], corners[idx][2]);
      uv.push(r.u0 + uvs[idx][0] * (r.u1 - r.u0), r.v0 + uvs[idx][1] * (r.v1 - r.v0));
    }
  };

  const at = (r: number, a: number, t: number, base: number) => {
    const rise = lift(a) * t * t;
    return [Math.cos(a) * r, base + rise, Math.sin(a) * r];
  };

  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2;
    const a1 = ((i + 1) / seg) * Math.PI * 2;
    const u0 = i / seg;
    const u1 = (i + 1) / seg;
    const inT0 = at(innerR, a0, 0, innerY);
    const inT1 = at(innerR, a1, 0, innerY);
    const outT0 = at(outerR, a0, 1, innerY);
    const outT1 = at(outerR, a1, 1, innerY);
    const inB0 = at(innerR, a0, 0, innerY - thick);
    const inB1 = at(innerR, a1, 0, innerY - thick);
    const outB0 = at(outerR, a0, 1, innerY - thick);
    const outB1 = at(outerR, a1, 1, innerY - thick);

    addQuad(inT0, outT0, outT1, inT1, topCell, [
      [u0, 0],
      [u0, 1],
      [u1, 1],
      [u1, 0],
    ]);
    addQuad(outB0, inB0, inB1, outB1, underCell, [
      [u0, 0],
      [u0, 1],
      [u1, 1],
      [u1, 0],
    ]);
    addQuad(outB0, outB1, outT1, outT0, rimCell, [
      [u0, 0],
      [u1, 0],
      [u1, 1],
      [u0, 1],
    ]);
    addQuad(inB0, inT0, inT1, inB1, underCell, [
      [u0, 0],
      [u0, 1],
      [u1, 1],
      [u1, 0],
    ]);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  return geo;
}

function mergeAll(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const prepared = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  const merged = mergeGeometries(prepared, false);
  if (!merged) throw new Error('pirate-chief geometry merge failed');
  for (const g of prepared) g.dispose();
  return merged;
}

// ---------------------------------------------------------------- model

export function createPirateChief(): THREE.Group {
  const mat = materials();
  const statics: THREE.BufferGeometry[] = [];
  const glow: THREE.BufferGeometry[] = [];
  const put = (geo: THREE.BufferGeometry) => statics.push(geo);

  // ---- 坐垫法兰 + 机械颈圈（三道环，中间一道红漆）
  put(cylinderY(0.118, 0.122, 0.034, 0, 0.021, 0, 12, CELL.dark));
  put(cylinderY(0.128, 0.132, 0.03, 0, 0.053, 0, 12, CELL.iron));
  put(cylinderY(0.12, 0.124, 0.028, 0, 0.082, 0, 12, CELL.red));
  put(cylinderY(0.11, 0.114, 0.026, 0, 0.109, 0, 12, CELL.iron));
  put(box(0.15, 0.04, 0.15, CELL.dark).translate(0, 0.136, 0) as THREE.BufferGeometry);

  // 四颗红色指示灯嵌在红漆环上
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i * Math.PI) / 2;
    glow.push(cylinderY(0.011, 0.011, 0.018, Math.cos(a) * 0.118, 0.082, Math.sin(a) * 0.118, 6, CELL.red));
  }

  // ---- 头骨主块：下颌、颅骨、颊甲
  put(box(0.17, 0.062, 0.168, CELL.iron).translate(0, 0.16, 0) as THREE.BufferGeometry);
  put(box(0.205, 0.116, 0.19, CELL.iron).translate(0, 0.236, 0) as THREE.BufferGeometry);
  put(box(0.026, 0.095, 0.135, CELL.dark).translate(-0.098, 0.207, -0.012) as THREE.BufferGeometry);
  put(box(0.026, 0.095, 0.135, CELL.dark).translate(0.098, 0.207, -0.012) as THREE.BufferGeometry);

  // 眼窝与鼻腔：深色凹板
  put(box(0.054, 0.03, 0.012, CELL.bore).translate(-0.047, 0.258, -0.0935) as THREE.BufferGeometry);
  put(box(0.028, 0.032, 0.012, CELL.bore).translate(-0.02, 0.222, -0.0935) as THREE.BufferGeometry);

  // 颊甲上的红漆窄条
  put(box(0.006, 0.075, 0.014, CELL.red).translate(-0.112, 0.205, -0.03) as THREE.BufferGeometry);
  put(box(0.006, 0.075, 0.014, CELL.red).translate(0.112, 0.205, -0.03) as THREE.BufferGeometry);

  // ---- 铁面口罩：盖住下颌与嘴部，三道通气缝 + 两颗铆钉
  put(box(0.15, 0.058, 0.026, CELL.iron).translate(0, 0.172, -0.094) as THREE.BufferGeometry);
  for (let i = 0; i < 3; i++) {
    put(box(0.096, 0.0085, 0.01, CELL.bore).translate(0, 0.187 - i * 0.015, -0.1065) as THREE.BufferGeometry);
  }
  put(box(0.01, 0.01, 0.008, CELL.rust).translate(-0.066, 0.19, -0.104) as THREE.BufferGeometry);
  put(box(0.01, 0.01, 0.008, CELL.rust).translate(0.066, 0.19, -0.104) as THREE.BufferGeometry);

  // ---- 独眼：向外突出的巨型激光镜筒 + 红色镜芯，另一侧铁眼罩 + 骨色骷髅纹
  // 三层同轴件严格留缝：镜筒 Φ0.086（端面 z=-0.115）→ 锈镜圈（z=-0.122，内孔 Φ0.068）
  // → 发光镜芯 Φ0.060（中心 z=-0.119，前端 -0.125，缩在镜圈内 3 mm），彼此不叠面。
  put(cylinderZ(0.043, 0.046, 0.05, 0.240, -0.092, 12, CELL.iron));
  put(torusZ(0.04, 0.006, 0.05, 0.240, -0.122, 12, 5, CELL.rust));
  glow.push(cylinderZ(0.03, 0.012, 0.05, 0.240, -0.119, 12, CELL.red));

  put(cylinderZ(0.052, 0.008, -0.047, 0.258, -0.092, 12, CELL.dark));
  put(cylinderZ(0.046, 0.014, -0.047, 0.258, -0.098, 12, CELL.iron));
  put(box(0.02, 0.022, 0.006, CELL.bone).translate(-0.047, 0.258, -0.109) as THREE.BufferGeometry);
  put(
    box(0.032, 0.006, 0.005, CELL.bone)
      .rotateZ(0.7)
      .translate(-0.047, 0.246, -0.109) as THREE.BufferGeometry,
  );
  put(
    box(0.032, 0.006, 0.005, CELL.bone)
      .rotateZ(-0.7)
      .translate(-0.047, 0.246, -0.109) as THREE.BufferGeometry,
  );

  // ---- 三角帽：帽檐内沿贴住帽冠底圈，外沿两侧上翻；锥形帽冠 + 帽带
  const lift = (a: number) => 0.03 + 0.055 * Math.pow(Math.abs(Math.cos(a)), 1.5);
  put(brimGeometry(0.118, 0.205, 0.298, 0.016, 28, lift, CELL.red, CELL.iron, CELL.dark));

  put(
    latheY(
      [
        [0.125, 0.298],
        [0.124, 0.33],
        [0.118, 0.36],
        [0.105, 0.392],
        [0.082, 0.418],
        [0.048, 0.433],
        [0, 0.437],
      ],
      12,
      CELL.red,
    ),
  );
  put(circleDown(0.126, 12, 0, 0.3, 0, CELL.dark));
  put(cylinderY(0.131, 0.131, 0.024, 0, 0.323, 0, 12, CELL.dark));

  // 帽带上的八颗铆钉
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    put(
      box(0.01, 0.01, 0.01, CELL.rust)
        .rotateY(Math.PI / 2 - a)
        .translate(Math.cos(a) * 0.1335, 0.323, Math.sin(a) * 0.1335) as THREE.BufferGeometry,
    );
  }

  // ---- 装配
  const root = new THREE.Group();
  root.name = 'pirate-chief';

  const hitCore = new THREE.Object3D();
  hitCore.name = 'hit_core';
  hitCore.position.set(0, 0.215, 0);
  root.add(hitCore);

  const body = new THREE.Mesh(mergeAll(statics), mat.atlas);
  body.name = 'pirate-chief-mesh';
  body.castShadow = true;
  body.receiveShadow = true;
  root.add(body);

  const glowMesh = new THREE.Mesh(mergeAll(glow), mat.glow);
  glowMesh.name = 'pirate-chief-glow';
  root.add(glowMesh);

  const hpBlood = new THREE.Object3D();
  hpBlood.name = 'hp_blood';
  hpBlood.position.set(0, 0.45, 0);
  root.add(hpBlood);

  return root;
}

