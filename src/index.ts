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
import { BossChiefSystem } from './boss-chief-system.js';
import { BuildPanelSystem } from './build-panel-system.js';
import { CameraOrbitSystem } from './camera-orbit-system.js';
import { CannonAimSystem } from './cannon-aim-system.js';
import { CannonFireSystem } from './cannon-fire-system.js';
import { ChiefDeathLightFxSystem } from './chief-death-light-fx-system.js';
import { ChiefDeathLightSystem } from './chief-death-light-system.js';
import { Billboard } from './components.js';
import { DefensePadInputSystem } from './defense-pad-input-system.js';
import { DefensePadSystem } from './defense-pad-system.js';
import { DieBurstSystem } from './die-burst-system.js';
import { EndlessPlannerSystem } from './endless-planner-system.js';
import { FreeLockTargetSystem } from './free-lock-target-system.js';
import { GunCycleSystem } from './gun-cycle-system.js';
import { HitFlashSystem } from './hit-flash-system.js';
import { HealthBarSystem } from './health-bar-system.js';
import { IntermissionPanelSystem } from './intermission-panel-system.js';
import { LaserCycleSystem } from './laser-cycle-system.js';
import { LaserFxSystem } from './laser-fx-system.js';
import { LevelWaveSystem } from './level-wave-system.js';
import { MenuSystem } from './menu-system.js';
import { OceanSystem } from './ocean-system.js';
import { PanelScaleSystem } from './panel-scale-system.js';
import { PirateFireSystem } from './pirate-fire-system.js';
import { PropellerSpinSystem } from './propeller-spin-system.js';
import { RepairSystem } from './repair-system.js';
import { RepairButtonSystem } from './repair-button-system.js';
import { ResultPanelSystem } from './result-panel-system.js';
import { ShellHitSystem } from './shell-hit-system.js';
import { ShipMovementSystem } from './ship-movement-system.js';
import { SkyDomeSystem } from './sky-dome-system.js';
import { SpawnFadeSystem } from './spawn-fade-system.js';
import { SplashSystem } from './splash-system.js';
import { StartPanelSystem } from './start-panel-system.js';
import { TrajectoryPreviewSystem } from './trajectory-preview-system.js';
import { WingFlapSystem } from './wing-flap-system.js';
import { installXRButton } from './xr-button.js';
import { installHandPriorityArbitration } from './xr-hand-arbitration.js';

World.create(
  document.getElementById('scene-container') as HTMLDivElement,
  projectOptions,
).then((world) => {
  // XR far-ray: visible whenever the hand is tracked (IWSDK defaults to
  // VisibleOnIntersection); RayPointer.visual is private, hence the cast.
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
  // AR partial-immersion dome: seaward half-dome over passthrough only in AR.
  world.registerSystem(SkyDomeSystem);
  // Simulation tier: the director (5) paces dispatch; the endless planner (6)
  // appends the new wave before any same-frame reader sees the list.
  world.registerSystem(LevelWaveSystem, { priority: 5 });
  world.registerSystem(EndlessPlannerSystem, { priority: 6 });
  world.registerSystem(CannonAimSystem, { priority: 8 });
  // Trajectory guide one tier after the aim pass, so it samples the muzzle
  // transform the drag just wrote.
  world.registerSystem(TrajectoryPreviewSystem, { priority: 9 });
  world.registerSystem(ShipMovementSystem, { priority: 10 });
  // Rotor spin and wing flap ride the movement tier and the same pause tags.
  world.registerSystem(PropellerSpinSystem, { priority: 10 });
  world.registerSystem(WingFlapSystem, { priority: 10 });
  // Both fire systems draw one shell pool at the same priority; the live
  // hasComponent guard stops them handing out the same shell in a frame.
  world.registerSystem(CannonFireSystem, { priority: 11 });
  world.registerSystem(PirateFireSystem, { priority: 11 });
  // Free gun pipeline: targeting (11) runs before the per-gun fire state
  // machines, so a slot cleared this frame is refilled now; all share the pool.
  world.registerSystem(FreeLockTargetSystem, { priority: 11 });
  world.registerSystem(GunCycleSystem, { priority: 11 });
  // Boss laser settles at 11 so its damage lands before ShellHitSystem's
  // death sweep (14); the fx rig (12) mirrors the frozen state.
  world.registerSystem(LaserCycleSystem, { priority: 11 });
  world.registerSystem(LaserFxSystem, { priority: 12 });
  // Chief-head mount (11) writes Health before ShellHitSystem's sweep (14);
  // its death light settles at 13 and the fx rig renders at 15.
  world.registerSystem(BossChiefSystem, { priority: 11 });
  world.registerSystem(ChiefDeathLightSystem, { priority: 13 });
  world.registerSystem(ChiefDeathLightFxSystem, { priority: 15 });
  // SpawnFade materialises hulls after the movement tier.
  world.registerSystem(SpawnFadeSystem, { priority: 12 });
  // Move first, then consume solid-target hits, then handle water splashes.
  world.registerSystem(BallisticSystem, { priority: 13 });
  world.registerSystem(ShellHitSystem, { priority: 14 });
  world.registerSystem(HitFlashSystem, { priority: 15 });
  world.registerSystem(DieBurstSystem, { priority: 15 });
  world.registerSystem(SplashSystem, { priority: 15 });
  // Repair (15) after the death sweep (14): a lethal hit must be dead before
  // repair ticks it above 0, or the unit survives as a zero-health ghost.
  world.registerSystem(RepairSystem, { priority: 15 });
  // Pedestal pads: RayInteractable on empty slots only; a press opens the
  // shared build dock (BuildOpen).
  world.registerSystem(DefensePadInputSystem, { priority: 16 });
  // Empty-slot pad breathing: one shared-material emissiveIntensity write per frame.
  world.registerSystem(DefensePadSystem, { priority: 17 });
  // UI tier, after the camera updates so billboards track this frame's view.
  world.registerSystem(PanelScaleSystem, { priority: 30 });
  world.registerSystem(StartPanelSystem, { priority: 30 });
  // Pause-menu orchestrator: watches GameStarted, owns the pause tag and the
  // head-following call button / menu panels.
  world.registerSystem(MenuSystem, { priority: 32 });
  // End-of-run result panel: on GameOver, offers RESTART / MAIN via MenuSystem.
  world.registerSystem(ResultPanelSystem, { priority: 33 });
  // Endless intermission: shows GET READY while the shortest wave window counts down.
  world.registerSystem(IntermissionPanelSystem, { priority: 33 });
  // Shared build panel: qualifies on BuildOpen, owns prices, wallet and unit swaps.
  world.registerSystem(BuildPanelSystem, { priority: 34 });
  world.registerSystem(BillboardSystem, { priority: 31 });
  // Health bars after the sim tier, so each frame's yaw cancels the unit's
  // freshest rotation.
  world.registerSystem(HealthBarSystem, { priority: 30 });
  // 维修按钮：血条（30）之后的视图层，按钮对齐本帧血条左缘；同系统消费 Pressed 切换 Repairing 标签。
  world.registerSystem(RepairButtonSystem, { priority: 31 });
  installXRButton(world);

  world.getSceneEntity('welcome-panel')?.addComponent(Billboard);

  const panel = world.getSceneObject<UIKitMLAsset>('welcome-panel');
  panel
    ?.getElementById('enter-game-button')
    ?.addEventListener('click', () => startBattle(world));
});
