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
  BossTurret,
  ChiefDown,
  ChiefMount,
  Destroyed,
  EndlessMode,
  GameOver,
  GamePaused,
  GameStarted,
  GunCycle,
  Health,
  HitCore,
  IslewrathChief,
  LaserCycle,
  LevelDirector,
  LockTarget,
  NextWaveCommand,
  PirateCannon,
  PropellerSpin,
  ShipMovement,
  SpawnFade,
  UnitTag,
  WakeSource,
  Wallet,
  WaveIntermission,
  WingFlap,
} from './components.js';
import {
  activeLevelList,
  COMBAT,
  ENDLESS,
  ECONOMY,
  endlessList,
  OCEAN,
  OCEAN_FAR_Z,
  BOSS,
  PACING,
  resetEndlessWaves,
  RewardTier,
  setActiveLevelList,
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
import { syncBatteryToLevel } from './battle-setup.js';
import { closeBuildDock } from './build-dock.js';

/** Local z of the muzzle helper under a gun_rotate pivot (barrel -Z tip). */
const MUZZLE_LOCAL_Z = -0.2;

/**
 * Hangs the `muzzle` / `cannon_mount` / `hit_core` helpers on a prototype once;
 * those node names are the cross-system contract. Boss hulls bake their own rig.
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
    // Yaw pivot on the pedestal axis; attach() preserves the gun's world transform.
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

/** Spawn-time material state for a fresh clone: transparent, depth writes on,
 * IBL re-linked (clone() drops it), shadows off until SpawnFadeSystem solidifies. */
function prepareSpawnMaterials(object: Object3D): void {
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
      // Depth writes stay on so DoubleSide hull/sail faces don't stack while
      // translucent and then snap lighter when the material turns opaque.
      material.depthWrite = true;
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
 * Director for the level -> wave -> unit flow: paces dispatch, waits for a
 * wave to clear, then advances. Both outcomes tag GameOver on the director.
 * Attacker units are UNIT_TYPES clones driven by ShipMovementSystem.
 */
export class LevelWaveSystem extends createSystem({
  directors: { required: [LevelDirector] },
  attackers: { required: [UnitTag, ShipMovement] },
  bossTurrets: { required: [BossTurret] },
  chiefs: { required: [IslewrathChief] },
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
    // Player wallet rides the director: RepairSystem and BuildPanelSystem
    // both spend it; this system resets it per run.
    director.addComponent(Wallet);
    this.director = director;

    for (const [type, def] of Object.entries(UNIT_TYPES)) {
      AssetManager.loadGLTFById(def.assetId)
        .then((gltf) => {
          // Boss hulls ship their own rig; decoration would break its articulation.
          if (!def.boss) decorateShipPrototype(gltf.scene);
          this.prototypes.set(type, gltf.scene);
        })
        .catch((err: unknown) =>
          console.error(`LevelWaveSystem: failed to load unit "${type}"`, err),
        );
    }
  }

  /**
   * Hand control to the endless level: every run opens the endless list; the
   * design sandbox list is not player-facing.
   */
  beginLevel(): void {
    setActiveLevelList(endlessList);
    // "Game running" tag: MenuSystem shows the call button on qualify.
    this.director.addComponent(GameStarted);
    this.director.removeComponent(GameOver);
    // Stale boss-phase and endless-phase state must never leak into a run.
    this.director.removeComponent(ChiefDown);
    this.director.removeComponent(NextWaveCommand);
    this.director.removeComponent(WaveIntermission);
    resetEndlessWaves();
    this.director.addComponent(EndlessMode);
    this.director.setValue(Wallet, 'money', this.startMoney());
    syncBatteryToLevel(this.world);
    this.enterLevel(0);
  }

  /** MAIN-menu hand-off: clear the field and park the director at START. */
  resetToWelcome(): void {
    this.disposeAttackers();
    this.director.removeComponent(GameStarted);
    this.director.removeComponent(GameOver);
    closeBuildDock(this.director);
    this.director.removeComponent(ChiefDown);
    this.director.removeComponent(EndlessMode);
    this.director.removeComponent(NextWaveCommand);
    this.director.removeComponent(WaveIntermission);
    resetEndlessWaves();
    this.director.setValue(LevelDirector, 'levelIndex', 0);
    this.director.setValue(LevelDirector, 'waveIndex', 0);
    this.director.setValue(LevelDirector, 'pendingUnits', 0);
    this.director.setValue(LevelDirector, 'timer', 0);
    this.setPhase('waiting-start');
  }

  /**
   * RESTART: clear the field and rerun the current level from wave 1. Caller
   * removes GamePaused first (MenuSystem owns that tag); the battery is re-crewed.
   */
  restartLevel(): void {
    this.disposeAttackers();
    this.director.removeComponent(GameOver);
    closeBuildDock(this.director);
    this.director.removeComponent(ChiefDown);
    this.director.removeComponent(NextWaveCommand);
    this.director.removeComponent(WaveIntermission);
    resetEndlessWaves();
    this.director.setValue(Wallet, 'money', this.startMoney());
    syncBatteryToLevel(this.world);
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

  /** Dispose every unit on the water. Resources are shared with the
   * prototypes, so disposeResources must stay false or future spawns are poisoned. */
  private disposeAttackers(): void {
    this.retiring.length = 0;
    // Children die first: Entity.dispose() never cascades and a Transform parent
    // link must not outlive its target; turret parts carry no UnitTag of their own.
    for (const entity of this.queries.chiefs.entities) {
      this.retiring.push(entity);
    }
    for (const entity of this.queries.bossTurrets.entities) {
      this.retiring.push(entity);
    }
    for (const entity of this.queries.attackers.entities) {
      this.retiring.push(entity);
    }
    for (const entity of this.retiring) {
      entity.dispose({ disposeResources: false });
    }
  }

  update(delta: number): void {
    if (this.paused()) return;
    // Thin boss-phase command, run ahead of the wave state machine.
    if (this.consumeChiefDown()) return;
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

  private updateDispatching(delta: number): void {
    let timer = this.readNumber('timer') - delta;
    let pending = this.pendingUnits();
    const units = this.currentWaveUnits();

    while (timer <= 0 && pending > 0) {
      // Per-layer cap: a full layer holds the wave in order, so later units
      // never jump ahead of a waiting one.
      if (
        this.layerCount(units[units.length - pending]) >=
        PACING.maxConcurrentUnits
      ) {
        break;
      }
      // A unit whose prototype is still loading holds the wave; retry next frame.
      if (!this.spawnUnit(pending)) break;
      pending -= 1;
      timer += PACING.spawnInterval;
    }
    // Don't bank negative time while capped, or a freed slot bursts ships on one frame.
    if (timer < 0) timer = 0;

    this.director.setValue(LevelDirector, 'timer', timer);
    this.director.setValue(LevelDirector, 'pendingUnits', pending);
    if (pending <= 0) this.setPhase('clearing');
  }

  /** Chief killed (thin command): clear the field; endless flows on via
   * advanceAfterWave, otherwise the run is won. */
  private consumeChiefDown(): boolean {
    if (!this.director.hasComponent(ChiefDown)) return false;
    this.director.removeComponent(ChiefDown);
    this.disposeAttackers();
    if (this.isEndless()) this.advanceAfterWave();
    else this.declareCleared();
    return true;
  }

  private rollX(): number {
    return (Math.random() * 2 - 1) * (OCEAN.width / 2 - SPAWN_MARGIN);
  }

  /**
   * Pick the spawn X furthest from every active attacker: a plain roll keeps
   * stacking ships at the same X, parallel course.
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
   * Pick the next attacker's stop by rolling candidates and keeping the
   * roomiest: claims are read from live attackers, so a stop frees itself.
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

  /** Distance to the nearest claim, normalised so 1 = the required spacing. */
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

  private spawnUnit(pending: number): boolean {
    const units = this.currentWaveUnits();
    const raw = units[units.length - pending];
    return this.spawnUnitByType(raw) !== null;
  }

  /** Spawn one unit of the given type; null while its prototype is still loading. */
  spawnUnitByType(unitType: string): Entity | null {
    const def = UNIT_TYPES[unitType];
    if (!def) {
      console.error(`LevelWaveSystem: unknown unit type "${unitType}"`);
      return null;
    }
    const prototype = this.prototypes.get(unitType);
    if (!prototype) return null;

    const object = prototype.clone(true);

    // Spawn X avoids active attackers (a single-unit wave keeps the centre
    // line); the stop target is the unit sheet's fixed point or a berth roll.
    const laneX =
      this.currentWaveUnits().length === 1 ? 0 : this.pickSpawnX();
    const target = def.fixedTarget ?? this.pickTarget(def);
    // Altitude comes from the unit sheet's cruiseY; ShipMovement carries it downstream.
    object.position.set(laneX, def.cruiseY, SPAWN_Z);
    // Bow is the hull's local -Z; yaw it onto the spawn -> target direction.
    object.rotation.y = Math.atan2(
      -(target.x - laneX),
      -(target.z - SPAWN_Z),
    );
    // Uniform unit-sheet scale; anchored children (muzzle, hit_core) ride along.
    object.scale.setScalar(def.scale);

    // Hull materials are shared across clones, so each ship gets its own
    // transparent copies; SpawnFadeSystem drives the fade and shadows.
    prepareSpawnMaterials(object);

    const entity = this.world.createTransformEntity(object);
    entity.addComponent(UnitTag, { unitType, faction: def.faction });
    // No `state`: ShipMovement defaults to 'moving', so the run starts on the
    // spawn frame while the hull fades in; cruiseY holds this unit's altitude.
    entity.addComponent(ShipMovement, {
      pattern: def.movement,
      spawnX: laneX,
      targetX: target.x,
      targetZ: target.z,
      cruiseY: def.cruiseY,
      // Per-hull wake radius: oversized hulls churn ship-scaled ripples.
      wakeRadius: def.wakeRadius ?? WAKE_RADIUS,
    });
    entity.addComponent(SpawnFade, { duration: SPAWN_FADE_DURATION });
    // Wake is a unit-sheet fact: the airborne bombardier never touches the water.
    if (def.wake) {
      const wakeRadius = def.wakeRadius ?? WAKE_RADIUS;
      entity.addComponent(WakeSource, {
        strength: 0,
        // Aim at the sailing values from frame one; ShipMovementSystem
        // retargets the wake when the ship stops or waits.
        targetStrength: WAKE_STRENGTH_MOVING,
        radius: wakeRadius,
        targetRadius: wakeRadius,
      });
    }
    // Rotor / flap are unit-sheet facts: PropellerSpinSystem turns the model's
    // `propellers` children, WingFlapSystem swings `wing_left`/`wing_right`.
    if (def.rotor) {
      entity.addComponent(PropellerSpin);
    }
    if (def.flap) {
      entity.addComponent(WingFlap);
    }
    // Boss hull: navigation as usual; the baked turrets are independent combat
    // parts, and the hull itself stays Health-less — only the turrets fight.
    if (def.boss) {
      this.attachBossTurrets(entity);
      return entity;
    }
    // Hull hit points: every unit shares the normalised COMBAT.unitHealth pool;
    // ShellHitSystem charges COMBAT.shellDamage per hit. barY comes from the unit sheet.
    const healthPool = COMBAT.unitHealth;
    entity.addComponent(Health, {
      current: healthPool,
      max: healthPool,
      barY: def.barY,
    });
    // Attacker hit core (consumes defender shells); `stone` reroutes shots to
    // the pooled-stone free query.
    entity.addComponent(HitCore, {
      radius: COMBAT.attackerCoreRadius,
      faction: def.faction,
      unitType,
      reward: RewardTier.Stock,
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

  /**
   * Turns the baked turret wrappers into child entities with their own Health,
   * HitCore, fire cycle and lock slot. Node names must stay unique at load.
   */
  private attachBossTurrets(boss: Entity): void {
    const root = boss.object3D;
    if (!root) return;
    const parts: Array<{
      wrapper: string;
      core: string;
      barY: number;
      gun: boolean;
    }> = [
      { wrapper: 'gun_t1', core: 'hit_core_1', barY: BOSS.turretBarY, gun: true },
      { wrapper: 'gun_t2', core: 'hit_core_2', barY: BOSS.turretBarY, gun: true },
      { wrapper: 'gun_t3', core: 'hit_core_3', barY: BOSS.turretBarY, gun: true },
      { wrapper: 'gun_t4', core: 'hit_core_4', barY: BOSS.turretBarY, gun: true },
      {
        wrapper: 'laser_turret',
        core: 'hit_core_laser',
        barY: BOSS.laserBarY,
        gun: false,
      },
    ];
    for (const spec of parts) {
      const wrapper = root.getObjectByName(spec.wrapper);
      if (!wrapper) continue;
      const part = this.world.createTransformEntity(wrapper, boss);
      // Lifecycle only: no UnitTag (parts don't count as wave units).
      part.addComponent(BossTurret);
      part.addComponent(Health, {
        current: COMBAT.unitHealth,
        max: COMBAT.unitHealth,
        barY: spec.barY,
      });
      if (!spec.gun) {
        // Laser: same targeting slot as the guns, its own aim/charge/fire
        // cycle, and a hit core; the timer freezes until the hull berths.
        part.addComponent(LockTarget);
        part.addComponent(LaserCycle, {
          state: 'cooldown',
          timer:
            BOSS.openFireDelay +
            COMBAT.fireJitterMin +
            Math.random() * (COMBAT.fireJitterMax - COMBAT.fireJitterMin),
          chargeSec: BOSS.laserChargeSec,
          fireSec: BOSS.laserFireSec,
          cooldownSec: BOSS.laserCooldownSec,
          turnSpeedDeg: BOSS.laserTurnSpeedDeg,
          turnThresholdDeg: BOSS.laserTurnThresholdDeg,
          aimHoldSec: BOSS.laserAimHoldSec,
          carrierIndex: boss.index,
          requireStopped: true,
          pivotName: 'gun_rotate_laser',
          muzzleName: 'muzzle_laser',
        });
        part.addComponent(HitCore, {
          radius: BOSS.turretCoreRadius,
          faction: 'attacker',
          unitType: 'islewrath-turret',
          nodeName: spec.core,
          reward: RewardTier.BossTurret,
        });
        continue;
      }
      // Staggered opening: base + one step per seat + shared jitter; timers
      // freeze until the hull berths, so the ripple survives the sail-in.
      const match = /gun_t(\d+)/.exec(spec.wrapper);
      const seat = match ? Number(match[1]) : 0;
      part.addComponent(GunCycle, {
        state: 'cooldown',
        timer:
          BOSS.openFireDelay +
          (seat - 1) * BOSS.openFireStagger +
          COMBAT.fireJitterMin +
          Math.random() * (COMBAT.fireJitterMax - COMBAT.fireJitterMin),
        fireInterval: BOSS.fireInterval,
        turnSpeedDeg: BOSS.turnSpeedDeg,
        turnThresholdDeg: BOSS.turnThresholdDeg,
        aimHoldSec: BOSS.aimHoldSec,
        shellSpeed: BOSS.shellSpeed,
        shellUnitType: 'islewrath-turret',
        carrierIndex: boss.index,
        requireStopped: true,
        pivotName: `gun_rotate_${seat}`,
        muzzleName: `muzzle_${seat}`,
      });
      part.addComponent(LockTarget);
      part.addComponent(HitCore, {
        radius: BOSS.turretCoreRadius,
        faction: 'attacker',
        unitType: 'islewrath-turret',
        nodeName: spec.core,
        reward: RewardTier.BossTurret,
      });
    }
    // Chief-head seat, captured at assembly: the laser turret's death strips its
    // subtree, and root.position is world-based, so it must stay out of the sum.
    const laserPivot = root.getObjectByName('gun_rotate_laser');
    if (laserPivot) {
      let mx = 0;
      let my = 0;
      let mz = 0;
      let node: Object3D | null = laserPivot;
      while (node && node !== root) {
        mx += node.position.x;
        my += node.position.y;
        mz += node.position.z;
        node = node.parent;
      }
      boss.addComponent(ChiefMount, { x: mx, y: my, z: mz });
    } else {
      console.error('LevelWaveSystem: boss hull has no "gun_rotate_laser"');
    }
  }

  private enterLevel(index: number): void {
    if (index >= activeLevelList.length) {
      this.declareCleared();
      return;
    }
    this.director.setValue(LevelDirector, 'levelIndex', index);
    this.enterWave(0);
  }

  private enterWave(index: number): void {
    const level = activeLevelList[this.levelIndex()];
    const wave = level.waves[index];
    if (!wave) {
      this.advanceAfterWave();
      return;
    }
    // Close the endless intermission as dispatch starts (NextWaveCommand is
    // cleared defensively: the planner normally consumes it immediately).
    this.director.removeComponent(WaveIntermission);
    this.director.removeComponent(NextWaveCommand);
    this.director.setValue(LevelDirector, 'waveIndex', index);
    this.director.setValue(LevelDirector, 'pendingUnits', wave.units.length);
    this.director.setValue(LevelDirector, 'timer', 0);
    this.setPhase('dispatching');
  }

  private advanceAfterWave(): void {
    // Endless never declares victory. NextWaveCommand goes out first: the
    // planner's synchronous qualify appends the wave before the panel reads it.
    if (this.isEndless()) {
      this.setPhase('wave-gap');
      this.director.setValue(LevelDirector, 'timer', ENDLESS.intermissionSec);
      this.director.addComponent(NextWaveCommand);
      this.director.addComponent(WaveIntermission);
      return;
    }
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

  /** Victory: commit the phase, then tag GameOver. Order matters: elics runs
   * query subscribers synchronously inside addComponent. */
  private declareCleared(): void {
    this.setPhase('game-cleared');
    this.director.addComponent(GameOver);
  }

  private attackerCount(): number {
    let count = 0;
    for (const entity of this.queries.attackers.entities) {
      if (entity.getValue(UnitTag, 'faction') === 'attacker') count += 1;
    }
    return count;
  }

  private layerCount(unitType: string): number {
    let count = 0;
    for (const entity of this.queries.attackers.entities) {
      if (entity.getValue(UnitTag, 'unitType') === unitType) count += 1;
    }
    return count;
  }

  /** Wave clear: no living attacker hull left on the water. */
  private fieldSettled(): boolean {
    return this.attackerCount() === 0;
  }

  /** Defeat: every defender hit core is Destroyed. Phase is committed before
   * the GameOver tag, which elics broadcasts synchronously. */
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

  private paused(): boolean {
    return this.director.hasComponent(GamePaused);
  }

  private isEndless(): boolean {
    return this.director.hasComponent(EndlessMode);
  }

  private countDown(delta: number): boolean {
    const timer = this.readNumber('timer') - delta;
    if (timer <= 0) return true;
    this.director.setValue(LevelDirector, 'timer', timer);
    return false;
  }
}
