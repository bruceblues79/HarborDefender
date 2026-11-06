/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  createSystem,
  IcosahedronGeometry,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
  Vector3,
} from '@iwsdk/core';
import type { Entity, Object3D } from '@iwsdk/core';
import {
  BallisticFlight,
  CannonFire,
  Destroyed,
  GameOver,
  GamePaused,
  LevelDirector,
  ShellFaction,
  ShellTag,
  StoneTag,
} from './components.js';
import { COMBAT } from './level-config.js';

/**
 * Owns the shared projectile pools; a projectile is free while it lacks
 * `BallisticFlight`. Stones carry StoneTag so a ball gun can never grab one.
 * Muzzle is the `muzzle` child battle-setup hangs under gun_rotate.
 */
export class CannonFireSystem extends createSystem({
  cannons: { required: [CannonFire], excluded: [Destroyed] },
  freeShells: {
    required: [ShellTag],
    excluded: [BallisticFlight, StoneTag],
  },
  airborne: { required: [ShellTag, BallisticFlight] },
  directors: { required: [LevelDirector] },
}) {
  private readonly muzzles = new Map<number, Object3D>();
  /** Shells handed out this frame; the free-shell query only refreshes next frame. */
  private readonly claimed = new Set<number>();
  private readonly retiring: Entity[] = [];
  private readonly muzzlePos = new Vector3();
  private readonly muzzleDir = new Vector3();

  init(): void {
    const geometry = new SphereGeometry(COMBAT.shellRadius, 8, 6);
    const material = new MeshStandardMaterial({
      color: COMBAT.shellColor,
      metalness: 1,
      roughness: 0.6,
    });
    for (let i = 0; i < COMBAT.shellPoolSize; i++) {
      const shell = new Mesh(geometry, material);
      shell.castShadow = true;
      shell.visible = false;
      this.world.createTransformEntity(shell).addComponent(ShellTag);
    }
    const stoneGeometry = new IcosahedronGeometry(COMBAT.stoneRadius, 0);
    const stoneMaterial = new MeshStandardMaterial({
      color: COMBAT.stoneColor,
      roughness: 0.9,
      metalness: 0,
    });
    for (let i = 0; i < COMBAT.stonePoolSize; i++) {
      const stone = new Mesh(stoneGeometry, stoneMaterial);
      stone.castShadow = true;
      stone.visible = false;
      this.world
        .createTransformEntity(stone)
        .addComponent(ShellTag)
        .addComponent(StoneTag);
    }
    this.queries.cannons.subscribe('qualify', (entity) => {
      const muzzle = entity.object3D?.getObjectByName('muzzle');
      if (muzzle) this.muzzles.set(entity.index, muzzle);
      // Roll the first cooldown too: the opening volley starts staggered.
      entity.setValue(CannonFire, 'cooldown', this.rollInterval(entity));
    });
  }

  update(delta: number): void {
    // Hold fire until the START gate opens (LevelDirector.phase is the single
    // flow truth); pause and game-over freeze cooldowns without changing them.
    if (this.paused() || this.over() || !this.gameRunning()) return;
    this.claimed.clear();
    for (const entity of this.queries.cannons.entities) {
      let cooldown = Number(entity.getValue(CannonFire, 'cooldown')) - delta;
      if (cooldown <= 0) {
        // Pool empty: retry in 0.1 s instead of banking negative time.
        cooldown = this.fire(entity) ? this.rollInterval(entity) : 0.1;
      }
      entity.setValue(CannonFire, 'cooldown', cooldown);
    }
  }

  private rollInterval(cannon: Entity): number {
    return (
      Number(cannon.getValue(CannonFire, 'interval')) +
      COMBAT.fireJitterMin +
      Math.random() * (COMBAT.fireJitterMax - COMBAT.fireJitterMin)
    );
  }

  /** Launch one free projectile down the muzzle's -Z; false when the pool is empty. */
  private fire(cannon: Entity): boolean {
    const muzzle = this.muzzles.get(cannon.index);
    if (!muzzle) return false;
    const shell = this.firstFreeShell();
    const shellObject = shell?.object3D;
    if (!shell || !shellObject) return false;

    muzzle.getWorldPosition(this.muzzlePos);
    // Object3D.getWorldDirection returns +Z; the barrel fires down its -Z.
    muzzle.getWorldDirection(this.muzzleDir).negate();
    shellObject.position.copy(this.muzzlePos);
    shellObject.visible = true;
    shell.addComponent(BallisticFlight, {
      vx: this.muzzleDir.x * COMBAT.shellSpeed,
      vy: this.muzzleDir.y * COMBAT.shellSpeed,
      vz: this.muzzleDir.z * COMBAT.shellSpeed,
      drag: COMBAT.shellDrag,
    });
    // City batteries fight for the defender side; ShellHitSystem reads both the
    // faction and unitType.
    shell.addComponent(ShellFaction, {
      faction: 'defender',
      unitType: String(cannon.getValue(CannonFire, 'unitType')),
    });
    return true;
  }

  /**
   * First pooled shell neither airborne nor claimed this frame; the live
   * hasComponent check also blocks PirateFireSystem, whose claim lands next frame.
   */
  private firstFreeShell(): Entity | undefined {
    for (const shell of this.queries.freeShells.entities) {
      if (this.claimed.has(shell.index)) continue;
      if (shell.hasComponent(BallisticFlight)) continue;
      this.claimed.add(shell.index);
      return shell;
    }
    return undefined;
  }

  private gameRunning(): boolean {
    for (const director of this.queries.directors.entities) {
      return (
        String(director.getValue(LevelDirector, 'phase')) !== 'waiting-start'
      );
    }
    return false;
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

  /** RESTART / MAIN reset: hide and free every airborne shell; the pool is never rebuilt. */
  recycleAirborneShells(): void {
    this.retiring.length = 0;
    for (const shell of this.queries.airborne.entities) {
      this.retiring.push(shell);
    }
    for (const shell of this.retiring) {
      shell.removeComponent(BallisticFlight);
      shell.removeComponent(ShellFaction);
      if (shell.object3D) shell.object3D.visible = false;
    }
  }
}
