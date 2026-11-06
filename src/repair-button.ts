/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  BoxGeometry,
  CanvasTexture,
  CircleGeometry,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PlaneGeometry,
  SRGBColorSpace,
} from '@iwsdk/core';
import { REPAIR_BUTTON } from './level-config.js';

/**
 * 维修按钮的可见资产。
 *
 * 图标由 SVG path 在运行时绘进一张共享 CanvasTexture（不落地 PNG、不走 GLB）；
 * 血条本身就是 world-space mesh，按钮每帧跟随即可。
 *
 * 结构（根原点 = 按钮中心，正面朝 +Z）：`visual` 组是灰底圆钮 + 白色图标，维修中
 * 整组缩小、灰底换亮灰，不可见命中盒比圆钮大一圈，命中盒尺寸不变。
 * 几何、材质、纹理全部共享；每单位只有 Object3D 层级克隆。
 */

/** SVG path（viewBox 2048，白色填充由画布写入）。 */
const REPAIR_ICON_PATH =
  'M1930 220q26 45 47 86t38 83t24 87t9 100q0 79-20 152t-58 138t-91 117t-117 90t-137 58t-153 21q-23 0-46-2t-47-6l-806 806q-48 48-109 73t-129 25q-69 0-130-26t-106-72t-72-107t-27-130q0-67 25-128t73-110l806-806q-4-23-6-46t-2-47q0-79 20-152t58-138t91-117t117-90t137-58t153-21q54 0 99 8t88 25t83 37t86 48l-394 394l102 102zm-458 804q93 0 174-35t142-96t96-142t36-175q0-73-24-141l-360 359l-282-282l359-360q-68-24-141-24q-93 0-174 35t-142 96t-96 142t-36 175q0 35 6 68t14 66l-855 856q-29 29-45 67t-16 80t16 80t45 66t66 44t80 17q42 0 80-16t67-45l856-855q33 8 66 14t68 6';

const ICON_VIEWBOX = 2048;
/** 纹理边长；2 的幂保证 mipmap 完整。 */
const ICON_TEXTURE_SIZE = 256;

interface SharedButtonResources {
  backgroundGeometry: CircleGeometry;
  iconGeometry: PlaneGeometry;
  proxyGeometry: BoxGeometry;
  backgroundMaterial: MeshBasicMaterial;
  activeBackgroundMaterial: MeshBasicMaterial;
  iconMaterial: MeshBasicMaterial;
  proxyMaterial: MeshBasicMaterial;
}

/** 所有按钮共享，首次创建时惰性生成。 */
let sharedResources: SharedButtonResources | null = null;

function drawIconTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = ICON_TEXTURE_SIZE;
  canvas.height = ICON_TEXTURE_SIZE;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('repair-button: 2D canvas unavailable');
  context.setTransform(
    ICON_TEXTURE_SIZE / ICON_VIEWBOX,
    0,
    0,
    ICON_TEXTURE_SIZE / ICON_VIEWBOX,
    0,
    0,
  );
  context.fillStyle = '#ffffff';
  context.fill(new Path2D(REPAIR_ICON_PATH));
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

function getSharedResources(): SharedButtonResources {
  if (sharedResources) return sharedResources;
  const iconTexture = drawIconTexture();
  const iconGeometry = new PlaneGeometry(
    REPAIR_BUTTON.iconSize,
    REPAIR_BUTTON.iconSize,
  );
  sharedResources = {
    backgroundGeometry: new CircleGeometry(REPAIR_BUTTON.diameter / 2, 40),
    iconGeometry,
    proxyGeometry: new BoxGeometry(
      REPAIR_BUTTON.proxy.x,
      REPAIR_BUTTON.proxy.y,
      REPAIR_BUTTON.proxy.z,
    ),
    backgroundMaterial: new MeshBasicMaterial({
      color: REPAIR_BUTTON.background,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      toneMapped: false,
    }),
    iconMaterial: new MeshBasicMaterial({
      color: 0xffffff,
      map: iconTexture,
      transparent: true,
      alphaTest: 0.02,
      depthWrite: false,
      side: DoubleSide,
      toneMapped: false,
    }),
    activeBackgroundMaterial: new MeshBasicMaterial({
      color: REPAIR_BUTTON.activeBackground,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      toneMapped: false,
    }),
    proxyMaterial: new MeshBasicMaterial({
      colorWrite: false,
      depthWrite: false,
      transparent: true,
    }),
  };
  return sharedResources;
}

export interface RepairButtonRig {
  /** 根节点：RepairButtonSystem 驱动它的世界变换。 */
  root: Object3D;
  /** 维修状态反馈：整组缩小 + 灰底换亮灰。 */
  setRepairing(repairing: boolean): void;
}

/** 创建根原点在按钮中心、正面朝 +Z 的按钮；实体创建、RayInteractable 与位置同步由调用方负责。 */
export function createRepairButtonRig(): RepairButtonRig {
  const resources = getSharedResources();

  const visual = new Object3D();
  visual.name = 'repair-button-visual';

  const background = new Mesh(
    resources.backgroundGeometry,
    resources.backgroundMaterial,
  );
  background.name = 'repair-button-background';
  background.renderOrder = REPAIR_BUTTON.backgroundRenderOrder;

  const icon = new Mesh(resources.iconGeometry, resources.iconMaterial);
  icon.name = 'repair-button-icon';
  icon.renderOrder = REPAIR_BUTTON.iconRenderOrder;
  icon.position.z = 0.002;

  const proxy = new Mesh(resources.proxyGeometry, resources.proxyMaterial);
  proxy.name = 'repair-button-proxy';

  for (const mesh of [background, icon, proxy]) {
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.userData.skipShadow = true;
  }

  visual.add(background, icon);
  const root = new Object3D();
  root.name = 'repair-button';
  root.add(visual, proxy);
  return {
    root,
    setRepairing(repairing: boolean): void {
      visual.scale.setScalar(repairing ? REPAIR_BUTTON.activeScale : 1);
      background.material = repairing
        ? resources.activeBackgroundMaterial
        : resources.backgroundMaterial;
    },
  };
}
