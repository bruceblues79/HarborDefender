/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  AssetManager,
  Box3,
  createSystem,
  Mesh,
  Object3D,
  Vector3,
} from '@iwsdk/core';
import type { Entity, MeshStandardMaterial } from '@iwsdk/core';
import {
  HitCore,
  LevelDirector,
  PirateCannon,
  ShipMovement,
  SpawnFade,
  UnitTag,
  WakeSource,
} from './components.js';
import {
  activeLevelList,
  COMBAT,
  OCEAN,
  OCEAN_FAR_Z,
  PACING,
  SHIP_STOP_Z_MAX,
  SHIP_STOP_Z_MIN,
  SHIP_Y,
  SPAWN_FADE_DURATION,
  SPAWN_ROLL_TRIES,
  STOP_MIN_GAP_X,
  STOP_MIN_GAP_Z,
  STOP_ROLL_TRIES,
  UNIT_TYPES,
  WAKE_RADIUS,
  WAKE_STRENGTH_MOVING,
} from './level-config.js';

/** Local z of the muzzle helper under a gun_rotate pivot (barrel -Z tip). */
const MUZZLE_LOCAL_Z = -0.2;

/**
 * Hang the pirate ship's combat helpers on its prototype once:
 *
 * - a `muzzle` under the embedded gun_rotate pivot (identical placement to
 *   the city cannon, local z = -0.2 at the barrel tip);
 * - a `cannon_mount` yaw wrapper that owns the WHOLE deck gun. In the GLB,
 *   `ship-carriage` and `gun_rotate` (barrel) are siblings: yawing
 *   gun_rotate alone swings just the barrel and visibly snaps it off the
 *   carriage. Both are reparented under one shared pivot (Object3D.attach
 *   keeps their world transforms), so PirateFireSystem rotates carriage and
 *   barrel together as a rigid gun while the hull stays put;
 * - a `hit_core` at the model's bounding-box centre.
 */
function decorateShipPrototype(prototype: Object3D): void {
  const gunPivot = prototype.getObjectByName('gun_rotate');
  if (gunPivot && !gunPivot.getObjectByName('muzzle')) {
    const muzzle = new Object3D();
    muzzle.name = 'muzzle';
    muzzle.position.set(0, 0, MUZZLE_LOCAL_Z);
    gunPivot.add(muzzle);
  }
  if (!prototype.getObjectByName('cannon_mount')) {
    const carriage = prototype.getObjectByName('ship-carriage');
    if (carriage && gunPivot) {
      const mount = new Object3D();
      mount.name = 'cannon_mount';
      prototype.add(mount);
      // attach() reparents while preserving world position/rotation, so the
      // gun looks identical until the mount actually yaws.
      mount.attach(carriage);
      mount.attach(gunPivot);
    }
  }
  if (!prototype.getObjectByName('hit_core')) {
    const center = new Box3().setFromObject(prototype).getCenter(new Vector3());
    const hitCore = new Object3D();
    hitCore.name = 'hit_core';
    hitCore.position.copy(center);
    prototype.add(hitCore);
  }
}

/** Ships emerge this far inside the ocean's far edge. */
const SPAWN_Z = OCEAN_FAR_Z + 0.1;
/** Keep a lane clear of the ocean edge. */
const SPAWN_MARGIN = 0.3;

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
        .then((gltf) => {
          decorateShipPrototype(gltf.scene);
          this.prototypes.set(type, gltf.scene);
        })
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

  /** World x a ship may emerge at: anywhere across the ocean minus edge margin. */
  private rollX(): number {
    return (Math.random() * 2 - 1) * (OCEAN.width / 2 - SPAWN_MARGIN);
  }

  /**
   * Pick the spawn X furthest from every active attacker's current X.
   *
   * A plain random roll keeps dropping new ships on top of ones that just
   * emerged — same X, parallel course, neither can pass. Rolling several
   * candidates and keeping the one with the largest clearance spreads the
   * fleet across the far edge. This mirrors `pickTarget`'s best-candidate
   * approach but in one dimension (all spawns share the same Z).
   *
   * Runs once per dispatch (~every 2 s), never per frame.
   */
  private pickSpawnX(): number {
    let best = this.rollX();
    let bestClearance = this.spawnClearance(best);
    for (let attempt = 1; attempt < SPAWN_ROLL_TRIES; attempt += 1) {
      const x = this.rollX();
      const clearance = this.spawnClearance(x);
      if (clearance <= bestClearance) continue;
      best = x;
      bestClearance = clearance;
    }
    return best;
  }

  /** Smallest |Δx| from a candidate spawn to any attacker still on the water. */
  private spawnClearance(x: number): number {
    let clearance = Number.POSITIVE_INFINITY;
    for (const entity of this.queries.attackers.entities) {
      const object = entity.object3D;
      if (!object) continue;
      clearance = Math.min(clearance, Math.abs(x - object.position.x));
    }
    return clearance;
  }

  private rollZ(): number {
    return SHIP_STOP_Z_MIN + Math.random() * (SHIP_STOP_Z_MAX - SHIP_STOP_Z_MIN);
  }

  /**
   * Choose where the next attacker drops anchor: roll a handful of candidates
   * and keep the roomiest.
   *
   * A single uniform roll clusters badly, because the stop zone is only 2.4 m
   * by 3.2 m — wide enough for roughly six ships at the spacing below, so
   * unconstrained rolls keep landing on top of each other. Rolling several
   * candidates and keeping the one furthest from every existing claim keeps
   * the fleet spread without any placement table to maintain.
   *
   * A claim is both the destination another ship is still sailing toward and
   * its present position, so an inbound ship reserves its own arrival point —
   * and because claims are read from *live* attackers, a stop is released the
   * moment its ship leaves the water, with no cleanup anywhere.
   *
   * This runs once per dispatch (about every two seconds), never per frame.
   */
  private pickTarget(): { x: number; z: number } {
    let best = { x: this.rollX(), z: this.rollZ() };
    let bestRoom = this.roominess(best.x, best.z);
    for (let attempt = 1; attempt < STOP_ROLL_TRIES && bestRoom < 1; attempt += 1) {
      const x = this.rollX();
      const z = this.rollZ();
      const room = this.roominess(x, z);
      if (room < bestRoom) continue;
      best = { x, z };
      bestRoom = room;
    }
    return best;
  }

  /**
   * Distance from a candidate stop to the nearest existing claim, normalised
   * so 1 means "exactly at the required spacing" and anything below it means
   * the hulls would be closer than intended.
   */
  private roominess(x: number, z: number): number {
    let room = Number.POSITIVE_INFINITY;
    for (const entity of this.queries.attackers.entities) {
      const object = entity.object3D;
      if (object) {
        const px = (x - object.position.x) / STOP_MIN_GAP_X;
        const pz = (z - object.position.z) / STOP_MIN_GAP_Z;
        room = Math.min(room, Math.hypot(px, pz));
      }
      const dx =
        (x - Number(entity.getValue(ShipMovement, 'targetX'))) / STOP_MIN_GAP_X;
      const dz =
        (z - Number(entity.getValue(ShipMovement, 'targetZ'))) / STOP_MIN_GAP_Z;
      room = Math.min(room, Math.hypot(dx, dz));
    }
    return room;
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

    // Spawn point: best-candidate x on the far edge (spread away from active
    // attackers). A single-unit wave just comes down the centre line — no
    // need to randomise when there is nothing to avoid. The stop target comes
    // from the berth cascade, which is why it is resolved before anything is
    // committed.
    const spawnX = units.length === 1 ? 0 : this.pickSpawnX();
    const target = this.pickTarget();
    object.position.set(spawnX, SHIP_Y, SPAWN_Z);
    // Bow is the hull's local -Z; yaw it onto the spawn -> target direction.
    object.rotation.y = Math.atan2(
      -(target.x - spawnX),
      -(target.z - SPAWN_Z),
    );

    // Instancing setup for the fade: hull materials are shared across clones,
    // so each ship gets its own clones starting fully transparent. Driving that
    // opacity, and switching shadows on when the hull is solid, is
    // SpawnFadeSystem's job — the spawner only lands the starting state.
    object.traverse((child) => {
      const mesh = child as Mesh;
      if (!mesh.isMesh) return;
      const original = mesh.material;
      const solid = Array.isArray(original)
        ? original.map((material) => material.clone())
        : original.clone();
      for (let i = 0; i < (Array.isArray(solid) ? solid.length : 1); i++) {
        const material = Array.isArray(solid) ? solid[i] : solid;
        const src = Array.isArray(original) ? original[i] : original;
        material.transparent = true;
        material.opacity = 0;
        // Keep depth writes on during the fade so DoubleSide meshes (hull,
        // sail) don't render front + back faces blended together — that
        // stacking darkened the colour while translucent and made it snap
        // lighter the moment the material flipped back to opaque.
        material.depthWrite = true;
        // IWSDK's EnvironmentSystem may attach the IBL directly onto the
        // prototype's materials (not only scene.environment); clone() drops
        // that reference, so re-link it or the PBR ship spawns without
        // environment reflections and looks unlit until something re-applies.
        const srcStd = src as MeshStandardMaterial;
        const matStd = material as MeshStandardMaterial;
        if (!matStd.envMap && srcStd.envMap) {
          matStd.envMap = srcStd.envMap;
        }
      }
      mesh.material = solid;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
    });

    const entity = this.world.createTransformEntity(object);
    entity.addComponent(UnitTag, { unitType, faction: def.faction });
    // No `state`: ShipMovement defaults to 'moving', so the run starts on the
    // spawn frame while SpawnFadeSystem materialises the hull in parallel.
    entity.addComponent(ShipMovement, {
      pattern: def.movement,
      spawnX,
      targetX: target.x,
      targetZ: target.z,
    });
    entity.addComponent(SpawnFade, { duration: SPAWN_FADE_DURATION });
    entity.addComponent(WakeSource, {
      strength: 0,
      // Under way (or held up) from frame one, so the wake aims at the
      // sailing values; ShipMovementSystem retargets it the moment the ship
      // stops or starts waiting.
      targetStrength: WAKE_STRENGTH_MOVING,
      radius: WAKE_RADIUS,
      targetRadius: WAKE_RADIUS,
    });
    // Combat: attacker hit core (defender shells are consumed inside it)
    // and the ship's cannon ability (fires only once anchored).
    entity.addComponent(HitCore, {
      radius: COMBAT.attackerCoreRadius,
      faction: def.faction,
    });
    entity.addComponent(PirateCannon);
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
   * cleared once every dispatched attacker has stopped at its target or is
   * queued behind another ship. Swap this for a destroyed/killed check once
   * units can be sunk.
   */
  private fieldSettled(): boolean {
    for (const entity of this.queries.attackers.entities) {
      if (entity.getValue(UnitTag, 'faction') !== 'attacker') continue;
      if (entity.getValue(ShipMovement, 'state') !== 'stopped') {
        if (!entity.getValue(ShipMovement, 'blocked')) return false;
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
