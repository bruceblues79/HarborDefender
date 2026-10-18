/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { AssetType, defineAssets } from '@iwsdk/core';

const publicAssetUrl = (filePath: string): string =>
  `${import.meta.env.BASE_URL}${filePath.replace(/^\/+/u, '')}`;

export default defineAssets({
  'welcome-panel': {
    url: publicAssetUrl('ui/welcome.uikitml'),
    type: AssetType.UIKitML,
    name: 'Welcome Panel',
    priority: 'critical',
  },
  'loading-panel': {
    url: publicAssetUrl('ui/loading.uikitml'),
    type: AssetType.UIKitML,
    name: 'Loading Panel',
    priority: 'critical',
  },
  'start-panel': {
    url: publicAssetUrl('ui/start.uikitml'),
    type: AssetType.UIKitML,
    name: 'Start Panel',
    priority: 'critical',
  },
  'menu-call': {
    url: publicAssetUrl('ui/menu-call.uikitml'),
    type: AssetType.UIKitML,
    name: 'Menu Call',
    priority: 'critical',
  },
  'pause-menu': {
    url: publicAssetUrl('ui/pause-menu.uikitml'),
    type: AssetType.UIKitML,
    name: 'Pause Menu',
    priority: 'critical',
  },
  'result-panel': {
    url: publicAssetUrl('ui/result.uikitml'),
    type: AssetType.UIKitML,
    name: 'Result Panel',
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
  'pirate-ship': {
    url: publicAssetUrl('gltf/pirate-ship-v2.glb'),
    type: AssetType.GLTF,
    name: 'Pirate Ship',
    priority: 'background',
  },
});
