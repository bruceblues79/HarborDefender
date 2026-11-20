/**
 * 生成程序化 equirectangular HDR 天空（RGBE .hdr），替换 public/textures 下的
 * 外部 HDRI。太阳方向直接读 main.iwsdk.scene.json 的 sun-light，保证云的高光边
 * 与场景主光同向。
 *
 * 上半球：解析大气渐变 + 太阳光晕；远景云层在云平面投影上采样 FBM，用向太阳
 * 偏移的密度估计做 Beer–Lambert 自阴影与前向 Mie 银边。下半球给深海底色，
 * 天幕和海洋自身会用地平线色覆盖这一带。
 */

import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const WIDTH = 1024;
const HEIGHT = 512;

// --- 云层参数（后续调视觉只改这一段） ---
const CLOUD_SCALE = 3.4;
const CLOUD_WARP = 0.35;
const CLOUD_COVERAGE = 0.42;
const CLOUD_SOFTNESS = 0.16;
const HAZE_SCALE = 4.2; // 高层薄卷云
const SHADOW_STEPS = 5;
const SHADOW_STEP = 0.02;
const SHADOW_ABSORB = 2.6;

// --- 大气参数 ---
const ZENITH = [0.055, 0.135, 0.36];
const HORIZON = [0.56, 0.68, 0.86];
const SUN_TINT = [1.0, 0.955, 0.90];
const SUN_GLOW_STRENGTH = 2.1;

function hash3(ix, iy, iz) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(iz, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function valueNoise3(x, y, z) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const xf = x - xi;
  const yf = y - yi;
  const zf = z - zi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const w = zf * zf * (3 - 2 * zf);
  const c000 = hash3(xi, yi, zi);
  const c100 = hash3(xi + 1, yi, zi);
  const c010 = hash3(xi, yi + 1, zi);
  const c110 = hash3(xi + 1, yi + 1, zi);
  const c001 = hash3(xi, yi, zi + 1);
  const c101 = hash3(xi + 1, yi, zi + 1);
  const c011 = hash3(xi, yi + 1, zi + 1);
  const c111 = hash3(xi + 1, yi + 1, zi + 1);
  const x00 = c000 * (1 - u) + c100 * u;
  const x10 = c010 * (1 - u) + c110 * u;
  const x01 = c001 * (1 - u) + c101 * u;
  const x11 = c011 * (1 - u) + c111 * u;
  const y0 = x00 * (1 - v) + x10 * v;
  const y1 = x01 * (1 - v) + x11 * v;
  return y0 * (1 - w) + y1 * w;
}

function fbm3(x, y, z, octaves) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise3(x, y, z) * amp;
    norm += amp;
    x = x * 2.02 + 17.3;
    y = y * 2.02 - 9.1;
    z = z * 2.02 + 5.7;
    amp *= 0.5;
  }
  return sum / norm;
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

// 云密度直接在方向空间采样 3D 噪声：球面上各向同性，不会出现投影拉伸造成的弧线。
function cloudDensityDir(dx, dy, dz) {
  const s = CLOUD_SCALE;
  let bx = dx * s;
  let by = dy * s;
  let bz = dz * s;
  // 小幅度域扭曲，只做局部翻卷；幅度过大会重新形成大尺度弧。
  bx += (fbm3(bx * 0.9 + 3.1, by * 0.9 + 7.3, bz * 0.9 - 2.1, 2) - 0.5) * CLOUD_WARP;
  by += (fbm3(bx * 0.9 - 5.7, by * 0.9 + 1.9, bz * 0.9 + 4.3, 2) - 0.5) * CLOUD_WARP;
  bz += (fbm3(bx * 0.9 + 9.4, by * 0.9 - 6.2, bz * 0.9 + 0.8, 2) - 0.5) * CLOUD_WARP;
  // 三个尺度叠加：低频给大团块，中频给块间过渡，高频给零散小块。
  const large = fbm3(bx + 11.3, by - 4.1, bz + 2.7, 4);
  const mid = fbm3(bx * 2.2 - 7.7, by * 2.2 + 2.9, bz * 2.2 + 5.5, 4);
  const small = fbm3(bx * 4.6 + 31.7, by * 4.6 - 12.4, bz * 4.6 + 8.2, 3);
  return clamp01(large * 0.62 + mid * 0.27 + small * 0.11);
}

function sampleSky(dir, sunDir) {
  const up = Math.max(dir.y, 0);
  const grad = Math.pow(Math.max(1 - up, 0), 2.8);
  let r = mix(ZENITH[0], HORIZON[0], grad);
  let g = mix(ZENITH[1], HORIZON[1], grad);
  let b = mix(ZENITH[2], HORIZON[2], grad);

  const mu = Math.max(dir.x * sunDir[0] + dir.y * sunDir[1] + dir.z * sunDir[2], 0);
  const glow = Math.pow(mu, 64) * SUN_GLOW_STRENGTH + Math.pow(mu, 8) * 0.28;
  r += SUN_TINT[0] * glow;
  g += SUN_TINT[1] * glow;
  b += SUN_TINT[2] * glow;

  return [r, g, b];
}

function sampleCloud(dir, sunDir) {
  if (dir.y <= 0.02) return null;

  const dens = cloudDensityDir(dir.x, dir.y, dir.z);

  // 主积云：软阈值转成覆盖率。越靠地平线越薄，模拟远云的视觉压缩。
  const horizonFade = smoothstep(0.02, 0.16, dir.y);
  const alpha = smoothstep(CLOUD_COVERAGE, CLOUD_COVERAGE + CLOUD_SOFTNESS, dens) * horizonFade;
  if (alpha <= 0.001) return null;

  // 云的自阴影：沿太阳的水平方向在方向空间累积遮挡。
  const hLen = Math.hypot(sunDir[0], sunDir[2]) || 1e-4;
  const sx = (sunDir[0] / hLen) * SHADOW_STEP;
  const sz = (sunDir[2] / hLen) * SHADOW_STEP;
  let occ = 0;
  let w = 1;
  for (let i = 1; i <= SHADOW_STEPS; i++) {
    const o = cloudDensityDir(dir.x + sx * i, dir.y, dir.z + sz * i);
    occ += Math.max(o - CLOUD_COVERAGE, 0) * w;
    w *= 0.78;
  }
  const light = Math.exp(-occ * SHADOW_ABSORB);

  // 前向 Mie 相函数：逆光方向的云边发亮（银边）。
  const mu = Math.max(dir.x * sunDir[0] + dir.y * sunDir[1] + dir.z * sunDir[2], 0);
  const phase = 1 + 2.8 * Math.pow(mu, 6);

  const lit = SUN_TINT[0] * 1.5 * light * phase;
  const litG = SUN_TINT[1] * 1.45 * light * phase;
  const litB = SUN_TINT[2] * 1.4 * light * phase;
  const shadow = [ZENITH[0] * 1.0, ZENITH[1] * 0.95, ZENITH[2] * 0.9];

  return { rgb: [shadow[0] + lit, shadow[1] + litG, shadow[2] + litB], alpha };
}

// 高层薄卷云：细密、半透明，铺在所有积云之上，与积云覆盖率无关。
function hazeAlpha(dir) {
  if (dir.y <= 0.05) return 0;
  const fade = smoothstep(0.05, 0.22, dir.y);
  const h = fbm3(dir.x * HAZE_SCALE + 5.2, dir.y * HAZE_SCALE - 3.1, dir.z * HAZE_SCALE + 1.4, 4);
  return smoothstep(0.55, 0.80, h) * 0.20 * fade;
}

function equirectDir(col, row) {
  const u = col / (WIDTH - 1);
  const v = 1 - row / (HEIGHT - 1); // 顶部第 0 行 = 天顶
  const lat = (v - 0.5) * Math.PI;
  const phi = (u - 0.5) * Math.PI * 2;
  const cl = Math.cos(lat);
  return { x: cl * Math.cos(phi), y: Math.sin(lat), z: cl * Math.sin(phi) };
}

// 光沿节点本地 -Z 发射；rot 为 three 的 XYZ 欧拉角（弧度）。
function sunDirFromRotation(rx, ry) {
  const s1 = Math.sin(rx);
  const c1 = Math.cos(rx);
  const s2 = Math.sin(ry);
  const c2 = Math.cos(ry);
  const dx = s2;
  const dy = -s1 * c2;
  const dz = c1 * c2;
  const len = Math.hypot(dx, dy, dz);
  return [dx / len, dy / len, dz / len];
}

function toRGBE(r, g, b, out, offset) {
  const maxc = Math.max(r, g, b);
  if (maxc < 1e-32) {
    out[offset] = 0;
    out[offset + 1] = 0;
    out[offset + 2] = 0;
    out[offset + 3] = 0;
    return;
  }
  const e = Math.floor(Math.log2(maxc)) + 1;
  const scale = 256 / Math.pow(2, e);
  out[offset] = Math.min(255, Math.floor(r * scale));
  out[offset + 1] = Math.min(255, Math.floor(g * scale));
  out[offset + 2] = Math.min(255, Math.floor(b * scale));
  out[offset + 3] = e + 128;
}

function rleEncodeChannel(channel, out) {
  const n = channel.length;
  let i = 0;
  while (i < n) {
    let run = 1;
    while (i + run < n && channel[i + run] === channel[i] && run < 127) run++;
    if (run >= 4) {
      out.push(128 + run, channel[i]);
      i += run;
      continue;
    }
    const start = i;
    let lit = 0;
    while (i < n && lit < 128) {
      if (
        i + 3 < n &&
        channel[i] === channel[i + 1] &&
        channel[i] === channel[i + 2] &&
        channel[i] === channel[i + 3]
      ) {
        break;
      }
      i++;
      lit++;
    }
    out.push(lit);
    for (let k = 0; k < lit; k++) out.push(channel[start + k]);
  }
}

function encodeHDR(rgbe) {
  const parts = [];
  parts.push(
    Buffer.from(
      `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${HEIGHT} +X ${WIDTH}\n`,
      'ascii',
    ),
  );
  const channel = new Uint8Array(WIDTH);
  for (let y = 0; y < HEIGHT; y++) {
    const row = [2, 2, (WIDTH >> 8) & 0xff, WIDTH & 0xff];
    for (let c = 0; c < 4; c++) {
      for (let x = 0; x < WIDTH; x++) channel[x] = rgbe[(y * WIDTH + x) * 4 + c];
      rleEncodeChannel(channel, row);
    }
    parts.push(Buffer.from(row));
  }
  return Buffer.concat(parts);
}

function main() {
  const scenePath = resolve(ROOT, 'public/scenes/main.iwsdk.scene.json');
  const scene = JSON.parse(readFileSync(scenePath, 'utf8'));
  const sun = scene.nodes.find((n) => n.id === 'sun-light');
  const [rx, ry] = sun.transform.rotationDeg.map((d) => (d * Math.PI) / 180);
  const sunDir = sunDirFromRotation(rx, ry);

  const rgbe = new Uint8Array(WIDTH * HEIGHT * 4);
  let cloudPixels = 0;
  let maxLuma = 0;

  for (let row = 0; row < HEIGHT; row++) {
    for (let col = 0; col < WIDTH; col++) {
      const dir = equirectDir(col, row);
      let rgb;

      if (dir.y < 0) {
        // 下半球：深海底色，天幕和海洋会用地平线色覆盖这一段。
        const t = clamp01(-dir.y * 3);
        rgb = [
          mix(HORIZON[0] * 0.55, 0.02, t),
          mix(HORIZON[1] * 0.55, 0.045, t),
          mix(HORIZON[2] * 0.55, 0.08, t),
        ];
      } else {
        const sky = sampleSky(dir, sunDir);
        const cloud = sampleCloud(dir, sunDir);
        rgb = cloud ? [
          mix(sky[0], cloud.rgb[0], cloud.alpha),
          mix(sky[1], cloud.rgb[1], cloud.alpha),
          mix(sky[2], cloud.rgb[2], cloud.alpha),
        ] : sky;
        if (cloud && cloud.alpha > 0.5) cloudPixels++;

        const h = hazeAlpha(dir);
        if (h > 0.001) {
          // 被太阳侧照的薄卷云：暖白，略带天顶环境色。
          rgb = [
            mix(rgb[0], SUN_TINT[0] * 1.28, h),
            mix(rgb[1], SUN_TINT[1] * 1.24, h),
            mix(rgb[2], SUN_TINT[2] * 1.20, h),
          ];
        }
      }

      const luma = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
      if (luma > maxLuma) maxLuma = luma;
      toRGBE(rgb[0], rgb[1], rgb[2], rgbe, (row * WIDTH + col) * 4);
    }
  }

  const buf = encodeHDR(rgbe);
  const outPath = resolve(ROOT, 'public/textures/procedural_sky_1k.hdr');
  writeFileSync(outPath, buf);

  // 编码自检：读回文件，解第一行首个像素，与源数据比对。
  const reRead = readFileSync(outPath);
  const blank = reRead.indexOf('\n\n') + 2;
  const dataStart = reRead.indexOf('\n', blank) + 1;
  const scanHeader = reRead.readUInt32BE(dataStart);
  const ok = scanHeader === ((2 << 24) | (2 << 16) | WIDTH);

  const probe = (d) => {
    const len = Math.hypot(d[0], d[1], d[2]);
    const n = { x: d[0] / len, y: d[1] / len, z: d[2] / len };
    const sky = sampleSky(n, sunDir);
    const c = sampleCloud(n, sunDir);
    return c
      ? [mix(sky[0], c.rgb[0], c.alpha), mix(sky[1], c.rgb[1], c.alpha), mix(sky[2], c.rgb[2], c.alpha)]
      : sky;
  };

  console.log('sun dir      ', sunDir.map((v) => v.toFixed(3)).join(', '));
  console.log('file bytes   ', statSync(outPath).size);
  console.log('RLE header ok', ok);
  console.log('zenith       ', probe([0, 1, 0]).map((v) => v.toFixed(3)).join(', '));
  console.log('near sun     ', probe([sunDir[0], sunDir[1], sunDir[2]]).map((v) => v.toFixed(3)).join(', '));
  console.log('near horizon ', probe([sunDir[0], 0.08, sunDir[2]]).map((v) => v.toFixed(3)).join(', '));
  console.log(
    'cloud cover  ',
    ((cloudPixels / (WIDTH * HEIGHT)) * 100).toFixed(1) + '% of full sphere',
  );
  console.log('max luma     ', maxLuma.toFixed(3));
}

main();
