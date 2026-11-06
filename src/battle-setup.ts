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
import type { Entity, MeshStandardMaterial } from '@iwsdk/core';
import { CameraOrbitSystem } from './camera-orbit-system.js';
import {
  CannonAim,
  CannonFire,
  DefensePad,
  Destroyed,
  Health,
  HitCore,
  OceanTag,
  Taunt,
} from './components.js';
import { COMBAT, activeLevelList, DEFENSE_PAD, DEFENSE_SLOTS, DEFENDER_BAR_Y, OCEAN, WALL_CENTER_Z } from './level-config.js';
import type { DefenseUnitId } from './level-config.js';
import { createOceanMaterial } from './scene-assets/ocean.scene-asset.js';
import { StartPanelSystem } from './start-panel-system.js';
import { CannonFireSystem } from './cannon-fire-system.js';
import { DieBurstSystem } from './die-burst-system.js';
import { HitFlashSystem } from './hit-flash-system.js';
import { SplashSystem } from './splash-system.js';

/**
 * Re-bakes the harbor wall's sparse vertex colors into per-face stone mottle:
 * non-indexed geometry (original normals kept) carries one solid tint per face.
 * Idempotent: already non-indexed geometry is left untouched.
 */
function bakeWallFaceMottle(root: Object3D): void {
  let seed = 0x9e3779b9;
  const rand = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) / 0xffffffff) * 2 - 1; // -1..1
  };
  root.traverse((child: Object3D) => {
    const mesh = child as Mesh;
    if (!mesh.isMesh || !mesh.geometry.index) return;
    const geometry = mesh.geometry.toNonIndexed();
    const color = geometry.attributes.color;
    if (!color) return;
    for (let face = 0; face < color.count; face += 3) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let v = 0; v < 3; v++) {
        r += color.getX(face + v);
        g += color.getY(face + v);
        b += color.getZ(face + v);
      }
      r /= 3;
      g /= 3;
      b /= 3;
      const jitter = 1 + rand() * 0.07;
      const warm = rand() * 0.02;
      const tint = (c: number): number => Math.min(1, Math.max(0, c));
      r = tint(r * jitter + warm);
      g = tint(g * jitter);
      b = tint(b * jitter - warm * 0.5);
      for (let v = 0; v < 3; v++) color.setXYZ(face + v, r, g, b);
    }
    mesh.geometry = geometry;
  });
}

/**
 * Hangs the `muzzle` (on the gun_rotate pivot) and `hit_core` (bounding-box
 * centre) helpers on a defender prototype once, so every clone inherits them.
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
 * Mount one defender into a defense slot, with the unit's combat kit: cannon
 * gets RayInteractable + CannonAim + CannonFire, iron-guard gets Taunt. Shared
 * by the initial battery build and build-panel purchases.
 */
function mountDefenseUnit(
  world: World,
  slotIndex: number,
  unitId: DefenseUnitId,
): Entity {
  const slot = DEFENSE_SLOTS[slotIndex];
  const prototype = defensePrototypes.get(unitId);
  if (!prototype) throw new Error(`battle-setup: unit "${unitId}" not loaded`);
  const unit = prototype.clone(true);
  unit.position.set(slot.x, 0.8 + DEFENSE_PAD.height, WALL_CENTER_Z);
  // Runtime-instantiated GLB meshes keep three.js defaults (both false).
  unit.traverse((child: Object3D) => {
    if ((child as Mesh).isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
  const unitEntity = world.createTransformEntity(unit);
  // RayInteractable makes the unit pressable; CannonAim hands it to the shared
  // aim system with per-entity yaw/pitch limits.
  if (unitId === 'cannon') {
    unitEntity.addComponent(RayInteractable);
    unitEntity.addComponent(CannonAim);
    unitEntity.addComponent(CannonFire, { unitType: 'cannon' });
  } else {
    // 钢铁卫士：嘲讽坦位 —— 在场即劫持普通攻击者索敌。
    unitEntity.addComponent(Taunt);
  }
  // Defender hit core: ShellHitSystem consumes enemy shells within this radius
  // and charges health; unitType keys the DAMAGE_MATRIX row.
  unitEntity.addComponent(HitCore, {
    radius: COMBAT.defenderCoreRadius,
    faction: 'defender',
    unitType: unitId,
  });
  unitEntity.addComponent(Health, {
    current: COMBAT.unitHealth,
    max: COMBAT.unitHealth,
    barY: DEFENDER_BAR_Y[unitId],
  });
  defenseEntities.push({
    entity: unitEntity,
    unit: unitId,
    defaultPitchDeg: COMBAT.aimPitchDefault,
    slot: slotIndex,
  });
  battlefieldObjects.push(unit);
  return unitEntity;
}

/** The occupant of a slot; destroyed units still count as mounted. */
export function getDefenseSlotInfo(
  slotIndex: number,
): { entity: Entity; unit: DefenseUnitId } | undefined {
  return defenseEntities.find((entry) => entry.slot === slotIndex);
}

/** Whether a live (not Destroyed) occupant of `unitId` stands in any slot;
 * UNIQUE_UNITS panels use it to forbid a second one. */
export function hasLiveDefenseUnit(unitId: DefenseUnitId): boolean {
  return defenseEntities.some(
    (entry) =>
      entry.unit === unitId && !entry.entity.hasComponent(Destroyed),
  );
}

/**
 * Strip a slot's occupant without mounting a replacement: combat components
 * removed, object hidden, registry entry dropped. Money stays with the caller.
 */
export function removeDefenseUnit(world: World, slotIndex: number): void {
  const old = defenseEntities.find((entry) => entry.slot === slotIndex);
  if (!old) return;
  const { entity } = old;
  entity.removeComponent(CannonAim);
  entity.removeComponent(CannonFire);
  entity.removeComponent(Taunt);
  entity.removeComponent(HitCore);
  entity.removeComponent(Health);
  entity.removeComponent(Destroyed);
  const object3D = entity.object3D;
  if (object3D) {
    object3D.visible = false;
    // Leave the battlefield-reveal set too, or the next battle entry
    // would resurrect the stripped ghost on top of its replacement.
    const battlefieldIndex = battlefieldObjects.indexOf(object3D);
    if (battlefieldIndex !== -1) battlefieldObjects.splice(battlefieldIndex, 1);
  }
  defenseEntities.splice(defenseEntities.indexOf(old), 1);
}

/**
 * Place a freshly mounted unit into a slot, stripping any old occupant first.
 * Money handling stays with the caller (BuildPanelSystem).
 */
export function replaceDefenseUnit(
  world: World,
  slotIndex: number,
  unitId: DefenseUnitId,
): Entity {
  removeDefenseUnit(world, slotIndex);
  return mountDefenseUnit(world, slotIndex, unitId);
}

/**
 * Battlefield persistence: the ocean, wall and cannons are built once per page
 * load and kept alive across MAIN-menu round trips; disposing them would poison
 * the AssetManager cache their GLTF prototypes share. Runtime state resets on entry.
 */
let battlefieldReady = false;
/** Whether a battle entry is currently in flight (guards double ENTER). */
let battleStarted = false;
/**
 * Whether the loading panel already carries a transform entity — re-entry
 * reuses the cached document, and a second one would double-place it.
 */
let loadingPanelPlaced = false;
const battlefieldObjects: Object3D[] = [];

/**
 * Per-slot pedestal pad materials; each pad clone owns its instance so
 * DefensePadSystem breathes only empty slots. Null until the first build.
 */
const defensePadMaterials: (MeshStandardMaterial | null)[] = [];
export function getDefensePadMaterial(
  slotIndex: number,
): MeshStandardMaterial | null {
  return defensePadMaterials[slotIndex] ?? null;
}

/** Every mounted defender with the pose it resets to on battle re-entry. */
interface DefenseEntity {
  entity: Entity;
  unit: DefenseUnitId;
  defaultPitchDeg: number;
  slot: number;
}
const defenseEntities: DefenseEntity[] = [];

/**
 * Unit prototypes loaded once by startBattle; build-panel purchases clone
 * from them like the initial battery does.
 */
const defensePrototypes = new Map<DefenseUnitId, Object3D>();

/**
 * Battle-entry failure: re-arm the entry gate, hide the loading panel and
 * restore the welcome screen so ENTER GAME can retry (loads already done are
 * AssetManager cache hits).
 */
function failEntry(
  world: World,
  loadingPanel: UIKitMLAsset | null,
  err: unknown,
): void {
  console.error('Battle entry failed:', err);
  battleStarted = false;
  if (loadingPanel) loadingPanel.visible = false;
  const panel = world.getSceneObject<UIKitMLAsset>('welcome-panel');
  if (panel) panel.visible = true;
}

/**
 * One-shot battle start: hide the welcome panel, show the loading panel, build
 * the battlefield, then ease into the battle view. Re-entry after a MAIN-menu
 * return skips straight to the view change — the battlefield already exists.
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

  const panel = world.getSceneObject<UIKitMLAsset>('welcome-panel');
  if (panel) panel.visible = false;

  const proceed = (): void => {
    cameraSystem?.moveToView(
      new Vector3(0, 2.75, 2.75),
      new Vector3(0, 1.697, -2),
    );
    startPanelSystem?.show();
  };

  // Round trip: reveal the persistent battlefield, un-destroy and level the
  // cannons, and go straight to the view change.
  if (battlefieldReady) {
    for (const object of battlefieldObjects) object.visible = true;
    restoreCannons();
    resetCannonAim();
    proceed();
    return;
  }

  loadUIKitMLAsset('loading-panel')
    .then((loadingPanel) => {
      // A failed entry reuses the cached document — guard double placement.
      if (!loadingPanelPlaced) {
        loadingPanel.position.set(0, 1.25, -1.5);
        world.createTransformEntity(loadingPanel);
        loadingPanelPlaced = true;
      }
      loadingPanel.visible = true;

      AssetManager.loadHDRTextureById('ocean-env.hdr')
        .then(async (hdrTexture) => {
          // Equirect HDR -> cubemap: avoids pole stretching in reflections
          const cubeRT = new WebGLCubeRenderTarget(256, {
            type: HalfFloatType,
          });
          cubeRT.fromEquirectangularTexture(world.renderer, hdrTexture);

          const [oceanGltf, wallGltf, cannonGltf, ironGuardGltf, padGltf] =
            await Promise.all([
              AssetManager.loadGLTFById('ocean-body'),
              AssetManager.loadGLTFById('harbor-wall'),
              AssetManager.loadGLTFById('cannon'),
              AssetManager.loadGLTFById('iron-guard'),
              AssetManager.loadGLTFById('defense-pad'),
            ]);

          const oceanObject = oceanGltf.scene;
          const oceanMaterial = createOceanMaterial();
          oceanMaterial.uniforms.envMap.value = cubeRT.texture;
          oceanMaterial.userData.envCubeRT = cubeRT; // keep the RT alive with the mesh
          oceanObject.traverse((child: Object3D) => {
            if ((child as Mesh).isMesh) {
              (child as Mesh).material = oceanMaterial;
              // The unlit ocean shader still samples the shadow map.
              child.receiveShadow = true;
            }
          });

          // Ocean near edge meets the wall's sea face; centre rides OCEAN.centerZ.
          oceanObject.position.set(0, 0.55, OCEAN.centerZ);
          world.createTransformEntity(oceanObject).addComponent(OceanTag);
          battlefieldObjects.push(oceanObject);

          const wallObject = wallGltf.scene;
          bakeWallFaceMottle(wallObject);
          wallObject.position.set(0, 0.55, WALL_CENTER_Z);
          // Runtime-instantiated GLB meshes keep three.js defaults (both false).
          wallObject.traverse((child: Object3D) => {
            if ((child as Mesh).isMesh) {
              child.castShadow = true;
              child.receiveShadow = true;
            }
          });
          world.createTransformEntity(wallObject);
          battlefieldObjects.push(wallObject);

          // One clone per DEFENSE_SLOTS entry, muzzles facing the sea (-Z). The
          // active level may re-crew the slots via LevelSpec.initialUnits.
          const cannonProto = cannonGltf.scene;
          decorateCombatPrototype(cannonProto, 0, -0.2);
          defensePrototypes.set('cannon', cannonProto);
          const ironGuardPrototype = ironGuardGltf.scene;
          // 钢铁卫士不开火不瞄准：无 gun_rotate 可挂 muzzle，只挂 hit_core。
          decorateCombatPrototype(ironGuardPrototype, 0, 0);
          defensePrototypes.set('iron-guard', ironGuardPrototype);
          const initialUnits =
            activeLevelList[0]?.initialUnits ??
            DEFENSE_SLOTS.map((slot) => slot.unit);
          for (
            let slotIndex = 0;
            slotIndex < DEFENSE_SLOTS.length;
            slotIndex++
          ) {
            const initial = initialUnits[slotIndex] ?? DEFENSE_SLOTS[slotIndex].unit;
            if (initial) mountDefenseUnit(world, slotIndex, initial);
          }

          // Empty-slot pedestal pads: one permanent disc per slot. DefensePadInput
          // keeps RayInteractable on the pad only while the slot is empty.
          const padPrototype = padGltf.scene;
          for (
            let slotIndex = 0;
            slotIndex < DEFENSE_SLOTS.length;
            slotIndex++
          ) {
            const pad = padPrototype.clone(true);
            pad.position.set(DEFENSE_SLOTS[slotIndex].x, 0.8, WALL_CENTER_Z);
            pad.traverse((child: Object3D) => {
              if ((child as Mesh).isMesh) {
                child.castShadow = true;
                child.receiveShadow = true;
              }
            });
            const padMesh = pad.getObjectByName(
              'defense-pad-mesh',
            ) as Mesh | null;
            if (padMesh) {
              padMesh.material = (padMesh.material as MeshStandardMaterial).clone();
              defensePadMaterials[slotIndex] =
                padMesh.material as MeshStandardMaterial;
            }
            world
              .createTransformEntity(pad)
              .addComponent(DefensePad, { slot: slotIndex });
            battlefieldObjects.push(pad);
          }

          battlefieldReady = true;

          // Game is ready: hide the panel and raise the START gates; units are
          // dispatched by LevelWaveSystem once the player presses START.
          loadingPanel.visible = false;
          proceed();
        })
        .catch((err: unknown) => failEntry(world, loadingPanel, err));
    })
    .catch((err: unknown) => failEntry(world, null, err));
}

/**
 * MAIN-menu hand-off: hide the battlefield (never disposed), bring the welcome
 * panel back and ease the camera to its welcome pose.
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
 * Reset every mounted defender to its spawn pose (yaw centre, stock pitch);
 * CannonAimSystem re-applies it next frame. Shared by re-entry and RESTART.
 */
export function resetCannonAim(): void {
  for (const { entity, defaultPitchDeg } of defenseEntities) {
    if (!entity.hasComponent(CannonAim)) continue;
    entity.setValue(CannonAim, 'yawDeg', 0);
    entity.setValue(CannonAim, 'pitchDeg', defaultPitchDeg);
  }
}

/**
 * Undo every knockout: drop Destroyed, reveal the hidden defender and refill
 * its health. Shared by the pause menu's RESTART and the MAIN-menu re-entry.
 */
export function restoreCannons(): void {
  for (const { entity } of defenseEntities) {
    entity.removeComponent(Destroyed);
    if (entity.object3D) entity.object3D.visible = true;
    entity.setValue(Health, 'current', Number(entity.getValue(Health, 'max')));
  }
}

/**
 * Re-crew the battery to the active level's initialUnits: restore every
 * occupant, then strip and remount slots whose unit differs; a null wish means
 * an empty slot. Called by LevelWaveSystem's beginLevel / restartLevel.
 */
export function syncBatteryToLevel(world: World): void {
  restoreCannons();
  const initialUnits =
    activeLevelList[0]?.initialUnits ??
    DEFENSE_SLOTS.map((slot) => slot.unit);
  for (
    let slotIndex = 0;
    slotIndex < DEFENSE_SLOTS.length;
    slotIndex++
  ) {
    const wanted = initialUnits[slotIndex] ?? DEFENSE_SLOTS[slotIndex].unit;
    const current = defenseEntities.find((entry) => entry.slot === slotIndex);
    if (current && current.unit === wanted) continue;
    if (current) removeDefenseUnit(world, slotIndex);
    if (wanted) mountDefenseUnit(world, slotIndex, wanted);
  }
  resetCannonAim();
}

/**
 * Recall everything the last round left flying or blooming: airborne shells,
 * hit flashes and splash ripples. Shared by every reset path.
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
