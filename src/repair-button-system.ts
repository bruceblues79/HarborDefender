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
  GameOver,
  GamePaused,
  Health,
  HitCore,
  LevelDirector,
  RepairButton,
  Repairing,
} from './components.js';
import { createRepairButtonRig } from './repair-button.js';
import { HEALTH_BAR_RIG_NAME } from './health-bar-system.js';
import { COMBAT, REPAIR_BUTTON } from './level-config.js';

/**
 * 守方血条上的维修按钮。
 *
 * 只给守方炮台（faction `defender` / unitType `cannon`）建按钮——海盗船与
 * Boss 装甲件也有 Health，但维修它们等于花玩家金币给敌人回血；钢铁卫士沿用
 * 旧规则（不可维修，不出现按钮）。
 *
 * 按钮是一个独立的根级实体，每帧把自己的世界变换对齐到目标单位血条 rig 的
 * 左缘上方：这样它随血条一起 billboard，又不会嵌进单位实体的射线子树，按到
 * 按钮不会误触炮台开火或空槽底座。
 *
 * 血量、Destroyed、血条可见性全部复用 HealthBarSystem 的视图结果（rig
 * visible），本系统只负责按钮的显隐、跟随与 `Repairing` 开关；真正的回血和
 * 扣钱仍然只由 RepairSystem 处理。
 */
interface RepairButtonEntry {
  /** 按钮自身的实体（RayInteractable + RepairButton）。 */
  readonly button: Entity;
  /** 按钮服务的炮台实体。 */
  readonly unit: Entity;
  readonly root: Object3D;
  /** 维修状态反馈：整组缩小 + 灰底换亮灰。 */
  readonly setRepairing: (repairing: boolean) => void;
  /** 目标的血条 rig，第一次可见时按名字解析并缓存。 */
  rig: Object3D | null;
}

export class RepairButtonSystem extends createSystem({
  units: { required: [Health, HitCore] },
  pressed: { required: [RepairButton, Pressed] },
  directors: { required: [LevelDirector] },
}) {
  /** 炮台实体 index → 按钮条目。 */
  private readonly entries = new Map<number, RepairButtonEntry>();
  /** 按钮实体 index → 按钮条目，供 Pressed 查询直接定位。 */
  private readonly byButton = new Map<number, RepairButtonEntry>();

  // update() 不分配：全部预分配。
  private readonly rigPosition = new Vector3();
  private readonly rigScale = new Vector3();
  private readonly worldCenter = new Vector3();
  private readonly right = new Vector3();
  private readonly up = new Vector3();
  private readonly rigQuaternion = new Quaternion();
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
        rig: null,
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
      if (entry) this.toggle(entry.unit);
    });
  }

  update(): void {
    for (const unit of this.queries.units.entities) {
      const entry = this.entries.get(unit.index);
      if (!entry) continue;
      const unitObject = unit.object3D;
      if (!unitObject) {
        entry.root.visible = false;
        continue;
      }
      if (!entry.rig) {
        entry.rig =
          (unitObject.getObjectByName(HEALTH_BAR_RIG_NAME) as Object3D | null) ??
          null;
      }
      const rig = entry.rig;
      const current = Number(unit.getValue(Health, 'current'));
      const max = Number(unit.getValue(Health, 'max'));
      // 满血、阵亡、单位本体隐藏（主菜单 / 欢迎屏）或血条被面板门禁隐藏时，
      // 按钮一并不出现。
      const visible =
        !!rig &&
        current < max &&
        !unit.hasComponent(Destroyed) &&
        unitObject.visible &&
        rig.visible;
      entry.root.visible = visible;
      if (!visible || !rig) continue;

      this.alignToBar(entry, rig);

      // 维修中：整组缩小 + 灰底换亮灰；命中盒尺寸不变。
      entry.setRepairing(unit.hasComponent(Repairing));
    }
  }

  /** 把按钮的世界位置 / 朝向对齐到血条 rig 的左缘上方（世界尺寸固定）。 */
  private alignToBar(entry: RepairButtonEntry, rig: Object3D): void {
    rig.getWorldPosition(this.rigPosition);
    rig.getWorldScale(this.rigScale);
    rig.getWorldQuaternion(this.rigQuaternion);

    this.right.set(1, 0, 0).applyQuaternion(this.rigQuaternion);
    this.up.set(0, 1, 0).applyQuaternion(this.rigQuaternion);

    const radius = REPAIR_BUTTON.diameter / 2;
    const barWidth = COMBAT.healthBarWidth * this.rigScale.x;
    const barHeight = COMBAT.healthBarHeight * this.rigScale.y;
    this.worldCenter
      .copy(this.rigPosition)
      .addScaledVector(this.right, -barWidth / 2 + radius)
      .addScaledVector(
        this.up,
        barHeight / 2 + REPAIR_BUTTON.gap + radius,
      );

    const parent = entry.root.parent;
    if (parent) {
      parent.getWorldQuaternion(this.parentQuaternion).invert();
      entry.root.quaternion
        .copy(this.parentQuaternion)
        .multiply(this.rigQuaternion);
      parent.worldToLocal(this.worldCenter);
    } else {
      entry.root.quaternion.copy(this.rigQuaternion);
    }
    entry.root.position.copy(this.worldCenter);
  }

  /** Pressed：切换目标炮台的 Repairing，门禁与旧按钮一致。 */
  private toggle(unit: Entity): void {
    if (this.paused() || this.over() || this.waitingStart()) return;
    if (unit.hasComponent(Destroyed) || !unit.hasComponent(Health)) return;
    const current = Number(unit.getValue(Health, 'current'));
    const max = Number(unit.getValue(Health, 'max'));
    if (current >= max) return;
    if (unit.hasComponent(Repairing)) {
      unit.removeComponent(Repairing);
    } else {
      unit.addComponent(Repairing);
    }
  }

  private paused(): boolean {
    for (const director of this.queries.directors.entities) {
      return director.hasComponent(GamePaused);
    }
    return false;
  }

  private over(): boolean {
    for (const director of this.queries.directors.entities) {
      return director.hasComponent(GameOver);
    }
    return false;
  }

  private waitingStart(): boolean {
    for (const director of this.queries.directors.entities) {
      return (
        String(director.getValue(LevelDirector, 'phase')) === 'waiting-start'
      );
    }
    return false;
  }
}
