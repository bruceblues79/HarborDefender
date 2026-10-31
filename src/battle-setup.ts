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
  DefenseButton,
  Destroyed,
  Health,
  HitCore,
  OceanTag,
  Repairing,
  Taunt,
} from './components.js';
import { COMBAT, activeLevelList, DEFENSE_BUTTONS, DEFENSE_PAD, DEFENSE_SLOTS, DEFENDER_BAR_Y, OCEAN, WALL_CENTER_Z } from './level-config.js';
import type { DefenseUnitId } from './level-config.js';
import { createDefenseButtonRig } from './defense-buttons.js';
import { createOceanMaterial } from './scene-assets/ocean.scene-asset.js';
import { StartPanelSystem } from './start-panel-system.js';
import { CannonFireSystem } from './cannon-fire-system.js';
import { DieBurstSystem } from './die-burst-system.js';
import { HitFlashSystem } from './hit-flash-system.js';
import { SplashSystem } from './splash-system.js';

/**
 * Re-bake the harbor wall's vertex colors into per-face stone mottle. The
 * GLB's baked colors are sparse (1694 verts across a 3.4 m wall), so their
 * large-scale variation interpolates over huge faces into a near-flat wash —
 * extra faces would buy mottling far too dearly. Instead the geometry goes
 * non-indexed (original normals kept — no recompute, shading is unchanged)
 * so each face can carry ONE solid tint: its averaged baked color jittered
 * by a seeded ±7% brightness and a whisper of warmth. Zero extra triangles,
 * zero textures, and the sequence is deterministic across sessions.
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
 * Hang the two invisible combat helpers on a mounted-defender prototype once,
 * so every clone inherits them: the `muzzle` on the gun_rotate pivot (shots
 * launch down its world -Z at the barrel tip) and the `hit_core` at the
 * model's bounding-box centre (opposing shells within its radius get
 * consumed).
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
 * Mount one defender into a defense slot: clone the unit's prototype, place
 * it on the wall top facing the sea, hand it the unit's combat kit and file
 * it into the battery registry. Shared by the initial battery build and
 * build-panel purchases — a purchase into a destroyed slot is this mount
 * with the old occupant stripped first (replaceDefenseUnit below).
 *
 * Kit by unit id:
 * - cannon: RayInteractable + CannonAim + CannonFire (the aim/fire loop) and
 *   HitCore(faction defender, unitType 'cannon').
 * - iron-guard (钢铁卫士): never fires, never aims — no RayInteractable, no
 *   CannonAim/CannonFire. Carries Taunt (嘲讽) so raiders always roll it as
 *   their target, and the same defender HitCore keyed 'iron-guard' so the
 *   DAMAGE_MATRIX charges its fixed 2% per hit.
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
  // Runtime-instantiated GLB meshes keep three.js defaults
  // (both false); scene-JSON assets get these via content flags.
  unit.traverse((child: Object3D) => {
    if ((child as Mesh).isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
  const unitEntity = world.createTransformEntity(unit);
  // RayInteractable makes the unit pressable (mouse / touch / XR ray);
  // CannonAim hands it to the shared aim system, with per-entity yaw and
  // pitch limits so each mount's traverse/elevation envelope rides the same
  // component.
  if (unitId === 'cannon') {
    unitEntity.addComponent(RayInteractable);
    unitEntity.addComponent(CannonAim);
    unitEntity.addComponent(CannonFire, { unitType: 'cannon' });
  } else {
    // 钢铁卫士：嘲讽坦位 —— 在场即劫持普通攻击者索敌。
    unitEntity.addComponent(Taunt);
  }
  // Defender hit core: enemy shells arriving within this radius are
  // consumed by ShellHitSystem, which charges the unit's health pool per
  // hit (knockout = Destroyed tag + hidden). unitType keys the
  // DAMAGE_MATRIX row — iron-guard takes a flat 2% from every attacker.
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

/**
 * The entity and unit id currently mounted in a defense slot. Destroyed
 * units still count as mounted — callers check the Destroyed tag for
 * "needs building".
 */
export function getDefenseSlotInfo(
  slotIndex: number,
): { entity: Entity; unit: DefenseUnitId } | undefined {
  return defenseEntities.find((entry) => entry.slot === slotIndex);
}

/**
 * Whether a live (not Destroyed) occupant of `unitId` stands in any slot —
 * the single truth UNIQUE_UNITS panels consult: one live iron-guard anywhere
 * forbids building a second.
 */
export function hasLiveDefenseUnit(unitId: DefenseUnitId): boolean {
  return defenseEntities.some(
    (entry) =>
      entry.unit === unitId && !entry.entity.hasComponent(Destroyed),
  );
}

/**
 * Strip a slot's occupant without mounting a replacement: the unit loses
 * its combat components (every combat query drops it this frame), is hidden
 * and is forgotten by the battery registry — hidden forever like a knockout,
 * so its entity index is never freed and reused. No-op when the slot is
 * already empty. Money handling stays with the caller (BuildPanelSystem);
 * this is the structural removal only.
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
  entity.removeComponent(Repairing);
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
 * Place a freshly mounted unit into a slot that has no live occupant (empty
 * or destroyed): the old unit is stripped via removeDefenseUnit first.
 * Money handling stays with the caller (BuildPanelSystem); this is the
 * structural placement only.
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
 * Per-slot pedestal pad materials — each pad clone gets its own instance so
 * DefensePadSystem breathes only the empty slots (all at the same phase,
 * so the glowing ones still pulse in lockstep). Null until the first build.
 */
const defensePadMaterials: (MeshStandardMaterial | null)[] = [];
export function getDefensePadMaterial(
  slotIndex: number,
): MeshStandardMaterial | null {
  return defensePadMaterials[slotIndex] ?? null;
}

/**
 * Every mounted defender with the pose it resets to on battle re-entry:
 * the stock half-raised barrel.
 */
interface DefenseEntity {
  entity: Entity;
  unit: DefenseUnitId;
  defaultPitchDeg: number;
  /** Index into DEFENSE_SLOTS this unit occupies. */
  slot: number;
}
const defenseEntities: DefenseEntity[] = [];

/**
 * Unit prototypes loaded once by startBattle; build-panel purchases clone
 * from them exactly like the initial battery does. `defensePrototypes` maps
 * every DefenseUnitId to its mounted prototype (cannon carries the muzzle
 * helper; iron-guard is a static bust with only hit_core).
 */
const defensePrototypes = new Map<DefenseUnitId, Object3D>();

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

          const [oceanGltf, wallGltf, cannonGltf, ironGuardGltf, buildButtonGltf, repairButtonGltf, padGltf] =
            await Promise.all([
              AssetManager.loadGLTFById('ocean-body'),
              AssetManager.loadGLTFById('harbor-wall'),
              AssetManager.loadGLTFById('cannon'),
              AssetManager.loadGLTFById('iron-guard'),
              AssetManager.loadGLTFById('defense-button-build'),
              AssetManager.loadGLTFById('defense-button-repair'),
              AssetManager.loadGLTFById('defense-pad'),
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

          // Ocean extended to 10 m: the near edge sits against the wall's
          // sea face, the centre rides OCEAN.centerZ.
          oceanObject.position.set(0, 0.55, OCEAN.centerZ);
          world.createTransformEntity(oceanObject).addComponent(OceanTag);
          battlefieldObjects.push(oceanObject);

          // Place harbor wall at the ocean body's maxZ edge
          const wallObject = wallGltf.scene;
          bakeWallFaceMottle(wallObject);
          wallObject.position.set(0, 0.55, WALL_CENTER_Z);
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
          // pivot stays independent; the prototype carries the muzzle and
          // hit_core helpers, so every clone is an armed, targetable
          // combatant. The active level may re-crew the slots
          // (LevelSpec.initialUnits — the design boss stage opens with a
          // full five-gun battery); the slots' own units are the default.
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

          // Empty-slot pedestal pads: one permanent disc per slot, standing
          // on the wall top (pure scenery — no RayInteractable; the build
          // buttons stay the only build entry). Each clone gets its own
          // material instance so DefensePadSystem breathes only empty slots.
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
            world.createTransformEntity(pad);
            battlefieldObjects.push(pad);
          }

          // Build/repair buttons: two per slot on the wall's land face —
          // build left, repair right. Persistent battlefield objects like the
          // units (hidden on MAIN, revealed on re-entry); they keep serving
          // destroyed slots so the player can rebuild from the panel.
          for (
            let slotIndex = 0;
            slotIndex < DEFENSE_SLOTS.length;
            slotIndex++
          ) {
            for (const kind of ['build', 'repair'] as const) {
              const rig = createDefenseButtonRig(
                kind,
                kind === 'build'
                  ? buildButtonGltf.scene
                  : repairButtonGltf.scene,
              );
              rig.position.set(
                DEFENSE_SLOTS[slotIndex].x +
                  (kind === 'build'
                    ? -DEFENSE_BUTTONS.spacingX
                    : DEFENSE_BUTTONS.spacingX),
                DEFENSE_BUTTONS.y,
                DEFENSE_BUTTONS.z,
              );
              world
                .createTransformEntity(rig)
                .addComponent(RayInteractable)
                .addComponent(DefenseButton, { slot: slotIndex, kind });
              battlefieldObjects.push(rig);
            }
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
 * barrel pitch back to the spawn elevation (stock half-raised).
 * `CannonAim` stays the single truth — CannonAimSystem re-applies the pose
 * to the transforms on its next frame. Shared by the MAIN-menu battlefield
 * re-entry and the pause menu's RESTART. Units without an aim kit (the
 * iron-guard bust) have nothing to reset.
 */
export function resetCannonAim(): void {
  for (const { entity, defaultPitchDeg } of defenseEntities) {
    if (!entity.hasComponent(CannonAim)) continue;
    entity.setValue(CannonAim, 'yawDeg', 0);
    entity.setValue(CannonAim, 'pitchDeg', defaultPitchDeg);
  }
}

/**
 * Undo every knockout: the Destroyed tag drops, the hidden defender object
 * is revealed and its health pool refills. Cannons persist across rounds
 * (see the battlefield-persistence note above), so a RESTART
 * restores rather than rebuilds the battery. Shared by the pause menu's
 * RESTART and the MAIN-menu battlefield re-entry.
 */
export function restoreCannons(): void {
  for (const { entity } of defenseEntities) {
    entity.removeComponent(Destroyed);
    entity.removeComponent(Repairing);
    if (entity.object3D) entity.object3D.visible = true;
    entity.setValue(Health, 'current', Number(entity.getValue(Health, 'max')));
  }
}

/**
 * Re-crew the battery to the active level's initialUnits (level-switch):
 * every occupant is restored first, then slots whose mounted unit differs
 * from the level's wish are stripped and remounted. A null wish means an
 * empty slot (the endless gate leaves the wing slots to the player). Level
 * lists without initialUnits fall back to the slot defaults. Callers are the
 * LevelWaveSystem's beginLevel / restartLevel.
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
