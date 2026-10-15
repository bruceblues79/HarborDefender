/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { AssetManager, createSystem, Mesh } from '@iwsdk/core';
import type { Entity, Material, Object3D } from '@iwsdk/core';
import {
  LevelDirector,
  ShipMovement,
  UnitTag,
  WakeSource,
} from './components.js';
import {
  activeLevelList,
  OCEAN,
  OCEAN_FAR_Z,
  PACING,
  SHIP_STOP_Z_MAX,
  SHIP_STOP_Z_MIN,
  SHIP_Y,
  UNIT_TYPES,
} from './level-config.js';

/** Ships emerge this far inside the ocean's far edge. */
const SPAWN_Z = OCEAN_FAR_Z + 0.1;
/** Keep a lane clear of the ocean edge. */
const SPAWN_MARGIN = 0.3;
/** Ripple radius a sailing ship carries; ShipMovementSystem halves it when stopped. */
const WAKE_RADIUS = 1.25;

type DirectorPhase =
  | 'waiting-start'
  | 'dispatching'
  | 'clearing'
  | 'wave-gap'
  | 'level-gap'
  | 'game-cleared';

/**
 * Director for the level -> wave -> unit flow.
 *
 * A single entity carries the LevelDirector state and this system is its only
 * writer. It paces dispatch (`PACING.spawnInterval` between units), pauses
 * while `PACING.maxConcurrentUnits` attackers are on the water, waits for a
 * wave to clear before the next, and advances levels until the list runs out.
 *
 * Attacker units are clones of UNIT_TYPES prototypes (loaded once in init) and
 * are handed to ShipMovementSystem through the ShipMovement component.
 */
export class LevelWaveSystem extends createSystem({
  directors: { required: [LevelDirector] },
  attackers: { required: [UnitTag, ShipMovement] },
}) {
  /** Unit prototypes keyed by unitType; clones share geometry and materials. */
  private readonly prototypes = new Map<string, Object3D>();
  private director!: Entity;

  init(): void {
    const director = this.world.createEntity();
    director.addComponent(LevelDirector, { phase: 'waiting-start' });
    this.director = director;

    for (const [type, def] of Object.entries(UNIT_TYPES)) {
      AssetManager.loadGLTFById(def.assetId)
        .then((gltf) => this.prototypes.set(type, gltf.scene))
        .catch((err: unknown) =>
          console.error(`LevelWaveSystem: failed to load unit "${type}"`, err),
        );
    }
  }

  /** Hand control to the first level. Called after the START panel dismisses. */
  beginLevel(): void {
    this.enterLevel(0);
  }

  update(delta: number): void {
    const phase = this.director.getValue(
      LevelDirector,
      'phase',
    ) as DirectorPhase;
    switch (phase) {
      case 'dispatching':
        this.updateDispatching(delta);
        break;
      case 'clearing':
        if (this.fieldSettled()) this.advanceAfterWave();
        break;
      case 'wave-gap':
        if (this.countDown(delta)) this.enterWave(this.waveIndex() + 1);
        break;
      case 'level-gap':
        if (this.countDown(delta)) this.enterLevel(this.levelIndex() + 1);
        break;
      default:
        break;
    }
  }

  /** Send out units while the field is not full and the wave has some left. */
  private updateDispatching(delta: number): void {
    let timer = this.readNumber('timer') - delta;
    let pending = this.pendingUnits();

    while (
      timer <= 0 &&
      pending > 0 &&
      this.attackerCount() < PACING.maxConcurrentUnits
    ) {
      // A unit whose prototype is still loading holds the wave; retry next frame.
      if (!this.spawnUnit(pending)) break;
      pending -= 1;
      timer += PACING.spawnInterval;
    }
    // Waiting on the concurrency cap must not bank up negative time, or a
    // freed slot would burst several ships out at once on the same frame.
    if (timer < 0) timer = 0;

    this.director.setValue(LevelDirector, 'timer', timer);
    this.director.setValue(LevelDirector, 'pendingUnits', pending);
    if (pending <= 0) this.setPhase('clearing');
  }

  /** Spawn the next unit of the current wave. False when it cannot spawn yet. */
  private spawnUnit(pending: number): boolean {
    const units = this.currentWaveUnits();
    const unitType = units[units.length - pending];
    const def = UNIT_TYPES[unitType];
    if (!def) {
      console.error(`LevelWaveSystem: unknown unit type "${unitType}"`);
      return false;
    }
    const prototype = this.prototypes.get(unitType);
    if (!prototype) return false;

    const object = prototype.clone(true);

    // Spawn point: rolled x on the far edge; sail target: rolled x and z.
    const rollX = () =>
      (Math.random() * 2 - 1) * (OCEAN.width / 2 - SPAWN_MARGIN);
    const spawnX = rollX();
    const targetX = rollX();
    const targetZ =
      SHIP_STOP_Z_MIN + Math.random() * (SHIP_STOP_Z_MAX - SHIP_STOP_Z_MIN);
    object.position.set(spawnX, SHIP_Y, SPAWN_Z);
    // Bow is the hull's local -Z; yaw it onto the spawn -> target direction.
    object.rotation.y = Math.atan2(-(targetX - spawnX), -(targetZ - SPAWN_Z));

    // Fade-in via standard-material alpha: hull materials are shared across
    // clones, so each ship gets its own clones driven by opacity. Shadows stay
    // off until the ship is fully materialised.
    object.traverse((child) => {
      const mesh = child as Mesh;
      if (!mesh.isMesh) return;
      const original = mesh.material;
      const solid = Array.isArray(original)
        ? original.map((material) => material.clone())
        : original.clone();
      for (const material of Array.isArray(solid) ? solid : [solid]) {
        material.transparent = true;
        material.opacity = 0;
      }
      mesh.material = solid;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
    });

    const entity = this.world.createTransformEntity(object);
    entity.addComponent(UnitTag, { unitType, faction: def.faction });
    entity.addComponent(ShipMovement, {
      pattern: def.movement,
      state: 'spawning',
      spawnFade: 0,
      spawnX,
      targetX,
      targetZ,
    });
    entity.addComponent(WakeSource, {
      strength: 0,
      targetStrength: 0.5,
      radius: WAKE_RADIUS,
      targetRadius: WAKE_RADIUS * 0.5,
    });
    return true;
  }

  /** Begin the given level, or declare the run complete past the last one. */
  private enterLevel(index: number): void {
    if (index >= activeLevelList.length) {
      this.setPhase('game-cleared');
      return;
    }
    this.director.setValue(LevelDirector, 'levelIndex', index);
    this.enterWave(0);
  }

  /** Begin the given wave, or move the level on when its waves run out. */
  private enterWave(index: number): void {
    const level = activeLevelList[this.levelIndex()];
    const wave = level.waves[index];
    if (!wave) {
      this.advanceAfterWave();
      return;
    }
    this.director.setValue(LevelDirector, 'waveIndex', index);
    this.director.setValue(LevelDirector, 'pendingUnits', wave.units.length);
    this.director.setValue(LevelDirector, 'timer', 0);
    this.setPhase('dispatching');
  }

  /** A wave is done: wait, then start the next wave or level. */
  private advanceAfterWave(): void {
    const level = activeLevelList[this.levelIndex()];
    if (this.waveIndex() + 1 < level.waves.length) {
      this.setPhase('wave-gap');
      this.director.setValue(LevelDirector, 'timer', PACING.postWaveDelay);
      return;
    }
    if (this.levelIndex() + 1 < activeLevelList.length) {
      this.setPhase('level-gap');
      this.director.setValue(LevelDirector, 'timer', PACING.postLevelDelay);
      return;
    }
    this.setPhase('game-cleared');
  }

  /** Attackers of any type currently on the water. */
  private attackerCount(): number {
    let count = 0;
    for (const entity of this.queries.attackers.entities) {
      if (entity.getValue(UnitTag, 'faction') === 'attacker') count += 1;
    }
    return count;
  }

  /**
   * Placeholder wave-clear test. Combat is not in yet, so a wave counts as
   * cleared once every dispatched attacker has finished emerging and is
   * either halted at its lane or waiting behind another ship. Swap this for a
   * destroyed/killed check once units can be sunk.
   */
  private fieldSettled(): boolean {
    for (const entity of this.queries.attackers.entities) {
      if (entity.getValue(UnitTag, 'faction') !== 'attacker') continue;
      if (entity.getValue(ShipMovement, 'state') === 'spawning') return false;
      if (
        entity.getValue(ShipMovement, 'state') === 'moving' &&
        !entity.getValue(ShipMovement, 'blocked')
      ) {
        return false;
      }
    }
    return true;
  }

  private currentWaveUnits(): string[] {
    const level = activeLevelList[this.levelIndex()];
    return level.waves[this.waveIndex()]?.units ?? [];
  }

  private levelIndex(): number {
    return this.readNumber('levelIndex');
  }

  private waveIndex(): number {
    return this.readNumber('waveIndex');
  }

  private pendingUnits(): number {
    return this.readNumber('pendingUnits');
  }

  private readNumber(
    field: 'levelIndex' | 'waveIndex' | 'pendingUnits' | 'timer',
  ): number {
    return Number(this.director.getValue(LevelDirector, field));
  }

  private setPhase(phase: DirectorPhase): void {
    this.director.setValue(LevelDirector, 'phase', phase);
  }

  /** Returns true on the frame the countdown reaches zero. */
  private countDown(delta: number): boolean {
    const timer = this.readNumber('timer') - delta;
    if (timer <= 0) return true;
    this.director.setValue(LevelDirector, 'timer', timer);
    return false;
  }
}
