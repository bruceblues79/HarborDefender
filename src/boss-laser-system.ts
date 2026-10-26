/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  AdditiveBlending,
  createSystem,
  CylinderGeometry,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  SphereGeometry,
  Vector3,
} from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';
import {
  BossLaser,
  BossSummon,
  Destroyed,
  GameOver,
  GamePaused,
  Health,
  HitCore,
  HitFlash,
  HitFlashTag,
  LevelDirector,
  ShipMovement,
  UnitTag,
} from './components.js';
import { BOSS, COMBAT } from './level-config.js';

/**
 * The Islewrath's laser citadel — the charged signature weapon. Cadence:
 * idle (cooling) -> lock ONE random defender core -> charging (an ember glow
 * swells at the muzzle over laserChargeSec, the turret yaw tracks the
 * victim) -> firing (a beam pillar stretches muzzle -> core for
 * laserBeamSec) -> idle. The burn lands on the FIRE frame: the victim's
 * Health drops by `laserDamagePct` % of its MAX pool — a direct write, not a
 * DAMAGE_MATRIX lookup (the matrix is a flat-percentage-of-pool table; the
 * beam is a max-pool special case, documented in combat.md). ShellHitSystem's
 * death sweep collects the kill if the pool runs dry.
 *
 * Lock discipline: the victim is validated every frame against the live
 * cores query (Destroyed cannons drop out) — a dead lock dissolves back to
 * idle and the citadel re-arms. The beam itself is one pooled cylinder
 * (additive, depthWrite off, renderOrder above the health bars, like the
 * hit-flash bloom) stretched between muzzle and core; the charge glow is a
 * pooled sphere parked at the muzzle world position each frame.
 */
export class BossLaserSystem extends createSystem({
  lasers: { required: [BossLaser] },
  bosses: { required: [UnitTag, ShipMovement, BossSummon] },
  cores: { required: [HitCore], excluded: [Destroyed] },
  freeFlashes: { required: [HitFlashTag], excluded: [HitFlash] },
  directors: { required: [LevelDirector] },
}) {
  /** Muzzle node per laser entity index, resolved once on qualify. */
  private readonly muzzles = new Map<number, Object3D>();
  /** Defender hit_core nodes per core entity index, resolved once on qualify. */
  private readonly coreNodes = new Map<number, Object3D>();
  /** Flashes handed out this frame; the free-flash query refreshes next frame. */
  private readonly claimedFlashes = new Set<number>();
  /** The pooled beam pillar (created in init, toggled visible while firing). */
  private beam!: Mesh;
  /** The pooled charge-glow sphere (scaled up while charging). */
  private glow!: Mesh;
  private readonly muzzlePos = new Vector3();
  private readonly corePos = new Vector3();
  private readonly pivotPos = new Vector3();
  private readonly beamDir = new Vector3();
  private readonly up = new Vector3(0, 1, 0);

  init(): void {
    this.queries.lasers.subscribe('qualify', (laser) => {
      const muzzle = laser.object3D?.getObjectByName('muzzle');
      if (muzzle) this.muzzles.set(laser.index, muzzle);
    });
    // A citadel that leaves the fight (RESTART / MAIN field clear, or its
    // own destruction) takes the beam and glow down with it — the pooled
    // meshes outlive the entity and would freeze visible otherwise.
    this.queries.lasers.subscribe('disqualify', () => {
      this.beam.visible = false;
      this.glow.visible = false;
    });
    this.queries.cores.subscribe('qualify', (core) => {
      if (core.getValue(HitCore, 'faction') !== 'defender') return;
      const node = core.object3D?.getObjectByName('hit_core');
      if (node) this.coreNodes.set(core.index, node);
    });

    // Beam pillar: unit cylinder along +Y, scaled to the shot's span.
    const beamGeometry = new CylinderGeometry(
      BOSS.laserBeamRadius,
      BOSS.laserBeamRadius,
      1,
      8,
    );
    const beamMaterial = new MeshBasicMaterial({
      color: 0xff3a2a,
      transparent: true,
      opacity: 0.85,
      blending: AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    this.beam = new Mesh(beamGeometry, beamMaterial);
    this.beam.renderOrder = 10;
    this.beam.visible = false;
    this.beam.castShadow = false;
    this.beam.userData.skipShadow = true;
    this.world.createTransformEntity(this.beam);

    // Charge glow: unit sphere at the muzzle, scaled by the charge progress.
    const glowGeometry = new SphereGeometry(1, 10, 8);
    const glowMaterial = new MeshBasicMaterial({
      color: 0xff5522,
      transparent: true,
      opacity: 0.8,
      blending: AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    this.glow = new Mesh(glowGeometry, glowMaterial);
    this.glow.renderOrder = 10;
    this.glow.visible = false;
    this.glow.castShadow = false;
    this.glow.userData.skipShadow = true;
    this.world.createTransformEntity(this.glow);
  }

  update(delta: number): void {
    if (this.paused() || this.over() || !this.gameRunning()) return;
    const boss = this.queries.bosses.entities.values().next().value;
    // The citadel opens up only once the hull has parked at its berth.
    if (!boss || String(boss.getValue(ShipMovement, 'state')) !== 'stopped') {
      return;
    }

    this.claimedFlashes.clear();
    for (const laser of this.queries.lasers.entities) {
      const phase = String(laser.getValue(BossLaser, 'phase'));
      if (phase === 'idle') this.updateIdle(laser, delta);
      else if (phase === 'charging') this.updateCharging(laser, delta);
      else if (phase === 'firing') this.updateFiring(laser, delta);
    }
  }

  /** Cooling down; on an empty timer, lock a victim and start charging. */
  private updateIdle(laser: Entity, delta: number): void {
    this.glow.visible = false;
    this.beam.visible = false;
    let cooldown = Number(laser.getValue(BossLaser, 'cooldown')) - delta;
    if (cooldown <= 0) {
      const core = this.randomDefenderCore();
      if (!core) {
        // Nothing to burn (defeat check is about to settle the run): retry soon.
        cooldown = 0.5;
      } else {
        const node = this.coreNodes.get(core.index);
        if (node) {
          node.getWorldPosition(this.corePos);
          laser.setValue(BossLaser, 'targetCoreIndex', core.index);
          laser.setValue(BossLaser, 'targetX', this.corePos.x);
          laser.setValue(BossLaser, 'targetY', this.corePos.y);
          laser.setValue(BossLaser, 'targetZ', this.corePos.z);
          laser.setValue(BossLaser, 'phase', 'charging');
          laser.setValue(BossLaser, 'elapsed', 0);
          return;
        }
        cooldown = 0.5;
      }
    }
    laser.setValue(BossLaser, 'cooldown', cooldown);
  }

  /** Charge up; the glow swells, the turret tracks, the lock stays live. */
  private updateCharging(laser: Entity, delta: number): void {
    if (!this.lockAlive(laser)) {
      this.backToIdle(laser);
      return;
    }
    this.aimTurret(laser);
    const elapsed = Number(laser.getValue(BossLaser, 'elapsed')) + delta;
    const muzzle = this.muzzles.get(laser.index);
    if (muzzle) {
      muzzle.getWorldPosition(this.muzzlePos);
      this.glow.position.copy(this.muzzlePos);
      const progress = Math.min(1, elapsed / BOSS.laserChargeSec);
      this.glow.scale.setScalar(BOSS.laserGlowRadius * progress);
      this.glow.visible = progress > 0.05;
    }
    if (elapsed >= BOSS.laserChargeSec) {
      this.fireBeam(laser);
      return;
    }
    laser.setValue(BossLaser, 'elapsed', elapsed);
  }

  /** Beam visible for its burn window, then back to idle. */
  private updateFiring(laser: Entity, delta: number): void {
    const elapsed = Number(laser.getValue(BossLaser, 'elapsed')) + delta;
    if (elapsed >= BOSS.laserBeamSec) {
      this.backToIdle(laser);
      return;
    }
    laser.setValue(BossLaser, 'elapsed', elapsed);
  }

  /** The burn: write laserDamagePct % of the victim's MAX pool, bloom, beam. */
  private fireBeam(laser: Entity): void {
    const victim = this.lockedCore(laser);
    const muzzle = this.muzzles.get(laser.index);
    if (!victim || !muzzle) {
      this.backToIdle(laser);
      return;
    }
    const node = this.coreNodes.get(victim.index);
    if (!node) {
      this.backToIdle(laser);
      return;
    }
    node.getWorldPosition(this.corePos);
    muzzle.getWorldPosition(this.muzzlePos);

    // Max-pool burn, then the pool's single death authority takes over.
    const max = Number(victim.getValue(Health, 'max'));
    const current = Number(victim.getValue(Health, 'current'));
    victim.setValue(
      Health,
      'current',
      Math.max(0, current - (max * BOSS.laserDamagePct) / 100),
    );
    this.spawnHitFlash(this.corePos, victim);

    // Stretch the beam pillar across the muzzle -> core span.
    this.beamDir.subVectors(this.corePos, this.muzzlePos);
    const span = this.beamDir.length();
    this.beam.position.copy(this.muzzlePos).addScaledVector(this.beamDir, 0.5);
    this.beam.quaternion.setFromUnitVectors(this.up, this.beamDir.normalize());
    this.beam.scale.set(1, span, 1);
    this.beam.visible = true;
    this.glow.visible = false;

    laser.setValue(BossLaser, 'phase', 'firing');
    laser.setValue(BossLaser, 'elapsed', 0);
  }

  /** Park the citadel: clear the lock, hide the effects, re-arm the timer. */
  private backToIdle(laser: Entity): void {
    laser.setValue(BossLaser, 'phase', 'idle');
    laser.setValue(BossLaser, 'cooldown', BOSS.laserIntervalSec);
    laser.setValue(BossLaser, 'elapsed', 0);
    laser.setValue(BossLaser, 'targetCoreIndex', -1);
    this.beam.visible = false;
    this.glow.visible = false;
  }

  /** Yaw the citadel pivot onto its locked victim (hull-local conversion). */
  private aimTurret(laser: Entity): void {
    const pivot = laser.object3D;
    const boss = this.queries.bosses.entities.values().next().value;
    if (!pivot || !boss?.object3D) return;
    pivot.getWorldPosition(this.pivotPos);
    const worldYaw = Math.atan2(
      -(Number(laser.getValue(BossLaser, 'targetX')) - this.pivotPos.x),
      -(Number(laser.getValue(BossLaser, 'targetZ')) - this.pivotPos.z),
    );
    pivot.rotation.y = worldYaw - boss.object3D.rotation.y;
  }

  /** Whether the locked core still exists among live defender cores. */
  private lockAlive(laser: Entity): boolean {
    return this.lockedCore(laser) !== undefined;
  }

  /** The locked core entity, or undefined once it has left the live query. */
  private lockedCore(laser: Entity): Entity | undefined {
    const locked = Number(laser.getValue(BossLaser, 'targetCoreIndex'));
    if (locked < 0) return undefined;
    for (const core of this.queries.cores.entities) {
      if (core.getValue(HitCore, 'faction') !== 'defender') continue;
      if (core.index === locked) return core;
    }
    return undefined;
  }

  /**
   * One uniformly random live defender core — the same two-pass roll the
   * turret guns use. Runs once per charge cycle, never per frame.
   */
  private randomDefenderCore(): Entity | undefined {
    let defenderCount = 0;
    for (const core of this.queries.cores.entities) {
      if (core.getValue(HitCore, 'faction') === 'defender') defenderCount += 1;
    }
    if (defenderCount === 0) return undefined;
    let pick = Math.floor(Math.random() * defenderCount);
    for (const core of this.queries.cores.entities) {
      if (core.getValue(HitCore, 'faction') !== 'defender') continue;
      if (pick > 0) {
        pick -= 1;
        continue;
      }
      return core;
    }
    return undefined;
  }

  /** Claim a pooled hit-flash for the beam strike (ShellHitSystem's pool). */
  private spawnHitFlash(position: Vector3, victim: Entity): void {
    for (const flash of this.queries.freeFlashes.entities) {
      if (this.claimedFlashes.has(flash.index)) continue;
      if (flash.hasComponent(HitFlash)) continue;
      this.claimedFlashes.add(flash.index);
      const object = flash.object3D;
      if (!object) return;
      object.position.copy(position);
      object.scale.setScalar(COMBAT.hitFlashStartScale);
      object.visible = true;
      flash.addComponent(HitFlash, {
        duration: COMBAT.hitFlashDuration,
        peakScale: 1,
      });
      return;
    }
  }

  /** True while the pause-menu tag sits on the director entity. */
  private paused(): boolean {
    for (const director of this.queries.directors.entities) {
      return director.hasComponent(GamePaused);
    }
    return false;
  }

  /** True once the run has ended — the citadel goes dark. */
  private over(): boolean {
    for (const director of this.queries.directors.entities) {
      return director.hasComponent(GameOver);
    }
    return false;
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
}
