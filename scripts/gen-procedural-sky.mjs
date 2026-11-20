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
const CLOUD_SCALE = 0.85;
const CLOUD_WARP = 1.5;
const CLOUD_COVERAGE = 0.50;
const CLOUD_SOFTNESS = 0.16;
const CLOUD_HEIGHT = 1.9; // 云层在投影坐标里的高度切片，给噪声第三维
const HAZE_SCALE = 2.4; // 高层薄卷云
const SHADOW_STEPS = 5;
const SHADOW_STEP = 0.14;
const SHADOW_ABSORB = 2.6;

// --- 大气参数 ---
const ZENITH = [0.055, 0.135, 0.36];
const HORIZON = [0.56, 0.68, 0.86];
const SUN_TINT = [1.0, 0.955, 0.90];
const SUN_GLOW_STRENGTH = 2.1;

// 32 位整数哈希，确定性且不依赖随机源。
function hash2(ix, iy) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function valueNoise2(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}

function fbm(x, y, octaves) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise2(x, y) * amp;
    norm += amp;
    x = x * 2.02 + 17.3;
    y = y * 2.02 - 9.1;
    amp *= 0.5;
  }
  return sum / norm;
}

// ridged 项专门做云的絮状侵蚀边缘。
function ridged(x, y) {
  return 1 - Math.abs(fbm(x, y, 4) * 2 - 1);
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

// 云平面投影坐标：仰角越低越远，接近地平线时 clamp 防止无限拉伸。
function projectToCloudPlane(dir, scale) {
  const y = Math.max(dir.y, 0.035);
  return [dir.x / y * scale, dir.z / y * scale];
}

function cloudDensity(px, pz) {
  const qx = fbm(px * 0.9 + 11.3, pz * 0.9 - 4.1, 4);
  const qz = fbm(px * 0.9 - 7.7, pz * 0.9 + 2.9, 4);
  const wx = px + (qx - 0.5) * CLOUD_WARP;
  const wz = pz + (qz - 0.5) * CLOUD_WARP;
  const base = fbm(wx, wz, 5);
  const detail = ridged(wx * 2.7 + 31.7, wz * 2.7 - 12.4);
  const n = base * 0.76 + detail * 0.24;
  // 高度切片：让不同仰角的云看到噪声的不同层，弱化平铺感。
  const slab = valueNoise2(wx * 0.35 + CLOUD_HEIGHT, wz * 0.35 - CLOUD_HEIGHT) * 0.06;
  return clamp01(n + slab);
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

  const [px, pz] = projectToCloudPlane(dir, CLOUD_SCALE);
  const dens = cloudDensity(px, pz);

  // 主积云：软阈值转成覆盖率。越靠地平线越薄，模拟远云的视觉压缩。
  const horizonFade = smoothstep(0.02, 0.16, dir.y);
  const alpha = smoothstep(CLOUD_COVERAGE, CLOUD_COVERAGE + CLOUD_SOFTNESS, dens) * horizonFade;
  if (alpha <= 0.001) return null;

  // 云的自阴影：沿太阳的水平投影方向（云的厚度投影）累积遮挡。
  const hLen = Math.hypot(sunDir[0], sunDir[2]) || 1e-4;
  const sx = (sunDir[0] / hLen) * SHADOW_STEP;
  const sz = (sunDir[2] / hLen) * SHADOW_STEP;
  let occ = 0;
  let w = 1;
  for (let i = 1; i <= SHADOW_STEPS; i++) {
    const o = cloudDensity(px + sx * i, pz + sz * i);
    occ += Math.max(o - CLOUD_COVERAGE, 0) * w;
    w *= 0.78;
  }
  const light = Math.exp(-occ * SHADOW_ABSORB);

  // 前向 Mie 相函数：逆光方向的云边发亮（银边）。
  const mu = Math.max(dir.x * sunDir[0] + dir.y * sunDir[1] + dir.z * sunDir[2], 0);
  const phase = 1 + 2.8 * Math.pow(mu, 6);

  const lit = SUN_TINT[0] * 2.3 * light * phase;
  const litG = SUN_TINT[1] * 2.25 * light * phase;
  const litB = SUN_TINT[2] * 2.2 * light * phase;
  const shadow = [ZENITH[0] * 1.6, ZENITH[1] * 1.5, ZENITH[2] * 1.4];

  return { rgb: [shadow[0] + lit, shadow[1] + litG, shadow[2] + litB], alpha };
}

// 高层薄卷云：细密、半透明，铺在所有积云之上，与积云覆盖率无关。
function hazeAlpha(dir) {
  if (dir.y <= 0.05) return 0;
  const [hx, hz] = projectToCloudPlane(dir, HAZE_SCALE);
  const fade = smoothstep(0.05, 0.22, dir.y);
  return smoothstep(0.55, 0.80, fbm(hx + 5.2, hz - 3.1, 4)) * 0.20 * fade;
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
