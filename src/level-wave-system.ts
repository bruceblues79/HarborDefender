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
  BuildOpen,
  BossSummon,
  Destroyed,
  GameOver,
  GamePaused,
  GameStarted,
  Health,
  HitCore,
  LevelDirector,
  PirateCannon,
  PropellerSpin,
  ShipMovement,
  SpawnFade,
  UnitTag,
  WakeSource,
  Wallet,
  WingFlap,
} from './components.js';
import {
  activeLevelList,
  COMBAT,
  ECONOMY,
  OCEAN,
  OCEAN_FAR_Z,
  PACING,
  SPAWN_FADE_DURATION,
  SPAWN_ROLL_TRIES,
  STOP_MIN_GAP_X,
  STOP_MIN_GAP_Z,
  STOP_ROLL_TRIES,
  UNIT_TYPES,
  WAKE_RADIUS,
  WAKE_STRENGTH_MOVING,
} from './level-config.js';
import type { UnitTypeDef } from './level-config.js';

/** Local z of the muzzle helper under a gun_rotate pivot (barrel -Z tip). */
const MUZZLE_LOCAL_Z = -0.2;

/**
 * Hang combat helpers on a unit prototype once (runs for every UNIT_TYPES
 * entry):
 *
 * - a `muzzle` — under the embedded gun_rotate pivot for gunned units
 *   (identical placement to the city cannon, local z = -0.2 at the barrel
 *   tip). Pivotless units adopt the GLB-borne `muzzle` when the model ships
 *   one (the bombardier: baked at its bomb's centroid); only a model without
 *   one falls back to the bounding box's bottom centre.
 * - a `cannon_mount` yaw wrapper that owns the WHOLE deck gun. The GLB's
 *   gun_rotate pivot sits on the fixed pedestal's central axis, and the
 *   wrapper copies that position before attach(), so yawing the mount spins
 *   turntable + barrel around the pedestal's own axis — the hull stays put
 *   and the gun never sweeps around the ship centre — gunned units only;
 * - a `hit_core` at the model's bounding-box centre — every unit.
 */
function decorateShipPrototype(prototype: Object3D): void {
  const gunPivot = prototype.getObjectByName('gun_rotate');
  if (gunPivot && !gunPivot.getObjectByName('muzzle')) {
    const muzzle = new Object3D();
    muzzle.name = 'muzzle';
    muzzle.position.set(0, 0, MUZZLE_LOCAL_Z);
    gunPivot.add(muzzle);
  } else if (!gunPivot && !prototype.getObjectByName('muzzle')) {
    const box = new Box3().setFromObject(prototype);
    const muzzle = new Object3D();
    muzzle.name = 'muzzle';
    muzzle.position.set(
      (box.min.x + box.max.x) / 2,
      box.min.y,
      (box.min.z + box.max.z) / 2,
    );
    prototype.add(muzzle);
  }
  if (gunPivot && !prototype.getObjectByName('cannon_mount')) {
    const mount = new Object3D();
    mount.name = 'cannon_mount';
    // Yaw pivot ON the pedestal axis: the gun spins around its own base,
    // not around the hull origin. attach() preserves world transforms, so
    // the gun looks identical until the mount actually yaws.
    mount.position.copy(gunPivot.position);
    prototype.add(mount);
    mount.attach(gunPivot);
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
  | 'game-cleared'
  | 'defeated';

/**
 * Director for the level -> wave -> unit flow.
 *
 * A single entity carries the LevelDirector state and this system is its only
 * writer. It paces dispatch (`PACING.spawnInterval` between units), pauses
 * while `PACING.maxConcurrentUnits` attackers are on the water, waits for a
 * wave to clear — every dispatched attacker sunk — before the next, and
 * advances levels until the list runs out ('game-cleared' victory). It also
 * owns the defeat check: the whole battery tagged Destroyed flips the phase
 * to 'defeated'. Both outcomes add the GameOver tag on the director.
 *
 * Attacker units are clones of UNIT_TYPES prototypes (loaded once in init) and
 * are handed to ShipMovementSystem through the ShipMovement component.
 */
export class LevelWaveSystem extends createSystem({
  directors: { required: [LevelDirector] },
  attackers: { required: [UnitTag, ShipMovement] },
  cores: { required: [HitCore] },
}) {
  /** Unit prototypes keyed by unitType; clones share geometry and materials. */
  private readonly prototypes = new Map<string, Object3D>();
  /** Snapshot buffer for bulk disposal; allocated once, reused per call. */
  private readonly retiring: Entity[] = [];
  private director!: Entity;

  init(): void {
    const director = this.world.createEntity();
    director.addComponent(LevelDirector, { phase: 'waiting-start' });
    // Player wallet rides the director; RepairSystem drains it per frame,
    // BuildPanelSystem deducts builds, this system resets it per run.
    director.addComponent(Wallet);
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
    // Explicit "game running" tag: MenuSystem shows the call button on its
    // qualify and hides everything on its dismiss.
    this.director.addComponent(GameStarted);
    this.director.removeComponent(GameOver);
    this.director.setValue(Wallet, 'money', this.startMoney());
    this.enterLevel(0);
  }

  /**
   * MAIN-menu hand-off: clear the field, park the director back at the START
   * gate. The GameStarted tag drops here, which dismisses the pause-menu UI.
   */
  resetToWelcome(): void {
    this.disposeAttackers();
    this.director.removeComponent(GameStarted);
    this.director.removeComponent(GameOver);
    this.director.removeComponent(BuildOpen);
    this.director.setValue(LevelDirector, 'levelIndex', 0);
    this.director.setValue(LevelDirector, 'waveIndex', 0);
    this.director.setValue(LevelDirector, 'pendingUnits', 0);
    this.director.setValue(LevelDirector, 'timer', 0);
    this.setPhase('waiting-start');
  }

  /**
   * RESTART command: clear the field and rerun the current level from its
   * first wave. Caller removes GamePaused first (MenuSystem owns that tag).
   * Dropping GameOver re-shows the pause-menu call button and dismisses the
   * result panel.
   */
  restartLevel(): void {
    this.disposeAttackers();
    this.director.removeComponent(GameOver);
    this.director.removeComponent(BuildOpen);
    this.director.setValue(Wallet, 'money', this.startMoney());
    const index = Math.min(
      Math.max(0, this.levelIndex()),
      activeLevelList.length - 1,
    );
    this.enterLevel(index);
  }

  /** The current level's starting purse (per-level override, else the stock). */
  private startMoney(): number {
    const level = activeLevelList[this.levelIndex()];
    return level?.startMoney ?? ECONOMY.startMoney;
  }

  /** Dispose every unit on the water. Resources stay shared with the
   * prototypes (per-ship material clones are plain JS objects — GC reclaims
   * them), so the dispose must NOT walk the tree freeing geometry/materials/
   * textures: those instances belong to the session-persistent prototypes
   * every later spawn clones from. IWSDK's default disposeResources:true
   * destroys exactly those shared GPU resources and poisons future spawns. */
  private disposeAttackers(): void {
    this.retiring.length = 0;
    for (const entity of this.queries.attackers.entities) {
      this.retiring.push(entity);
    }
    for (const entity of this.retiring) {
      entity.dispose({ disposeResources: false });
    }
  }

  update(delta: number): void {
    if (this.paused()) return;
    const phase = this.director.getValue(
      LevelDirector,
      'phase',
    ) as DirectorPhase;
    if (this.checkOutcome(phase)) return;
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

  private rollZ(stopZMin: number, stopZMax: number): number {
    return stopZMin + Math.random() * (stopZMax - stopZMin);
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
   * The z bounds come from the unit's own berth band (ships roll the ocean's
   * wall-side half; the bombardier rolls the sky-ballista coverage band).
   * This runs once per dispatch (about every two seconds), never per frame.
   */
  private pickTarget(def: UnitTypeDef): { x: number; z: number } {
    let best = {
      x: this.rollX(),
      z: this.rollZ(def.stopZMin, def.stopZMax),
    };
    let bestRoom = this.roominess(best.x, best.z);
    for (
      let attempt = 1;
      attempt < STOP_ROLL_TRIES && bestRoom < 1;
      attempt += 1
    ) {
      const x = this.rollX();
      const z = this.rollZ(def.stopZMin, def.stopZMax);
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
    return this.spawnUnitByType(unitType) !== null;
  }

  /**
   * Spawn one unit of the given type — the single spawn truth, shared by the
   * wave dispatch (above) and the boss summon (BossSummonSystem hands out
   * ornithopters outside the wave flow). Returns the new entity, or null
   * while the prototype is still loading (the caller retries next frame).
   * `spawnX` pins the emergence lane: the summon calls pass a small spread so
   * a same-frame brood fans out instead of materialising stacked on the
   * centre line.
   */
  spawnUnitByType(unitType: string, spawnX?: number): Entity | null {
    const def = UNIT_TYPES[unitType];
    if (!def) {
      console.error(`LevelWaveSystem: unknown unit type "${unitType}"`);
      return null;
    }
    const prototype = this.prototypes.get(unitType);
    if (!prototype) return null;

    const object = prototype.clone(true);

    // Spawn point: best-candidate x on the far edge (spread away from active
    // attackers). A single-unit wave just comes down the centre line — no
    // need to randomise when there is nothing to avoid. The stop target is
    // the unit sheet's fixed point when it carries one (the boss's straight
    // centre-line run), else the berth cascade — resolved before anything is
    // committed.
    const laneX =
      spawnX ??
      (this.currentWaveUnits().length === 1 ? 0 : this.pickSpawnX());
    const target = def.fixedTarget ?? this.pickTarget(def);
    // Altitude is the unit sheet's cruiseY — ships float at the waterline,
    // the bombardier holds FLYER_Y. Everything downstream reads the same
    // value off ShipMovement, so no system ever hard-codes an altitude.
    object.position.set(laneX, def.cruiseY, SPAWN_Z);
    // Bow is the hull's local -Z; yaw it onto the spawn -> target direction.
    object.rotation.y = Math.atan2(
      -(target.x - laneX),
      -(target.z - SPAWN_Z),
    );
    // Unit-sheet model scale: the clone shrinks uniformly, so every child
    // (embedded muzzle, hit_core) rides along in the right place.
    object.scale.setScalar(def.scale);

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
    // cruiseY rides along so ShipMovementSystem holds this unit's own
    // altitude instead of a shared waterline constant.
    entity.addComponent(ShipMovement, {
      pattern: def.movement,
      spawnX: laneX,
      targetX: target.x,
      targetZ: target.z,
      cruiseY: def.cruiseY,
      // Per-hull wake radius: oversized hulls (the boss) churn ship-scaled
      // ripples; everyone else rides the shared WAKE_RADIUS default.
      wakeRadius: def.wakeRadius ?? WAKE_RADIUS,
    });
    entity.addComponent(SpawnFade, { duration: SPAWN_FADE_DURATION });
    // Water contact is a unit-sheet fact: ships churn a wake, the airborne
    // bombardier never touches the surface and gets none.
    if (def.wake) {
      const wakeRadius = def.wakeRadius ?? WAKE_RADIUS;
      entity.addComponent(WakeSource, {
        strength: 0,
        // Under way (or held up) from frame one, so the wake aims at the
        // sailing values; ShipMovementSystem retargets it the moment the ship
        // stops or starts waiting.
        targetStrength: WAKE_STRENGTH_MOVING,
        radius: wakeRadius,
        targetRadius: wakeRadius,
      });
    }
    // The rotor is also a unit-sheet fact: PropellerSpinSystem turns the
    // model's `propellers` children for as long as the unit lives. Driven
    // wings are the same deal: WingFlapSystem swings `wing_left`/`wing_right`
    // around their shoulder axle.
    if (def.rotor) {
      entity.addComponent(PropellerSpin);
    }
    if (def.flap) {
      entity.addComponent(WingFlap);
    }
    // Boss hulls skip the generic hull core: their armour lives in per-turret
    // child entities (assembled by BossRigSystem), and the main Health +
    // HitCore only land once every turret is destroyed — which is also what
    // reveals the hull's health bar. BossSummon goes on LAST so its
    // synchronous qualify sees the fully materialised clone.
    if (def.boss) {
      entity.addComponent(BossSummon);
      return entity;
    }
    // Hull hit points: the ship sinks once ShellHitSystem has charged
    // COMBAT.shellDamage per defender-shell hit into this pool. Normalised:
    // every unit shares COMBAT.unitHealth (100) as its pool size.
    entity.addComponent(Health, {
      current: COMBAT.unitHealth,
      max: COMBAT.unitHealth,
    });
    // Combat: attacker hit core (defender shells are consumed inside it) and
    // — for armed units — the deck-gun ability with the unit sheet's own
    // fire interval (pirate ships 3 s, the bombardier 2 s, the ornithopter
    // 1.2 s between shots) and its own fire line, the far edge of its berth
    // band. `stone` reroutes the shots to the pooled-stone free query.
    entity.addComponent(HitCore, {
      radius: COMBAT.attackerCoreRadius,
      faction: def.faction,
      unitType,
    });
    if (def.armed) {
      entity.addComponent(PirateCannon, {
        interval: def.fireInterval,
        fireLineZ: def.stopZMin,
        stone: def.stone,
      });
    }
    return entity;
  }

  /** Begin the given level, or declare the run complete past the last one. */
  private enterLevel(index: number): void {
    if (index >= activeLevelList.length) {
      this.declareCleared();
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
    this.declareCleared();
  }

  /**
   * Victory: the last wave of the last level has cleared. Besides the phase
   * string, the GameOver tag goes on the director — it is what flips every
   * fire/aim system silent and what the result panel qualifies on. Restart
   * and MAIN both remove it (restartLevel / resetToWelcome).
   *
   * Order matters: elics fires query subscribers synchronously inside
   * addComponent, and the result panel reads the phase in its qualify
   * callback — so the outcome phase must be committed BEFORE the tag lands.
   */
  private declareCleared(): void {
    this.setPhase('game-cleared');
    this.director.addComponent(GameOver);
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
   * Wave-clear test: no dispatched attacker is left on the water. Dead ships
   * are disposed by ShellHitSystem, so the query holding only living hulls
   * makes "all sunk" an empty list — the wave cannot clear while any ship
   * still floats, which is exactly the pressure the defence is built on.
   */
  private fieldSettled(): boolean {
    return this.attackerCount() === 0;
  }

  /**
   * Defeat check: the whole battery is tagged Destroyed. Runs once per frame
   * while the game runs (never in waiting-start, never after an outcome is
   * already recorded). Ships keep shelling until the last gun falls, so the
   * test is only ever satisfied by combat, not by a pre-battle state.
   *
   * The phase is committed BEFORE the GameOver tag: elics fires query
   * subscribers synchronously inside addComponent, and the result panel
   * reads the phase in its qualify callback to pick the outcome copy.
   */
  private checkOutcome(phase: DirectorPhase): boolean {
    if (phase === 'waiting-start' || this.director.hasComponent(GameOver)) {
      return false;
    }
    let cannons = 0;
    let destroyed = 0;
    for (const core of this.queries.cores.entities) {
      if (core.getValue(HitCore, 'faction') !== 'defender') continue;
      cannons += 1;
      if (core.hasComponent(Destroyed)) destroyed += 1;
    }
    if (cannons === 0 || destroyed < cannons) return false;
    this.setPhase('defeated');
    this.director.addComponent(GameOver);
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

  /** True while the pause-menu tag sits on the director entity. */
  private paused(): boolean {
    return this.director.hasComponent(GamePaused);
  }

  /** Returns true on the frame the countdown reaches zero. */
  private countDown(delta: number): boolean {
    const timer = this.readNumber('timer') - delta;
    if (timer <= 0) return true;
    this.director.setValue(LevelDirector, 'timer', timer);
    return false;
  }
}
