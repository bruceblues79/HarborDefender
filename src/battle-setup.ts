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
import { CameraOrbitSystem } from './camera-orbit-system.js';
import { CannonAim, CannonFire, HitCore, OceanTag } from './components.js';
import { COMBAT } from './level-config.js';
import { createOceanMaterial } from './scene-assets/ocean.scene-asset.js';
import { StartPanelSystem } from './start-panel-system.js';

/**
 * Hang the two invisible combat helpers on the cannon prototype once, so
 * every clone inherits them: the `muzzle` on the gun_rotate pivot (shells
 * launch down its world -Z) and the `hit_core` at the model's bounding-box
 * centre (opposing shells within its radius get consumed).
 */
function decorateCannonPrototype(prototype: Object3D): void {
  const gunPivot = prototype.getObjectByName('gun_rotate');
  if (gunPivot && !gunPivot.getObjectByName('muzzle')) {
    const muzzle = new Object3D();
    muzzle.name = 'muzzle';
    muzzle.position.set(0, 0, -0.2);
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

let battleStarted = false;

/**
 * One-shot battle start flow: hide the welcome panel, show the loading
 * panel, instantiate the solidified GLB models and the ocean reflection
 * cubemap, place them into the world, then ease into the battle view.
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

          const [oceanGltf, wallGltf, cannonGltf] = await Promise.all([
            AssetManager.loadGLTFById('ocean-body'),
            AssetManager.loadGLTFById('harbor-wall'),
            AssetManager.loadGLTFById('cannon'),
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

          // Five cannons evenly spaced across the central 3 m of the
          // 3.4 m wall (0.2 m margin each side), muzzles facing the
          // sea (-Z). One prototype is cloned so geometry/materials
          // stay shared while each gun_rotate pivot stays independent;
          // the muzzle and hit_core helpers live on that prototype.
          const cannonPrototype = cannonGltf.scene;
          decorateCannonPrototype(cannonPrototype);
          for (const x of [-1.2, -0.6, 0, 0.6, 1.2]) {
            const cannon = cannonPrototype.clone(true);
            cannon.position.set(x, 0.8, -0.8);
            cannon.traverse((child: Object3D) => {
              if ((child as Mesh).isMesh) {
                child.castShadow = true;
                child.receiveShadow = true;
              }
            });
            const cannonEntity = world.createTransformEntity(cannon);
            // RayInteractable makes the cannon pressable (mouse / touch / XR
            // ray); CannonAim + CannonFire hand it to the combat systems.
            cannonEntity.addComponent(RayInteractable);
            cannonEntity.addComponent(CannonAim);
            cannonEntity.addComponent(CannonFire);
            // Defender hit core: pirate shells arriving within this radius
            // are consumed by ShellHitSystem.
            cannonEntity.addComponent(HitCore, {
              radius: COMBAT.defenderCoreRadius,
              faction: 'defender',
            });
          }

          // 4. Hide loading panel — game is ready, ease into the game view,
          // then raise the START gates. Units are dispatched by
          // LevelWaveSystem once the player presses START.
          loadingPanel.visible = false;
          cameraSystem?.moveToView(
            new Vector3(0, 2.75, 2.75),
            new Vector3(0, 1.697, -2),
          );
          startPanelSystem?.show();
        })
        .catch((err: unknown) => {
          console.error('Failed to load game assets:', err);
        });
    })
    .catch((err: unknown) => {
      console.error('Failed to load loading panel:', err);
    });
}
