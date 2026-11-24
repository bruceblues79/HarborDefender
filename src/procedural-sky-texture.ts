/**
 * 运行时天空纹理：在 Worker 里生成 equirect 像素，转成 HalfFloat DataTexture。
 * 取代原先下载的 HDRI 全景图，照明数值按那一张逐项标定（scripts/sky-fingerprint.mjs）。
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
import type { DirectionalLight, Texture, World } from '@iwsdk/core';
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
 * 场景主光没取到时的太阳状态，与 main.iwsdk.scene.json 的 sun-light 一致：
 * 傍晚前的暖光，太阳在海面上方偏左 30°、高度约 20°。
 */
const SUN_LIGHT_FALLBACK: SunLightState = {
  direction: [-0.4698, 0.342, -0.8138],
  color: [1, 0.84, 0.64],
  intensity: 4.8,
};

export interface SunLightState {
  /** 单位向量，指向太阳（世界空间）。 */
  direction: SkySunDirection;
  /** 主光颜色（线性 RGB，与天空贴图同一空间）。 */
  color: readonly [number, number, number];
  intensity: number;
}

/**
 * 主光的颜色与强度（方向取主光的 world +Z：DirectionalLight 沿本地 -Z 发光，+Z 指向太阳）。
 */
export function resolveSunLight(world: World): SunLightState {
  const sunLight = world.getSceneObject('sun-light') as DirectionalLight | null;
  if (!sunLight || !sunLight.isDirectionalLight) return SUN_LIGHT_FALLBACK;
  const direction = sunLight.getWorldDirection(new Vector3());
  return {
    direction: [direction.x, direction.y, direction.z],
    color: [sunLight.color.r, sunLight.color.g, sunLight.color.b],
    intensity: sunLight.intensity,
  };
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

/**
 * 生成天空 equirect 纹理，供天幕采样、海面 cubemap 与 PMREM 环境光共用。
 * sunDir 必须是生成器标定时的太阳方向，照明常量只对这一个方向准确。
 */
export async function createSkyTexture(sunDir: SkySunDirection): Promise<Texture> {
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
  // HalfFloat 上限 65504，日盘核心（G≈66235）略超，先夹住再转，否则 toHalfFloat 每个通道报一次越界。
  for (let i = 0; i < pixels.length; i++) {
    half[i] = DataUtils.toHalfFloat(Math.min(pixels[i], 65504));
  }

  const texture = new DataTexture(
    half,
    SKY_MAP_WIDTH,
    SKY_MAP_HEIGHT,
    RGBAFormat,
    HalfFloatType,
  );
  // 行 0 在天顶（与 equirect 采样约定一致）、线性色彩空间、线性过滤。
  texture.flipY = true;
  texture.colorSpace = LinearSRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.mapping = EquirectangularReflectionMapping;
  texture.needsUpdate = true;
  return texture;
}
