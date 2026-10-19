/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { UIKitMLAsset, World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { BallisticSystem } from './ballistic-system.js';
import { BillboardSystem } from './billboard-system.js';
import { startBattle } from './battle-setup.js';
import { CameraOrbitSystem } from './camera-orbit-system.js';
import { CannonAimSystem } from './cannon-aim-system.js';
import { CannonFireSystem } from './cannon-fire-system.js';
import { Billboard } from './components.js';
import { HitFlashSystem } from './hit-flash-system.js';
import { HealthBarSystem } from './health-bar-system.js';
import { LevelWaveSystem } from './level-wave-system.js';
import { MenuSystem } from './menu-system.js';
import { OceanSystem } from './ocean-system.js';
import { PanelScaleSystem } from './panel-scale-system.js';
import { PirateFireSystem } from './pirate-fire-system.js';
import { ResultPanelSystem } from './result-panel-system.js';
import { ShellHitSystem } from './shell-hit-system.js';
import { ShipMovementSystem } from './ship-movement-system.js';
import { SpawnFadeSystem } from './spawn-fade-system.js';
import { SplashSystem } from './splash-system.js';
import { StartPanelSystem } from './start-panel-system.js';
import { installXRButton } from './xr-button.js';

World.create(
  document.getElementById('scene-container') as HTMLDivElement,
  projectOptions,
).then((world) => {
  world.registerSystem(CameraOrbitSystem);
  world.registerSystem(OceanSystem);
  // Simulation tier: the director paces dispatch, movement runs the ships in
  // while the fade system materialises their hulls in parallel.
  world.registerSystem(LevelWaveSystem, { priority: 5 });
  world.registerSystem(CannonAimSystem, { priority: 8 });
  world.registerSystem(ShipMovementSystem, { priority: 10 });
  // Both fire systems draw from one shell pool at the same priority; pirate
  // is registered second and its live hasComponent guard keeps the two from
  // ever handing out the same shell in a frame.
  world.registerSystem(CannonFireSystem, { priority: 11 });
  world.registerSystem(PirateFireSystem, { priority: 11 });
  world.registerSystem(SpawnFadeSystem, { priority: 12 });
  // Move first, then consume solid-target hits, then handle water splashes.
  world.registerSystem(BallisticSystem, { priority: 13 });
  world.registerSystem(ShellHitSystem, { priority: 14 });
  world.registerSystem(HitFlashSystem, { priority: 15 });
  world.registerSystem(SplashSystem, { priority: 15 });
  // UI tier, after the camera updates so billboards track this frame's view.
  world.registerSystem(PanelScaleSystem, { priority: 30 });
  world.registerSystem(StartPanelSystem, { priority: 30 });
  // Pause-menu orchestrator: watches GameStarted, owns the pause tag and the
  // head-following call button / menu panels.
  world.registerSystem(MenuSystem, { priority: 32 });
  // End-of-run result panel: qualifies on GameOver (victory / defeat) and
  // hands RESTART / MAIN to MenuSystem's shared reset sequences.
  world.registerSystem(ResultPanelSystem, { priority: 33 });
  world.registerSystem(BillboardSystem, { priority: 31 });
  // Health bars: after the simulation tier so each frame's yaw cancels the
  // unit's freshest rotation; keeps billboarding through pauses like the
  // other viewer-facing systems.
  world.registerSystem(HealthBarSystem, { priority: 30 });
  installXRButton(world);

  // Keep the welcome panel turned toward the viewer in browser and XR alike.
  world.getSceneEntity('welcome-panel')?.addComponent(Billboard);

  const panel = world.getSceneObject<UIKitMLAsset>('welcome-panel');
  panel
    ?.getElementById('enter-game-button')
    ?.addEventListener('click', () => startBattle(world));
});
