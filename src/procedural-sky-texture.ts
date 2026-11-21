/**
 * 运行时天空纹理：在 Worker 里生成 equirect 像素，转成 HalfFloat DataTexture。
 * 取代原先下载 public/textures/procedural_sky_1k.hdr 的静态资源路径。
 *
 * Worker 起不来时（极少数环境）退回主线程同步生成：会卡住 loading 面板一次，
 * 但保证战斗一定能进。
 */

import {
  DataTexture,
  DataUtils,
  EquirectangularReflectionMapping,
  HalfFloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  RGBAFormat,
  Vector3,
} from '@iwsdk/core';
import type { Texture, World } from '@iwsdk/core';
import {
  SKY_MAP_HEIGHT,
  SKY_MAP_WIDTH,
  generateSkyPixels,
} from './procedural-sky.js';
// inline：Worker 打成 Blob，单文件 html 里没有独立的 worker 文件可加载。
import SkyWorker from './procedural-sky.worker.ts?worker&inline';
import type { SkySunDirection } from './procedural-sky.js';
import type {
  SkyWorkerRequest,
  SkyWorkerResponse,
} from './procedural-sky.worker.js';

/**
 * 场景主光没取到时的太阳方向，与 main.iwsdk.scene.json 的 sun-light 旋转
 * （-46°, -30°, 0）一致：下午三点，太阳在 +Z 一侧偏 -X 约 40°，高度约 38°。
 */
const SUN_DIRECTION_FALLBACK: SkySunDirection = [-0.5, 0.623, 0.602];

/**
 * 太阳方向取自主光的 world +Z（DirectionalLight 沿本地 -Z 发光，+Z 指向太阳），
 * 云的高光边因此永远跟着场景光照走。
 */
function resolveSunDirection(world: World): SkySunDirection {
  const sunLight = world.getSceneObject('sun-light');
  if (!sunLight) return SUN_DIRECTION_FALLBACK;
  const direction = sunLight.getWorldDirection(new Vector3());
  return [direction.x, direction.y, direction.z];
}

function requestSkyPixels(sunDir: SkySunDirection): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new SkyWorker();
    } catch (error) {
      reject(error);
      return;
    }

    worker.addEventListener(
      'message',
      (event: MessageEvent<SkyWorkerResponse>) => {
        worker.terminate();
        resolve(event.data.pixels);
      },
    );
    worker.addEventListener('error', (event) => {
      worker.terminate();
      reject(event.error ?? new Error(event.message));
    });
    worker.postMessage({ sunDir } satisfies SkyWorkerRequest);
  });
}

/** 生成天空 equirect 纹理，供天幕采样、海面 cubemap 与 PMREM 环境光共用。 */
export async function createSkyTexture(world: World): Promise<Texture> {
  const sunDir = resolveSunDirection(world);

  let pixels: Float32Array;
  try {
    pixels = await requestSkyPixels(sunDir);
  } catch (error) {
    console.warn(
      'Procedural sky worker unavailable; generating on the main thread.',
      error,
    );
    pixels = generateSkyPixels(sunDir);
  }

  const half = new Uint16Array(pixels.length);
  for (let i = 0; i < pixels.length; i++) {
    half[i] = DataUtils.toHalfFloat(pixels[i]);
  }

  const texture = new DataTexture(
    half,
    SKY_MAP_WIDTH,
    SKY_MAP_HEIGHT,
    RGBAFormat,
    HalfFloatType,
  );
  // 与原先 HDRLoader 的输出保持一致：行 0 在天顶、线性色彩空间、线性过滤。
  texture.flipY = true;
  texture.colorSpace = LinearSRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.mapping = EquirectangularReflectionMapping;
  texture.needsUpdate = true;
  return texture;
}
