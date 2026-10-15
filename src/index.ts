/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { UIKitMLAsset, World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { BillboardSystem } from './billboard-system.js';
import { startBattle } from './battle-setup.js';
import { CameraOrbitSystem } from './camera-orbit-system.js';
import { Billboard } from './components.js';
import { LevelWaveSystem } from './level-wave-system.js';
import { OceanSystem } from './ocean-system.js';
import { PanelScaleSystem } from './panel-scale-system.js';
import { ShipMovementSystem } from './ship-movement-system.js';
import { StartPanelSystem } from './start-panel-system.js';
import { installXRButton } from './xr-button.js';

World.create(
  document.getElementById('scene-container') as HTMLDivElement,
  projectOptions,
).then((world) => {
  world.registerSystem(CameraOrbitSystem);
  world.registerSystem(OceanSystem);
  // Simulation tier: the director paces dispatch, movement runs the ships in.
  world.registerSystem(LevelWaveSystem, { priority: 5 });
  world.registerSystem(ShipMovementSystem, { priority: 10 });
  // UI tier, after the camera updates so billboards track this frame's view.
  world.registerSystem(PanelScaleSystem, { priority: 30 });
  world.registerSystem(StartPanelSystem, { priority: 30 });
  world.registerSystem(BillboardSystem, { priority: 31 });
  installXRButton(world);

  // Keep the welcome panel turned toward the viewer in browser and XR alike.
  world.getSceneEntity('welcome-panel')?.addComponent(Billboard);

  const panel = world.getSceneObject<UIKitMLAsset>('welcome-panel');
  panel
    ?.getElementById('enter-game-button')
    ?.addEventListener('click', () => startBattle(world));
});
