/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { AssetType, defineAssets } from '@iwsdk/core';

// 单文件预览构建里 public/ 不存在，URL 换成构建期内联的 data URL。
const inlineAsset = (filePath: string): string | null =>
  __PREVIEW_ASSETS__?.[filePath.replace(/^\/+/u, '')] ?? null;

const publicAssetUrl = (filePath: string): string =>
  inlineAsset(filePath) ?? `${import.meta.env.BASE_URL}${filePath.replace(/^\/+/u, '')}`;

// Resources served from public/ with no Cache-Control can stay stale in a
// client's HTTP cache across deploys (seen on Huawei Browser). Versioning the
// URL makes every deploy a fresh resource. Binary assets normally keep
// unversioned URLs (glTF is renamed for incompatible swaps); the ocean carrier
// changed in place, so it opts in.
const versionedAssetUrl = (filePath: string): string =>
  inlineAsset(filePath) ?? `${publicAssetUrl(filePath)}?v=${__BUILD_VERSION__}`;

export default defineAssets({
  'welcome-panel': {
    url: versionedAssetUrl('ui/welcome.uikitml'),
    type: AssetType.UIKitML,
    name: 'Welcome Panel',
    priority: 'critical',
  },
  'loading-panel': {
    url: versionedAssetUrl('ui/loading.uikitml'),
    type: AssetType.UIKitML,
    name: 'Loading Panel',
    priority: 'critical',
  },
  'start-panel': {
    url: versionedAssetUrl('ui/start.uikitml'),
    type: AssetType.UIKitML,
    name: 'Start Panel',
    priority: 'critical',
  },
  'menu-call': {
    url: versionedAssetUrl('ui/menu-call.uikitml'),
    type: AssetType.UIKitML,
    name: 'Menu Call',
    priority: 'critical',
  },
  'pause-menu': {
    url: versionedAssetUrl('ui/pause-menu.uikitml'),
    type: AssetType.UIKitML,
    name: 'Pause Menu',
    priority: 'critical',
  },
  'result-panel': {
    url: versionedAssetUrl('ui/result.uikitml'),
    type: AssetType.UIKitML,
    name: 'Result Panel',
    priority: 'critical',
  },
  'intermission-panel': {
    url: versionedAssetUrl('ui/intermission.uikitml'),
    type: AssetType.UIKitML,
    name: 'Intermission Panel',
    priority: 'critical',
  },
  'build-panel': {
    url: versionedAssetUrl('ui/build-panel.uikitml'),
    type: AssetType.UIKitML,
    name: 'Build Panel',
    priority: 'critical',
  },
});
