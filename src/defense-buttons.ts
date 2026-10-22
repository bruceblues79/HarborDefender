/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  BoxGeometry,
  ExtrudeGeometry,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Shape,
} from '@iwsdk/core';
import { DEFENSE_BUTTONS } from './level-config.js';

/**
 * Build/repair button geometry — flat low-poly icon extrusions facing +Z,
 * authored as hand-placed polygons in a ~1-unit space then scaled to
 * DEFENSE_BUTTONS.iconSize. Two shapes, two shared geometries; every button
 * clones the template material so the per-button states (build gray-out,
 * repair breathing) stay independent without touching the neighbours.
 *
 * The material is unlit (MeshBasicMaterial, toneMapped off): the icon shows
 * its pure flat tint regardless of the scene's lighting. Repair breathing is
 * scale-driven by DefenseButtonSystem (the icon pulses, the material never
 * changes). Silhouettes are kept minimal — a plate this thin reads as a
 * sticker, so extra structure only adds vertices.
 *
 * The invisible hit proxy is a box that renders nothing (colorWrite off) yet
 * stays raycastable — object.visible is what raycasters key on, not material
 * color. It is deliberately larger than the glyph so a thumb or XR ray never
 * has to land on the icon itself.
 */

/** Hammer outline: horizontal head across the top, straight handle down. */
function hammerShape(): Shape {
  const s = new Shape();
  s.moveTo(-0.45, 0.18);
  s.lineTo(-0.45, 0.5);
  s.lineTo(0.45, 0.5);
  s.lineTo(0.45, 0.18);
  s.lineTo(0.1, 0.18);
  s.lineTo(0.1, -0.5);
  s.lineTo(-0.1, -0.5);
  s.lineTo(-0.1, 0.18);
  s.closePath();
  return s;
}

/** Wrench outline: open jaw on top, straight shaft, closed ring foot. */
function wrenchShape(): Shape {
  const s = new Shape();
  s.moveTo(-0.26, 0.5);
  s.lineTo(-0.42, 0.18);
  s.lineTo(-0.26, -0.06);
  s.lineTo(-0.1, -0.16);
  s.lineTo(-0.1, -0.5);
  s.lineTo(0.1, -0.5);
  s.lineTo(0.1, -0.16);
  s.lineTo(0.26, -0.06);
  s.lineTo(0.42, 0.18);
  s.lineTo(0.26, 0.5);
  s.lineTo(0.12, 0.3);
  s.lineTo(-0.12, 0.3);
  s.closePath();
  return s;
}

const size = DEFENSE_BUTTONS.iconSize;
const depth = DEFENSE_BUTTONS.iconDepth;

/** Shared icon geometries — one per kind, every button of a kind shares it. */
export const BUTTON_GEOMETRIES = {
  build: new ExtrudeGeometry(hammerShape(), {
    depth,
    bevelEnabled: false,
  }),
  repair: new ExtrudeGeometry(wrenchShape(), {
    depth,
    bevelEnabled: false,
  }),
};
for (const geometry of Object.values(BUTTON_GEOMETRIES)) {
  geometry.scale(size, size, 1);
  // Centre the extrusion on the button plane so the glyph straddles z = 0.
  geometry.translate(0, 0, -depth / 2);
}

/** Shared invisible-hit-proxy geometry/material — renders nothing, hits all. */
const PROXY_GEOMETRY = new BoxGeometry(
  DEFENSE_BUTTONS.proxySize,
  DEFENSE_BUTTONS.proxySize,
  DEFENSE_BUTTONS.proxySize / 2,
);
const PROXY_MATERIAL = new MeshBasicMaterial({
  colorWrite: false,
  depthWrite: false,
  transparent: true,
});

/**
 * Unlit icon template each button clones from — flat tint, tone mapping off,
 * so the glyph keeps its exact color under the bright sky and the repair
 * breathing can be driven purely by lerping the color.
 */
const ICON_MATERIAL = new MeshBasicMaterial({
  color: 0xffffff,
  toneMapped: false,
});

export type ButtonKind = 'build' | 'repair';

/**
 * One button rig: the visible icon plus the invisible hit proxy under one
 * parentless Object3D, centred on its mount point and facing +Z. The caller
 * creates the transform entity, adds RayInteractable + DefenseButton and
 * owns placement (battle-setup); DefenseButtonSystem resolves the icon mesh
 * by name for its per-frame state writes.
 */
export function createDefenseButtonRig(kind: ButtonKind): Object3D {
  const rig = new Object3D();
  rig.name = `defense-button-${kind}`;

  const color = kind === 'build' ? DEFENSE_BUTTONS.buildColor : DEFENSE_BUTTONS.repairColor;
  const material = ICON_MATERIAL.clone();
  material.color.setHex(color);

  const icon = new Mesh(BUTTON_GEOMETRIES[kind], material);
  icon.name = 'button-icon';
  icon.castShadow = false;
  icon.receiveShadow = false;

  const proxy = new Mesh(PROXY_GEOMETRY, PROXY_MATERIAL);
  proxy.name = 'button-proxy';
  proxy.castShadow = false;
  proxy.receiveShadow = false;

  rig.add(icon, proxy);
  return rig;
}
