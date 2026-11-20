/**
 * 程序化 equirectangular 天空的像素生成（线性 HDR，RGBA Float32）。
 *
 * 在 loading 阶段由 Web Worker 生成后直接进渲染管线：天幕 shader 采样它、
 * 海洋反射用它烤 cubemap、PMREM 用它生成 scene.environment —— 不再下载任何
 * .hdr 文件。太阳方向由调用方传入（读场景主光的朝向）。
 *
 * 上半球：解析大气渐变 + 太阳光晕；云在方向空间采样 3D 噪声，用向太阳偏移的
 * 密度估计做 Beer–Lambert 自阴影与前向 Mie 银边，再叠一层高层薄卷云。下半球
 * 给深海底色，天幕和海洋自身会用地平线色覆盖这一带。
 *
 * 纯函数、无副作用、不依赖引擎：Worker 与主线程兜底路径共用同一份实现。
 */

export const SKY_MAP_WIDTH = 1024;
export const SKY_MAP_HEIGHT = 512;

export type SkySunDirection = readonly [number, number, number];

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
const SUN_TINT = [1.0, 0.955, 0.9];

/**
 * 负海拔下沉：`-y` 超过 DEEP_START 开始向 DEEP_BLUE 过渡，到 DEEP_END
 * 完全沉入。球面下半部分因此是从高空俯瞰的深海，而不是平涂的地平线色。
 */
const DEEP_START = 0.07;
const DEEP_END = 0.8;
const DEEP_BLUE = [0.012, 0.05, 0.16];

function hash3(ix: number, iy: number, iz: number): number {
  let h =
    (Math.imul(ix, 374761393) +
      Math.imul(iy, 668265263) +
      Math.imul(iz, 1274126177)) |
    0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function valueNoise3(x: number, y: number, z: number): number {
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

function fbm3(x: number, y: number, z: number, octaves: number): number {
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

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// 云密度直接在方向空间采样 3D 噪声：球面上各向同性，不会出现投影拉伸造成的弧线。
function cloudDensityDir(dx: number, dy: number, dz: number): number {
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

function sampleSky(dx: number, dy: number, dz: number): [number, number, number] {
  const up = Math.max(dy, 0);
  const grad = Math.pow(Math.max(1 - up, 0), 2.8);
  const r = mix(ZENITH[0], HORIZON[0], grad);
  const g = mix(ZENITH[1], HORIZON[1], grad);
  const b = mix(ZENITH[2], HORIZON[2], grad);

  return [r, g, b];
}

function sampleCloud(
  dx: number,
  dy: number,
  dz: number,
  sunDir: SkySunDirection,
): { rgb: [number, number, number]; alpha: number } | null {
  const dens = cloudDensityDir(dx, dy, dz);

  // 主积云：软阈值转成覆盖率。整球都是云天，不做地平线稀释 ——
  // 云对水平线镜像后本身就是连续的，任何“近地平线变薄”的处理都会
  // 在球面上留下一圈没有云的空白带。
  const alpha = smoothstep(CLOUD_COVERAGE, CLOUD_COVERAGE + CLOUD_SOFTNESS, dens);
  if (alpha <= 0.001) return null;

  // 云的自阴影：沿太阳的水平方向在方向空间累积遮挡。
  const hLen = Math.hypot(sunDir[0], sunDir[2]) || 1e-4;
  const sx = (sunDir[0] / hLen) * SHADOW_STEP;
  const sz = (sunDir[2] / hLen) * SHADOW_STEP;
  let occ = 0;
  let w = 1;
  for (let i = 1; i <= SHADOW_STEPS; i++) {
    const o = cloudDensityDir(dx + sx * i, dy, dz + sz * i);
    occ += Math.max(o - CLOUD_COVERAGE, 0) * w;
    w *= 0.78;
  }
  const light = Math.exp(-occ * SHADOW_ABSORB);

  // 前向 Mie 相函数：逆光方向的云边发亮（银边）。
  const mu = Math.max(dx * sunDir[0] + dy * sunDir[1] + dz * sunDir[2], 0);
  const phase = 1 + 1.6 * Math.pow(mu, 10);

  const lit = SUN_TINT[0] * 1.5 * light * phase;
  const litG = SUN_TINT[1] * 1.45 * light * phase;
  const litB = SUN_TINT[2] * 1.4 * light * phase;
  const shadow = [ZENITH[0] * 1.0, ZENITH[1] * 0.95, ZENITH[2] * 0.9];

  return { rgb: [shadow[0] + lit, shadow[1] + litG, shadow[2] + litB], alpha };
}

// 高层薄卷云：细密、半透明，铺在所有积云之上，与积云覆盖率无关。
function hazeAlpha(dx: number, dy: number, dz: number): number {
  const h = fbm3(dx * HAZE_SCALE + 5.2, dy * HAZE_SCALE - 3.1, dz * HAZE_SCALE + 1.4, 4);
  return smoothstep(0.55, 0.8, h) * 0.2;
}

function equirectDir(col: number, row: number): { x: number; y: number; z: number } {
  const u = col / (SKY_MAP_WIDTH - 1);
  const v = 1 - row / (SKY_MAP_HEIGHT - 1); // 顶部第 0 行 = 天顶
  const lat = (v - 0.5) * Math.PI;
  const phi = (u - 0.5) * Math.PI * 2;
  const cl = Math.cos(lat);
  return { x: cl * Math.cos(phi), y: Math.sin(lat), z: cl * Math.sin(phi) };
}

/**
 * 生成整张 equirect 天空。返回 RGBA Float32Array（行 0 = 天顶，alpha 恒为 1），
 * 由调用方转成 HalfFloat 并上传成 DataTexture（flipY = true）。
 */
export function generateSkyPixels(sunDir: SkySunDirection): Float32Array {
  const pixels = new Float32Array(SKY_MAP_WIDTH * SKY_MAP_HEIGHT * 4);
  let offset = 0;

  for (let row = 0; row < SKY_MAP_HEIGHT; row++) {
    for (let col = 0; col < SKY_MAP_WIDTH; col++) {
      const { x, y, z } = equirectDir(col, row);

      // 整球都是云天：云的图案对水平线做镜像，下半球照样有云，
      // 云一直落到海面，不再有“某个仰角以上才有云”的分界。
      // 底色在下半球保持地平线色，与上半球严格连续。
      const dy = Math.abs(y);
      const sky = y >= 0 ? sampleSky(x, y, z) : HORIZON;
      let rgb: [number, number, number] = [sky[0], sky[1], sky[2]];

      const cloud = sampleCloud(x, dy, z, sunDir);
      if (cloud) {
        rgb = [
          mix(sky[0], cloud.rgb[0], cloud.alpha),
          mix(sky[1], cloud.rgb[1], cloud.alpha),
          mix(sky[2], cloud.rgb[2], cloud.alpha),
        ];
      }

      const h = hazeAlpha(x, dy, z);
      if (h > 0.001) {
        // 被太阳侧照的薄卷云：暖白，略带天顶环境色。
        rgb = [
          mix(rgb[0], SUN_TINT[0] * 1.28, h),
          mix(rgb[1], SUN_TINT[1] * 1.24, h),
          mix(rgb[2], SUN_TINT[2] * 1.2, h),
        ];
      }

      // 负海拔：越过一定角度后，云天下沉并逐渐过渡到超深蓝——像从高海拔
      // 俯瞰地球弧线之外的深海。水平线以下因此不是平涂，也没有镜像。
      const deep = smoothstep(DEEP_START, DEEP_END, -y);
      if (deep > 0.001) {
        rgb = [
          mix(rgb[0], DEEP_BLUE[0], deep),
          mix(rgb[1], DEEP_BLUE[1], deep),
          mix(rgb[2], DEEP_BLUE[2], deep),
        ];
      }

      pixels[offset++] = rgb[0];
      pixels[offset++] = rgb[1];
      pixels[offset++] = rgb[2];
      pixels[offset++] = 1;
    }
  }

  return pixels;
}
