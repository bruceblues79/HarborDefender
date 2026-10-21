/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  AssetManager,
  Box3,
  HalfFloatType,
  Mesh,
  Object3D,
  RayInteractable,
  UIKitMLAsset,
  Vector3,
  WebGLCubeRenderTarget,
  World,
  loadUIKitMLAsset,
} from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';
import { CameraOrbitSystem } from './camera-orbit-system.js';
import {
  CannonAim,
  CannonFire,
  Destroyed,
  Health,
  HitCore,
  OceanTag,
} from './components.js';
import { COMBAT, BALLISTA_MUZZLE_LOCAL_Y, BALLISTA_MUZZLE_LOCAL_Z, DEFENSE_SLOTS, SKY_BALLISTA } from './level-config.js';
import type { DefenseUnitId } from './level-config.js';
import { createOceanMaterial } from './scene-assets/ocean.scene-asset.js';
import { StartPanelSystem } from './start-panel-system.js';
import { CannonFireSystem } from './cannon-fire-system.js';
import { DieBurstSystem } from './die-burst-system.js';
import { HitFlashSystem } from './hit-flash-system.js';
import { SplashSystem } from './splash-system.js';

/**
 * Hang the two invisible combat helpers on a mounted-defender prototype once,
 * so every clone inherits them: the `muzzle` on the gun_rotate pivot (shots
 * launch down its world -Z; the offset is per unit — the cannon's barrel tip
 * vs the ballista's loaded bolt tip) and the `hit_core` at the model's
 * bounding-box centre (opposing shells within its radius get consumed).
 */
function decorateCombatPrototype(
  prototype: Object3D,
  muzzleLocalY: number,
  muzzleLocalZ: number,
): void {
  const gunPivot = prototype.getObjectByName('gun_rotate');
  if (gunPivot && !gunPivot.getObjectByName('muzzle')) {
    const muzzle = new Object3D();
    muzzle.name = 'muzzle';
    muzzle.position.set(0, muzzleLocalY, muzzleLocalZ);
    gunPivot.add(muzzle);
  }
  if (!prototype.getObjectByName('hit_core')) {
    const center = new Box3().setFromObject(prototype).getCenter(new Vector3());
    const hitCore = new Object3D();
    hitCore.name = 'hit_core';
    hitCore.position.copy(center);
    prototype.add(hitCore);
  }
}

/**
 * Battlefield persistence: the ocean, wall and cannons are built once per
 * page load and kept alive across MAIN-menu round trips (hidden, never
 * disposed — their geometry/materials are shared with the cached GLTF
 * prototypes, so disposing them would poison the AssetManager cache). Their
 * runtime state resets on every (re)entry: cannon aim returns to level.
 */
let battlefieldReady = false;
/** Whether a battle entry is currently in flight (guards double ENTER). */
let battleStarted = false;
const battlefieldObjects: Object3D[] = [];

/**
 * Every mounted defender with the pose it resets to on battle re-entry.
 * Cannons reset to the stock half-raised barrel; the ballista to its fixed
 * 75° anti-air elevation (its per-entity pitchMin/pitchMax differ).
 */
interface DefenseEntity {
  entity: Entity;
  unit: DefenseUnitId;
  defaultPitchDeg: number;
}
const defenseEntities: DefenseEntity[] = [];

/**
 * One-shot battle start flow: hide the welcome panel, show the loading
 * panel, instantiate the solidified GLB models and the ocean reflection
 * cubemap, place them into the world, then ease into the battle view.
 * Re-entry after a MAIN-menu return skips straight to the view change —
 * the battlefield is already built.
 *
 * All game assets are preloaded with `background` priority while the
 * welcome screen is up, so these loads are warm cache hits and the loading
 * panel only becomes visible on a slow network.
 *
 * Lighting split: standard PBR objects (wall, cannons) are lit by the
 * scene's IBLTexture (EnvironmentSystem writes scene.environment) and need
 * no per-object setup; the ocean keeps its unlit fake-reflection shader,
 * which samples the cubemap built here from the same cached HDR texture.
 */
export function startBattle(world: World): void {
  if (battleStarted) return;
  battleStarted = true;

  const cameraSystem = world
    .getSystems()
    .find((system): system is CameraOrbitSystem =>
      system instanceof CameraOrbitSystem,
    );
  const startPanelSystem = world
    .getSystems()
    .find((system): system is StartPanelSystem =>
      system instanceof StartPanelSystem,
    );

  // 1. Hide the welcome panel
  const panel = world.getSceneObject<UIKitMLAsset>('welcome-panel');
  if (panel) panel.visible = false;

  const proceed = (): void => {
    cameraSystem?.moveToView(
      new Vector3(0, 2.75, 2.75),
      new Vector3(0, 1.697, -2),
    );
    startPanelSystem?.show();
  };

  // Round trip: the battlefield persists across MAIN-menu returns — reveal
  // it, un-destroy and level the cannons, and go straight to the view change.
  if (battlefieldReady) {
    for (const object of battlefieldObjects) object.visible = true;
    restoreCannons();
    resetCannonAim();
    proceed();
    return;
  }

  // 2. Show loading panel (1 m × 0.5 m, faces +Z)
  loadUIKitMLAsset('loading-panel')
    .then((loadingPanel) => {
      loadingPanel.position.set(0, 1.25, -1.5);
      world.createTransformEntity(loadingPanel);

      // 3. Load game assets: HDR env + solidified GLB models
      AssetManager.loadHDRTextureById('ocean-env.hdr')
        .then(async (hdrTexture) => {
          // Equirect HDR -> cubemap: avoids pole stretching in reflections
          const cubeRT = new WebGLCubeRenderTarget(256, {
            type: HalfFloatType,
          });
          cubeRT.fromEquirectangularTexture(world.renderer, hdrTexture);

          const [oceanGltf, wallGltf, cannonGltf, ballistaGltf] =
            await Promise.all([
              AssetManager.loadGLTFById('ocean-body'),
              AssetManager.loadGLTFById('harbor-wall'),
              AssetManager.loadGLTFById('cannon'),
              AssetManager.loadGLTFById('sky-ballista'),
            ]);

          // Swap the GLB's placeholder material for the wave shader
          const oceanObject = oceanGltf.scene;
          const oceanMaterial = createOceanMaterial();
          oceanMaterial.uniforms.envMap.value = cubeRT.texture;
          oceanMaterial.userData.envCubeRT = cubeRT; // keep the RT alive with the mesh
          oceanObject.traverse((child: Object3D) => {
            if ((child as Mesh).isMesh) {
              (child as Mesh).material = oceanMaterial;
              // The unlit shader still samples the shadow map when the
              // mesh receives shadows (see createOceanMaterial).
              child.receiveShadow = true;
            }
          });

          // Ocean extended to 10 m: near edge stays at z = -1 (against the
          // wall), centre shifts back from -4 to -6.
          oceanObject.position.set(0, 0.55, -6);
          world.createTransformEntity(oceanObject).addComponent(OceanTag);
          battlefieldObjects.push(oceanObject);

          // Place harbor wall at the ocean body's maxZ edge
          const wallObject = wallGltf.scene;
          wallObject.position.set(0, 0.55, -0.8);
          // Runtime-instantiated GLB meshes keep three.js defaults
          // (both false); scene-JSON assets get these via content flags.
          wallObject.traverse((child: Object3D) => {
            if ((child as Mesh).isMesh) {
              child.castShadow = true;
              child.receiveShadow = true;
            }
          });
          world.createTransformEntity(wallObject);
          battlefieldObjects.push(wallObject);

          // The defense battery: one clone per DEFENSE_SLOTS entry across the
          // central 3 m of the 3.4 m wall, muzzles facing the sea (-Z).
          // Cloning keeps geometry/materials shared while each gun_rotate
          // pivot stays independent; both prototypes carry the muzzle and
          // hit_core helpers, so cannons and ballistas alike are armed,
          // targetable combatants.
          const cannonPrototype = cannonGltf.scene;
          decorateCombatPrototype(cannonPrototype, 0, -0.2);
          const ballistaPrototype = ballistaGltf.scene;
          decorateCombatPrototype(
            ballistaPrototype,
            BALLISTA_MUZZLE_LOCAL_Y,
            BALLISTA_MUZZLE_LOCAL_Z,
          );
          for (const slot of DEFENSE_SLOTS) {
            const isCannon = slot.unit === 'cannon';
            const unit = (isCannon ? cannonPrototype : ballistaPrototype).clone(
              true,
            );
            unit.position.set(slot.x, 0.8, -0.8);
            unit.traverse((child: Object3D) => {
              if ((child as Mesh).isMesh) {
                child.castShadow = true;
                child.receiveShadow = true;
              }
            });
            const unitEntity = world.createTransformEntity(unit);
            // RayInteractable makes the unit pressable (mouse / touch / XR
            // ray); CannonAim hands it to the shared aim system, with
            // per-entity pitch limits so the ballista's high-elevation
            // envelope rides the same component.
            unitEntity.addComponent(RayInteractable);
            if (isCannon) {
              unitEntity.addComponent(CannonAim);
              unitEntity.addComponent(CannonFire, { unitType: 'cannon' });
              // Defender hit core: pirate shells arriving within this radius
              // are consumed by ShellHitSystem, which charges the cannon's
              // health pool per hit (knockout = Destroyed tag + hidden).
              unitEntity.addComponent(HitCore, {
                radius: COMBAT.defenderCoreRadius,
                faction: 'defender',
                unitType: 'cannon',
              });
              unitEntity.addComponent(Health, {
                current: COMBAT.unitHealth,
                max: COMBAT.unitHealth,
              });
              defenseEntities.push({
                entity: unitEntity,
                unit: slot.unit,
                defaultPitchDeg: COMBAT.aimPitchDefault,
              });
            } else {
              // Anti-air ballista: fixed 75° elevation with 20° of
              // depression, and a full combat kit. It fires straight bolts
              // (gravityScale 0 — the flight model the flyer's berth band
              // FLYER_STOP_Z_* is derived from) that are recycled once they
              // climb past COMBAT.boltReclaimY, and carries the same
              // HitCore/Health pool as a cannon so ships and bombardiers
              // can knock it out (17.5% / 15% per hit) and the defeat check
              // counts it.
              unitEntity.addComponent(CannonAim, {
                pitchDeg: SKY_BALLISTA.pitchDefault,
                pitchMinDeg: SKY_BALLISTA.pitchMin,
                pitchMaxDeg: SKY_BALLISTA.pitchMax,
                // Dragging the swivel body inverts the vertical mapping:
                // pull down lifts the bolt head, the rack-hand feel.
                pitchDragInvert: true,
              });
              unitEntity.addComponent(CannonFire, {
                interval: COMBAT.ballistaFireInterval,
                unitType: 'sky-ballista',
                gravityScale: 0,
                bolt: true,
              });
              unitEntity.addComponent(HitCore, {
                radius: COMBAT.defenderCoreRadius,
                faction: 'defender',
                unitType: 'sky-ballista',
              });
              unitEntity.addComponent(Health, {
                current: COMBAT.unitHealth,
                max: COMBAT.unitHealth,
              });
              defenseEntities.push({
                entity: unitEntity,
                unit: slot.unit,
                defaultPitchDeg: SKY_BALLISTA.pitchDefault,
              });
            }
            battlefieldObjects.push(unit);
          }
          battlefieldReady = true;

          // 4. Hide loading panel — game is ready, ease into the game view,
          // then raise the START gates. Units are dispatched by
          // LevelWaveSystem once the player presses START.
          loadingPanel.visible = false;
          proceed();
        })
        .catch((err: unknown) => {
          console.error('Failed to load game assets:', err);
        });
    })
    .catch((err: unknown) => {
      console.error('Failed to load loading panel:', err);
    });
}

/**
 * MAIN-menu hand-off: hide the battlefield (it is never disposed — see the
 * persistence note above), bring the welcome panel back and ease the camera
 * to its authored welcome pose. A later ENTER GAME rebuilds nothing.
 */
export function returnToWelcome(world: World): void {
  battleStarted = false;
  for (const object of battlefieldObjects) object.visible = false;
  const panel = world.getSceneObject<UIKitMLAsset>('welcome-panel');
  if (panel) panel.visible = true;
  world
    .getSystems()
    .find((system): system is CameraOrbitSystem =>
      system instanceof CameraOrbitSystem,
    )
    ?.returnToWelcome();
}

/**
 * Spawn-pose reset for every mounted defender: turret yaw back to centre,
 * barrel pitch back to the unit's own spawn elevation (cannons half-raised,
 * ballista at its fixed 75°). `CannonAim` stays the single truth —
 * CannonAimSystem re-applies the pose to the transforms on its next frame.
 * Shared by the MAIN-menu battlefield re-entry and the pause menu's RESTART.
 */
export function resetCannonAim(): void {
  for (const { entity, defaultPitchDeg } of defenseEntities) {
    entity.setValue(CannonAim, 'yawDeg', 0);
    entity.setValue(CannonAim, 'pitchDeg', defaultPitchDeg);
  }
}

/**
 * Undo every knockout: the Destroyed tag drops, the hidden defender object
 * is revealed and its health pool refills. Cannons and ballistas persist
 * across rounds (see the battlefield-persistence note above), so a RESTART
 * restores rather than rebuilds the battery. Shared by the pause menu's
 * RESTART and the MAIN-menu battlefield re-entry.
 */
export function restoreCannons(): void {
  for (const { entity } of defenseEntities) {
    entity.removeComponent(Destroyed);
    if (entity.object3D) entity.object3D.visible = true;
    entity.setValue(Health, 'current', Number(entity.getValue(Health, 'max')));
  }
}

/**
 * Recall everything the last round left flying or blooming: airborne shells
 * back to the pool, hit flashes and splash ripples disposed. Shared by the
 * pause menu's MAIN / RESTART and the result panel's equivalents, so every
 * reset path clears the exact same effect set.
 */
export function recycleCombatEffects(world: World): void {
  world
    .getSystems()
    .find((system): system is CannonFireSystem =>
      system instanceof CannonFireSystem,
    )
    ?.recycleAirborneShells();
  world
    .getSystems()
    .find((system): system is HitFlashSystem => system instanceof HitFlashSystem)
    ?.recycleAll();
  world
    .getSystems()
    .find((system): system is DieBurstSystem => system instanceof DieBurstSystem)
    ?.recycleAll();
  world
    .getSystems()
    .find((system): system is SplashSystem => system instanceof SplashSystem)
    ?.disposeAll();
}
