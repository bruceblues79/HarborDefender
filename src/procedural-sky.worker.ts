/**
 * 天空生成 Worker：把 1536×768 的天空计算挪出主线程，loading 面板照常动画。
 * 像素以 RGBA Float32Array 回传（transferable），主线程再转 HalfFloat 上传。
 */

import {
  SKY_MAP_HEIGHT,
  SKY_MAP_WIDTH,
  generateSkyPixels,
} from './procedural-sky.js';
import type { SkySunDirection } from './procedural-sky.js';

export type SkyWorkerRequest = { sunDir: SkySunDirection };
export type SkyWorkerResponse = {
  width: number;
  height: number;
  pixels: Float32Array;
};

/** tsconfig 只带 DOM lib，这里声明用到的 DedicatedWorkerGlobalScope 子集。 */
interface SkyWorkerScope {
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<SkyWorkerRequest>) => void,
  ): void;
  postMessage(message: SkyWorkerResponse, transfer: Transferable[]): void;
}

const scope = self as unknown as SkyWorkerScope;

scope.addEventListener('message', (event) => {
  const pixels = generateSkyPixels(event.data.sunDir);
  scope.postMessage(
    { width: SKY_MAP_WIDTH, height: SKY_MAP_HEIGHT, pixels },
    [pixels.buffer as ArrayBuffer],
  );
});
