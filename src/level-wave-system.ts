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
  BuildOpen,
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
  Kamikaze,
  LaserCycle,
  LevelDirector,
  LockTarget,
  NextWaveCommand,
  PirateCannon,
  PropellerSpin,
  ShipMovement,
  SpawnFade,
  SummonCommand,
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
  endlessList,
  ECONOMY,
  KAMIKAZE,
  OCEAN,
  OCEAN_FAR_Z,
  BOSS,
  PACING,
  resetEndlessWaves,
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
 * - a `hit_core` at the model's bounding-box centre — every non-boss unit.
 *   Boss hulls bake their own rig (root hit_core plus per-part
 *   gun_rotate/muzzle/hit_core nodes), so they skip this decorator entirely:
 *   wrapping a boss `gun_rotate` in `cannon_mount` would entangle the hull's
 *   own articulation with a deck-gun wrapper.
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

/**
 * Spawn-time material state for a freshly cloned unit tree: per-clone
 * material clones starting fully transparent, depth writes kept on through
 * the fade, IBL re-linked from the prototype materials (clone() drops the
 * reference), shadows off until SpawnFadeSystem solidifies the hull.
 * Shared by the hull clone and the boss turret part clones so every piece
 * of one unit fades in as one body.
 */
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
      // Keep depth writes on during the fade so DoubleSide meshes (hull,
      // sail) don't render front + back faces blended together — that
      // stacking darkened the colour while translucent and made it snap
      // lighter the moment the material flipped back to opaque.
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
    // Player wallet rides the director; RepairSystem drains it per frame,
    // BuildPanelSystem deducts builds, this system resets it per run.
    director.addComponent(Wallet);
    this.director = director;

    for (const [type, def] of Object.entries(UNIT_TYPES)) {
      AssetManager.loadGLTFById(def.assetId)
        .then((gltf) => {
          // Boss hulls already ship every functional node; generic decoration
          // would add a cannon_mount around the first gun_rotate and break
          // the hull's own articulation.
          if (!def.boss) decorateShipPrototype(gltf.scene);
          this.prototypes.set(type, gltf.scene);
        })
        .catch((err: unknown) =>
          console.error(`LevelWaveSystem: failed to load unit "${type}"`, err),
        );
    }
  }

  /**
   * Hand control to the endless level. Called after the START panel dismisses:
   * the run always opens the DDT-driven endless list (three cannons, 200 g,
   * generated waves). The design sandbox list stays parked — switching to it
   * is a deliberate request-level change, not a player-facing mode.
   */
  beginLevel(): void {
    setActiveLevelList(endlessList);
    // Explicit "game running" tag: MenuSystem shows the call button on its
    // qualify and hides everything on its dismiss.
    this.director.addComponent(GameStarted);
    this.director.removeComponent(GameOver);
    // Stale boss-phase and endless-phase state must never leak into a run.
    this.director.removeComponent(ChiefDown);
    this.director.removeComponent(SummonCommand);
    this.director.removeComponent(NextWaveCommand);
    this.director.removeComponent(WaveIntermission);
    resetEndlessWaves();
    this.director.addComponent(EndlessMode);
    this.director.setValue(Wallet, 'money', this.startMoney());
    syncBatteryToLevel(this.world);
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
    this.director.removeComponent(ChiefDown);
    this.director.removeComponent(SummonCommand);
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
   * RESTART command: clear the field and rerun the current level from its
   * first wave. Caller removes GamePaused first (MenuSystem owns that tag).
   * Dropping GameOver re-shows the pause-menu call button and dismisses the
   * result panel. syncBatteryToLevel re-crews the slots to the level's own
   * initialUnits — mid-run swaps (a ballista where a cannon stood, wing-slot
   * builds) do not survive a restart. In endless mode the generated wave
   * list crops back to the seed wave, so the run restarts from wave 1.
   */
  restartLevel(): void {
    this.disposeAttackers();
    this.director.removeComponent(GameOver);
    this.director.removeComponent(BuildOpen);
    this.director.removeComponent(ChiefDown);
    this.director.removeComponent(SummonCommand);
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

  /** Dispose every unit on the water. Resources stay shared with the
   * prototypes (per-ship material clones are plain JS objects — GC reclaims
   * them), so the dispose must NOT walk the tree freeing geometry/materials/
   * textures: those instances belong to the session-persistent prototypes
   * every later spawn clones from. IWSDK's default disposeResources:true
   * destroys exactly those shared GPU resources and poisons future spawns. */
  private disposeAttackers(): void {
    this.retiring.length = 0;
    // Boss hull CHILD entities die first, then their hull: Entity.dispose()
    // never cascades into child entities, and the children's ECS Transform
    // parent link must not outlive its target. The turret parts (BossTurret)
    // and the phase-two chief head (IslewrathChief) carry no UnitTag/
    // ShipMovement, so the attackers query above cannot see them — those
    // tags are their only teardown handles.
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
    // Thin commands from the boss phase (task 031) run ahead of the wave
    // state machine: a chief kill ends the run immediately, and summon
    // batches ride the same spawn pipeline as wave dispatch.
    if (this.consumeChiefDown()) return;
    this.consumeSummons();
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

  /**
   * Chief-down thin command (task 031): the pirate chief head has been
   * killed — the field clears and the run is won. In endless mode the win
   * never comes: the field clears and the run flows on through the regular
   * advanceAfterWave branch (下一波间歇), forever. Consumed ahead of the
   * wave switch so it also stops a mid-dispatch spawner. GameOver stays
   * single-writer through declareCleared.
   */
  private consumeChiefDown(): boolean {
    if (!this.director.hasComponent(ChiefDown)) return false;
    this.director.removeComponent(ChiefDown);
    this.director.removeComponent(SummonCommand);
    this.disposeAttackers();
    if (this.isEndless()) this.advanceAfterWave();
    else this.declareCleared();
    return true;
  }

  /**
   * Summon-batch thin command (task 031): spawn the requested kamikaze
   * ornithopters through the shared spawn pipeline. The command survives
   * until every unit has left — a prototype still loading (null) does not
   * consume the count, so the batch finishes on the following frames.
   * Commands are ignored once an outcome is recorded (the field is already
   * being torn down).
   */
  private consumeSummons(): void {
    if (!this.director.hasComponent(SummonCommand)) return;
    if (this.director.hasComponent(GameOver)) {
      this.director.removeComponent(SummonCommand);
      return;
    }
    let count = Number(this.director.getValue(SummonCommand, 'count'));
    while (count > 0 && this.spawnUnitByType('ornithopter_kamikaze')) {
      count -= 1;
    }
    if (count <= 0) {
      this.director.removeComponent(SummonCommand);
    } else {
      this.director.setValue(SummonCommand, 'count', count);
    }
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
    const raw = units[units.length - pending];
    // Elite entries (endless DDT) carry the `elite:` prefix and resolve to
    // the named unit with a scale-and-health boost; the damage matrix rows
    // of the stock unit apply unchanged.
    const elite = raw.startsWith(ENDLESS.elitePrefix);
    const unitType = elite ? raw.slice(ENDLESS.elitePrefix.length) : raw;
    return this.spawnUnitByType(unitType, elite) !== null;
  }

  /**
   * Spawn one unit of the given type — the single spawn truth of the wave
   * dispatch. Returns the new entity, or null while the prototype is still
   * loading (the caller retries next frame). `elite` scales the clone up and
   * doubles its health pool; nothing else about the unit changes.
   */
  spawnUnitByType(unitType: string, elite = false): Entity | null {
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
    // need to randomise when there is nothing to avoid — but summoned
    // kamikaze flyers (task 031) always spread: their "wave" is the boss's
    // single-unit sheet, so the centre-line rule would stack every batch at
    // x = 0. The stop target is the unit sheet's fixed point when it carries
    // one (the boss's straight centre-line run), else the berth cascade —
    // resolved before anything is committed.
    const laneX =
      !def.kamikaze && this.currentWaveUnits().length === 1
        ? 0
        : this.pickSpawnX();
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
    // (embedded muzzle, hit_core) rides along in the right place. Elite
    // variants multiply the sheet scale (endless DDT).
    object.scale.setScalar(def.scale * (elite ? ENDLESS.eliteScale : 1));

    // Instancing setup for the fade: hull materials are shared across clones,
    // so each ship gets its own clones starting fully transparent. Driving that
    // opacity, and switching shadows on when the hull is solid, is
    // SpawnFadeSystem's job — the spawner only lands the starting state.
    prepareSpawnMaterials(object);

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
    // Boss hull: navigation runs as usual, while the four baked gun
    // turrets are independent combat parts (their own state machines and
    // targeting slots). The hull itself stays Health-less — nothing can
    // hit it; only the turrets fight.
    if (def.boss) {
      this.attachBossTurrets(entity);
      return entity;
    }
    // Hull hit points: the ship sinks once ShellHitSystem has charged
    // COMBAT.shellDamage per defender-shell hit into this pool. Normalised:
    // every unit shares COMBAT.unitHealth (100) as its pool size — the elite
    // variant doubles the pool (bar shows 200). barY comes off the unit
    // sheet — every Health-carrying def pins its measured top.
    const healthPool = COMBAT.unitHealth * (elite ? ENDLESS.eliteHealthRatio : 1);
    entity.addComponent(Health, {
      current: healthPool,
      max: healthPool,
      barY: def.barY,
    });
    // Combat: attacker hit core (defender shells are consumed inside it) and
    // — for armed units — the deck-gun ability with the unit sheet's own
    // fire interval (pirate ships 3 s, the bombardier 2 s, the ornithopter
    // 1.2 s between shots) and its own fire line, the far edge of its berth
    // band. `stone` reroutes the shots to the pooled-stone free query. The
    // elite's core radius grows with its scale so the bigger hull reads.
    entity.addComponent(HitCore, {
      radius: COMBAT.attackerCoreRadius * (elite ? ENDLESS.eliteScale : 1),
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
    // Kamikaze ability (task 031): the summoned ornithopter variant arms the
    // fuse-and-dive on top of the shared armed-flyer behaviour above. The
    // fuse only ticks once the flyer has stopped, and starts fully wound.
    if (def.kamikaze) {
      entity.addComponent(Kamikaze, { timer: KAMIKAZE.waitSec });
    }
    return entity;
  }

  /**
   * Construction, not behaviour: turn the GLB's baked turret wrappers
   * (`gun_t1`..`gun_t4`) into child entities, each with its own Health pool
   * (HealthBarSystem attaches its own bar), a HitCore on the seat's baked
   * core node (so defender shells can knock it out), and — per gun — its
   * fire state machine (`GunCycle`, per-seat rhythm data) plus its
   * `LockTarget` targeting slot. The laser turret gets the same treatment
   * with its own state machine (`LaserCycle`): the generic systems do the
   * rest; the hull itself never needs to know its turrets exist.
   *
   * Node names in the v3 asset are unique per seat (`gun_rotate_1`,
   * `muzzle_1`, `hit_core_1`, …; `_laser`, `_hull` for the rest): three.js
   * GLTFLoader de-duplicates same-name nodes with numeric suffixes at load
   * time, so same-name helpers in a multi-seat asset are an asset bug —
   * with unique names every exact find resolves and the systems bind
   * through the names frozen on the components.
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
      // Lifecycle only: no UnitTag (parts must not count as wave units),
      // teardown finds them through BossTurret (see disposeAttackers).
      part.addComponent(BossTurret);
      part.addComponent(Health, {
        current: COMBAT.unitHealth,
        max: COMBAT.unitHealth,
        barY: spec.barY,
      });
      if (!spec.gun) {
        // Laser main cannon (task 030): the same free targeting slot as the
        // guns, its own aim/charge/fire state machine, and a hit core so
        // defenders can knock it out (existing `islewrath-turret` matrix
        // rows apply). Opening beat shares the guns' base delay + jitter;
        // the timer freezes until the hull berths (requireStopped).
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
        });
        continue;
      }
      // Staggered opening: each seat rolls its own first-shot delay — base,
      // plus one stagger step per seat index, plus the shared jitter. The
      // timers freeze until the hull berths (requireStopped), so the ripple
      // survives the whole sail-in.
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
      });
    }
    // Chief-head mount seat (task 031): captured HERE at assembly, the only
    // moment the pivot node is guaranteed to exist — the laser turret's
    // death strips its whole subtree (pivot included) from the hull clone,
    // so a phase-two-time worldToLocal read finds nothing and would seat
    // the head at the hull origin, buried inside the island rock. The seat
    // is the pivot's position accumulated over the parent chain EXCLUDING
    // the hull root: root.position is a world coordinate, not hull-local,
    // and the head parents under the hull, so including it would
    // double-count the hull's world position and plant the head out at sea.
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
    // Close the endless intermission: the GET READY panel hides as the wave
    // dispatch starts. (A NextWaveCommand never survives to here — the
    // planner consumes it the frame it is raised — but clear it defensively.)
    this.director.removeComponent(WaveIntermission);
    this.director.removeComponent(NextWaveCommand);
    this.director.setValue(LevelDirector, 'waveIndex', index);
    this.director.setValue(LevelDirector, 'pendingUnits', wave.units.length);
    this.director.setValue(LevelDirector, 'timer', 0);
    this.setPhase('dispatching');
  }

  /** A wave is done: wait, then start the next wave or level. */
  private advanceAfterWave(): void {
    // Endless runs forever: no level list to walk, no victory to declare.
    // The NextWaveCommand goes out first so the planner's synchronous
    // qualify appends the wave BEFORE the intermission panel reads its
    // number; the shortest window then counts down and enterWave consumes it.
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

  /** True while the current run is the endless level (EndlessMode on the director). */
  private isEndless(): boolean {
    return this.director.hasComponent(EndlessMode);
  }

  /** Returns true on the frame the countdown reaches zero. */
  private countDown(delta: number): boolean {
    const timer = this.readNumber('timer') - delta;
    if (timer <= 0) return true;
    this.director.setValue(LevelDirector, 'timer', timer);
    return false;
  }
}
