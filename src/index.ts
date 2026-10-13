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
  WebGLCubeRenderTarget,
  World,
  loadUIKitMLAsset,
} from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { CameraLookSystem } from './camera-look-system.js';
import { OceanTag } from './components.js';
import { OceanSystem } from './ocean-system.js';
import { createOceanMaterial } from './scene-assets/ocean.scene-asset.js';

World.create(
  document.getElementById('scene-container') as HTMLDivElement,
  projectOptions,
).then((world) => {
  world.registerSystem(CameraLookSystem);
  world.registerSystem(OceanSystem);

  const panel = world.getSceneObject<UIKitMLAsset>('welcome-panel');
  const enterGameButton = panel?.getElementById('enter-game-button');

  let gameStarted = false;

  enterGameButton?.addEventListener('click', () => {
    if (gameStarted) return;
    gameStarted = true;

    // 1. Hide the welcome panel
    if (panel) panel.visible = false;

    // 2. Show loading panel (1 m × 0.5 m, faces +Z)
    loadUIKitMLAsset('loading-panel')
      .then((loadingPanel) => {
        loadingPanel.position.set(0, 1.5, -1.5);
        world.createTransformEntity(loadingPanel);

        // 3. Load game assets: HDR env + solidified GLB models
        AssetManager.loadHDRTextureById('ocean-env-hdr')
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
            oceanObject.position.set(0, 0.8, -4);
            world.createTransformEntity(oceanObject).addComponent(OceanTag);

            // Place harbor wall at the ocean body's maxZ edge
            const wallObject = wallGltf.scene;
            wallObject.position.set(0, 0.8, -0.8);
            world.createTransformEntity(wallObject);

            // Five cannons evenly spaced across the central 3 m of the
            // 3.4 m wall (0.2 m margin each side), muzzles facing the
            // sea (-Z). One prototype is cloned so geometry/materials
            // stay shared while each gun_rotate pivot stays independent.
            const cannonPrototype = cannonGltf.scene;
            for (const x of [-1.2, -0.6, 0, 0.6, 1.2]) {
              const cannon = cannonPrototype.clone(true);
              cannon.position.set(x, 1.05, -0.8);
              world.createTransformEntity(cannon);
            }

            // 4. Hide loading panel — game is ready
            loadingPanel.visible = false;
          })
          .catch((err: unknown) => {
            console.error('Failed to load game assets:', err);
          });
      })
      .catch((err: unknown) => {
        console.error('Failed to load loading panel:', err);
      });
  });
});
