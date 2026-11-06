/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { AssetManager, createSystem, Object3D } from '@iwsdk/core';
import type {
  Entity,
  Mesh,
  MeshStandardMaterial,
} from '@iwsdk/core';
import {
  ChiefDeathLight,
  ChiefMount,
  ChiefPending,
  ChiefRise,
  GameOver,
  GamePaused,
  Health,
  HitCore,
  IslewrathChief,
  LevelDirector,
  SpawnFade,
  UnitTag,
  BossTurret,
} from './components.js';
import {
  BOSS_CHIEF,
  RewardTier,
  SPAWN_FADE_DURATION,
} from './level-config.js';

/**
 * Phase-two chief head (海盗头领): once every BossTurret is gone while the hull
 * still floats, the head rises at the laser citadel as a Health + HitCore child
 * every defender shell can hit. Owns the phase trigger, the 0.5 s beat, the
 * head mount and the emerge rise. Death belongs to ShellHitSystem's kill().
 */
export class BossChiefSystem extends createSystem({
  bosses: { required: [UnitTag] },
  bossTurrets: { required: [BossTurret] },
  chiefs: { required: [IslewrathChief] },
  pending: { required: [UnitTag, ChiefPending] },
  rising: { required: [IslewrathChief, ChiefRise] },
  directors: { required: [LevelDirector] },
}) {
  private chiefPrototype: Object3D | null = null;

  init(): void {
    AssetManager.loadGLTFById('pirate-chief')
      .then((gltf) => {
        this.chiefPrototype = gltf.scene;
      })
      .catch((err: unknown) =>
        console.error('BossChiefSystem: failed to load "pirate-chief"', err),
      );
  }

  update(delta: number): void {
    if (this.paused() || this.over() || !this.gameRunning()) return;
    this.tickPending(delta);
    this.tickRise(delta);
    this.tryMountChief();
  }

  /**
   * The 0.5 s beat between the last turret dying and the rise; at zero the head mounts.
   */
  private tickPending(delta: number): void {
    for (const boss of this.queries.pending.entities) {
      const timer = Number(boss.getValue(ChiefPending, 'timer')) - delta;
      if (timer > 0) {
        boss.setValue(ChiefPending, 'timer', timer);
        continue;
      }
      boss.removeComponent(ChiefPending);
      this.mountChief(
        boss,
        Number(boss.getValue(ChiefMount, 'x')),
        Number(boss.getValue(ChiefMount, 'y')),
        Number(boss.getValue(ChiefMount, 'z')),
      );
    }
  }

  /**
   * Phase-two trigger: hull afloat, every BossTurret gone, no chief yet; runs
   * after the rise tick so a freshly mounted head never doubles.
   */
  private tryMountChief(): void {
    if (this.chiefPrototype === null) return;
    if (this.queries.chiefs.entities.size > 0) return;
    if (this.queries.bossTurrets.entities.size > 0) return;
    for (const boss of this.queries.bosses.entities) {
      if (String(boss.getValue(UnitTag, 'unitType')) !== 'boss_islewrath') {
        continue;
      }
      if (!boss.object3D) return;
      if (!boss.hasComponent(ChiefMount)) {
        // Assembly never captured the seat (missing pivot node); surface it loudly
        // instead of silently never entering phase two.
        console.error('BossChiefSystem: boss hull carries no ChiefMount seat');
        return;
      }
      if (boss.hasComponent(ChiefPending)) return;
      // The 0.5 s beat first; tickPending mounts the head when it elapses.
      boss.addComponent(ChiefPending, { timer: BOSS_CHIEF.riseDelay });
      return;
    }
  }

  /**
   * Construction, not behaviour: clone the head, fade it in, seat it sunk into
   * the citadel drum, and give it a Health pool (bar pinned to the baked
   * `hp_blood` mount) plus a hit core. The seat comes from the ChiefMount
   * component captured at assembly and cannot be re-derived here — the laser
   * turret's death strips its whole subtree from the hull clone. It is
   * hull-local, which is the space a child parented under the hull needs.
   */
  private mountChief(boss: Entity, mountX: number, mountY: number, mountZ: number): void {
    const prototype = this.chiefPrototype;
    if (!prototype) return;
    const head = prototype.clone(true);

    const hpBlood = head.getObjectByName('hp_blood');
    const barY = hpBlood ? hpBlood.position.y : BOSS_CHIEF.riseY;

    // Same spawn-time material state as every unit: per-clone transparent
    // clones, SpawnFadeSystem solidifies them.
    this.prepareFadeMaterials(head);

    const entity = this.world.createTransformEntity(head, boss);
    entity.addComponent(IslewrathChief);
    entity.addComponent(Health, {
      current: BOSS_CHIEF.health,
      max: BOSS_CHIEF.health,
      barY,
    });
    entity.addComponent(HitCore, {
      radius: BOSS_CHIEF.coreRadius,
      faction: 'attacker',
      unitType: 'islewrath-chief',
      nodeName: 'hit_core',
      // Own BossChief bounty tier, shared with the five turrets.
      reward: RewardTier.BossChief,
    });
    // Emerge: start sunk into the drum and integrate up to riseY over riseSec;
    // baseY snapshots the seat so the tick needs no parent lookup.
    head.position.set(mountX, mountY - BOSS_CHIEF.riseSink, mountZ);
    entity.addComponent(ChiefRise, {
      elapsed: 0,
      duration: BOSS_CHIEF.riseSec,
      baseY: mountY,
    });
    entity.addComponent(SpawnFade, { duration: SPAWN_FADE_DURATION });
  }

  /**
   * Pause-frozen scalar rise from seat-riseSink to seat+riseY; on completion
   * the death light attaches at beatTimer 0.
   */
  private tickRise(delta: number): void {
    for (const chief of this.queries.rising.entities) {
      const object = chief.object3D;
      if (!object) continue;
      const elapsed = Number(chief.getValue(ChiefRise, 'elapsed')) + delta;
      const duration = Number(chief.getValue(ChiefRise, 'duration'));
      const t = Math.min(1, elapsed / duration);
      // Smoothstep ease — the emerge decelerates into its rest pose.
      const eased = t * t * (3 - 2 * t);
      const baseY = Number(chief.getValue(ChiefRise, 'baseY'));
      object.position.y =
        baseY - BOSS_CHIEF.riseSink + (BOSS_CHIEF.riseSink + BOSS_CHIEF.riseY) * eased;
      if (elapsed >= duration) {
        chief.removeComponent(ChiefRise);
        chief.addComponent(ChiefDeathLight, { timer: 0, beatCount: 0 });
      } else {
        chief.setValue(ChiefRise, 'elapsed', elapsed);
      }
    }
  }

  /**
   * Spawn-time material state for the head clone: per-clone transparent
   * materials, envMap re-linked (clone() drops it), shadows off until
   * SpawnFade solidifies. Mirrors LevelWaveSystem.prepareSpawnMaterials.
   */
  private prepareFadeMaterials(object: Object3D): void {
    object.traverse((child) => {
      const mesh = child as Mesh;
      if (!mesh.isMesh) return;
      const original = mesh.material;
      const solid = Array.isArray(original)
        ? original.map((material) => material.clone())
        : original.clone();
      const materials = Array.isArray(solid) ? solid : [solid];
      const sources = Array.isArray(original) ? original : [original];
      for (let i = 0; i < materials.length; i++) {
        const material = materials[i];
        material.transparent = true;
        material.opacity = 0;
        material.depthWrite = true;
        const srcStd = sources[i] as MeshStandardMaterial;
        const matStd = material as MeshStandardMaterial;
        if (!matStd.envMap && srcStd.envMap) {
          matStd.envMap = srcStd.envMap;
        }
      }
      mesh.material = solid;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
    });
  }

  /** True once the START hand-off has moved the director past waiting-start. */
  private gameRunning(): boolean {
    for (const director of this.queries.directors.entities) {
      return (
        String(director.getValue(LevelDirector, 'phase')) !== 'waiting-start'
      );
    }
    return false;
  }

  /** True while the pause-menu tag sits on the director entity. */
  private paused(): boolean {
    for (const director of this.queries.directors.entities) {
      return director.hasComponent(GamePaused);
    }
    return false;
  }

  /** True once the run has ended (victory or defeat) — the chief freezes. */
  private over(): boolean {
    for (const director of this.queries.directors.entities) {
      return director.hasComponent(GameOver);
    }
    return false;
  }
}
