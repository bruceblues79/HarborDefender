/// <reference types="vite/client" />
/// <reference types="@iwsdk/vite-plugin-dev/client" />

/** Build revision from package.json, injected by the Vite define in vite.config.ts. */
declare const __BUILD_VERSION__: string;

/** 单文件预览构建内联的 public/ 资源；正式构建里是 null。 */
declare const __PREVIEW_ASSETS__: Record<string, string> | null;
