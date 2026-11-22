/**
 * 程序化 equirectangular 天空的像素生成（线性 HDR，RGBA Float32）。
 *
 * 在 loading 阶段由 Web Worker 生成后直接进渲染管线：天幕 shader 采样它、
 * 海洋反射用它烤 cubemap、PMREM 用它生成 scene.environment —— 不再下载任何
 * .hdr 文件。太阳方向由调用方传入（读场景主光的朝向），太阳本体、日晕、
 * 地平线暖带和云的逆光银边都由同一个方向推出。
 *
 * 视觉基调：黄金时刻的低角度侧逆光。天空是天顶深蓝 -> 冷灰地平线的渐变，
 * 朝太阳一侧叠加暖橙地平线带与米氏日晕；太阳本体是可见的过曝日盘；积云带
 * 冷色阴影底与暖色逆光边，云缝里透出太阳；高层薄卷云被夕阳染暖。下半球给
 * 深海底色，天幕和海洋自身会用地平线色覆盖这一带。
 *
 * 纯函数、无副作用、不依赖引擎：Worker 与主线程兜底路径共用同一份实现。
 */

export const SKY_MAP_WIDTH = 1536;
export const SKY_MAP_HEIGHT = 768;

export type SkySunDirection = readonly [number, number, number];

// --- 云层参数（后续调视觉只改这一段） ---
const CLOUD_SCALE = 3.6;
const CLOUD_WARP = 0.5;
const CLOUD_COVERAGE = 0.49;
const CLOUD_SOFTNESS = 0.09;
const HAZE_SCALE = 4.6; // 高层薄卷云
const SHADOW_STEPS = 5;
const SHADOW_STEP = 0.03;
const SHADOW_ABSORB = 4.2;

// --- 大气参数 ---
const ZENITH = [0.034, 0.076, 0.195];
const MID_SKY = [0.085, 0.145, 0.295];
const HORIZON_COOL = [0.24, 0.31, 0.45];
const HORIZON_WARM = [0.78, 0.56, 0.33];
const SUN_TINT = [1.0, 0.85, 0.64];
const CLOUD_SHADOW = [0.1, 0.12, 0.17];
const SUN_CORE = [1.0, 0.94, 0.82];

/** 日盘 HDR 亮度：sRGB 直出时烧成纯白，边缘由日晕过渡。 */
const SUN_CORE_POWER = 26;

// 日盘角半径约 1.5°，外缘 2.8°，两者之间做 smoothstep 抗锯齿。
const SUN_COS_INNER = Math.cos((1.5 * Math.PI) / 180);
const SUN_COS_OUTER = Math.cos((2.8 * Math.PI) / 180);

/**
 * 负海拔下沉：`-y` 超过 DEEP_START 才开始向 DEEP_BLUE 过渡，到 DEEP_END
 * 完全沉入。海面远缘在视平线下方约 6°，这段可见的“地平线下空档”必须保持
 * 地平线色，否则天与海之间会露出一条更深的蓝带，水面立刻显得脱节。
 * 真正的深海色只在视线明显向下时才出现。
 */
const DEEP_START = 0.22;
const DEEP_END = 0.95;
const DEEP_BLUE = [0.01, 0.04, 0.115];

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

// 云自阴影只取低频大团块：遮挡形状本来就低频，省掉中高频三个八度。
function cloudDensityCoarse(dx: number, dy: number, dz: number): number {
  const s = CLOUD_SCALE;
  const large = fbm3(dx * s + 11.3, dy * s - 4.1, dz * s + 2.7, 4);
  return clamp01(large * 0.62 + 0.19);
}

function sampleSky(
  dx: number,
  dy: number,
  dz: number,
  sunDir: SkySunDirection,
): [number, number, number] {
  const up = Math.max(dy, 0);
  const t = Math.pow(Math.max(1 - up, 0), 3.0);
  const tMid = Math.pow(Math.max(1 - up, 0), 1.2);

  // 天顶 -> 中层 -> 冷灰地平线：中层过渡让蓝有层次，不会一路线性发灰。
  let r = mix(mix(ZENITH[0], MID_SKY[0], tMid), HORIZON_COOL[0], t);
  let g = mix(mix(ZENITH[1], MID_SKY[1], tMid), HORIZON_COOL[1], t);
  let b = mix(mix(ZENITH[2], MID_SKY[2], tMid), HORIZON_COOL[2], t);

  // 朝太阳一侧的地平线暖带：只压低层，高空的蓝保持干净。
  const hLen = Math.hypot(dx, dz) || 1e-4;
  const sunHLen = Math.hypot(sunDir[0], sunDir[2]) || 1e-4;
  const azimuth =
    (dx * sunDir[0]) / hLen / sunHLen + (dz * sunDir[2]) / hLen / sunHLen;
  const warm = Math.pow(Math.max(azimuth, 0), 3.0) * Math.pow(Math.max(1 - up, 0), 5.0);
  r = mix(r, HORIZON_WARM[0], warm);
  g = mix(g, HORIZON_WARM[1], warm);
  b = mix(b, HORIZON_WARM[2], warm);

  // 米氏日晕：大范围暖光 + 靠近日盘的一圈强光晕。
  const mu = Math.max(dx * sunDir[0] + dy * sunDir[1] + dz * sunDir[2], 0);
  const glow =
    (Math.pow(mu, 6.0) * 0.28 + Math.pow(mu, 42.0) * 0.9) *
    (0.35 + 0.65 * Math.pow(1 - up, 2.0));
  return [
    r + SUN_TINT[0] * glow,
    g + SUN_TINT[1] * glow,
    b + SUN_TINT[2] * glow,
  ];
}

function sampleCloud(
  dx: number,
  dy: number,
  dz: number,
  sunDir: SkySunDirection,
): { rgb: [number, number, number]; alpha: number } | null {
  const mu = Math.max(dx * sunDir[0] + dy * sunDir[1] + dz * sunDir[2], 0);
  const dens = cloudDensityDir(dx, dy, dz);

  // 主积云：软阈值转成覆盖率。整球都是云天，不做地平线稀释 ——
  // 云对水平线镜像后本身就是连续的，任何“近地平线变薄”的处理都会
  // 在球面上留下一圈没有云的空白带。
  //
  // 日盘周围向云层要一个柔和云隙：低角度太阳必须能透出来，否则逆光
  // 剪影就变成了阴天。只削薄不挖穿，避免出现不自然的圆形空洞。
  const sunGap = 1.0 - 0.5 * smoothstep(0.94, 0.998, mu);
  const alpha =
    smoothstep(CLOUD_COVERAGE, CLOUD_COVERAGE + CLOUD_SOFTNESS, dens) * sunGap;
  if (alpha <= 0.001) return null;

  // 云的自阴影：沿太阳的水平方向在方向空间累积低频遮挡。
  const hLen = Math.hypot(sunDir[0], sunDir[2]) || 1e-4;
  const sx = (sunDir[0] / hLen) * SHADOW_STEP;
  const sz = (sunDir[2] / hLen) * SHADOW_STEP;
  let occ = 0;
  let w = 1;
  for (let i = 1; i <= SHADOW_STEPS; i++) {
    const o = cloudDensityCoarse(dx + sx * i, dy, dz + sz * i);
    occ += Math.max(o - CLOUD_COVERAGE * 0.9, 0) * w;
    w *= 0.75;
  }
  const light = Math.exp(-occ * SHADOW_ABSORB);

  // 前向散射：逆光方向的云边发亮（银边），低太阳让这一圈更宽更暖。
  const phase = 1 + 2.0 * Math.pow(mu, 5);

  const up = Math.max(dy, 0);
  const bounce = Math.pow(Math.max(1 - up, 0), 4) * 0.18;
  const ambR = CLOUD_SHADOW[0] * (0.85 + 0.3 * (1 - up)) + HORIZON_WARM[0] * bounce;
  const ambG = CLOUD_SHADOW[1] * (0.85 + 0.3 * (1 - up)) + HORIZON_WARM[1] * bounce;
  const ambB = CLOUD_SHADOW[2] * (0.85 + 0.3 * (1 - up)) + HORIZON_WARM[2] * bounce;

  const litR = SUN_TINT[0] * 1.3 * light * phase;
  const litG = SUN_TINT[1] * 1.15 * light * phase;
  const litB = SUN_TINT[2] * 1.0 * light * phase;

  return { rgb: [ambR + litR, ambG + litG, ambB + litB], alpha };
}

// 高层薄卷云：细密、半透明，铺在所有积云之上，与积云覆盖率无关。
// 远离太阳的一侧保持冷灰，避免把天顶深蓝洗成暖灰。
function hazeAlpha(dx: number, dy: number, dz: number): number {
  const h = fbm3(dx * HAZE_SCALE + 5.2, dy * HAZE_SCALE - 3.1, dz * HAZE_SCALE + 1.4, 4);
  return smoothstep(0.6, 0.9, h) * 0.09;
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
      // 底色在下半球取地平线色，与上半球严格连续。
      const dy = Math.abs(y);
      const sky = sampleSky(x, y >= 0 ? y : 0, z, sunDir);
      let rgb: [number, number, number] = [sky[0], sky[1], sky[2]];

      const cloud = sampleCloud(x, dy, z, sunDir);
      if (cloud) {
        rgb = [
          mix(sky[0], cloud.rgb[0], cloud.alpha),
          mix(sky[1], cloud.rgb[1], cloud.alpha),
          mix(sky[2], cloud.rgb[2], cloud.alpha),
        ];
      }

      // 太阳本体压在云层之上，但被厚云遮挡到只剩一圈微光；日晕已经在
      // sampleSky 里铺好，所以这里只画日盘。
      const mu = Math.max(x * sunDir[0] + y * sunDir[1] + z * sunDir[2], 0);
      const disc = smoothstep(SUN_COS_OUTER, SUN_COS_INNER, mu);
      if (disc > 0.001) {
        const visible = 1 - (cloud?.alpha ?? 0) * 0.9;
        const energy = disc * visible * SUN_CORE_POWER;
        rgb = [
          rgb[0] + SUN_CORE[0] * energy,
          rgb[1] + SUN_CORE[1] * energy,
          rgb[2] + SUN_CORE[2] * energy,
        ];
      }

      const h = hazeAlpha(x, dy, z);
      if (h > 0.001) {
        // 薄卷云只在朝太阳的一侧被夕阳染暖，其余保持冷灰：
        // 否则天顶深蓝会被一层暖雾洗成灰紫色。
        const warmHaze = Math.pow(mu, 6);
        rgb = [
          mix(rgb[0], mix(0.42, SUN_TINT[0] * 1.35, warmHaze), h),
          mix(rgb[1], mix(0.47, SUN_TINT[1] * 1.3, warmHaze), h),
          mix(rgb[2], mix(0.56, SUN_TINT[2] * 1.22, warmHaze), h),
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
