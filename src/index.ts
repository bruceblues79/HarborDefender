/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { UIKitMLAsset, World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { CameraLookSystem } from './camera-look-system.js';

World.create(
  document.getElementById('scene-container') as HTMLDivElement,
  projectOptions,
).then((world) => {
  // Register camera drag-to-look system (browser mode only)
  world.registerSystem(CameraLookSystem);

  // Bind "ENTER GAME" button on the panel (reserved interface)
  const panel = world.getSceneObject<UIKitMLAsset>('welcome-panel');
  const enterGameButton = panel?.getElementById('enter-game-button');
  enterGameButton?.addEventListener('click', () => {
    console.log('ENTER GAME clicked — interface reserved, game entry TBD');
  });
});
