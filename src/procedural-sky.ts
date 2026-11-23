/**
 * 程序化 equirect 天空（线性 HDR，辐亮度量纲同参考 HDRI 的解码值）。
 * 方向约定与贴图行序一致：行 0 = 天顶，u = 0.5 指向 +x，u = 0.75 指向 +z。
 *
 * 由太阳方向驱动、固定种子确定性生成。照明数值全部标定自
 * kloofendal_48d_partly_cloudy_puresky，回归脚本：scripts/sky-fingerprint.mjs。
 *   晴空   —— 实测色表（仰角带 × 相对太阳方位），平滑双线性插值；
 *   太阳   —— 实测径向剖面（日盘 + 眩光），θ<12° 内盖过天空；外面叠一层实测日晕；
 *   云     —— 云层平板光线步进，密度取自两张可平铺的噪声瓦片；
 *   下半球 —— 实测色表（仰角带 × 方位扇区）。
 */

export const SKY_MAP_WIDTH = 1536;
export const SKY_MAP_HEIGHT = 768;
export type SkySunDirection = readonly [number, number, number];

export interface SkyOptions {
  /** 覆盖内置的云量偏置表（标定用）。 */
  cloudBias?: number[][];
  /** 覆盖内置的云亮度表（标定用）。 */
  cloudLight?: number[][];
  /** 分辨率除数：4 → 384×192，标定迭代用。 */
  scale?: number;
}

// --- 实测常量（node scripts/sky-fingerprint.mjs <ref.hdr> --emit 的输出） ---
/** 晴空色表：行 = 仰角带 90..80 … 10..5, 5..2, 2..0°，列 = |相对太阳方位| 15..165°（步长 30）。 */
const CLEAR_SKY = new Float32Array(
  [
    [[0.1431, 0.1995, 0.3478], [0.1567, 0.2144, 0.3659], [0.1275, 0.1788, 0.322], [0.1182, 0.1667, 0.3066], [0.1399, 0.1906, 0.3333], [0.1605, 0.2141, 0.3603]],
    [[0.2125, 0.2764, 0.4114], [0.2184, 0.2938, 0.4624], [0.1478, 0.2077, 0.3693], [0.1188, 0.1643, 0.3018], [0.1222, 0.1635, 0.2939], [0.1405, 0.1737, 0.292]],
    [[0.4018, 0.4732, 0.6283], [0.2209, 0.3248, 0.5489], [0.1807, 0.2552, 0.4482], [0.1225, 0.1695, 0.3147], [0.0861, 0.1227, 0.2475], [0.0942, 0.1271, 0.2469]],
    [[0.349, 0.4474, 0.6861], [0.2384, 0.3489, 0.6056], [0.1629, 0.2348, 0.4356], [0.1268, 0.1775, 0.337], [0.0731, 0.1059, 0.2298], [0.0968, 0.1292, 0.2565]],
    [[0.2466, 0.3889, 0.731], [0.2155, 0.3197, 0.5761], [0.1499, 0.2186, 0.4166], [0.0945, 0.1371, 0.2849], [0.0588, 0.0905, 0.2142], [0.0665, 0.0982, 0.2243]],
    [[0.2553, 0.4044, 0.7716], [0.2171, 0.3283, 0.6133], [0.1447, 0.2147, 0.4177], [0.0936, 0.1384, 0.2955], [0.07, 0.1075, 0.247], [0.0654, 0.1015, 0.2392]],
    [[0.3707, 0.5065, 0.8472], [0.2571, 0.3804, 0.6945], [0.1897, 0.2643, 0.4744], [0.1124, 0.1633, 0.3348], [0.0945, 0.1416, 0.3021], [0.0823, 0.1286, 0.2911]],
    [[0.466, 0.6399, 1.0143], [0.3299, 0.4589, 0.7541], [0.2328, 0.3153, 0.522], [0.1615, 0.2272, 0.4093], [0.1529, 0.211, 0.3778], [0.1583, 0.2154, 0.3826]],
    [[0.7474, 0.8735, 1.1227], [0.4865, 0.5935, 0.8097], [0.3462, 0.409, 0.5592], [0.3055, 0.3411, 0.4526], [0.3092, 0.331, 0.422], [0.2671, 0.3045, 0.4185]],
    [[0.7842, 0.87, 1.0487], [0.5967, 0.6505, 0.7762], [0.4094, 0.4391, 0.5342], [0.325, 0.3402, 0.4181], [0.3077, 0.3107, 0.3796], [0.2902, 0.2971, 0.3737]],
    [[0.7316, 0.8085, 0.9555], [0.571, 0.6234, 0.736], [0.3975, 0.4241, 0.5086], [0.2979, 0.3148, 0.3887], [0.2736, 0.2858, 0.3565], [0.2633, 0.2767, 0.3532]],
  ].flat(2),
);
/** 日晕 [θ°, R, G, B]：太阳周围叠在晴空上的前向散射，各环非云像素均值减掉最外环。 */
const SUN_AUREOLE = [
[12, 0.2114, 0.2619, 0.4709],
[16, 0.148, 0.1903, 0.3602],
[20, 0.0682, 0.1117, 0.2713],
[30, 0.0282, 0.0446, 0.1174],
[40, 0, 0, 0],
];
/** 太阳径向剖面 [θ°, R, G, B]：日盘边缘加密节点；环带均值含其下的天空，所以与天空取较亮者。 */
const SUN_GLARE = [
  [0, 64342.8067, 66235.1908, 61680.205],
  [0.15, 64342.8067, 66235.1908, 61680.205],
  [0.25, 36336.3246, 37405.0081, 34832.4733],
  [0.3, 8319.4198, 7554.7495, 5870.518],
  [0.35, 5268.0676, 4693.3517, 3554.1047],
  [0.4, 3062.656, 2692.3165, 2012.7478],
  [0.5, 801.079, 716.4585, 568.251],
  [0.6, 209.533, 190.6584, 160.432],
  [0.75, 78.6822, 69.9277, 57.027],
  [1, 53.3358, 54.2062, 56.1849],
  [1.25, 24.7146, 26.6838, 30.887],
  [1.5, 24.7146, 26.6838, 29.9478],
  [1.75, 23.4805, 25.3559, 28.3557],
  [2, 18.0121, 18.4213, 19.7438],
  [2.5, 15.7453, 16.0188, 17.1096],
  [3, 14.3863, 13.5862, 12.6315],
  [3.5, 7.5311, 6.9793, 6.8814],
  [4, 6.2492, 5.7127, 5.6874],
  [5, 5.6298, 4.9598, 5.0958],
  [6, 3.1613, 3.1595, 3.858],
  [8, 1.8233, 1.9848, 2.51],
  [10, 0.714, 0.8678, 1.4182],
  [12, 0.714, 0.8678, 1.4182],
];
/** 下半球色表 [仰角带 0..-2, -2..-5, …, -60..-90][方位扇区 45k..45k+45°（自 +x 轴起）] = RGB。 */
const LOWER_SKY = new Float32Array(
  [
    [[0.7089, 0.7889, 0.9395], [0.6034, 0.6584, 0.77], [0.3593, 0.3883, 0.4694], [0.257, 0.2712, 0.3346], [0.2501, 0.2625, 0.3373], [0.2709, 0.2821, 0.3527], [0.302, 0.3175, 0.3923], [0.4916, 0.5282, 0.6273]],
    [[0.6861, 0.7683, 0.9367], [0.5641, 0.6228, 0.7451], [0.354, 0.3759, 0.4552], [0.2692, 0.2735, 0.3277], [0.2479, 0.255, 0.3242], [0.273, 0.2783, 0.3426], [0.2783, 0.2987, 0.378], [0.4491, 0.4886, 0.5931]],
    [[0.5589, 0.6615, 0.8729], [0.4817, 0.5498, 0.6942], [0.2858, 0.3224, 0.4229], [0.2426, 0.2563, 0.3188], [0.1943, 0.2215, 0.3094], [0.2769, 0.282, 0.3426], [0.2196, 0.2529, 0.3507], [0.3226, 0.3874, 0.5331]],
    [[0.3743, 0.4775, 0.7217], [0.2858, 0.3598, 0.5375], [0.1965, 0.2342, 0.3407], [0.137, 0.1623, 0.2453], [0.123, 0.1502, 0.238], [0.1586, 0.1797, 0.262], [0.1411, 0.1734, 0.2723], [0.2171, 0.2772, 0.4253]],
    [[0.3102, 0.3914, 0.6139], [0.2036, 0.2651, 0.4327], [0.1389, 0.1679, 0.2589], [0.0707, 0.0906, 0.1624], [0.0587, 0.0791, 0.1527], [0.1037, 0.1227, 0.1947], [0.105, 0.129, 0.2099], [0.1801, 0.2256, 0.3513]],
    [[0.3816, 0.4387, 0.6235], [0.2265, 0.2739, 0.4151], [0.106, 0.1301, 0.2064], [0.0553, 0.0703, 0.126], [0.0492, 0.0638, 0.1193], [0.0982, 0.1122, 0.1699], [0.0965, 0.1162, 0.184], [0.124, 0.1635, 0.2732]],
    [[0.3888, 0.4242, 0.5571], [0.2713, 0.2986, 0.3977], [0.1338, 0.1512, 0.2123], [0.0769, 0.0893, 0.1365], [0.0733, 0.0848, 0.1312], [0.106, 0.1178, 0.1676], [0.1069, 0.1244, 0.1842], [0.1173, 0.1508, 0.2427]],
    [[0.1981, 0.2197, 0.2932], [0.1866, 0.2042, 0.2681], [0.1384, 0.153, 0.2057], [0.1119, 0.1247, 0.1718], [0.1101, 0.1222, 0.168], [0.1209, 0.1338, 0.1818], [0.1285, 0.1446, 0.1991], [0.1429, 0.1641, 0.2302]],
  ].flat(2),
);

/**
 * 云量偏置（加到噪声上，正 = 云更多）与云亮度（多次散射的白底，再乘云内明暗）。
 * 两张表的行 = 仰角带 90..60 / 60..35 / 35..15 / 15..0，列 = 方位扇区 45k..45k+45°（自 +x 轴起）；
 * 节点在各带中央，格子中央只受自己那一格影响。由 sky-fingerprint --fit 逐格标定。
 */
export const CLOUD_BIAS = [
  [0.299, 0.301, 0.254, 0.304, 0.362, 0.382, 0.35, 0.277],
  [-0.149, -0.013, 0.117, 0.288, 0.28, 0.22, 0.089, -0.003],
  [-0.117, -0.167, -0.099, -0.053, 0.14, 0.081, -0.049, -0.204],
  [-0.238, -0.174, -0.129, -0.193, -0.231, -0.04, -0.2, -0.199],
];
export const CLOUD_LIGHT = [
  [1.161, 0.886, 0.316, 0.88, 0.592, 0.571, 1.066, 0.273],
  [0.854, 0.738, 0.427, 0.193, 0.218, 0.402, 0.389, 0.375],
  [0.776, 0.428, 0.501, 0.029, 0.15, 0.347, 0.398, 0.638],
  [1.104, 0.643, 0.249, 0.281, 0.149, 0.39, 0.09, 0.206],
];

// --- 模型参数 ---
const DEG = Math.PI / 180;
const GLARE_START = 8; // 眩光开始让位给天空的角度
const GLARE_END = 12;
const GLARE_SUPER_COS = Math.cos(1.3 * DEG); // 日盘只有一两像素，范围内逐像素 6×6 超采样
const AUREOLE_END = SUN_AUREOLE[SUN_AUREOLE.length - 1][0];
const TILE_SIZE = 512;
const TILE_MASK = TILE_SIZE - 1;
const TILE_EXTENT = 9; // 一张瓦片在云底高度上覆盖的世界边长
const TILE_SCALE = TILE_SIZE / TILE_EXTENT;
const CLOUD_BASE = 1; // 云底高度（观察者在原点）
const CLOUD_THICKNESS = 0.4;
const CLOUD_THRESHOLD = 0.5;
const CLOUD_TOP_FADE = 0.12; // 阈值随高度抬升：厚的云柱才够得到云顶
const CLOUD_DENSITY = 10;
const CLOUD_EXTINCTION = 27;
const CLOUD_STEP = 0.1;
const CLOUD_MAX_STEPS = 8;
const CLOUD_NEAR = 4; // 细节瓦片开始淡出的距离
const CLOUD_FAR = 12; // 超过这个进入距离，云层按均匀介质处理
const CLOUD_SHEAR = [0.15, 0.067]; // 云顶相对云底的平移，给云体一点体积感
const CLOUD_SHADOW_OFFSETS = [0.09, 0.24];
const CLOUD_SHADOW_EXTINCTION = 1.6;
export const CLOUD_TINT = 0.7; // 云对周围天空色的反射比例

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const smooth = (t: number): number => t * t * (3 - 2 * t);
const smoothRange = (edge0: number, edge1: number, value: number): number =>
  smooth(Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0))));
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
/**
 * 等距或非等距节点表的下标与插值参数：value 落在相邻节点之间（t 从 0 到 1），越界停在端点。
 * 节点升序、降序都可以；晴空色表与云图表的带宽不等，所以按节点位置而不是按序号查。
 */
function nodeWeights(mids: readonly number[], value: number): [number, number] {
  const step = Math.sign(mids[1] - mids[0]);
  let k = 0;
  while (k < mids.length - 2 && step * (value - mids[k + 1]) >= 0) k++;
  return [k, clamp01((value - mids[k]) / (mids[k + 1] - mids[k]))];
}
/** 晴空色表的行节点（仰角，自上而下）与列节点（相对太阳方位）。 */
const CLEAR_ROWS = [85, 75, 65, 55, 45, 35, 25, 15, 7.5, 3.5, 1];
const CLEAR_COLUMNS = [15, 45, 75, 105, 135, 165];
/** 云图表的行节点：各行的中心在仰角 75 / 47.5 / 25 / 7.5°。 */
const CLOUD_ROWS = [75, 47.5, 25, 7.5];

/** 晴空色表每一行的方位平均色，天顶附近各方位收敛到它。 */
const CLEAR_ROW_MEAN = Array.from({ length: CLEAR_ROWS.length }, (_, row) =>
  Array.from({ length: 3 }, (_, c) => {
    let sum = 0;
    for (let col = 0; col < CLEAR_COLUMNS.length; col++) sum += CLEAR_SKY[(row * CLEAR_COLUMNS.length + col) * 3 + c];
    return sum / CLEAR_COLUMNS.length;
  }),
);
const GLARE_LOG = SUN_GLARE.map(([, r, g, b]) => [Math.log(r), Math.log(g), Math.log(b)]);
const LOWER_BANDS = [0, -2, -5, -10, -20, -30, -45, -60, -90].map((deg) => Math.sin(deg * DEG));
const LOWER_MID = LOWER_BANDS.slice(0, -1).map((y, k) => (y + LOWER_BANDS[k + 1]) / 2);
const SCRATCH = [0, 0, 0];

/** 径向眩光：相邻节点间在对数空间线性插值（跨度从 6 万到 1，线性插值会失真）。 */
function glareColour(theta: number, out: number[]): void {
  let k = 1;
  while (k < SUN_GLARE.length - 1 && SUN_GLARE[k][0] < theta) k++;
  const t = clamp01((theta - SUN_GLARE[k - 1][0]) / (SUN_GLARE[k][0] - SUN_GLARE[k - 1][0]));
  const a = GLARE_LOG[k - 1];
  const b = GLARE_LOG[k];
  for (let c = 0; c < 3; c++) out[c] = Math.exp(lerp(a[c], b[c], t));
}

/** 日晕：节点间线性插值，小于首个节点取首节点（那里由眩光盖过）。 */
function aureoleColour(theta: number, out: number[]): void {
  let k = 1;
  while (k < SUN_AUREOLE.length - 1 && SUN_AUREOLE[k][0] < theta) k++;
  const a = SUN_AUREOLE[k - 1];
  const b = SUN_AUREOLE[k];
  const t = clamp01((theta - a[0]) / (b[0] - a[0]));
  for (let c = 0; c < 3; c++) out[c] = lerp(a[c + 1], b[c + 1], t);
}

/** 固定种子的 xorshift32，保证每次生成逐位一致。 */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

interface CloudTiles {
  low: Float32Array;
  high: Float32Array;
}

let cloudTiles: CloudTiles | null = null;

/** 建两张可平铺的瓦片：低频决定云块，高频（均值为零）只修边。只在首次调用时算。 */
function buildTiles(): CloudTiles {
  if (cloudTiles) return cloudTiles;
  const random = createRandom(0x51ce7e);
  const periods = [4, 8, 16, 32, 4, 4, 32, 64];
  const lattices = periods.map((period) => {
    const grid = new Float32Array(period * period);
    for (let i = 0; i < grid.length; i++) grid[i] = random();
    return grid;
  });
  // 周期 value noise：格点每 period 格重复，瓦片因此无缝。
  const noise = (u: number, v: number, octave: number): number => {
    const period = periods[octave];
    const grid = lattices[octave];
    const fx = u * period;
    const fy = v * period;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const sx = tx * tx * tx * (tx * (tx * 6 - 15) + 10);
    const sy = ty * ty * ty * (ty * (ty * 6 - 15) + 10);
    const xa = x0 % period;
    const xb = (x0 + 1) % period;
    const ya = (y0 % period) * period;
    const yb = ((y0 + 1) % period) * period;
    const top = grid[ya + xa] + (grid[ya + xb] - grid[ya + xa]) * sx;
    const bottom = grid[yb + xa] + (grid[yb + xb] - grid[yb + xa]) * sx;
    return top + (bottom - top) * sy;
  };
  const low = new Float32Array(TILE_SIZE * TILE_SIZE);
  const high = new Float32Array(TILE_SIZE * TILE_SIZE);
  const wrap = (v: number): number => ((v % 1) + 1) % 1;
  for (let y = 0; y < TILE_SIZE; y++) {
    const v = y / TILE_SIZE;
    for (let x = 0; x < TILE_SIZE; x++) {
      const u = x / TILE_SIZE;
      // 域扭曲：把大尺度的噪声块拉出不规则的涡卷边。
      const wu = wrap(u + 0.1 * (noise(u, v, 4) - 0.5));
      const wv = wrap(v + 0.1 * (noise(u, v, 5) - 0.5));
      const i = y * TILE_SIZE + x;
      low[i] =
        (noise(wu, wv, 0) +
          0.5 * noise(wu, wv, 1) +
          0.25 * noise(wu, wv, 2) +
          0.125 * noise(wu, wv, 3)) /
        1.875;
      high[i] = 0.02 * (noise(wu, wv, 6) - 0.5) + 0.01 * (noise(wu, wv, 7) - 0.5);
    }
  }
  cloudTiles = { low, high };
  return cloudTiles;
}

function sampleTile(tile: Float32Array, px: number, pz: number): number {
  const u = px * TILE_SCALE;
  const v = pz * TILE_SCALE;
  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  const xa = x0 & TILE_MASK;
  const xb = (x0 + 1) & TILE_MASK;
  const row0 = (y0 & TILE_MASK) * TILE_SIZE;
  const row1 = ((y0 + 1) & TILE_MASK) * TILE_SIZE;
  const tx = u - x0;
  const ty = v - y0;
  const top = tile[row0 + xa] + (tile[row0 + xb] - tile[row0 + xa]) * tx;
  const bottom = tile[row1 + xa] + (tile[row1 + xb] - tile[row1 + xa]) * tx;
  return top + (bottom - top) * ty;
}

/** 按方向生成 equirect 像素：RGBA Float32，行 0 = 天顶。 */
export function generateSkyPixels(
  sunDir: SkySunDirection,
  options: SkyOptions = {},
): Float32Array {
  const width = Math.round(SKY_MAP_WIDTH / (options.scale ?? 1));
  const height = width >> 1;
  const half = height >> 1;
  const chart = options.cloudBias ?? CLOUD_BIAS;
  const lightChart = options.cloudLight ?? CLOUD_LIGHT;
  const pixels = new Float32Array(width * height * 4);
  const { low, high } = buildTiles();
  const sunLength = Math.hypot(...sunDir);
  const sx = sunDir[0] / sunLength;
  const sy = sunDir[1] / sunLength;
  const sz = sunDir[2] / sunLength;
  const sunAzimuth = Math.atan2(sz, sx);
  const glareStartCos = Math.cos(GLARE_START * DEG);

  // --- 逐列常量 ---
  const colCos = new Float32Array(width);
  const colSin = new Float32Array(width);
  const clearBase = new Int32Array(width); // 晴空色表列节点在数组里的下标
  const clearWeight = new Float32Array(width);
  const biasSector = new Int32Array(width);
  const biasWeight = new Float32Array(width);
  for (let col = 0; col < width; col++) {
    const phi = ((col + 0.5) / width - 0.5) * 2 * Math.PI;
    colCos[col] = Math.cos(phi);
    colSin[col] = Math.sin(phi);
    const azimuth = Math.atan2(colSin[col], colCos[col]);
    const deltaAzimuth = Math.abs(Math.atan2(Math.sin(azimuth - sunAzimuth), Math.cos(azimuth - sunAzimuth)));
    const [clearCol, clearT] = nodeWeights(CLEAR_COLUMNS, deltaAzimuth / DEG);
    clearBase[col] = clearCol * 3;
    clearWeight[col] = smooth(clearT);
    const sector = (((azimuth / (Math.PI / 4) - 0.5) % 8) + 8) % 8;
    biasSector[col] = Math.floor(sector);
    biasWeight[col] = smoothRange(0.25, 0.75, sector - Math.floor(sector)); // 只在格子边界附近过渡
  }

  // --- 上半球：晴空 + 日晕 + 云 + 太阳 ---
  for (let row = 0; row < half; row++) {
    const lat = (0.5 - (row + 0.5) / height) * Math.PI;
    const cosLat = Math.cos(lat);
    const dy = Math.sin(lat);
    const elevation = lat / DEG;
    const [clearRow0, clearRowT] = nodeWeights(CLEAR_ROWS, elevation);
    const clearRowW = smooth(clearRowT);
    const clearRow1 = clearRow0 + 1;
    const pole = Math.min(1, cosLat / Math.cos(85 * DEG)); // 天顶处各方位收敛
    const meanR = lerp(CLEAR_ROW_MEAN[clearRow0][0], CLEAR_ROW_MEAN[clearRow1][0], clearRowW);
    const meanG = lerp(CLEAR_ROW_MEAN[clearRow0][1], CLEAR_ROW_MEAN[clearRow1][1], clearRowW);
    const meanB = lerp(CLEAR_ROW_MEAN[clearRow0][2], CLEAR_ROW_MEAN[clearRow1][2], clearRowW);
    const [biasRow0, biasRowT] = nodeWeights(CLOUD_ROWS, elevation);
    const biasRowW = smoothRange(0.25, 0.75, biasRowT); // 只在带的边界附近过渡
    const biasRow1 = biasRow0 + 1;
    const chart0 = chart[biasRow0];
    const chart1 = chart[biasRow1];
    const light0 = lightChart[biasRow0];
    const light1 = lightChart[biasRow1];
    const entryDistance = CLOUD_BASE / dy;
    const pathLength = CLOUD_THICKNESS / dy;
    const steps = Math.min(CLOUD_MAX_STEPS, Math.max(3, Math.ceil(pathLength / CLOUD_STEP)));
    const stepLength = pathLength / steps;

    for (let col = 0; col < width; col++) {
      const x = cosLat * colCos[col];
      const z = cosLat * colSin[col];
      const base = clearBase[col];
      const wc = clearWeight[col];
      const i00 = clearRow0 * 18 + base;
      const i01 = i00 + 3;
      const i10 = clearRow1 * 18 + base;
      const i11 = i10 + 3;
      let r = lerp(
        lerp(CLEAR_SKY[i00], CLEAR_SKY[i01], wc),
        lerp(CLEAR_SKY[i10], CLEAR_SKY[i11], wc),
        clearRowW,
      );
      let g = lerp(
        lerp(CLEAR_SKY[i00 + 1], CLEAR_SKY[i01 + 1], wc),
        lerp(CLEAR_SKY[i10 + 1], CLEAR_SKY[i11 + 1], wc),
        clearRowW,
      );
      let b = lerp(
        lerp(CLEAR_SKY[i00 + 2], CLEAR_SKY[i01 + 2], wc),
        lerp(CLEAR_SKY[i10 + 2], CLEAR_SKY[i11 + 2], wc),
        clearRowW,
      );
      r = meanR + (r - meanR) * pole;
      g = meanG + (g - meanG) * pole;
      b = meanB + (b - meanB) * pole;

      const cosTheta = x * sx + dy * sy + z * sz;
      let thetaDeg = Math.acos(Math.min(1, cosTheta)) / DEG;
      if (thetaDeg < AUREOLE_END) {
        aureoleColour(thetaDeg, SCRATCH);
        r += SCRATCH[0];
        g += SCRATCH[1];
        b += SCRATCH[2];
      }
      if (cosTheta < glareStartCos) {
        // 云：前向合成。眼睛到云层的进入距离越远，细节越少。
        const sector0 = biasSector[col];
        const sector1 = (sector0 + 1) % 8;
        const bw = biasWeight[col];
        const bias = lerp(
          lerp(chart0[sector0], chart0[sector1], bw),
          lerp(chart1[sector0], chart1[sector1], bw),
          biasRowW,
        );
        const white = lerp(
          lerp(light0[sector0], light0[sector1], bw),
          lerp(light1[sector0], light1[sector1], bw),
          biasRowW,
        );
        let transmit = 1;
        let cloudR = 0;
        let cloudG = 0;
        let cloudB = 0;
        if (entryDistance < CLOUD_FAR) {
          const hash = Math.imul(col, 73856093) ^ Math.imul(row, 19349663);
          const jitter = ((hash ^ (hash >>> 13)) >>> 0) % 1024 / 1024;
          for (let s = 0; s < steps; s++) {
            const t = entryDistance + (s + jitter) * stepLength;
            const px = x * t;
            const pz = z * t;
            const h = (t * dy - CLOUD_BASE) / CLOUD_THICKNESS;
            const detail = 1 - smoothRange(CLOUD_NEAR, CLOUD_FAR, t);
            const noise =
              sampleTile(low, px + CLOUD_SHEAR[0] * h, pz + CLOUD_SHEAR[1] * h) +
              (detail > 0 ? detail * sampleTile(high, px, pz) : 0);
            const n = noise + bias - CLOUD_THRESHOLD - CLOUD_TOP_FADE * h * h;
            if (n <= 0) continue;
            const alpha = 1 - Math.exp(-n * CLOUD_DENSITY * stepLength * CLOUD_EXTINCTION);
            let occlusion = 0;
            for (const offset of CLOUD_SHADOW_OFFSETS) {
              const hs = h + offset * sy / CLOUD_THICKNESS;
              if (hs >= 1) continue;
              const ns =
                sampleTile(low, px + offset * sx + CLOUD_SHEAR[0] * hs, pz + offset * sz + CLOUD_SHEAR[1] * hs) +
                bias - CLOUD_THRESHOLD - CLOUD_TOP_FADE * hs * hs;
              if (ns > 0) occlusion += ns;
            }
            const shade = (0.8 + 0.4 * h) * (0.6 + 0.8 * Math.exp(-occlusion * CLOUD_DENSITY * CLOUD_SHADOW_EXTINCTION));
            const weight = transmit * alpha;
            cloudR += weight * (CLOUD_TINT * r + white * shade);
            cloudG += weight * (CLOUD_TINT * g + white * shade);
            cloudB += weight * (CLOUD_TINT * b + white * shade);
            transmit -= weight;
            if (transmit < 0.01) {
              transmit = 0;
              break;
            }
          }
        }
        // 步进没走完的剩余路径：在中点取一个样品，按均匀厚板估算，远处的云才留得住块状结构。
        const rest = pathLength - steps * stepLength;
        if (transmit > 0 && rest > 0) {
          const t = entryDistance + steps * stepLength + rest / 2;
          const h = (t * dy - CLOUD_BASE) / CLOUD_THICKNESS;
          const px = x * t;
          const pz = z * t;
          const n =
            sampleTile(low, px + CLOUD_SHEAR[0] * h, pz + CLOUD_SHEAR[1] * h) +
            bias - CLOUD_THRESHOLD - CLOUD_TOP_FADE * h * h;
          if (n > 0) {
            let occlusion = 0;
            for (const offset of CLOUD_SHADOW_OFFSETS) {
              const hs = h + offset * sy / CLOUD_THICKNESS;
              if (hs >= 1) continue;
              const ns =
                sampleTile(low, px + offset * sx + CLOUD_SHEAR[0] * hs, pz + offset * sz + CLOUD_SHEAR[1] * hs) +
                bias - CLOUD_THRESHOLD - CLOUD_TOP_FADE * hs * hs;
              if (ns > 0) occlusion += ns;
            }
            const shade = (0.8 + 0.4 * h) * (0.6 + 0.8 * Math.exp(-occlusion * CLOUD_DENSITY * CLOUD_SHADOW_EXTINCTION));
            const weight = transmit * (1 - Math.exp(-n * CLOUD_DENSITY * rest * CLOUD_EXTINCTION));
            cloudR += weight * (CLOUD_TINT * r + white * shade);
            cloudG += weight * (CLOUD_TINT * g + white * shade);
            cloudB += weight * (CLOUD_TINT * b + white * shade);
            transmit -= weight;
          }
        }
        r = cloudR + transmit * r;
        g = cloudG + transmit * g;
        b = cloudB + transmit * b;
      }

      // 太阳：θ<GLARE_END 内取实测径向剖面与天空的较亮者（剖面的环带均值本身含天空）；
      // 日盘只有一两像素，近处逐像素 6×6 超采样。
      if (thetaDeg < GLARE_END) {
        if (cosTheta >= GLARE_SUPER_COS) {
          let gr = 0;
          let gg = 0;
          let gb = 0;
          for (let j = 0; j < 6; j++) {
            const subLat = (0.5 - (row + (j + 0.5) / 6) / height) * Math.PI;
            const subCos = Math.cos(subLat);
            const subY = Math.sin(subLat);
            for (let i = 0; i < 6; i++) {
              const subPhi = ((col + (i + 0.5) / 6) / width - 0.5) * 2 * Math.PI;
              const subCosTheta =
                subCos * Math.cos(subPhi) * sx + subY * sy + subCos * Math.sin(subPhi) * sz;
              glareColour(Math.acos(Math.min(1, subCosTheta)) / DEG, SCRATCH);
              gr += SCRATCH[0];
              gg += SCRATCH[1];
              gb += SCRATCH[2];
            }
          }
          SCRATCH[0] = gr / 36;
          SCRATCH[1] = gg / 36;
          SCRATCH[2] = gb / 36;
          thetaDeg = 0;
        } else {
          glareColour(thetaDeg, SCRATCH);
        }
        const glareFade = 1 - smoothRange(GLARE_START, GLARE_END, thetaDeg);
        if (glareFade > 0) {
          r = Math.max(r, SCRATCH[0] * glareFade);
          g = Math.max(g, SCRATCH[1] * glareFade);
          b = Math.max(b, SCRATCH[2] * glareFade);
        }
      }

      const o = (row * width + col) * 4;
      pixels[o] = r;
      pixels[o + 1] = g;
      pixels[o + 2] = b;
      pixels[o + 3] = 1;
    }
  }

  // --- 下半球：实测色表。仰角带之间沿带中点平滑过渡，方位扇区节点在扇区中央、线性过渡 ---
  const columns = 8;
  const sectors = new Int32Array(width);
  const sectorWeights = new Float32Array(width);
  for (let col = 0; col < width; col++) {
    // 列 0 在方位 -180°，扇区 0 从 +x 轴起，所以先转半圈再取扇区位置
    const binPos = ((col + 0.5) / width) * columns - columns / 2 - 0.5;
    sectors[col] = ((Math.floor(binPos) % columns) + columns) % columns;
    sectorWeights[col] = binPos - Math.floor(binPos);
  }
  for (let row = half; row < height; row++) {
    const y = Math.sin((0.5 - (row + 0.5) / height) * Math.PI);
    let k = 0;
    while (k < LOWER_MID.length - 2 && LOWER_MID[k + 1] >= y) k++;
    const w = LOWER_MID[k] <= y ? 0 : smooth(Math.min(1, (LOWER_MID[k] - y) / (LOWER_MID[k] - LOWER_MID[k + 1])));
    const band0 = k * columns * 3;
    const band1 = band0 + columns * 3;
    for (let col = 0; col < width; col++) {
      const p0 = sectors[col] * 3;
      const p1 = ((sectors[col] + 1) % columns) * 3;
      const sw = sectorWeights[col];
      const o = (row * width + col) * 4;
      for (let c = 0; c < 3; c++) {
        pixels[o + c] = lerp(
          lerp(LOWER_SKY[band0 + p0 + c], LOWER_SKY[band0 + p1 + c], sw),
          lerp(LOWER_SKY[band1 + p0 + c], LOWER_SKY[band1 + p1 + c], sw),
          w,
        );
      }
      pixels[o + 3] = 1;
    }
  }
  return pixels;
}
