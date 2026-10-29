/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createSystem, Vector3 } from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';
import {
  ChiefDeathLight,
  Destroyed,
  GameOver,
  GamePaused,
  Health,
  HitCore,
  HitFlash,
  HitFlashTag,
  IslewrathChief,
  LevelDirector,
} from './components.js';
import { COMBAT, DEATH_LIGHT, WALL_SEA_FACE_Z } from './level-config.js';

const DEG2RAD = Math.PI / 180;
/** Yaw error under this (rad) snaps the aim and opens the hold beat. */
const AIM_SNAP_RAD = 1.5 * DEG2RAD;

/**
 * Chief death light (铁头死光) — the phase-two chief head's own attack,
 * task 03. ChiefDeathLight attaches when the rise completes (BossChiefSystem
 * mounts it at beatTimer 0); this system is its only writer:
 *
 * - Beat clock (state 'idle'): every DEATH_LIGHT.intervalSec a beat fires.
 *   Beats 1..3 fire a LIGHTNING bolt — an instant jagged segment between the
 *   chief's hit core and one random surviving defender core that deducts
 *   75% of the victim's MAX Health. The 4th beat (t = 12 s after the rise)
 *   starts the SWEEP instead.
 * - Sweep (aiming -> hold -> forming -> sweeping): the head yaws onto one
 *   end of the wall at aimTurnSpeedDeg, holds aimHoldSec, the red beam
 *   forms over formSec (no charge-up), then sweeps across ALL five defense
 *   slots over sweepSec — the beam tracks a point walking the wall's sea
 *   face between the two span ends while the head's yaw follows. Every live
 *   defender core the corridor crosses loses 50% of its MAX Health, once
 *   per unit per sweep (the claimed-set guard). When the sweep ends the
 *   beat count restarts: the next lightning comes intervalSec later.
 *
 * Only Health.current is written — what dying means stays single-truthed in
 * ShellHitSystem's death sweep (same-frame pickup, priority 14). The head
 * never moves for the lightning; only the sweep yaws it (rotation.y, the
 * beam's own arc — nothing else rotates the head). The bolt endpoints and
 * the sweep axis freeze into the component when they fire: the fx system
 * renders from those fields alone, never the live scene graph.
 *
 * Stateless system: no per-entity caches; every scratch is a class property.
 */
export class ChiefDeathLightSystem extends createSystem({
  chiefs: { required: [IslewrathChief, ChiefDeathLight] },
  cores: { required: [HitCore, Health], excluded: [Destroyed] },
  /** The shared hit-bloom pool — same pool ShellHitSystem draws from. */
  freeFlashes: { required: [HitFlashTag], excluded: [HitFlash] },
  directors: { required: [LevelDirector] },
}) {
  /** Chief hit-core world position scratch (bolt origin / sweep origin). */
  private readonly origin = new Vector3();
  /** Rolled victim core world position scratch. */
  private readonly corePos = new Vector3();
  /** Frozen sweep endpoints, unfrozen per frame for the damage pass. */
  private readonly aimA = new Vector3();
  private readonly aimB = new Vector3();
  private readonly aim = new Vector3();
  /** Beam direction + damage-corridor scratch. */
  private readonly beamDir = new Vector3();
  private readonly toCore = new Vector3();
  private readonly closest = new Vector3();
  /** Defender cores already hit by the current sweep (once per unit). */
  private readonly claimed = new Set<number>();
  /** Hit-bloom pool entities claimed this frame (query refreshes next frame). */
  private readonly claimedFlashes = new Set<number>();

  update(delta: number): void {
    if (this.paused() || this.over() || !this.gameRunning()) return;
    this.claimedFlashes.clear();
    for (const chief of this.queries.chiefs.entities) {
      // Bolt life burns down no matter which state the head is in — the
      // flash is fire-and-forget, the beat clock never waits for it.
      const boltTimer =
        Number(chief.getValue(ChiefDeathLight, 'boltTimer')) - delta;
      chief.setValue(ChiefDeathLight, 'boltTimer', Math.max(0, boltTimer));

      switch (String(chief.getValue(ChiefDeathLight, 'state'))) {
        case 'aiming':
          this.tickAim(chief, delta);
          break;
        case 'hold':
        case 'forming':
          this.tickCountdown(chief, delta);
          break;
        case 'sweeping':
          this.tickSweep(chief, delta);
          break;
        default:
          this.tickBeats(chief, delta);
      }
    }
  }

  /**
   * Beat pacing: each elapse fires a lightning (beats 1..7) or, on the
   * sweepEveryBeats-th beat, the sweep. timer 0 at attach fires the first
   * bolt on the very next tick ("升起完毕立即开火").
   */
  private tickBeats(chief: Entity, delta: number): void {
    const timer = Number(chief.getValue(ChiefDeathLight, 'timer')) - delta;
    if (timer > 0) {
      chief.setValue(ChiefDeathLight, 'timer', timer);
      return;
    }
    if (
      Number(chief.getValue(ChiefDeathLight, 'beatCount')) >=
      DEATH_LIGHT.sweepEveryBeats - 1
    ) {
      this.beginSweep(chief);
      return;
    }
    this.fireBolt(chief);
    chief.setValue(
      ChiefDeathLight,
      'beatCount',
      Number(chief.getValue(ChiefDeathLight, 'beatCount')) + 1,
    );
    chief.setValue(ChiefDeathLight, 'timer', DEATH_LIGHT.intervalSec);
  }

  /**
   * Lightning: roll one surviving defender core (two passes, allocation
   * free), freeze both endpoints (chief hit core -> victim core) and start
   * the bolt visual, then deduct damageRatio of the victim's MAX Health.
   * No live defender (the run is being lost anyway): skip the bolt, the
   * beat clock just rolls on.
   */
  private fireBolt(chief: Entity): void {
    let defenderCount = 0;
    for (const core of this.queries.cores.entities) {
      if (core.getValue(HitCore, 'faction') === 'defender') defenderCount += 1;
    }
    if (defenderCount === 0 || !this.resolveOrigin(chief)) return;
    let pick = Math.floor(Math.random() * defenderCount);
    for (const core of this.queries.cores.entities) {
      if (core.getValue(HitCore, 'faction') !== 'defender') continue;
      if (pick > 0) {
        pick -= 1;
        continue;
      }
      core.object3D?.getWorldPosition(this.corePos);
      chief.setValue(ChiefDeathLight, 'boltOriginX', this.origin.x);
      chief.setValue(ChiefDeathLight, 'boltOriginY', this.origin.y);
      chief.setValue(ChiefDeathLight, 'boltOriginZ', this.origin.z);
      chief.setValue(ChiefDeathLight, 'boltTargetX', this.corePos.x);
      chief.setValue(ChiefDeathLight, 'boltTargetY', this.corePos.y);
      chief.setValue(ChiefDeathLight, 'boltTargetZ', this.corePos.z);
      chief.setValue(ChiefDeathLight, 'boltTimer', DEATH_LIGHT.boltLifeSec);
      const max = Number(core.getValue(Health, 'max'));
      const hp =
        Number(core.getValue(Health, 'current')) - max * DEATH_LIGHT.damageRatio;
      core.setValue(Health, 'current', Math.max(0, hp));
      // Hit bloom at the victim's centre — the same pool/look a defender
      // shell strike uses (defender-size peak).
      this.spawnHitFlash(this.corePos, 1);
      return;
    }
  }

  /**
   * Sweep start: freeze the beam origin (the chief's hit-core world
   * position) and the two wall-face aim endpoints — direction rolls
   * randomly left-to-right or right-to-left. State 'aiming' has no fixed
   * duration: the yaw swing below decides when the hold opens.
   */
  private beginSweep(chief: Entity): void {
    if (!this.resolveOrigin(chief)) return;
    const leftFirst = Math.random() < 0.5;
    const ax = leftFirst ? -DEATH_LIGHT.sweepSpanX : DEATH_LIGHT.sweepSpanX;
    const bx = leftFirst ? DEATH_LIGHT.sweepSpanX : -DEATH_LIGHT.sweepSpanX;
    chief.setValue(ChiefDeathLight, 'originX', this.origin.x);
    chief.setValue(ChiefDeathLight, 'originY', this.origin.y);
    chief.setValue(ChiefDeathLight, 'originZ', this.origin.z);
    chief.setValue(ChiefDeathLight, 'aimAX', ax);
    chief.setValue(ChiefDeathLight, 'aimAY', DEATH_LIGHT.sweepAimY);
    chief.setValue(ChiefDeathLight, 'aimAZ', WALL_SEA_FACE_Z);
    chief.setValue(ChiefDeathLight, 'aimBX', bx);
    chief.setValue(ChiefDeathLight, 'aimBY', DEATH_LIGHT.sweepAimY);
    chief.setValue(ChiefDeathLight, 'aimBZ', WALL_SEA_FACE_Z);
    chief.setValue(ChiefDeathLight, 'state', 'aiming');
  }

  /**
   * Yaw the head onto the start end (the beam's own arc — the head's only
   * rotation). Shortest-arc step at aimTurnSpeedDeg; convergence snaps and
   * opens the hold beat. The head is a bust on the drum: nothing else ever
   * touches its rotation.
   */
  private tickAim(chief: Entity, delta: number): void {
    const object = chief.object3D;
    if (!object) return;
    this.aimA.set(
      Number(chief.getValue(ChiefDeathLight, 'aimAX')),
      Number(chief.getValue(ChiefDeathLight, 'aimAY')),
      Number(chief.getValue(ChiefDeathLight, 'aimAZ')),
    );
    this.origin.set(
      Number(chief.getValue(ChiefDeathLight, 'originX')),
      Number(chief.getValue(ChiefDeathLight, 'originY')),
      Number(chief.getValue(ChiefDeathLight, 'originZ')),
    );
    this.aim.copy(this.aimA).sub(this.origin);
    // The bust faces +Z (toward the wall): its yaw onto the aim direction
    // is atan2(x, z).
    const targetYaw = Math.atan2(this.aim.x, this.aim.z);
    let err = targetYaw - object.rotation.y;
    // Wrap to the shortest arc.
    err = Math.atan2(Math.sin(err), Math.cos(err));
    const step = DEATH_LIGHT.aimTurnSpeedDeg * DEG2RAD * delta;
    if (Math.abs(err) <= Math.max(step, AIM_SNAP_RAD)) {
      object.rotation.y = targetYaw;
      chief.setValue(ChiefDeathLight, 'state', 'hold');
      chief.setValue(ChiefDeathLight, 'timer', DEATH_LIGHT.aimHoldSec);
      return;
    }
    object.rotation.y += Math.sign(err) * step;
  }

  /** Shared hold/form countdown: at zero the next state opens. */
  private tickCountdown(chief: Entity, delta: number): void {
    const timer = Number(chief.getValue(ChiefDeathLight, 'timer')) - delta;
    if (timer > 0) {
      chief.setValue(ChiefDeathLight, 'timer', timer);
      return;
    }
    const state = String(chief.getValue(ChiefDeathLight, 'state'));
    if (state === 'hold') {
      chief.setValue(ChiefDeathLight, 'state', 'forming');
      chief.setValue(ChiefDeathLight, 'timer', DEATH_LIGHT.formSec);
      return;
    }
    // Form complete: the sweep starts. The claimed set resets here — every
    // unit gets exactly one bite per sweep.
    this.claimed.clear();
    chief.setValue(ChiefDeathLight, 'state', 'sweeping');
    chief.setValue(ChiefDeathLight, 'timer', DEATH_LIGHT.sweepSec);
  }

  /**
   * The sweep proper: the beam tracks a point lerping between the frozen
   * wall-face endpoints while the head's yaw follows. Each frame every live
   * defender core inside the corridor (beam half-width + its own core
   * radius around the origin->end segment) not yet claimed loses
   * sweepDamageRatio of its MAX Health. At the end the beat clock restarts:
   * beatCount 0, next lightning intervalSec after the sweep finishes.
   */
  private tickSweep(chief: Entity, delta: number): void {
    const timer = Number(chief.getValue(ChiefDeathLight, 'timer')) - delta;
    if (timer <= 0) {
      chief.setValue(ChiefDeathLight, 'state', 'idle');
      chief.setValue(ChiefDeathLight, 'timer', DEATH_LIGHT.intervalSec);
      chief.setValue(ChiefDeathLight, 'beatCount', 0);
      return;
    }
    chief.setValue(ChiefDeathLight, 'timer', timer);
    const t = 1 - timer / DEATH_LIGHT.sweepSec;
    this.aimA.set(
      Number(chief.getValue(ChiefDeathLight, 'aimAX')),
      Number(chief.getValue(ChiefDeathLight, 'aimAY')),
      Number(chief.getValue(ChiefDeathLight, 'aimAZ')),
    );
    this.aimB.set(
      Number(chief.getValue(ChiefDeathLight, 'aimBX')),
      Number(chief.getValue(ChiefDeathLight, 'aimBY')),
      Number(chief.getValue(ChiefDeathLight, 'aimBZ')),
    );
    this.origin.set(
      Number(chief.getValue(ChiefDeathLight, 'originX')),
      Number(chief.getValue(ChiefDeathLight, 'originY')),
      Number(chief.getValue(ChiefDeathLight, 'originZ')),
    );
    this.aim.lerpVectors(this.aimA, this.aimB, t).sub(this.origin);
    const aimDist = this.aim.length();
    if (aimDist < 1e-6) return;
    this.beamDir.copy(this.aim).divideScalar(aimDist);
    // The head rides the beam's yaw — the y-axis sweep the spec asks for.
    if (chief.object3D) {
      chief.object3D.rotation.y = Math.atan2(this.beamDir.x, this.beamDir.z);
    }
    const beamLength = aimDist * DEATH_LIGHT.beamLengthBoost;
    for (const core of this.queries.cores.entities) {
      if (core.getValue(HitCore, 'faction') !== 'defender') continue;
      if (this.claimed.has(core.index)) continue;
      core.object3D?.getWorldPosition(this.corePos);
      this.toCore.copy(this.corePos).sub(this.origin);
      // Closest point on the frozen segment [origin, origin + dir·length].
      const along = Math.max(0, Math.min(beamLength, this.toCore.dot(this.beamDir)));
      this.closest.copy(this.origin).addScaledVector(this.beamDir, along);
      this.toCore.copy(this.corePos).sub(this.closest);
      const reach =
        Number(core.getValue(HitCore, 'radius')) + DEATH_LIGHT.sweepDamageRadius;
      if (this.toCore.lengthSq() > reach * reach) continue;
      this.claimed.add(core.index);
      const max = Number(core.getValue(Health, 'max'));
      const hp =
        Number(core.getValue(Health, 'current')) -
        max * DEATH_LIGHT.sweepDamageRatio;
      core.setValue(Health, 'current', Math.max(0, hp));
      // Same hit bloom as the lightning: the sweep bite reads on the field.
      this.spawnHitFlash(this.corePos, 1);
    }
  }

  /**
   * Freeze the chief's hit-core world position into `origin`. The baked
   * hit_core node rides the head clone; without it there is no attack.
   */
  private resolveOrigin(chief: Entity): boolean {
    const node = chief.object3D?.getObjectByName(
      String(chief.getValue(HitCore, 'nodeName')),
    );
    if (!node) return false;
    node.getWorldPosition(this.origin);
    return true;
  }

  /**
   * Claim a free pooled hit bloom and land its starting state at the struck
   * core's centre — identical to ShellHitSystem's spawn (same shared pool,
   * same visual): position, start scale, visible, then the HitFlash tag
   * that hands animation to HitFlashSystem. Pool empty: skip silently — a
   * busy battle loses the odd bloom, never a hit.
   */
  private spawnHitFlash(position: Vector3, peakScale: number): void {
    for (const flash of this.queries.freeFlashes.entities) {
      if (this.claimedFlashes.has(flash.index)) continue;
      // Live guard: another spawn this frame may have claimed it already,
      // since the free-flash query only refreshes next frame.
      if (flash.hasComponent(HitFlash)) continue;
      this.claimedFlashes.add(flash.index);
      const object = flash.object3D;
      if (!object) return;
      object.position.copy(position);
      object.scale.setScalar(COMBAT.hitFlashStartScale * peakScale);
      object.visible = true;
      flash.addComponent(HitFlash, {
        duration: COMBAT.hitFlashDuration,
        peakScale,
      });
      return;
    }
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

  /** True once the run has ended (victory or defeat) — the beam holds. */
  private over(): boolean {
    for (const director of this.queries.directors.entities) {
      return director.hasComponent(GameOver);
    }
    return false;
  }
}
