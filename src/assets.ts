/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { AssetType, defineAssets } from '@iwsdk/core';
import { createCannon } from './scene-assets/cannon.scene-asset.js';
import { createHarborWall } from './scene-assets/harbor-wall.scene-asset.js';
import { createOceanBody } from './scene-assets/ocean.scene-asset.js';

const publicAssetUrl = (filePath: string): string =>
  `${import.meta.env.BASE_URL}${filePath.replace(/^\/+/u, '')}`;

export default defineAssets({
  'welcome-panel': {
    url: publicAssetUrl('ui/welcome.uikitml'),
    type: AssetType.UIKitML,
    name: 'Welcome Panel',
  },
  'loading-panel': {
    url: publicAssetUrl('ui/loading.uikitml'),
    type: AssetType.UIKitML,
    name: 'Loading Panel',
  },
  'ocean-env-hdr': {
    url: publicAssetUrl('textures/kloofendal_partly_cloudy_puresky_1k.hdr'),
    type: AssetType.HDRTexture,
    name: 'Ocean Environment HDR',
  },
  'ocean-body': createOceanBody(),
  'harbor-wall': createHarborWall(),
  cannon: createCannon(),
});
