/**
 * 单文件预览专用：file:// 页面是 null origin，浏览器会拒绝 Blob Worker，
 * uikit 的字体就无法从 TTF 转成 MSDF。这里把 worker 源码直接在当前页面里
 * 求值，拿到生成器实例同步调用，绕开 Worker。
 *
 * 只在 vite.single.config.ts 里被注入，正式构建不会引用。
 */

type MSDFOptions = Record<string, unknown>;

interface MSDFWorkerInstance {
  initialize(wasmUrl?: string): Promise<void>;
  generate(options: MSDFOptions): Promise<unknown>;
}

export interface InlineMSDF {
  initialize(wasmUrl?: string): Promise<void>;
  generate(options: MSDFOptions): Promise<unknown>;
  dispose(): Promise<void>;
}

export function createInlineMSDF(workerSource: string, wasmUrl: string): InlineMSDF {
  const scope = globalThis as unknown as Record<string, unknown>;
  scope.__PREVIEW_SCRIPT_URL__ = typeof location === 'undefined' ? '' : location.href;

  const source = workerSource
    .replace(/import\.meta\.url/gu, 'globalThis.__PREVIEW_SCRIPT_URL__')
    .replace('expose(new MSDFGeneratorWorker());', 'return MSDFGeneratorWorker;');

  const factory = new Function(source) as () => new () => MSDFWorkerInstance;
  const instance = new (factory())();

  return {
    initialize: (url?: string) => instance.initialize(url ?? wasmUrl),
    generate: (options: MSDFOptions) => instance.generate(options),
    dispose: async () => {},
  };
}
