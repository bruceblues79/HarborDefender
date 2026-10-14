/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  AssetManager,
  HalfFloatType,
  Mesh,
  Object3D,
  UIKitMLAsset,
  Vector3,
  WebGLCubeRenderTarget,
  World,
  loadUIKitMLAsset,
} from '@iwsdk/core';
import { CameraOrbitSystem } from './camera-orbit-system.js';
import { OceanTag } from './components.js';
import { createOceanMaterial } from './scene-assets/ocean.scene-asset.js';

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

  // 1. Hide the welcome panel
  const panel = world.getSceneObject<UIKitMLAsset>('welcome-panel');
  if (panel) panel.visible = false;

  // 2. Show loading panel (1 m × 0.5 m, faces +Z)
  loadUIKitMLAsset('loading-panel')
    .then((loadingPanel) => {
      loadingPanel.position.set(0, 1.05, -1.5);
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
            }
          });

          // Place ocean at requested position, tagged for OceanSystem
          oceanObject.position.set(0, 0.35, -4);
          world.createTransformEntity(oceanObject).addComponent(OceanTag);

          // Place harbor wall at the ocean body's maxZ edge
          const wallObject = wallGltf.scene;
          wallObject.position.set(0, 0.35, -0.8);
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
          // stay shared while each gun_rotate pivot stays independent.
          const cannonPrototype = cannonGltf.scene;
          for (const x of [-1.2, -0.6, 0, 0.6, 1.2]) {
            const cannon = cannonPrototype.clone(true);
            cannon.position.set(x, 0.6, -0.8);
            cannon.traverse((child: Object3D) => {
              if ((child as Mesh).isMesh) {
                child.castShadow = true;
                child.receiveShadow = true;
              }
            });
            world.createTransformEntity(cannon);
          }

          // 4. Hide loading panel — game is ready, ease into the game view
          loadingPanel.visible = false;
          cameraSystem?.moveToView(
            new Vector3(0, 2.55, 2.75),
            new Vector3(0, 1.497, -2),
          );
        })
        .catch((err: unknown) => {
          console.error('Failed to load game assets:', err);
        });
    })
    .catch((err: unknown) => {
      console.error('Failed to load loading panel:', err);
    });
}
