/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { AssetType, defineAssets } from '@iwsdk/core';

const publicAssetUrl = (filePath: string): string =>
  `${import.meta.env.BASE_URL}${filePath.replace(/^\/+/u, '')}`;

// UI documents are fetched by URL at runtime, and nginx sends no Cache-Control
// for them, so a client may reuse a stale copy across deploys (seen on Huawei
// Browser). Versioning the URL makes every deploy a fresh resource. Binary
// assets keep unversioned URLs: glTF is renamed for incompatible swaps, and
// the HDR is sniffed by key suffix.
const uiAssetUrl = (filePath: string): string =>
  `${publicAssetUrl(filePath)}?v=${__BUILD_VERSION__}`;

export default defineAssets({
  'welcome-panel': {
    url: uiAssetUrl('ui/welcome.uikitml'),
    type: AssetType.UIKitML,
    name: 'Welcome Panel',
    priority: 'critical',
  },
  'loading-panel': {
    url: uiAssetUrl('ui/loading.uikitml'),
    type: AssetType.UIKitML,
    name: 'Loading Panel',
    priority: 'critical',
  },
  'start-panel': {
    url: uiAssetUrl('ui/start.uikitml'),
    type: AssetType.UIKitML,
    name: 'Start Panel',
    priority: 'critical',
  },
  'menu-call': {
    url: uiAssetUrl('ui/menu-call.uikitml'),
    type: AssetType.UIKitML,
    name: 'Menu Call',
    priority: 'critical',
  },
  'pause-menu': {
    url: uiAssetUrl('ui/pause-menu.uikitml'),
    type: AssetType.UIKitML,
    name: 'Pause Menu',
    priority: 'critical',
  },
  'result-panel': {
    url: uiAssetUrl('ui/result.uikitml'),
    type: AssetType.UIKitML,
    name: 'Result Panel',
    priority: 'critical',
  },
  'intermission-panel': {
    url: uiAssetUrl('ui/intermission.uikitml'),
    type: AssetType.UIKitML,
    name: 'Intermission Panel',
    priority: 'critical',
  },
  'build-panel': {
    url: uiAssetUrl('ui/build-panel.uikitml'),
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
    url: publicAssetUrl('gltf/ocean-body.glb'),
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
  'sky-ballista': {
    url: publicAssetUrl('gltf/sky-ballista.glb'),
    type: AssetType.GLTF,
    name: 'Sky Ballista',
    priority: 'background',
  },
  'defense-button-build': {
    url: publicAssetUrl('gltf/defense-button-build.glb'),
    type: AssetType.GLTF,
    name: 'Defense Button Build',
    priority: 'background',
  },
  'defense-button-repair': {
    url: publicAssetUrl('gltf/defense-button-repair.glb'),
    type: AssetType.GLTF,
    name: 'Defense Button Repair',
    priority: 'background',
  },
  'defense-pad': {
    url: publicAssetUrl('gltf/defense-pad.glb'),
    type: AssetType.GLTF,
    name: 'Defense Pad',
    priority: 'background',
  },
  'ballista-bolt': {
    url: publicAssetUrl('gltf/ballista-bolt.glb'),
    type: AssetType.GLTF,
    name: 'Ballista Bolt',
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
