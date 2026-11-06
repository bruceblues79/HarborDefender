/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  createSystem,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';
import {
  GameOver,
  GamePaused,
  Health,
  HideHealthBar,
  HitCore,
  LevelDirector,
} from './components.js';
import { COMBAT } from './level-config.js';

/**
 * World-space health bars — a pure view; `Health` stays the single truth. The
 * rig is a child of the unit, so the billboard yaw is recomposed into the
 * parent's local frame (BillboardSystem's root-level math cannot be reused).
 * Per-unit material clones keep SpawnFade's opacity ramp isolated.
 */

const WIDTH = COMBAT.healthBarWidth;
const HEIGHT = COMBAT.healthBarHeight;

/**
 * 每个单位血条 rig 的节点名——RepairButtonSystem 按名字找到它并把维修按钮
 * 锚到血条左缘上方。
 */
export const HEALTH_BAR_RIG_NAME = 'health-bar';

const backGeometry = new PlaneGeometry(WIDTH, HEIGHT);
/**
 * Fill geometry origin moved to its left edge so scale.x shrinks the green
 * toward the left rim instead of the centre.
 */
const fillGeometry = new PlaneGeometry(WIDTH, HEIGHT);
fillGeometry.translate(WIDTH / 2, 0, 0);

/**
 * Material templates. Per-unit clones keep SpawnFade's per-ship opacity ramp
 * isolated; `toneMapped: false` keeps the status colours exact.
 */
const backMaterial = new MeshBasicMaterial({
  color: COMBAT.healthBarBackColor,
  transparent: true,
  depthWrite: false,
  side: DoubleSide,
  toneMapped: false,
});
const fillMaterial = new MeshBasicMaterial({
  color: COMBAT.healthBarFillColor,
  transparent: true,
  depthWrite: false,
  side: DoubleSide,
  toneMapped: false,
});

/**
 * Transparent draw order: fill after back plate, both under the hit-flash
 * bloom (10) and under the menu UI (20). Bars are depthWrite-off, so draw
 * order alone decides; the panel gate below hides them for full-screen panels.
 */
const BACK_RENDER_ORDER = 8;
const FILL_RENDER_ORDER = 9;
/** Fill sits a hair in front of the back plate — no z-fighting. */
const FILL_Z_OFFSET = 0.002;

export class HealthBarSystem extends createSystem({
  // Carriers may suppress their bar with the explicit HideHealthBar tag.
  units: { required: [Health], excluded: [HideHealthBar] },
  directors: { required: [LevelDirector] },
}) {
  private readonly rigs = new Map<number, Object3D>();
  private readonly fills = new Map<number, Mesh>();
  // Pre-allocated math scratch — update() never allocates.
  private readonly viewer = new Vector3();
  private readonly rigWorld = new Vector3();
  private readonly parentWorldQuat = new Quaternion();
  private readonly yawQuat = new Quaternion();
  private readonly up = new Vector3(0, 1, 0);

  init(): void {
    this.queries.units.subscribe('qualify', (entity) => {
      const unit = entity.object3D;
      if (!unit) return;
      // Per-faction sizing: defenders draw smaller; their margin is baked into barY.
      const defender =
        String(entity.getValue(HitCore, 'faction')) === 'defender';
      // barY is the carrier's authored local head height; no bounding-box
      // derivation — a deep child spawned mid-frame reads a stale matrixWorld.
      const rig = new Object3D();
      rig.name = HEALTH_BAR_RIG_NAME;
      rig.position.y = Number(entity.getValue(Health, 'barY'));
      rig.scale.setScalar(
        defender ? COMBAT.healthBarDefenderScale : 1,
      );

      const back = new Mesh(backGeometry, backMaterial.clone());
      back.renderOrder = BACK_RENDER_ORDER;
      const fill = new Mesh(fillGeometry, fillMaterial.clone());
      fill.renderOrder = FILL_RENDER_ORDER;
      fill.position.set(-WIDTH / 2, 0, FILL_Z_OFFSET);
      for (const mesh of [back, fill]) {
        // userData.skipShadow opts these out of SpawnFadeSystem's castShadow sweep.
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        mesh.userData.skipShadow = true;
      }
      rig.add(back, fill);
      unit.add(rig);

      this.rigs.set(entity.index, rig);
      this.fills.set(entity.index, fill);
      fill.scale.x = this.fillRatio(entity);
    });
    // A sunk ship leaves the query: drop the cache and dispose the rig's
    // cloned materials. Shared geometry/templates must survive for later units.
    this.queries.units.subscribe('disqualify', (entity) => {
      const rig = this.rigs.get(entity.index);
      if (rig) {
        for (const child of rig.children) {
          // Bar meshes carry exactly one material each (single, not array).
          ((child as Mesh).material as MeshBasicMaterial).dispose();
        }
        rig.removeFromParent();
      }
      this.rigs.delete(entity.index);
      this.fills.delete(entity.index);
    });
  }

  update(): void {
    // Panel gate: while a blocking panel owns the screen the bars hide
    // entirely — this sidesteps every transparent draw-order conflict.
    const panelsUp = this.panelsUp();
    this.world.camera.getWorldPosition(this.viewer);
    for (const entity of this.queries.units.entities) {
      const rig = this.rigs.get(entity.index);
      const fill = this.fills.get(entity.index);
      if (!rig || !fill) continue;
      rig.visible = !panelsUp;
      if (panelsUp) continue;
      fill.scale.x = this.fillRatio(entity);

      const parent = rig.parent;
      if (!parent) continue;
      // World yaw toward the viewer, recomposed into the unit's local space:
      // local = parentWorld⁻¹ × worldYaw. getWorld* refresh ancestor matrices.
      parent.getWorldQuaternion(this.parentWorldQuat).invert();
      rig.getWorldPosition(this.rigWorld);
      this.yawQuat.setFromAxisAngle(
        this.up,
        Math.atan2(
          this.viewer.x - this.rigWorld.x,
          this.viewer.z - this.rigWorld.z,
        ),
      );
      rig.quaternion.copy(this.parentWorldQuat).multiply(this.yawQuat);
    }
  }

  /** True while a blocking panel (START / pause menu / result) is on screen. */
  private panelsUp(): boolean {
    for (const director of this.queries.directors.entities) {
      return (
        director.hasComponent(GamePaused) ||
        director.hasComponent(GameOver) ||
        String(director.getValue(LevelDirector, 'phase')) === 'waiting-start'
      );
    }
    return false;
  }

  private fillRatio(entity: Entity): number {
    const current = Number(entity.getValue(Health, 'current'));
    const max = Number(entity.getValue(Health, 'max'));
    return max > 0 ? Math.min(1, Math.max(0, current / max)) : 0;
  }
}
