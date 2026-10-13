/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { UIKitMLAsset, World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { startBattle } from './battle-setup.js';
import { CameraOrbitSystem } from './camera-orbit-system.js';
import { OceanSystem } from './ocean-system.js';
import { installXRButton } from './xr-button.js';

World.create(
  document.getElementById('scene-container') as HTMLDivElement,
  projectOptions,
).then((world) => {
  world.registerSystem(CameraOrbitSystem);
  world.registerSystem(OceanSystem);
  installXRButton(world);

  const panel = world.getSceneObject<UIKitMLAsset>('welcome-panel');
  panel
    ?.getElementById('enter-game-button')
    ?.addEventListener('click', () => startBattle(world));
});
