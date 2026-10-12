/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  AssetManager,
  Mesh,
  Object3D,
  ShaderMaterial,
  UIKitMLAsset,
  World,
  loadUIKitMLAsset,
} from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { CameraLookSystem } from './camera-look-system.js';
import { OceanSystem } from './ocean-system.js';
import { createOceanBody } from './scene-assets/ocean.scene-asset.js';

World.create(
  document.getElementById('scene-container') as HTMLDivElement,
  projectOptions,
).then((world) => {
  world.registerSystem(CameraLookSystem);
  world.registerSystem(OceanSystem);
  const oceanSystem = world.getSystem(OceanSystem)!;

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

        // 3. Load game assets: HDR env + procedural ocean body
        AssetManager.loadHDRTextureById('ocean-env-hdr')
          .then((hdrTexture) => {
            const oceanObject = createOceanBody();

            oceanObject.traverse((child: Object3D) => {
              if ((child as Mesh).isMesh) {
                const mat = (child as Mesh).material as ShaderMaterial;
                mat.uniforms.envMap.value = hdrTexture;
                oceanSystem.setOceanMesh(child as Mesh);
              }
            });

            // Place ocean at requested position
            oceanObject.position.set(0, 0.8, -4);
            world.createTransformEntity(oceanObject);

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
