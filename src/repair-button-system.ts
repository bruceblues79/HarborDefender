/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  createSystem,
  Object3D,
  Pressed,
  Quaternion,
  RayInteractable,
  Vector3,
} from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';
import {
  Destroyed,
  Health,
  HealthBarView,
  HitCore,
  RepairButton,
  Repairing,
  RepairRequest,
} from './components.js';
import { createRepairButtonRig } from './repair-button.js';
import { REPAIR_BUTTON } from './level-config.js';

/**
 * 守方血条上的维修按钮。
 *
 * 只为守方炮台（faction `defender` / unitType `cannon`）建按钮；海盗船、Boss 装甲件
 * 与钢铁卫士也有 Health，但维修它们等于花玩家金币给敌人回血。
 *
 * 按钮是独立的根级实体，每帧把自己的世界变换对齐到目标血条 rig 的左缘上方：
 * 这样它随血条一起 billboard，又不会嵌进单位实体的射线子树（按按钮不会误触炮台）。
 * 可见性与锚点来自 `HealthBarView`；回血与扣钱仍归 RepairSystem。
 */
interface RepairButtonEntry {
  readonly button: Entity;
  readonly unit: Entity;
  readonly root: Object3D;
  readonly setRepairing: (repairing: boolean) => void;
}

export class RepairButtonSystem extends createSystem({
  units: { required: [Health, HitCore] },
  pressed: { required: [RepairButton, Pressed] },
}) {
  private readonly entries = new Map<number, RepairButtonEntry>();
  /** 供 Pressed 查询按按钮 index 直接定位。 */
  private readonly byButton = new Map<number, RepairButtonEntry>();

  // update() 不分配：全部预分配。
  private readonly anchor = new Vector3();
  private readonly worldCenter = new Vector3();
  private readonly right = new Vector3();
  private readonly up = new Vector3();
  private readonly viewQuaternion = new Quaternion();
  private readonly parentQuaternion = new Quaternion();

  init(): void {
    this.queries.units.subscribe('qualify', (unit) => {
      if (String(unit.getValue(HitCore, 'faction')) !== 'defender') return;
      if (String(unit.getValue(HitCore, 'unitType')) !== 'cannon') return;
      if (!unit.object3D) return;

      const rig = createRepairButtonRig();
      rig.root.visible = false;
      const button = this.world
        .createTransformEntity(rig.root)
        .addComponent(RayInteractable)
        .addComponent(RepairButton);
      const entry: RepairButtonEntry = {
        button,
        unit,
        root: rig.root,
        setRepairing: rig.setRepairing,
      };
      this.entries.set(unit.index, entry);
      this.byButton.set(button.index, entry);
    });

    this.queries.units.subscribe('disqualify', (unit) => {
      const entry = this.entries.get(unit.index);
      if (!entry) return;
      this.entries.delete(unit.index);
      this.byButton.delete(entry.button.index);
      // 共享几何 / 材质 / 纹理不随单次销毁释放，只回收这个实体与它的层级。
      entry.button.dispose();
    });

    this.queries.pressed.subscribe('qualify', (button) => {
      const entry = this.byButton.get(button.index);
      if (entry) entry.unit.addComponent(RepairRequest);
    });
  }

  update(): void {
    for (const unit of this.queries.units.entities) {
      const entry = this.entries.get(unit.index);
      if (!entry) continue;
      const unitObject = unit.object3D;
      if (!unitObject || !unit.hasComponent(HealthBarView)) {
        entry.root.visible = false;
        continue;
      }
      const current = Number(unit.getValue(Health, 'current'));
      const max = Number(unit.getValue(Health, 'max'));
      // 满血、阵亡、单位本体隐藏（主菜单 / 欢迎屏）或血条被面板门禁隐藏时，
      // 按钮一并不出现。
      const visible =
        Boolean(unit.getValue(HealthBarView, 'visible')) &&
        current < max &&
        !unit.hasComponent(Destroyed) &&
        unitObject.visible;
      entry.root.visible = visible;
      if (!visible) continue;

      this.anchor.set(
        Number(unit.getValue(HealthBarView, 'anchorX')),
        Number(unit.getValue(HealthBarView, 'anchorY')),
        Number(unit.getValue(HealthBarView, 'anchorZ')),
      );
      this.viewQuaternion.set(
        Number(unit.getValue(HealthBarView, 'quatX')),
        Number(unit.getValue(HealthBarView, 'quatY')),
        Number(unit.getValue(HealthBarView, 'quatZ')),
        Number(unit.getValue(HealthBarView, 'quatW')),
      );

      this.alignToAnchor(entry);

      entry.setRepairing(unit.hasComponent(Repairing));
    }
  }

  /** 对齐到血条左缘上角；偏移按按钮自身尺寸折算。 */
  private alignToAnchor(entry: RepairButtonEntry): void {
    this.right.set(1, 0, 0).applyQuaternion(this.viewQuaternion);
    this.up.set(0, 1, 0).applyQuaternion(this.viewQuaternion);

    const radius = REPAIR_BUTTON.diameter / 2;
    this.worldCenter
      .copy(this.anchor)
      .addScaledVector(this.right, radius)
      .addScaledVector(this.up, REPAIR_BUTTON.gap + radius);

    const parent = entry.root.parent;
    if (parent) {
      parent.getWorldQuaternion(this.parentQuaternion).invert();
      entry.root.quaternion
        .copy(this.parentQuaternion)
        .multiply(this.viewQuaternion);
      parent.worldToLocal(this.worldCenter);
    } else {
      entry.root.quaternion.copy(this.viewQuaternion);
    }
    entry.root.position.copy(this.worldCenter);
  }
}
