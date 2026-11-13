/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { AssetType, defineAssets } from '@iwsdk/core';

const publicAssetUrl = (filePath: string): string =>
  `${import.meta.env.BASE_URL}${filePath.replace(/^\/+/u, '')}`;

// Resources served from public/ with no Cache-Control can stay stale in a
// client's HTTP cache across deploys (seen on Huawei Browser). Versioning the
// URL makes every deploy a fresh resource. Binary assets normally keep
// unversioned URLs (glTF is renamed for incompatible swaps); the ocean carrier
// changed in place, so it opts in.
const versionedAssetUrl = (filePath: string): string =>
  `${publicAssetUrl(filePath)}?v=${__BUILD_VERSION__}`;

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
  // Key must end with ".hdr": IWSDK's EnvironmentSystem sniffs the file type
  // from the raw src suffix BEFORE resolving manifest keys, so a key without
  // the extension would be loaded as a plain (non-decodable) texture.
  'ocean-env.hdr': {
    url: publicAssetUrl('textures/kloofendal_partly_cloudy_puresky_1k.hdr'),
    type: AssetType.HDRTexture,
    name: 'Ocean Environment HDR',
    priority: 'background',
  },
  'ocean-body': {
    url: versionedAssetUrl('gltf/ocean-body.glb'),
    type: AssetType.GLTF,
    name: 'Ocean Body',
    priority: 'background',
  },
  'harbor-wall': {
    url: publicAssetUrl('gltf/harbor-wall.glb'),
    type: AssetType.GLTF,
    name: 'Harbor Wall',
    priority: 'background',
  },
  cannon: {
    url: publicAssetUrl('gltf/cannon.glb'),
    type: AssetType.GLTF,
    name: 'Cannon',
    priority: 'background',
  },
  'iron-guard': {
    url: publicAssetUrl('gltf/iron-guard.glb'),
    type: AssetType.GLTF,
    name: 'Iron Guard',
    priority: 'background',
  },
  'defense-pad': {
    url: publicAssetUrl('gltf/defense-pad.glb'),
    type: AssetType.GLTF,
    name: 'Defense Pad',
    priority: 'background',
  },
  'pirate-ship': {
    url: publicAssetUrl('gltf/pirate-ship-v2.glb'),
    type: AssetType.GLTF,
    name: 'Pirate Ship',
    priority: 'background',
  },
  bombardier: {
    url: publicAssetUrl('gltf/bombardier-v3.glb'),
    type: AssetType.GLTF,
    name: 'Bombardier',
    priority: 'background',
  },
  ornithopter: {
    url: publicAssetUrl('gltf/ornithopter.glb'),
    type: AssetType.GLTF,
    name: 'Ornithopter',
    priority: 'background',
  },
  'boss-islewrath': {
    url: publicAssetUrl('gltf/boss-islewrath-v3.glb'),
    type: AssetType.GLTF,
    name: 'Boss Islewrath',
    priority: 'background',
  },
  'pirate-chief': {
    url: publicAssetUrl('gltf/pirate-chief.glb'),
    type: AssetType.GLTF,
    name: 'Pirate Chief',
    priority: 'background',
  },
});
