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
  ChiefMount,
  ChiefPending,
  ChiefRise,
  ChiefSummon,
  GameOver,
  GamePaused,
  Health,
  HitCore,
  IslewrathChief,
  LevelDirector,
  SpawnFade,
  SummonCommand,
  UnitTag,
  BossTurret,
} from './components.js';
import { BOSS_CHIEF, SPAWN_FADE_DURATION } from './level-config.js';

/**
 * Phase-two chief head (海盗头领) — task 031. Once every boss turret is gone
 * (the BossTurret query runs empty while the hull still floats) the pirate
 * warlord's head rises at the laser citadel: a Health + HitCore child entity
 * every defender shell can hit (matrix rows chip 2% per strike), but with NO
 * attack ability of its own — it only paces the kamikaze summons.
 *
 * Responsibilities stay small (TESS):
 * - the phase-two trigger, the 0.5 s beat, and the one-shot head mount
 *   (construction);
 * - the emerge rise animation (ChiefRise, pause-frozen scalar integration):
 *   the head starts sunk INSIDE the citadel drum and rises just proud of the
 *   rim — visually connected to the ship, never floating free;
 * - the summon clock: ChiefSummon only attaches when the rise completes
 *   (timer 0 → first batch fires at once), each elapse raises the
 *   SummonCommand thin command that LevelWaveSystem — the single spawn
 *   truth — consumes.
 *
 * Death is NOT here: ShellHitSystem's kill() owns it (bounty, burst,
 * dispose, ChiefDown command).
 */
export class BossChiefSystem extends createSystem({
  bosses: { required: [UnitTag] },
  bossTurrets: { required: [BossTurret] },
  chiefs: { required: [IslewrathChief] },
  pending: { required: [UnitTag, ChiefPending] },
  rising: { required: [IslewrathChief, ChiefRise] },
  summoners: { required: [IslewrathChief, ChiefSummon] },
  directors: { required: [LevelDirector] },
}) {
  /** pirate-chief prototype loaded once in init; null until it arrives. */
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
    this.tickSummons(delta);
    this.tryMountChief();
  }

  /**
   * The 0.5 s beat between the last turret dying and the rise starting —
   * a ChiefPending timer on the boss hull. At zero the head mounts.
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
   * Phase-two trigger: the boss hull is still on the water, every BossTurret
   * part entity is gone, and no chief exists yet. Runs after the rise/summon
   * ticks so a freshly mounted head never doubles.
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
        // Assembly never captured the seat (missing pivot node) — surface it
        // loudly instead of silently never entering phase two.
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
   * Construction, not behaviour: clone the head prototype, fade it in, seat
   * it SUNK into the citadel drum (mount seat minus riseSink), and hand it
   * its Health pool (bar pinned to the baked `hp_blood` crown mount) and hit
   * core (defender shells resolve against it through the shared
   * ShellHitSystem). No summon clock yet — ChiefSummon only attaches when
   * the rise completes, so the first batch leaves after the emerge.
   *
   * The seat comes from the ChiefMount component, captured while the boss
   * turrets were assembled. It CANNOT be re-derived at phase-two time: the
   * laser turret's death strips its whole subtree (the `gun_rotate_laser`
   * pivot included) from the hull clone, so a lookup here finds nothing.
   * The seat is hull-local (parent chain summed EXCLUDING the hull root —
   * root.position is a world coordinate), which is exactly the space a
   * child parented under the hull needs.
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
    });
    // Emerge: start sunk into the drum, integrate up to just proud of the
    // rim over riseSec. baseY snapshots the seat so the rise tick stays a
    // pure scalar integrate with no parent lookup.
    head.position.set(mountX, mountY - BOSS_CHIEF.riseSink, mountZ);
    entity.addComponent(ChiefRise, {
      elapsed: 0,
      duration: BOSS_CHIEF.riseSec,
      baseY: mountY,
    });
    entity.addComponent(SpawnFade, { duration: SPAWN_FADE_DURATION });
  }

  /**
   * Pause-frozen scalar rise: y eases from seat-riseSink (sunk inside the
   * drum) to seat+riseY (just proud of the rim). On completion the summon
   * clock attaches at timer 0 — the first batch fires on the next tick.
   */
  private tickRise(delta: number): void {
    for (const chief of this.queries.rising.entities) {
      const object = chief.object3D;
      if (!object) continue;
      const elapsed = Number(chief.getValue(ChiefRise, 'elapsed')) + delta;
      const duration = Number(chief.getValue(ChiefRise, 'duration'));
      const t = Math.min(1, elapsed / duration);
      // Smoothstep ease — the emerge decelerates into its rest pose instead
      // of stopping dead.
      const eased = t * t * (3 - 2 * t);
      const baseY = Number(chief.getValue(ChiefRise, 'baseY'));
      object.position.y =
        baseY - BOSS_CHIEF.riseSink + (BOSS_CHIEF.riseSink + BOSS_CHIEF.riseY) * eased;
      if (elapsed >= duration) {
        chief.removeComponent(ChiefRise);
        chief.addComponent(ChiefSummon, { timer: 0 });
      } else {
        chief.setValue(ChiefRise, 'elapsed', elapsed);
      }
    }
  }

  /**
   * Summon clock: each head's countdown elapses into a SummonCommand thin
   * command on the director (LevelWaveSystem spawns through its single
   * pipeline). Timer 0 at mount fires the first batch immediately.
   */
  private tickSummons(delta: number): void {
    for (const chief of this.queries.summoners.entities) {
      const timer = Number(chief.getValue(ChiefSummon, 'timer')) - delta;
      if (timer > 0) {
        chief.setValue(ChiefSummon, 'timer', timer);
        continue;
      }
      chief.setValue(ChiefSummon, 'timer', BOSS_CHIEF.summonInterval);
      for (const director of this.queries.directors.entities) {
        // A batch still in flight keeps its remaining count; the clock
        // reset above paces the NEXT batch.
        if (!director.hasComponent(SummonCommand)) {
          director.addComponent(SummonCommand, { count: BOSS_CHIEF.summonBatch });
        }
        break;
      }
    }
  }

  /**
   * Spawn-time material state for the head clone — per-clone material clones
   * starting fully transparent, IBL re-linked from the prototype materials
   * (clone() drops the reference), shadows off until SpawnFade solidifies.
   * Mirrors LevelWaveSystem.prepareSpawnMaterials (kept local: that one is
   * tuned for unit hulls and lives beside the spawn pipeline).
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
