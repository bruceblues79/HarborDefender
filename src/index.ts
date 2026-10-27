/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { RayDisplayMode, type RayPointer, UIKitMLAsset, World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { BallisticSystem } from './ballistic-system.js';
import { BillboardSystem } from './billboard-system.js';
import { startBattle } from './battle-setup.js';
import { BuildPanelSystem } from './build-panel-system.js';
import { CameraOrbitSystem } from './camera-orbit-system.js';
import { CannonAimSystem } from './cannon-aim-system.js';
import { CannonFireSystem } from './cannon-fire-system.js';
import { Billboard } from './components.js';
import { DefenseButtonSystem } from './defense-button-system.js';
import { DefensePadSystem } from './defense-pad-system.js';
import { DieBurstSystem } from './die-burst-system.js';
import { FreeLockTargetSystem } from './free-lock-target-system.js';
import { GunCycleSystem } from './gun-cycle-system.js';
import { HitFlashSystem } from './hit-flash-system.js';
import { HealthBarSystem } from './health-bar-system.js';
import { LevelWaveSystem } from './level-wave-system.js';
import { MenuSystem } from './menu-system.js';
import { OceanSystem } from './ocean-system.js';
import { PanelScaleSystem } from './panel-scale-system.js';
import { PirateFireSystem } from './pirate-fire-system.js';
import { PropellerSpinSystem } from './propeller-spin-system.js';
import { RepairSystem } from './repair-system.js';
import { ResultPanelSystem } from './result-panel-system.js';
import { ShellHitSystem } from './shell-hit-system.js';
import { ShipMovementSystem } from './ship-movement-system.js';
import { SpawnFadeSystem } from './spawn-fade-system.js';
import { SplashSystem } from './splash-system.js';
import { StartPanelSystem } from './start-panel-system.js';
import { WingFlapSystem } from './wing-flap-system.js';
import { installXRButton } from './xr-button.js';
import { installHandPriorityArbitration } from './xr-hand-arbitration.js';

World.create(
  document.getElementById('scene-container') as HTMLDivElement,
  projectOptions,
).then((world) => {
  // XR far-ray: show whenever the hand is tracked, not only while hovering an
  // interactable (IWSDK defaults to VisibleOnIntersection). The RayPointer
  // visual sits behind a private field with no public toggle, so use a narrow
  // structural access. Tracking loss / near-pointer takeover still hide it.
  for (const hand of ['left', 'right'] as const) {
    const rayVisual = (
      world.input.xr.multiPointers[hand] as unknown as {
        ray: { visual: RayPointer };
      }
    ).ray.visual;
    rayVisual.rayDisplayMode = RayDisplayMode.Visible;
  }

  // 手部优先仲裁：跳过 runtime 注入的无 gamepad 虚拟控制器，防止其抢走 primary
  // （Swan 浏览器捏合时注入，导致射线变蓝后指针永久失效，见 xr-hand-arbitration.ts）
  installHandPriorityArbitration(world);

  world.registerSystem(CameraOrbitSystem);
  world.registerSystem(OceanSystem);
  // Simulation tier: the director paces dispatch, movement runs the ships in
  // while the fade system materialises their hulls in parallel.
  world.registerSystem(LevelWaveSystem, { priority: 5 });
  world.registerSystem(CannonAimSystem, { priority: 8 });
  world.registerSystem(ShipMovementSystem, { priority: 10 });
  // Rotor spin rides the simulation tier: same march cadence as movement,
  // frozen by the same pause/hold tags. Wing flap keeps the ornithopter's
  // canvas beating on the same tier.
  world.registerSystem(PropellerSpinSystem, { priority: 10 });
  world.registerSystem(WingFlapSystem, { priority: 10 });
  // Both fire systems draw from one shell pool at the same priority; pirate
  // is registered second and its live hasComponent guard keeps the two from
  // ever handing out the same shell in a frame.
  world.registerSystem(CannonFireSystem, { priority: 11 });
  world.registerSystem(PirateFireSystem, { priority: 11 });
  // Free gun pipeline: the independent targeting system rolls each gun's
  // LockTarget slot (registered first so a slot cleared by a shot this frame
  // is refilled the same frame), then every per-gun fire state machine runs.
  // All fire systems share the ball pool on the same tier; the claimed-set
  // guard (and its live hasComponent check) keeps them from ever handing out
  // the same shell in a frame.
  world.registerSystem(FreeLockTargetSystem, { priority: 11 });
  world.registerSystem(GunCycleSystem, { priority: 11 });
  // SpawnFade materialises hulls after the movement tier; ShellHitSystem
  // (14) sweeps every death.
  world.registerSystem(SpawnFadeSystem, { priority: 12 });
  // Move first, then consume solid-target hits, then handle water splashes.
  world.registerSystem(BallisticSystem, { priority: 13 });
  world.registerSystem(ShellHitSystem, { priority: 14 });
  world.registerSystem(HitFlashSystem, { priority: 15 });
  world.registerSystem(DieBurstSystem, { priority: 15 });
  world.registerSystem(SplashSystem, { priority: 15 });
  // Repair drain: the only per-frame wallet writer, on the simulation tier
  // so pauses and outcomes freeze it like every other sim system.
  world.registerSystem(RepairSystem, { priority: 12 });
  // Build/repair button commands: a sim-tier consumer of the transient
  // Pressed tags; it opens the build panel through the director's BuildOpen
  // tag and keeps the button visuals (gray-out, breathing) current.
  world.registerSystem(DefenseButtonSystem, { priority: 16 });
  // Empty-slot pad breathing: the pure visual over the battery registry —
  // one shared-material emissiveIntensity write per frame, no phase gate.
  world.registerSystem(DefensePadSystem, { priority: 17 });
  // UI tier, after the camera updates so billboards track this frame's view.
  world.registerSystem(PanelScaleSystem, { priority: 30 });
  world.registerSystem(StartPanelSystem, { priority: 30 });
  // Pause-menu orchestrator: watches GameStarted, owns the pause tag and the
  // head-following call button / menu panels.
  world.registerSystem(MenuSystem, { priority: 32 });
  // End-of-run result panel: qualifies on GameOver (victory / defeat) and
  // hands RESTART / MAIN to MenuSystem's shared reset sequences.
  world.registerSystem(ResultPanelSystem, { priority: 33 });
  // Shared build panel: qualifies on the director's BuildOpen tag, owns the
  // row prices / wallet readout and the structural unit swaps.
  world.registerSystem(BuildPanelSystem, { priority: 34 });
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
