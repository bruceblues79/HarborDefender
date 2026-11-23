#!/usr/bin/env node
/**
 * 天空指纹：把一张 equirect 天空（参考 .hdr，或 procedural-sky.ts 的生成结果）
 * 压成一组可比对的照明指标。方向约定与生成器一致：行 0 = 天顶，
 * u = 0.5 指向 +x，u = 0.75 指向 +z。
 *
 *   node scripts/sky-fingerprint.mjs <ref.hdr>           实测参考图，打印拟合数据与参考块
 *   node scripts/sky-fingerprint.mjs [--ref <ref.hdr>]   生成图对照参考（缺省用内置参考块）
 *
 *   node scripts/sky-fingerprint.mjs --fit [--rounds N]     逐格标定云量偏置与云亮度，打印两张表
 *   <ref.hdr> 模式加 --emit <path>：写出可直接贴进生成器的常量
 *
 * 可选 --png <out.png> [--width N]：写出 ACES 色调映射的对照图，存 %TEMP% 自查用。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { crc32, deflateSync } from 'node:zlib';
import {
  CLOUD_BIAS,
  CLOUD_LIGHT,
  CLOUD_TINT,
  SKY_MAP_HEIGHT,
  SKY_MAP_WIDTH,
  generateSkyPixels,
} from '../src/procedural-sky.ts';

const DEG = Math.PI / 180;
const GRID_WIDTH = 2048;
const LOBE_DEG = 4; // 日核 + 镜头眩光
const SUN_CLEAR_DEG = 10; // 分区/网格统计剔除太阳周围的半径
const CLOUD_FACTOR = 1.35; // 像素亮度超过同方向晴空的这个倍数即算云
const ZONE_EDGES = [90, 60, 30, 10, 0, -10, -30, -90];
const GRID_EDGES = [90, 60, 35, 15, 0];
const GRID_AZIMUTHS = 8;
const PROBE_AZIMUTHS = 8;
const SUN_EDGES = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4, 5, 6, 8, 10, 12, 16, 20, 30];
// 日晕：太阳周围叠在晴空上的前向散射亮区。各环取非云像素均值，减掉最外环，40° 以外不再单列
const AUREOLE_EDGES = [10, 12, 16, 20, 30, 40];
const FIT_EDGES = [90, 80, 70, 60, 50, 40, 30, 20, 10, 5, 2, 0]; // 晴空色表的仰角带，近地平线加密
const FIT_AZIMUTHS = 6;
const LUMA_BANDS = [0, 0.5, 1.5, 4, 12, Infinity];
const LOWER_EDGES = [0, -2, -5, -10, -20, -30, -45, -60, -90, -90.01];

/** 参考块：`<ref.hdr>` 模式打印，贴回这里；.hdr 删除后仍可回归。 */
const REFERENCE = {
  sunDirection: [0.55439,0.74166,0.37762],
  irradiance: {
    up: [1.46885,1.54168,1.66114],
    down: [0.15817,0.18509,0.27091],
    side: [
      [1.20719,1.29519,1.44666],
      [1.40711,1.50015,1.64926],
      [0.90801,0.97474,1.10582],
      [0.21768,0.25588,0.37675],
      [0.16859,0.19523,0.2945],
      [0.17769,0.20299,0.30231],
      [0.20794,0.24023,0.35311],
      [0.45706,0.51429,0.65921],
    ],
  },
  lobeShare: 0.70749,
  lobeEnergy: [
    [1.038,1.04581,0.94946],
    [1.05517,1.06406,0.96974],
    [1.08637,1.09437,1.00033],
    [1.12475,1.13133,1.04227],
  ],
  zones: [
    [0.47385,0.52393,0.69496],
    [0.26901,0.34061,0.5672],
    [0.31304,0.39267,0.61841],
    [0.44097,0.48653,0.61054],
    [0.35905,0.39641,0.49943],
    [0.17651,0.2193,0.34047],
    [0.14791,0.1711,0.2492],
  ],
  grid: [
    [0.90276,0.79719,0.38704,0.2678,0.39157,0.47121,0.60468,0.38281],
    [0.63978,0.65566,0.37488,0.16348,0.18731,0.29628,0.29794,0.32174],
    [0.72582,0.49539,0.34346,0.17011,0.16391,0.24707,0.25135,0.4745],
    [0.83784,0.71037,0.40858,0.3295,0.28561,0.35901,0.32878,0.50457],
  ],
  bands: {
    sky: [0.30571,0.49099,0.19023,0.01074,0.00233],
    energy: [0.0496,0.28226,0.41883,0.11575,2.27515],
  },
  sunProfile: [54759.77408,5131.63839,215.87212,61.70005,38.23145,26.53196,25.91311,21.48256,17.21559,14.75066,9.97152,6.40747,5.45824,4.05095,2.52431,1.33434,0.99616,0.76123,0.67327,0.30674],
  skyMean: 0.31691,
  gridZero: [
    [0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0],
  ],
  gridCover: [
    [0.49118,0.76802,0.39323,0.23469,0.68649,0.76672,0.74029,0.28475],
    [0.05977,0.28192,0.52509,0.24953,0.34595,0.6516,0.3421,0.02605],
    [0.18476,0.04938,0.27974,0.11332,0.11123,0.3347,0.24716,0.3174],
    [0.06599,0.11723,0.08915,0.16089,0.07872,0.27744,0.096,0.04527],
  ],
  gridCloud: [
    [1.19378,0.83629,0.55192,0.7648,0.6105,0.65018,0.78227,0.65524],
    [1.71506,1.25091,0.57477,0.39518,0.40297,0.40681,0.54473,0.71118],
    [1.3215,1.41445,0.56785,0.38275,0.40287,0.43702,0.42847,0.72303],
    [1.25987,1.02987,0.58566,0.50677,0.38544,0.47575,0.49367,0.69116],
  ],
  gridClear: [
    [0.36033,0.35112,0.17052,0.15095,0.1607,0.15733,0.21198,0.30869],
    [0.59161,0.46548,0.19862,0.09949,0.10121,0.11683,0.1789,0.31243],
    [0.58624,0.44872,0.25086,0.14062,0.13089,0.15389,0.1922,0.35833],
    [0.80748,0.66772,0.39089,0.29554,0.27694,0.31439,0.31106,0.49515],
  ],
};

const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

export function parseHdr(path) {
  const bytes = readFileSync(path);
  let pos = 0;
  let width = 0;
  let height = 0;
  for (;;) {
    const end = bytes.indexOf(10, pos);
    const line = bytes.toString('latin1', pos, end).trim();
    pos = end + 1;
    const match = /^-Y (\d+) \+X (\d+)$/.exec(line);
    if (match) {
      [, height, width] = match.map(Number);
      break;
    }
  }
  const rgb = new Float32Array(width * height * 3);
  const scanline = new Uint8Array(width * 4);
  for (let row = 0; row < height; row++) {
    if (bytes[pos] === 2) {
      pos += 4; // 2, 2, 宽度高字节, 低字节
      for (let channel = 0; channel < 4; channel++) {
        let x = channel;
        while (x < width * 4) {
          const count = bytes[pos++];
          if (count > 128) {
            const value = bytes[pos++];
            for (let i = count - 128; i > 0; i--, x += 4) scanline[x] = value;
          } else {
            for (let i = count; i > 0; i--, x += 4) scanline[x] = bytes[pos++];
          }
        }
      }
    } else {
      scanline.set(bytes.subarray(pos, pos + width * 4));
      pos += width * 4;
    }
    const base = row * width * 3;
    for (let col = 0; col < width; col++) {
      const i = col * 4;
      const e = scanline[i + 3];
      if (e === 0) continue;
      const f = 2 ** (e - 128) / 255;
      rgb[base + col * 3] = (scanline[i] + 0.5) * f;
      rgb[base + col * 3 + 1] = (scanline[i + 1] + 0.5) * f;
      rgb[base + col * 3 + 2] = (scanline[i + 2] + 0.5) * f;
    }
  }
  return { width, height, data: rgb, stride: 3 };
}

function dirOf(map, col, row) {
  const lat = (0.5 - (row + 0.5) / map.height) * Math.PI;
  const phi = ((col + 0.5) / map.width - 0.5) * 2 * Math.PI;
  const cl = Math.cos(lat);
  return [cl * Math.cos(phi), Math.sin(lat), cl * Math.sin(phi)];
}

/** 日核质心：只取远亮于天空与云的像素。 */
function sunCentroid(map) {
  let x = 0;
  let y = 0;
  let z = 0;
  let w = 0;
  let peak = 0;
  for (let i = 0; i < map.width * map.height; i++) {
    const l = luma(map.data[i * map.stride], map.data[i * map.stride + 1], map.data[i * map.stride + 2]);
    if (l > 50) {
      const d = dirOf(map, i % map.width, Math.floor(i / map.width));
      x += d[0] * l;
      y += d[1] * l;
      z += d[2] * l;
      w += l;
    }
    if (l > peak) peak = l;
  }
  const len = Math.hypot(x, y, z);
  return { direction: [x / len, y / len, z / len], peak };
}

function sample(map, x, y, z, out) {
  const fx = (((Math.atan2(z, x) / (2 * Math.PI) + 0.5) % 1) + 1) % 1 * map.width - 0.5;
  const fy = Math.max(0, Math.min(map.height - 1, (0.5 - Math.asin(y) / Math.PI) * map.height - 0.5));
  const x0 = (Math.floor(fx) + map.width) % map.width; // 第 0 列的 fx 是 -0.5，取整后要绕回末列
  const x1 = (x0 + 1) % map.width;
  const y0 = Math.floor(fy);
  const y1 = Math.min(map.height - 1, y0 + 1);
  const tx = fx - Math.floor(fx);
  const ty = fy - y0;
  const s = map.stride;
  const i00 = (y0 * map.width + x0) * s;
  const i10 = (y0 * map.width + x1) * s;
  const i01 = (y1 * map.width + x0) * s;
  const i11 = (y1 * map.width + x1) * s;
  for (let c = 0; c < 3; c++) {
    out[c] =
      (map.data[i00 + c] * (1 - tx) + map.data[i10 + c] * tx) * (1 - ty) +
      (map.data[i01 + c] * (1 - tx) + map.data[i11 + c] * tx) * ty;
  }
}

/** 降序边界：返回 k 使 edges[k] > value >= edges[k+1]。 */
function bandIndex(edges, value) {
  for (let k = 0; k < edges.length - 1; k++) {
    if (value >= edges[k + 1]) return k;
  }
  return edges.length - 2;
}

/** 升序边界：返回 k 使 edges[k] <= value < edges[k+1]，越界停在端点。 */
function ringIndex(edges, value) {
  let k = 0;
  while (k < edges.length - 2 && edges[k + 1] <= value) k++;
  return k;
}

function analyze(map, sun, { width = GRID_WIDTH, detail = true, clearMap, zeroMap } = {}) {
  const w = width;
  const h = w / 2;
  const n = w * h;
  // 经纬等间距网格：每行像素的立体角要乘 cos(lat)，否则极区被高估。
  const dOmega = (2 * Math.PI / w) * (Math.PI / h);
  const W = new Float32Array(n);
  const R = new Float32Array(n);
  const G = new Float32Array(n);
  const B = new Float32Array(n);
  const L = new Float32Array(n);
  const Y = new Float32Array(n);
  const HX = new Float32Array(n);
  const HZ = new Float32Array(n);
  const theta = new Float32Array(n);
  const elev = new Float32Array(n);
  const azim = new Float32Array(n);
  const C = new Float32Array(n); // 同方向的晴空亮度
  const Z = new Float32Array(n); // 亮度表置零的生成图的亮度
  const isCloud = new Uint8Array(n);
  const rgb = [0, 0, 0];
  for (let row = 0; row < h; row++) {
    const lat = (0.5 - (row + 0.5) / h) * Math.PI;
    const cl = Math.cos(lat);
    const y = Math.sin(lat);
    for (let col = 0; col < w; col++) {
      const phi = ((col + 0.5) / w - 0.5) * 2 * Math.PI;
      const x = cl * Math.cos(phi);
      const z = cl * Math.sin(phi);
      sample(map, x, y, z, rgb);
      const i = row * w + col;
      W[i] = dOmega * cl;
      R[i] = rgb[0];
      G[i] = rgb[1];
      B[i] = rgb[2];
      L[i] = luma(rgb[0], rgb[1], rgb[2]);
      if (clearMap) {
        sample(clearMap, x, y, z, rgb);
        C[i] = luma(rgb[0], rgb[1], rgb[2]);
      }
      if (zeroMap) {
        // 置零图里的云只剩对天空的反射，它与晴空图之差就是云的不透明度，与亮度无关。
        sample(zeroMap, x, y, z, rgb);
        Z[i] = luma(rgb[0], rgb[1], rgb[2]);
        isCloud[i] = C[i] - Z[i] > 0.5 * (1 - CLOUD_TINT) * C[i] ? 1 : 0;
      } else {
        isCloud[i] = L[i] > CLOUD_FACTOR * C[i] ? 1 : 0;
      }
      Y[i] = y;
      HX[i] = x;
      HZ[i] = z;
      theta[i] = Math.acos(Math.max(-1, Math.min(1, x * sun[0] + y * sun[1] + z * sun[2]))) / DEG;
      elev[i] = lat / DEG;
      azim[i] = Math.atan2(z, x) / DEG;
    }
  }
  const sunAz = Math.atan2(sun[2], sun[0]) / DEG;

  const vec = () => [0, 0, 0];
  const add = (acc, i, k) => {
    acc[0] += R[i] * k;
    acc[1] += G[i] * k;
    acc[2] += B[i] * k;
  };
  const scale = (a, k) => a.map((v) => v * k);

  // --- 辐照度探针：朝上 / 朝下 / 8 个方位的竖直面 ---
  const up = vec();
  const upLobe = vec();
  const lobeEnergy = [1, 2, 4, 8].map(() => vec());
  const down = vec();
  const side = Array.from({ length: PROBE_AZIMUTHS }, vec);
  const probes = Array.from({ length: PROBE_AZIMUTHS }, (_, a) => {
    const t = (a / PROBE_AZIMUTHS) * 2 * Math.PI;
    return [Math.cos(t), Math.sin(t)];
  });

  // --- 分区、云量网格、亮度带（剔除太阳周围）---
  const zones = ZONE_EDGES.slice(0, -1).map(() => ({ sum: vec(), omega: 0 }));
  const grid = GRID_EDGES.slice(0, -1).map(() =>
    Array.from({ length: GRID_AZIMUTHS }, () => ({ sum: vec(), omega: 0, zero: 0 })),
  );
  const bands = LUMA_BANDS.slice(0, -1).map(() => ({ omega: 0, energy: 0 }));
  const gridIdx = GRID_EDGES.slice(0, -1).map(() =>
    Array.from({ length: GRID_AZIMUTHS }, () => []),
  );
  const sunBins = SUN_EDGES.slice(0, -1).map(() => ({ flux: 0, omega: 0, moment: 0, sum: vec() }));
  const aureoleRings = AUREOLE_EDGES.slice(0, -1).map(() => ({ sum: vec(), omega: 0 }));
  let skyLumaSum = 0;
  let skyOmega = 0;
  for (let i = 0; i < n; i++) {
    const t = theta[i];
    const dw = W[i];
    let bin = ringIndex(SUN_EDGES, t);
    sunBins[bin].flux += L[i] * dw;
    sunBins[bin].moment += t * L[i] * dw;
    sunBins[bin].omega += dw;
    add(sunBins[bin].sum, i, dw);
    if (!isCloud[i] && t >= AUREOLE_EDGES[0] && t < AUREOLE_EDGES.at(-1)) {
      const ring = aureoleRings[ringIndex(AUREOLE_EDGES, t)];
      add(ring.sum, i, dw);
      ring.omega += dw;
    }

    if (Y[i] > 0) {
      add(up, i, Y[i] * dw);
      if (t < LOBE_DEG) add(upLobe, i, Y[i] * dw);
      for (let e = 0; e < lobeEnergy.length; e++) {
        if (t < [1, 2, 4, 8][e]) add(lobeEnergy[e], i, Y[i] * dw);
      }
    } else {
      add(down, i, -Y[i] * dw);
    }
    for (let a = 0; a < PROBE_AZIMUTHS; a++) {
      const c = HX[i] * probes[a][0] + HZ[i] * probes[a][1];
      if (c > 0) add(side[a], i, c * dw);
    }

    if (t > SUN_CLEAR_DEG) {
      skyLumaSum += L[i] * dw;
      skyOmega += dw;
      const zone = zones[bandIndex(ZONE_EDGES, elev[i])];
      add(zone.sum, i, dw);
      zone.omega += dw;
      if (elev[i] >= 0) {
        const az = Math.floor((((azim[i] + 360) % 360) / 360) * GRID_AZIMUTHS);
        gridIdx[bandIndex(GRID_EDGES, elev[i])][az].push(i);
        const cell = grid[bandIndex(GRID_EDGES, elev[i])][az];
        add(cell.sum, i, dw);
        cell.omega += dw;
        cell.zero += Z[i] * dw;
      }
    }
  }
  const skyMean = skyLumaSum / skyOmega;
  for (let i = 0; i < n; i++) {
    const rel = L[i] / skyMean;
    let b = LUMA_BANDS.length - 2;
    while (rel < LUMA_BANDS[b]) b--;
    bands[b].omega += W[i];
    if (Y[i] > 0) bands[b].energy += L[i] * Y[i] * W[i];
  }

  const upPi = scale(up, 1 / Math.PI);
  const lumaOf = (a) => luma(a[0], a[1], a[2]);
  const result = {
    sunDirection: sun,
    irradiance: {
      up: upPi,
      down: scale(down, 1 / Math.PI),
      side: side.map((a) => scale(a, 1 / Math.PI)),
    },
    lobeShare: lumaOf(upLobe) / lumaOf(up),
    lobeEnergy: lobeEnergy.map((a) => scale(a, 1 / Math.PI)),
    zones: zones.map((z) => scale(z.sum, 1 / z.omega)),
    grid: grid.map((row) => row.map((cell) => lumaOf(scale(cell.sum, 1 / cell.omega)))),
    bands: {
      sky: bands.map((b) => b.omega / (4 * Math.PI)),
      energy: bands.map((b) => b.energy / luma(...upPi)),
    },
    sunProfile: sunBins.map((b) => b.flux / b.omega),
    skyMean,
    gridZero: grid.map((row) => row.map((cell) => cell.zero / cell.omega)),
  };
  if (!detail) return result;

  // --- 拟合数据：晴空色表（仰角带 × 相对太阳方位，剔除云与日晕）、日晕剖面、下半球色表 ---
  const outerRing = aureoleRings.at(-1);
  const outerMean = scale(outerRing.sum, 1 / outerRing.omega);
  const aureoleRows = aureoleRings.map((ring, k) => [
    AUREOLE_EDGES[k + 1],
    ...scale(ring.sum, 1 / ring.omega).map((v, c) => Math.max(0, v - outerMean[c])),
  ]);
  const fit = FIT_EDGES.slice(0, -1).map(() => Array.from({ length: FIT_AZIMUTHS }, () => []));
  const lower = LOWER_EDGES.slice(0, -2).map(() => Array.from({ length: 8 }, () => []));
  for (let i = 0; i < n; i++) {
    if (theta[i] <= SUN_CLEAR_DEG) continue;
    const e = elev[i];
    if (e >= 0) {
      const dAz = Math.abs((((azim[i] - sunAz + 540) % 360) - 180));
      fit[bandIndex(FIT_EDGES, e)][Math.min(FIT_AZIMUTHS - 1, Math.floor((dAz / 180) * FIT_AZIMUTHS))].push(i);
    } else {
      lower[bandIndex(LOWER_EDGES, e)][Math.floor((((azim[i] + 360) % 360) / 360) * 8)].push(i);
    }
  }
  const meanRgb = (idx) => {
    const a = vec();
    for (const i of idx) add(a, i, 1 / idx.length);
    return a;
  };
  const quartile = (idx, sortKey, frac, fromTop) => {
    const sorted = idx.slice().sort((p, q) => sortKey(p) - sortKey(q));
    const count = Math.max(1, Math.round(idx.length * frac));
    return meanRgb(fromTop ? sorted.slice(-count) : sorted.slice(0, count));
  };
  // 逐格云估计：参考图里亮于同方向晴空 CLOUD_FACTOR 倍的像素算云，生成图里不透明度过半的像素算云。
  const gridFit = gridIdx.map((row) =>
    row.map((idx) => {
      const cloudIdx = idx.filter((i) => isCloud[i]);
      const clearIdx = idx.filter((i) => !isCloud[i]);
      return {
        cover: cloudIdx.length / idx.length,
        cloud: meanRgb(cloudIdx.length ? cloudIdx : idx),
        clear: meanRgb(clearIdx.length ? clearIdx : idx),
      };
    }),
  );
  // 晴空色 = 非云像素的均值（云缘的薄纱也算天空的一部分）减去日晕；没有非云像素时退回最暗 30%。
  const veilOf = (idx) => {
    const a = vec();
    let count = 0;
    for (const i of idx) {
      if (isCloud[i]) continue;
      a[0] += R[i] - knotValue(aureoleRows, theta[i], 0);
      a[1] += G[i] - knotValue(aureoleRows, theta[i], 1);
      a[2] += B[i] - knotValue(aureoleRows, theta[i], 2);
      count++;
    }
    return count ? scale(a, 1 / count) : quartile(idx, (i) => L[i], 0.3, false);
  };
  const fitTable = fit.map((row, r) =>
    row.map((idx, c) => {
      if (idx.length < 8) return null;
      return {
        veil: veilOf(idx),
        clear: quartile(idx, (i) => L[i], 0.3, false),
        bright: quartile(idx, (i) => L[i], 0.3, true),
        median: idx.slice().sort((p, q) => L[p] - L[q])[idx.length >> 1],
        luma: luma(...meanRgb(idx)),
      };
    }),
  );
  const lowerTable = lower.map((band) => band.map((idx) => (idx.length ? meanRgb(idx) : vec())));

  result.gridCover = gridFit.map((row) => row.map((c) => c.cover));
  result.gridCloud = gridFit.map((row) => row.map((c) => luma(...c.cloud)));
  result.gridClear = gridFit.map((row) => row.map((c) => luma(...c.clear)));
  result.detail = {
    fitTable,
    lowerTable,
    aureoleRows,
    sunColor: sunBins.map((b) => scale(b.sum, 1 / b.omega)),
    sunRadius: sunBins.map((b) => b.moment / b.flux),
    peak: 0,
  };
  return result;
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------
const f3 = (v) => v.toFixed(3);
const rgbText = (a) => a.map(f3).join(' ');
const pct = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
const rel = (ref, val) => (ref === 0 ? (val === 0 ? 0 : Infinity) : (val - ref) / ref);
const pass = (ok) => (ok ? 'PASS' : 'FAIL');

function printReference(fp) {
  const { irradiance: ir } = fp;
  const [sx, sy, sz] = fp.sunDirection;
  console.log(`太阳质心: ${fp.sunDirection.map((v) => v.toFixed(4)).join(' ')}  仰角 ${(Math.asin(sy) / DEG).toFixed(2)}°  方位 ${(Math.atan2(sz, sx) / DEG).toFixed(2)}°  峰值亮度 ${fp.detail.peak.toFixed(0)}`);
  console.log(`E/π 朝上: ${rgbText(ir.up)}   朝下: ${rgbText(ir.down)}`);
  console.log(`E/π 竖直面(方位 0..315°): ${ir.side.map((a) => f3(luma(...a))).join(' ')}`);
  console.log(`日瓣(θ<${LOBE_DEG}°)占朝上辐照: ${(fp.lobeShare * 100).toFixed(1)}%   日瓣 E/π θ<1/2/4/8°: ${fp.lobeEnergy.map((a) => f3(luma(...a))).join(' ')}`);
  console.log('分区均值(剔除 θ<10°):');
  fp.zones.forEach((z, k) => {
    console.log(`  ${ZONE_EDGES[k]}..${ZONE_EDGES[k + 1]}°: ${rgbText(z)}`);
  });
  console.log(`云量网格亮度(方位 0..315° × 仰角带):`);
  fp.grid.forEach((row, r) => {
    console.log(`  ${GRID_EDGES[r]}..${GRID_EDGES[r + 1]}°: ${row.map(f3).join(' ')}`);
  });
  console.log('亮度带(占全天立体角 / 占朝上辐照):');
  console.log(`  ${fp.bands.sky.map((v) => (v * 100).toFixed(1)).join(' ')}   M=${f3(fp.skyMean)}`);
  console.log(`  ${fp.bands.energy.map((v) => (v * 100).toFixed(1)).join(' ')}`);
  console.log('太阳径向剖面: 区间  亮度加权半径°  均值 RGB  (亮度)');
  fp.sunProfile.forEach((v, k) => {
    const c = fp.detail.sunColor[k];
    console.log(`  ${SUN_EDGES[k]}..${SUN_EDGES[k + 1]}°: ${fp.detail.sunRadius[k].toFixed(3)}  ${rgbText(c)}  (${v.toFixed(1)})`);
  });
  console.log('日晕(非云像素均值 − 最外环): 环带外缘°  RGB');
  fp.detail.aureoleRows.forEach(([edge, ...rgb]) => {
    console.log(`  ${edge}: ${rgbText(rgb)}`);
  });
  console.log('晴空色表(行=仰角带, 列=相对太阳方位 0-30..150-180°): 非云均值(已减日晕), 暗后30%色, 亮前30%色');
  fp.detail.fitTable.forEach((row, r) => {
    console.log(`  ${FIT_EDGES[r]}..${FIT_EDGES[r + 1]}°: ${row.map((c) => (c ? `${rgbText(c.veil)},${rgbText(c.clear)},${rgbText(c.bright)}` : '-')).join(' | ')}`);
  });
  console.log('逐格云估计(云覆盖% / 云均值亮度):');
  fp.gridCover.forEach((row, r) => {
    console.log(`  ${GRID_EDGES[r]}..${GRID_EDGES[r + 1]}°: ${row.map((cover, a) => `${(cover * 100).toFixed(0)}%/${f3(fp.gridCloud[r][a])}`).join('  ')}`);
  });
  console.log('下半球色表(行=仰角带, 列=方位扇区 0..315°):');
  fp.detail.lowerTable.forEach((band, k) => {
    console.log(`  ${LOWER_EDGES[k]}..${LOWER_EDGES[k + 1]}°: ${band.map(rgbText).join(' | ')}`);
  });
}

/** 太阳径向剖面的节点角度：日盘边缘（0.25..0.4°）加密，外面沿用环带边界。 */
const GLARE_EDGES = [
  0, 0.15, 0.25, 0.3, 0.35, 0.4, 0.5, 0.6, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4, 5, 6, 8, 10, 12,
];

/** 相邻节点间对数线性的剖面在环带 [a, b]° 内的立体角均值。 */
function profileMean(logs, a, b) {
  const steps = 200;
  let k = 1;
  let sum = 0;
  let weight = 0;
  for (let i = 0; i <= steps; i++) {
    const theta = a + ((b - a) * i) / steps;
    while (k < GLARE_EDGES.length - 1 && GLARE_EDGES[k] < theta) k++;
    const t = (theta - GLARE_EDGES[k - 1]) / (GLARE_EDGES[k] - GLARE_EDGES[k - 1]);
    const w = Math.sin(theta * DEG) * (i === 0 || i === steps ? 1 : i % 2 ? 4 : 2);
    sum += w * Math.exp(logs[k - 1] + (logs[k] - logs[k - 1]) * t);
    weight += w;
  }
  return sum / weight;
}

/**
 * 由环带均值反解径向剖面的节点：环带均值放在环带中点作初值，
 * 再按「实测 / 预测」比例逐轮修正环带内的节点（环带边界上的节点只修一半）。返回节点与最大残差。
 */
function glareKnots(sunColor, peak) {
  const halfMax = 65504; // HalfFloat 上限，超出部分上传纹理时会被截掉
  const coreScale = Math.min(peak, halfMax) / luma(...sunColor[0]);
  const mids = sunColor.map((_, k) => (SUN_EDGES[k] + SUN_EDGES[k + 1]) / 2);
  const logs = GLARE_EDGES.map((theta) => {
    const k = mids.findLastIndex((m) => m <= theta);
    if (k < 0) return sunColor[0].map((v) => Math.log(v * coreScale));
    const next = sunColor[Math.min(k + 1, 15)];
    const t = k === 15 ? 0 : (theta - mids[k]) / (mids[k + 1] - mids[k]);
    return sunColor[k].map((v, c) => Math.log(v) + Math.log(next[c] / v) * t);
  });
  let worst = 0;
  for (let round = 0; round < 300; round++) {
    worst = 0;
    for (let k = 0; k < 16; k++) {
      for (let c = 0; c < 3; c++) {
        const ratio = Math.log(
          sunColor[k][c] / profileMean(logs.map((row) => row[c]), SUN_EDGES[k], SUN_EDGES[k + 1]),
        );
        worst = Math.max(worst, Math.abs(Math.exp(ratio) - 1));
        GLARE_EDGES.forEach((theta, j) => {
          const inside = theta > SUN_EDGES[k] && theta < SUN_EDGES[k + 1];
          const bound = theta === SUN_EDGES[k] || theta === SUN_EDGES[k + 1];
          if (j && (inside || bound)) logs[j][c] += 0.6 * ratio * (inside ? 1 : 0.5);
        });
      }
    }
    // 剖面必须向外单调不增，否则节点会来回振荡（首节点是 HalfFloat 上限，不能被顶高）。
    for (let j = 1; j < logs.length; j++) {
      for (let c = 0; c < 3; c++) logs[j][c] = Math.min(logs[j][c], logs[j - 1][c]);
    }
  }
  return {
    rows: logs.map((row, j) => [GLARE_EDGES[j], ...row.map((v) => +Math.exp(v).toFixed(4))]),
    worst,
  };
}

/** [x, v…] 节点表在第 c 个值上的线性插值，x 越界停在端点。 */
function knotValue(rows, x, c) {
  let k = 1;
  while (k < rows.length - 1 && rows[k][0] < x) k++;
  const a = rows[k - 1];
  const b = rows[k];
  return a[c + 1] + (b[c + 1] - a[c + 1]) * clamp((x - a[0]) / (b[0] - a[0]), 0, 1);
}

/** 把拟合数据写成可直接贴进 procedural-sky.ts 的常量。 */
function emitConstants(fp) {
  const { fitTable, sunColor, lowerTable, aureoleRows } = fp.detail;
  const num = (v, digits) => +v.toFixed(digits);
  const lines = ['// 晴空色表：行 = 仰角带 90..80..2..0°，列 = |相对太阳方位| 15..165°', 'const CLEAR_SKY = ['];
  fitTable.forEach((row) => {
    lines.push(`  [${row.map((c) => `[${c.veil.map((v) => num(v, 4)).join(', ')}]`).join(', ')}],`);
  });
  lines.push('];', '// 日晕：[θ°, R, G, B]，叠加在晴空上', 'const SUN_AUREOLE = [');
  aureoleRows.forEach((row) => lines.push(`  [${row.map((v) => num(v, 4)).join(', ')}],`));
  lines.push('];', '// 太阳径向剖面：[θ°, R, G, B]', 'const SUN_GLARE = [');
  const knots = glareKnots(sunColor, fp.detail.peak);
  knots.rows.forEach((row) => lines.push(`  [${row.join(', ')}],`));
  lines.push(
    '];',
    '// 下半球色表：[仰角带 0..-2..-60..-90][方位扇区 0..315°] = RGB',
    'const LOWER_SKY = [',
  );
  lowerTable.forEach((band) => {
    lines.push(`  [${band.map((z) => `[${z.map((v) => num(v, 4)).join(', ')}]`).join(', ')}],`);
  });
  lines.push('];', '');
  console.log(`太阳剖面节点拟合的最大环带残差 ${pct(knots.worst)}`);
  return lines.join('\n');
}

function compare(reference, fp) {
  const rows = [];
  let failed = 0;
  const check = (name, ok, refText, genText, errText) => {
    if (!ok) failed++;
    rows.push(`${pass(ok)}  ${name.padEnd(26)} ${refText.padStart(22)} ${genText.padStart(22)}  ${errText}`);
  };
  const vecCheck = (name, ref, val, tol) => {
    const errs = ref.map((r, k) => rel(r, val[k]));
    const worst = errs.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a));
    check(name, Math.abs(worst) <= tol, rgbText(ref), rgbText(val), `${pct(worst)} / ±${tol * 100}%`);
  };
  vecCheck('E/π 朝上', reference.irradiance.up, fp.irradiance.up, 0.05);
  vecCheck('E/π 朝下', reference.irradiance.down, fp.irradiance.down, 0.15);
  const sideRef = reference.irradiance.side.map((a) => luma(...a));
  const sideGen = fp.irradiance.side.map((a) => luma(...a));
  sideRef.forEach((v, a) => {
    const e = rel(v, sideGen[a]);
    check(`E/π 竖直面 面朝 ${a * 45}°`, Math.abs(e) <= 0.1, f3(v), f3(sideGen[a]), `${pct(e)} / ±10%`);
  });
  const share = fp.lobeShare - reference.lobeShare;
  check('日瓣占比 θ<4°', Math.abs(share) <= 0.04, `${(reference.lobeShare * 100).toFixed(1)}%`, `${(fp.lobeShare * 100).toFixed(1)}%`, `${(share * 100).toFixed(1)}pt / ±4pt`);
  [1, 2, 4, 8].forEach((deg, k) => {
    const v = luma(...reference.lobeEnergy[k]);
    const g = luma(...fp.lobeEnergy[k]);
    const e = rel(v, g);
    check(`日瓣能量 θ<${deg}°`, Math.abs(e) <= 0.08, f3(v), f3(g), `${pct(e)} / ±8%`);
  });
  reference.zones.forEach((z, k) => {
    vecCheck(`分区 ${ZONE_EDGES[k]}..${ZONE_EDGES[k + 1]}°`, z, fp.zones[k], 0.1);
  });
  let gridFails = 0;
  const gridLines = fp.grid.map((row, r) =>
    row.map((v, a) => {
      const e = rel(reference.grid[r][a], v);
      if (Math.abs(e) > 0.15) gridFails++;
      return `${(e * 100).toFixed(0).padStart(4)}`;
    }).join(' '),
  );
  failed += gridFails;
  console.log(rows.join('\n'));
  console.log(`云量网格偏差%(行=仰角带, 列=方位 0..315°), 超出 ±15% 的格数: ${gridFails}/32`);
  gridLines.forEach((line, r) => console.log(`  ${GRID_EDGES[r]}..${GRID_EDGES[r + 1]}°: ${line}`));
  const pct1 = (v) => `${(v * 100).toFixed(1)}%`;
  console.log(`亮度带面积占比 (<0.5 / 0.5-1.5 / 1.5-4 / 4-12 / ≥12):`);
  console.log(`  参考 ${reference.bands.sky.map(pct1).join(' ')}   生成 ${fp.bands.sky.map(pct1).join(' ')}`);
  console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项未通过`}`);
  printCells(reference, fp);
  return failed === 0;
}

/** 逐格云估计对照：参考 覆盖%/云亮/晴亮 | 生成 覆盖%/云亮/晴亮。 */
function printCells(reference, fp) {
  console.log('逐格云(参考 覆盖%/云亮/晴亮 | 生成 覆盖%/云亮/晴亮):');
  fp.gridCover.forEach((row, r) => {
    const cells = row.map((cover, a) => {
      const ref = `${(reference.gridCover[r][a] * 100).toFixed(0)}%/${f3(reference.gridCloud[r][a])}/${f3(reference.gridClear[r][a])}`;
      return `${ref}|${(cover * 100).toFixed(0)}%/${f3(fp.gridCloud[r][a])}/${f3(fp.gridClear[r][a])}`;
    });
    console.log(`  ${GRID_EDGES[r]}..${GRID_EDGES[r + 1]}°: ${cells.join('  ')}`);
  });
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const logit = (v) => Math.log(v / (1 - v));
const DAMPING = 0.6; // 相邻格的平滑插值会分走一部分响应，阻尼迭代才稳

/**
 * 逐格标定云量偏置与云亮度。像素亮度对亮度表严格线性（云色 = 反射的天空 + 白底 × 明暗），
 * 所以每轮生成两张图：亮度表置零的图与晴空图之差给出每个像素的云不透明度，带亮度表的图给出格均值。
 * 偏置只管覆盖率（割线法追参考覆盖率），亮度按「目标格均值 − 置零底色」÷「当前亮度的贡献」修正。
 */
function fitClouds(sun, reference, rounds, clearMap) {
  const bias = CLOUD_BIAS.map((row) => row.slice());
  const light = CLOUD_LIGHT.map((row) => row.slice());
  const zeros = CLOUD_BIAS.map((row) => row.map(() => 0));
  const mapOf = (data) => ({ width: SKY_MAP_WIDTH, height: SKY_MAP_HEIGHT, data, stride: 4 });
  let last = null; // 上一轮各格的 [偏置, logit 覆盖率]
  for (let round = 1; round <= rounds; round++) {
    const zeroMap = mapOf(generateSkyPixels(sun, { cloudBias: bias, cloudLight: zeros }));
    const fp = analyze(
      mapOf(generateSkyPixels(sun, { cloudBias: bias, cloudLight: light })),
      sun,
      { clearMap, zeroMap },
    );
    let worstCover = 0;
    let worstCell = 0;
    const before = bias.map((row) => row.slice());
    fp.gridCover.forEach((row, r) =>
      row.forEach((cover, a) => {
        const coverRef = reference.gridCover[r][a];
        const logitGen = logit(clamp(cover, 0.02, 0.98));
        const gap = logit(clamp(coverRef, 0.02, 0.98)) - logitGen;
        worstCover = Math.max(worstCover, Math.abs(coverRef - cover));
        worstCell = Math.max(worstCell, Math.abs(rel(reference.grid[r][a], fp.grid[r][a])));
        const prev = last?.[r]?.[a];
        let step = DAMPING * 0.05 * gap;
        // 邻格同时变动会分走一部分响应，割线斜率只有为正时才可信
        const slope = prev && bias[r][a] !== prev[0] ? (logitGen - prev[1]) / (bias[r][a] - prev[0]) : 0;
        if (slope > 0) step = (DAMPING * gap) / slope;
        bias[r][a] = clamp(bias[r][a] + clamp(step, -0.2, 0.2), -0.4, 0.4);
        const gain = fp.grid[r][a] - fp.gridZero[r][a];
        if (cover > 0.02 && gain > 1e-4) {
          const ratio = (reference.grid[r][a] - fp.gridZero[r][a]) / gain;
          light[r][a] = clamp(light[r][a] * (1 - DAMPING + DAMPING * ratio), 0.02, 6);
        }
      }),
    );
    last = before.map((row, r) =>
      row.map((b, a) => [b, logit(clamp(fp.gridCover[r][a], 0.02, 0.98))]),
    );
    console.log(
      `第 ${round} 轮: 覆盖率最大偏差 ${(worstCover * 100).toFixed(0)}pt  格亮度最大偏差 ${pct(worstCell)}`,
    );
    const off = [];
    fp.gridCover.forEach((row, r) =>
      row.forEach((cover, a) => {
        if (Math.abs(reference.gridCover[r][a] - cover) > 0.1) {
          const from = (reference.gridCover[r][a] * 100).toFixed(0);
          off.push(`${r},${a} ${from}→${(cover * 100).toFixed(0)} b=${bias[r][a].toFixed(3)}`);
        }
      }),
    );
    if (off.length) console.log(`  覆盖率偏差 >10pt: ${off.join('; ')}`);
    if (round === rounds) printCells(reference, fp);
  }
  for (const [name, chart] of [
    ['CLOUD_BIAS', bias],
    ['CLOUD_LIGHT', light],
  ]) {
    console.log(`${name} = [`);
    chart.forEach((row) => console.log(`  [${row.map((v) => v.toFixed(3)).join(', ')}],`));
    console.log(']');
  }
}

// ---------------------------------------------------------------------------
// 预览图
// ---------------------------------------------------------------------------
function tonemap(x) {
  const v = (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14);
  const c = Math.min(Math.max(v, 0), 1);
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}

function toImage(map, width) {
  const height = width / 2;
  const out = new Uint8Array(width * height * 3);
  for (let oy = 0; oy < height; oy++) {
    const y0 = Math.floor((oy * map.height) / height);
    const y1 = Math.floor(((oy + 1) * map.height) / height);
    for (let ox = 0; ox < width; ox++) {
      const x0 = Math.floor((ox * map.width) / width);
      const x1 = Math.floor(((ox + 1) * map.width) / width);
      const sum = [0, 0, 0];
      for (let y = y0; y < y1; y++) {
        let i = (y * map.width + x0) * map.stride;
        for (let x = x0; x < x1; x++, i += map.stride) {
          sum[0] += map.data[i];
          sum[1] += map.data[i + 1];
          sum[2] += map.data[i + 2];
        }
      }
      const inv = 1 / ((y1 - y0) * (x1 - x0));
      out.set(sum.map((v) => Math.round(tonemap(v * inv) * 255)), (oy * width + ox) * 3);
    }
  }
  return out;
}

function writePng(path, width, height, rgb) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(raw, y * stride + 1);
  }
  const chunk = (type, data) => {
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const positional = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const hdrPath = positional[0] ?? option('--ref');
const pngPath = option('--png');
const pngWidth = Number(option('--width') ?? 1024);
const emitPath = option('--emit');

let referenceMap = null;
if (hdrPath) referenceMap = parseHdr(hdrPath);

const centroid = referenceMap ? sunCentroid(referenceMap) : null;
const sun = centroid ? centroid.direction : REFERENCE.sunDirection;
// 无云的晴空图：逐格统计用它判断哪些像素是云，参考图与生成图用同一把尺。
const clearMap = {
  width: SKY_MAP_WIDTH,
  height: SKY_MAP_HEIGHT,
  data: generateSkyPixels(sun, { cloudBias: CLOUD_BIAS.map((row) => row.map(() => -10)) }),
  stride: 4,
};

if (centroid && !args.includes('--ref')) {
  const fp = analyze(referenceMap, sun, { clearMap });
  fp.detail.peak = centroid.peak;
  console.log(`== 参考 ${hdrPath}  ${referenceMap.width}x${referenceMap.height}`);
  printReference(fp);
  if (emitPath) writeFileSync(emitPath, emitConstants(fp));
  delete fp.detail;
  console.log(`REFERENCE ${JSON.stringify(fp)}`);
  if (pngPath) writePng(pngPath, pngWidth, pngWidth / 2, toImage(referenceMap, pngWidth));
  process.exit(0);
}

if (!referenceMap && !REFERENCE) {
  console.error('没有内置参考块，也没有给 --ref <ref.hdr>。');
  process.exit(1);
}

const reference = referenceMap ? analyze(referenceMap, sun, { clearMap }) : REFERENCE;

if (args.includes('--fit')) {
  fitClouds(sun, reference, Number(option('--rounds') ?? 12), clearMap);
  process.exit(0);
}

const t0 = performance.now();
const pixels = generateSkyPixels(sun);
const ms = performance.now() - t0;
const generated = { width: SKY_MAP_WIDTH, height: SKY_MAP_HEIGHT, data: pixels, stride: 4 };
// 生成图的云按不透明度判定（与 --fit 同口径）：亮度表置零后，它与晴空图之差就是云的遮挡。
const zeroMap = {
  width: SKY_MAP_WIDTH,
  height: SKY_MAP_HEIGHT,
  data: generateSkyPixels(sun, { cloudLight: CLOUD_LIGHT.map((row) => row.map(() => 0)) }),
  stride: 4,
};
const fp = analyze(generated, sun, { clearMap, zeroMap });
console.log(`生成耗时 ${ms.toFixed(0)} ms（${SKY_MAP_WIDTH}x${SKY_MAP_HEIGHT}）`);
if (pngPath) {
  const refImage = referenceMap ? toImage(referenceMap, pngWidth) : null;
  const genImage = toImage(generated, pngWidth);
  const stacked = refImage ? new Uint8Array(refImage.length + genImage.length) : genImage;
  if (refImage) {
    stacked.set(refImage);
    stacked.set(genImage, refImage.length);
  }
  writePng(pngPath, pngWidth, pngWidth / 2 + (refImage ? pngWidth / 2 : 0), stacked);
  console.log(`预览图 ${pngPath}`);
}
const ok = compare(reference, fp);
process.exit(ok ? 0 : 1);
