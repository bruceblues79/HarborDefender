/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createComponent, defineComponents } from '@iwsdk/core';
import { COMBAT, ECONOMY, ORNITHOPTER, PROPELLER_SPIN_RAD, SHIP_STOP_Z_MIN, SHIP_Y, WAKE_RADIUS } from './level-config.js';

/** Marks the ocean body entity so OceanSystem can find it via query. */
export const OceanTag = createComponent('OceanTag', {});

/**
 * Marks an entity as a source of concentric wake ripples on the ocean;
 * OceanSystem feeds active sources into the ocean shader.
 */
export const WakeSource = createComponent('WakeSource', {
  /** Current ripple strength 0..1. OceanSystem eases toward targetStrength. */
  strength: { type: 'Float32', default: 1.0 },
  /** Target strength — set to 0 to fade out, 1 to fade in. */
  targetStrength: { type: 'Float32', default: 1.0 },
  /** Current radius (m) of the ripple's influence on the surface. */
  radius: { type: 'Float32', default: 1.25 },
  /** Target radius (m); OceanSystem eases radius toward it. */
  targetRadius: { type: 'Float32', default: 1.25 },
  /** Peak-to-peak wave height (m) at the centre of the ripple. */
  amplitude: { type: 'Float32', default: 0.015 },
  /** Spatial frequency of the concentric rings (waves per metre). */
  frequency: { type: 'Float32', default: 15.0 },
  /** How fast the rings travel outward (m/s). */
  speed: { type: 'Float32', default: 3.0 },
});

/** Single-instance director state for the level -> wave -> unit flow, owned by LevelWaveSystem. */
export const LevelDirector = createComponent('LevelDirector', {
  /** 'waiting-start' | 'dispatching' | 'clearing' | 'wave-gap' | 'level-gap' | 'game-cleared' | 'defeated' */
  phase: { type: 'String', default: 'waiting-start' },
  levelIndex: { type: 'Int32', default: 0 },
  waveIndex: { type: 'Int32', default: 0 },
  /** Units of the current wave still to be dispatched. */
  pendingUnits: { type: 'Int32', default: 0 },
  /** Countdown to the next dispatch, or to the next wave/level. */
  timer: { type: 'Float32', default: 0 },
});

/** Marks a dispatched combat unit and records what it is. */
export const UnitTag = createComponent('UnitTag', {
  /** unitType id from UNIT_TYPES (e.g. 'pirate-ship'). */
  unitType: { type: 'String', default: '' },
  /** 'attacker' | 'defender' — the director only counts attackers. */
  faction: { type: 'String', default: 'attacker' },
});

/**
 * Sail-in behaviour for attacker ships: a straight run from the ocean's far
 * edge to a rolled target point short of the wall.
 */
export const ShipMovement = createComponent('ShipMovement', {
  /** Movement pattern id (see MovementPattern in level-config). */
  pattern: { type: 'String', default: 'default-ship' },
  /** 'moving' | 'stopped' */
  state: { type: 'String', default: 'moving' },
  /** World x the ship emerged at (z is always the ocean's far edge). */
  spawnX: { type: 'Float32', default: 0 },
  /** World x of the sail target, rolled across the ocean width. */
  targetX: { type: 'Float32', default: 0 },
  /** World z of the sail target, rolled between SHIP_STOP_Z_MIN and _MAX. */
  targetZ: { type: 'Float32', default: 0 },
  /** Forward speed (m/s). */
  speed: { type: 'Float32', default: 0.4 },
  /** World y held while under way — ships at the waterline, flyers aloft. */
  cruiseY: { type: 'Float32', default: SHIP_Y },
  /** Gap (m) kept behind a same-type ship ahead along the travel direction. */
  stopDistance: { type: 'Float32', default: 1.1 },
  /** Lateral half-width (m) used for "ahead of me" obstacle checks. */
  laneHalfWidth: { type: 'Float32', default: 0.35 },
  /** Set while a ship ahead keeps this one waiting. */
  blocked: { type: 'Boolean', default: false },
  /** This hull's own wake radius (m); ShipMovementSystem retargets the WakeSource to half this when halted. */
  wakeRadius: { type: 'Float32', default: WAKE_RADIUS },
});

/**
 * Driven rotor of a flying unit (the bombardier's tandem propellers).
 * PropellerSpinSystem resolves the model's `propellers` node and turns each
 * child about local +Y; a hovering flyer keeps spinning.
 */
export const PropellerSpin = createComponent('PropellerSpin', {
  /** Rotor speed, radians per second. */
  speed: { type: 'Float32', default: PROPELLER_SPIN_RAD },
});

/**
 * Flapping wings of a flying unit (the ornithopter's canvas pair). WingFlapSystem
 * swings the `wing_left` / `wing_right` nodes about their root axle with mirrored
 * rotation.z; a hovering flyer keeps flapping.
 */
export const WingFlap = createComponent('WingFlap', {
  /** Flap frequency, radians per second. */
  speed: { type: 'Float32', default: ORNITHOPTER.flapSpeed },
  /** Swing amplitude, radians — each wing's full excursion is ±amplitude. */
  amplitude: { type: 'Float32', default: ORNITHOPTER.flapAmplitude },
});

/**
 * Materialisation countdown for a freshly dispatched unit. SpawnFadeSystem drives the
 * materials and removes it once the unit is solid; movement runs in parallel.
 */
export const SpawnFade = createComponent('SpawnFade', {
  /** Seconds the materialisation takes. */
  duration: { type: 'Float32', default: 0.9 },
  /** Seconds elapsed so far. */
  elapsed: { type: 'Float32', default: 0 },
});

/**
 * Rotation-only billboard: BillboardSystem yaws the entity so its +Z face looks at
 * the viewer — IWSDK's Follower would drag the anchor with the player.
 */
export const Billboard = createComponent('Billboard', {
  /** Keep true for yaw-only turning; false also allows pitch. */
  lockY: { type: 'Boolean', default: true },
});

/** Declarative scale animation used by panels for appear / disappear. */
export const PanelScaleAnim = createComponent('PanelScaleAnim', {
  /** Scale the panel eases toward. */
  targetScale: { type: 'Float32', default: 1 },
  /** Current scale; PanelScaleSystem writes the object transform from it. */
  currentScale: { type: 'Float32', default: 1 },
  /** Easing speed in scale units per second. */
  speed: { type: 'Float32', default: 4 },
});

/**
 * Marks a RayInteractable whose presses belong to its own UI — CameraOrbitSystem
 * refuses to orbit/pinch any pointer pressed on an entity carrying this tag. Attach
 * to the ROOT entity of a UIKitML panel so every child element is covered.
 */
export const CameraBlocker = createComponent('CameraBlocker', {});

/**
 * Marks a pooled projectile living in CannonFireSystem's pools. A projectile is free
 * exactly while it does NOT carry `BallisticFlight` (no separate in-use flag).
 */
export const ShellTag = createComponent('ShellTag', {});

/** Marks pooled stone projectiles inside the ShellTag pool (ornithopter). */
export const StoneTag = createComponent('StoneTag', {});

/**
 * Singleton tag on the trajectory-guide entity owned by TrajectoryPreviewSystem — an
 * InstancedMesh of unlit cubes, pure visual, no state fields.
 */
export const TrajectoryPreview = createComponent('TrajectoryPreview', {});

/**
 * Explicit "this cannon is mid-drag" tag, written and cleared only by CannonAimSystem.
 * Unlike the transient `Pressed` hover tag, it lives for the whole gesture.
 */
export const AimDragging = createComponent('AimDragging', {});

/**
 * Auto-fire ability of a cannon's muzzle: launch one pooled shell every `interval`
 * seconds; an empty pool skips the shot and retries shortly — slower, never stalled.
 */
export const CannonFire = createComponent('CannonFire', {
  /** Seconds between two shots. */
  interval: { type: 'Float32', default: COMBAT.fireInterval },
  /** Countdown to the next shot; written only by CannonFireSystem. */
  cooldown: { type: 'Float32', default: 0 },
  /**
   * Attacker unit id stamped onto fired shells (ShellFaction.unitType) for the
   * DAMAGE_MATRIX lookup.
   */
  unitType: { type: 'String', default: '' },
});

/**
 * Flight state for a shell: carrying this *is* the tag "shell airborne". `drag` is the
 * linear air-drag coefficient (1/s): city shells use COMBAT.shellDrag, pirate/boss
 * intercepts 0. Removed on splash-down, returning the shell to the pool.
 */
export const BallisticFlight = createComponent('BallisticFlight', {
  vx: { type: 'Float32', default: 0 },
  vy: { type: 'Float32', default: 0 },
  vz: { type: 'Float32', default: 0 },
  drag: { type: 'Float32', default: 0 },
});

/**
 * Cannon aim state (yaw on the cannon root, pitch on the `gun_rotate` pivot), written
 * by CannonAimSystem from drag input and applied every frame.
 */
export const CannonAim = createComponent('CannonAim', {
  /** Whole-cannon traverse, degrees, clamped ±yawRangeDeg. */
  yawDeg: { type: 'Float32', default: 0 },
  /** Per-entity traverse half-range (deg) — stock cannon: COMBAT.aimYawRange. */
  yawRangeDeg: { type: 'Float32', default: COMBAT.aimYawRange },
  /** Barrel elevation, degrees, clamped [pitchMinDeg, pitchMaxDeg]. */
  pitchDeg: { type: 'Float32', default: COMBAT.aimPitchDefault },
  /** Per-entity elevation floor (deg) — stock cannon: COMBAT.aimPitchMin. */
  pitchMinDeg: { type: 'Float32', default: COMBAT.aimPitchMin },
  /** Per-entity elevation ceiling (deg) — stock cannon: COMBAT.aimPitchMax. */
  pitchMaxDeg: { type: 'Float32', default: COMBAT.aimPitchMax },
});

/**
 * Splash ripple countdown: SplashSystem drives the WakeSource strength 1 -> 0 over
 * `duration`, then disposes the entity so it leaves OceanSystem's wake list.
 */
export const SplashFade = createComponent('SplashFade', {
  /** Seconds the ripple takes to fade out. */
  duration: { type: 'Float32', default: COMBAT.splashDuration },
  /** Seconds elapsed so far. */
  elapsed: { type: 'Float32', default: 0 },
});

/**
 * The hittable core of a combatant: an invisible `hit_core` helper; ShellHitSystem
 * consumes any opposing-faction shell within `radius`. Presence *is* "can be hit".
 */
export const HitCore = createComponent('HitCore', {
  /** Consume distance (m) from the hit_core centre. */
  radius: { type: 'Float32', default: 0.5 },
  /** 'attacker' | 'defender' — only opposing-faction shells are consumed. */
  faction: { type: 'String', default: 'attacker' },
  /** Unit id of the hittable combatant ('cannon', 'pirate-ship'…). */
  unitType: { type: 'String', default: '' },
  /**
   * Exact name of the hit-core node in the carrier's subtree. Multi-seat assets must use
   * unique names per seat — GLTFLoader de-duplicates same-name nodes with numeric suffixes.
   */
  nodeName: { type: 'String', default: 'hit_core' },
  /** Kill-bounty tier (RewardTier) paid once when this core dies. */
  reward: { type: 'String', default: 'none' },
});

/**
 * Damage pool of a hittable combatant. Reaching zero kills the unit: attackers sink
 * (dispose), defender cannons are tagged Destroyed.
 */
export const Health = createComponent('Health', {
  /** Hits remaining before the unit dies. */
  current: { type: 'Float32', default: 1 },
  /** Hits the unit starts with; the RESTART restore target. */
  max: { type: 'Float32', default: 1 },
  /**
   * Explicit bar height in the carrier's LOCAL space — HealthBarSystem pins the bar here
   * verbatim (no bbox fallback: a mid-frame child would read a stale matrixWorld).
   */
  barY: { type: 'Float32', default: 0 },
});

/**
 * Explicit tag: a defender cannon is knocked out. Written by ShellHitSystem at the
 * killing hit; the tag gates every consumer so the cannon leaves the fight without its
 * components being stripped. restoreCannons removes it on RESTART.
 */
export const Destroyed = createComponent('Destroyed', {});

/**
 * Faction carried by an airborne shell, added on fire and removed on every recycle path
 * (splash or hit) so a pooled shell never keeps a stale side.
 */
export const ShellFaction = createComponent('ShellFaction', {
  /** 'attacker' | 'defender'. */
  faction: { type: 'String', default: 'defender' },
  /** Attacker unit id for the DAMAGE_MATRIX lookup ('cannon', 'bombardier'…). */
  unitType: { type: 'String', default: '' },
});

/**
 * Pirate-ship cannon ability: a stopped ship locks one random defender HitCore, yaws
 * onto it and lobs guaranteed-hit shells on a cooldown.
 */
export const PirateCannon = createComponent('PirateCannon', {
  /** Seconds between two shots. */
  interval: { type: 'Float32', default: COMBAT.pirateFireInterval },
  /**
   * Seaward-most world z this unit may fire from — the far edge of its own berth band
   * (ships SHIP_STOP_Z_MIN, the bombardier FLYER_STOP_Z_MIN). Written at spawn.
   */
  fireLineZ: { type: 'Float32', default: SHIP_STOP_Z_MIN },
  /** Countdown to the next shot; ticks only while stopped and the game runs. */
  cooldown: { type: 'Float32', default: 0 },
  /** Set once a defender target has been acquired. */
  hasTarget: { type: 'Boolean', default: false },
  /**
   * Entity index of the locked defender core. PirateFireSystem re-validates it every
   * frame against the live core query (which drops Destroyed cannons).
   */
  targetCoreIndex: { type: 'Int32', default: -1 },
  /** Target hit_core world position snapshot (city cannons never move). */
  targetX: { type: 'Float32', default: 0 },
  targetY: { type: 'Float32', default: 0 },
  targetZ: { type: 'Float32', default: 0 },
  /** True when this unit hurls pooled stones (ornithopter) instead of cannonballs. */
  stone: { type: 'Boolean', default: false },
});

/**
 * Explicit tag: the START gate has opened and the level flow is live. MenuSystem watches
 * its qualify/dismiss to show and hide the call-menu button.
 */
export const GameStarted = createComponent('GameStarted', {});

/**
 * Explicit pause tag on the director entity (written by MenuSystem); every simulation
 * system early-returns while it is present, while UI/camera systems keep running.
 */
export const GamePaused = createComponent('GamePaused', {});

/**
 * Explicit tag: the run has ended — phase 'game-cleared' (victory) or 'defeated'. The
 * result panel qualifies on it; the fire/aim systems hold while it is present.
 */
export const GameOver = createComponent('GameOver', {});

/**
 * Marks a pooled hit-flash sphere; a flash is free exactly while it does NOT carry
 * `HitFlash` (no separate in-use flag).
 */
export const HitFlashTag = createComponent('HitFlashTag', {});

/**
 * Playing state of a pooled hit-flash sphere; HitFlashSystem derives scale and opacity
 * from `elapsed`. Removal returns the sphere to the pool.
 */
export const HitFlash = createComponent('HitFlash', {
  /** Seconds the bloom-and-fade takes. */
  duration: { type: 'Float32', default: COMBAT.hitFlashDuration },
  /** Seconds elapsed so far. */
  elapsed: { type: 'Float32', default: 0 },
  /** Full-size multiplier over the shared base geometry; set by the spawner. */
  peakScale: { type: 'Float32', default: 1 },
});

/**
 * Marks a pooled death-burst InstancedMesh; a burst is free exactly while it does NOT
 * carry `DieBurst` (no separate in-use flag).
 */
export const DieBurstTag = createComponent('DieBurstTag', {});

/**
 * Playing state of a pooled death-burst: the wood-and-iron chunk cloud a unit explodes
 * into. DieBurstSystem randomises per-chunk state on qualify and integrates it in update.
 */
export const DieBurst = createComponent('DieBurst', {
  /** Seconds the burst takes from spawn to fully recycled. */
  duration: { type: 'Float32', default: COMBAT.dieBurstDuration },
  /** Seconds elapsed so far. */
  elapsed: { type: 'Float32', default: 0 },
  /** Full-size multiplier over the shared base geometry; set by the spawner. */
  sizeRatio: { type: 'Float32', default: 1 },
  /**
   * Rest height in the pooled mesh's LOCAL space — chunks settle on the wall stone or
   * just under the water line for a sinking ship.
   */
  floorY: { type: 'Float32', default: 0 },
  /** Vertical bounce factor on reaching `floorY`; 0 hides the chunk on contact. */
  floorBounce: { type: 'Float32', default: 0 },
});

/**
 * Player wallet, carried by the director entity next to LevelDirector — drained by repair,
 * deducted on build, reset to ECONOMY.startMoney on begin / restart / welcome.
 */
export const Wallet = createComponent('Wallet', {
  /** Money the player currently holds. */
  money: { type: 'Float32', default: ECONOMY.startMoney },
});

/**
 * Explicit tag: this defender is under active repair — health rises and money drains
 * until the pool is full, the wallet empties or the unit dies. Toggled by
 * RepairButtonSystem, drained by RepairSystem.
 */
export const Repairing = createComponent('Repairing', {});

/**
 * Explicit tag: 嘲讽 (taunt) — while one live carrier exists, every non-boss attacker
 * rolls its target exclusively among carriers. PirateFireSystem reads it; the boss
 * ignores taunts by design. Carried by the iron-guard.
 */
export const Taunt = createComponent('Taunt', {});

/**
 * Explicit tag: the shared build panel is open, targeting the defense slot in `slot`.
 * Opened/closed by DefensePadInputSystem, removed by BuildPanelSystem on purchase.
 */
export const BuildOpen = createComponent('BuildOpen', {
  /** Index into DEFENSE_SLOTS the open panel builds into. */
  slot: { type: 'Int32', default: 0 },
});

/**
 * Explicit tag: 一个守方炮台血条上方的维修按钮实体。RepairButtonSystem 创建并驱动它，
 * 并把 `Pressed` 标签翻译成目标炮台的 `Repairing` 开关。
 */
export const RepairButton = createComponent('RepairButton', {});

/**
 * One pedestal pad under a defense slot: DefensePadSystem drives the breathing emissive,
 * DefensePadInputSystem gates its RayInteractable and opens the build dock on press.
 */
export const DefensePad = createComponent('DefensePad', {
  /** Index into DEFENSE_SLOTS this pad serves. */
  slot: { type: 'Int32', default: 0 },
});

/** Explicit tag (no fields): HealthBarSystem skips carriers. */
export const HideHealthBar = createComponent('HideHealthBar', {});

/**
 * Explicit tag (no fields): lifecycle marker on the boss's four baked turret children.
 * They carry Health but no UnitTag/ShipMovement, so the attackers query never sees them;
 * reset and restart tear them down through this tag (Entity.dispose() does not cascade).
 */
export const BossTurret = createComponent('BossTurret', {});

/**
 * Per-gun targeting slot (索敌组件): FreeLockTargetSystem re-rolls a live uniform-random
 * defender core whenever the slot is empty or its target died; a fire cycle clears it
 * after each shot. Repeats are legal, especially when one defender is left.
 */
export const LockTarget = createComponent('LockTarget', {
  /** Entity index of the locked defender core; -1 = no target. */
  targetCoreIndex: { type: 'Int32', default: -1 },
  /** Locked core's hit_core world-position snapshot (defenders never move). */
  targetX: { type: 'Float32', default: 0 },
  targetY: { type: 'Float32', default: 0 },
  targetZ: { type: 'Float32', default: 0 },
});

/**
 * Per-gun fire state machine (发射状态机): runs `cooldown -> turning -> hold -> fire`
 * independently — swing onto the LockTarget snapshot, hold, launch one pooled shell
 * on the closed-form intercept, then wait and clear the slot for the next roll.
 */
export const GunCycle = createComponent('GunCycle', {
  /** 'cooldown' | 'turning' | 'hold'. */
  state: { type: 'String', default: 'cooldown' },
  /** Countdown of the current phase (cooldown wait / hold beat), seconds. */
  timer: { type: 'Float32', default: 0 },
  /** Base seconds between two shots from this gun. */
  fireInterval: { type: 'Float32', default: 3 },
  /** Yaw swing rate while acquiring (deg/s). */
  turnSpeedDeg: { type: 'Float32', default: 120 },
  /** Aim error under this (deg) ends the swing and starts the hold beat. */
  turnThresholdDeg: { type: 'Float32', default: 3 },
  /** Hold-beat seconds between "on target" and the shot. */
  aimHoldSec: { type: 'Float32', default: 0.35 },
  /** Muzzle horizontal shell speed (m/s) for the intercept solve. */
  shellSpeed: { type: 'Float32', default: 8 },
  /** Damage-matrix row key stamped onto every shell this gun fires. */
  shellUnitType: { type: 'String', default: '' },
  /** Entity index of the hull carrying this gun (the berth gate). */
  carrierIndex: { type: 'Int32', default: -1 },
  /** When true the cycle only ticks once the carrier's state is 'stopped'. */
  requireStopped: { type: 'Boolean', default: false },
  /**
   * Exact node names of this gun's yaw pivot and muzzle inside its own subtree; unique
   * per seat (see HitCore.nodeName), written at assembly — no runtime guessing.
   */
  pivotName: { type: 'String', default: 'gun_rotate' },
  muzzleName: { type: 'String', default: 'muzzle' },
  /** Draw shells from the stone pool instead of the ball pool (ornithopter). */
  stone: { type: 'Boolean', default: false },
});

/**
 * Laser main cannon state machine (激光主炮状态机): `cooldown -> turning -> hold ->
 * charging -> firing`, then deducts laserDamageRatio of each swept defender at the
 * firing transition. The axis is frozen at convergence — a target dying mid-cycle never
 * re-aims, and LockTarget re-rolls are ignored until the next cooldown.
 */
export const LaserCycle = createComponent('LaserCycle', {
  /** 'cooldown' | 'turning' | 'hold' | 'charging' | 'firing'. */
  state: { type: 'String', default: 'cooldown' },
  /** Countdown of the current phase, seconds. */
  timer: { type: 'Float32', default: 0 },
  /** Hold at aim convergence before the charge, axis already frozen (s). */
  aimHoldSec: { type: 'Float32', default: 0.5 },
  /** Charge beat before the beam (energy gathering), seconds. */
  chargeSec: { type: 'Float32', default: 2 },
  /** Beam emission duration, seconds. */
  fireSec: { type: 'Float32', default: 1 },
  /** Base seconds between two emissions from this cannon. */
  cooldownSec: { type: 'Float32', default: 5 },
  /** Turn rate while acquiring (deg/s). */
  turnSpeedDeg: { type: 'Float32', default: 120 },
  /** Aim error under this (deg) ends the swing and freezes the beam axis. */
  turnThresholdDeg: { type: 'Float32', default: 0.75 },
  /** Entity index of the hull carrying this cannon (the berth gate). */
  carrierIndex: { type: 'Int32', default: -1 },
  /** When true the cycle only ticks once the carrier's state is 'stopped'. */
  requireStopped: { type: 'Boolean', default: false },
  /** Exact node names of the aim pivot and the beam origin muzzle. */
  pivotName: { type: 'String', default: 'gun_rotate_laser' },
  muzzleName: { type: 'String', default: 'muzzle_laser' },
  /**
   * Beam axis frozen at aim convergence: muzzle world origin, unit dir and origin-to-
   * target length. Written once per cycle; never re-read from LockTarget while firing.
   */
  originX: { type: 'Float32', default: 0 },
  originY: { type: 'Float32', default: 0 },
  originZ: { type: 'Float32', default: 0 },
  dirX: { type: 'Float32', default: 0 },
  dirY: { type: 'Float32', default: 0 },
  dirZ: { type: 'Float32', default: -1 },
  length: { type: 'Float32', default: 0 },
});

/**
 * The boss hull's laser-pivot mount seat for the phase-two chief head (海盗头领挂点).
 * Written by LevelWaveSystem at assembly — the only moment the pivot is guaranteed to
 * exist (the laser turret's death removes its subtree). The accumulated position skips
 * the hull root, whose position is a WORLD coordinate and would be double-counted.
 */
export const ChiefMount = createComponent('ChiefMount', {
  x: { type: 'Float32', default: 0 },
  y: { type: 'Float32', default: 0 },
  z: { type: 'Float32', default: 0 },
});

/**
 * Short beat between the last boss turret dying and the chief head rising: mounted on
 * the hull by BossChiefSystem, ticked down in place, removed at zero (which mounts the
 * head).
 */
export const ChiefPending = createComponent('ChiefPending', {
  timer: { type: 'Float32', default: 0 },
});

/**
 * The phase-two pirate chief head (海盗头领) lifecycle tag: a child entity of the boss
 * hull with Health + HitCore, so it is shootable; its death routes through ShellHitSystem
 * into the ChiefDown command. LevelWaveSystem's dispose sweep recycles it.
 */
export const IslewrathChief = createComponent('IslewrathChief', {});

/**
 * Chief-head emerge animation (升场状态): BossChiefSystem integrates the head's local y
 * over `duration`, then removes the component (head sits at its rest pose).
 */
export const ChiefRise = createComponent('ChiefRise', {
  /** Elapsed rise seconds. */
  elapsed: { type: 'Float32', default: 0 },
  /** Total rise seconds. */
  duration: { type: 'Float32', default: 1.2 },
  /** Hull-local y the rise starts from — the mount seat, snapshotted at mount time. */
  baseY: { type: 'Float32', default: 0 },
});

/**
 * Chief death light (铁头死光) attack state on the phase-two chief head, attached when
 * the rise completes. Every DEATH_LIGHT.intervalSec a beat fires: a bolt, or on the
 * sweepEveryBeats-th beat a sweep (`aiming -> hold -> forming -> sweeping` across the
 * slot row). Frozen fields are the one truth per attack; ChiefDeathLightFxSystem is a
 * pure derived view.
 */
export const ChiefDeathLight = createComponent('ChiefDeathLight', {
  /** 'idle' | 'aiming' | 'hold' | 'forming' | 'sweeping'. */
  state: { type: 'String', default: 'idle' },
  /** Countdown of the current phase (beat gap / hold / form / sweep), s. */
  timer: { type: 'Float32', default: 0 },
  /** Lightnings fired since the last sweep; the sweep replaces that beat. */
  beatCount: { type: 'Int32', default: 0 },
  /** Frozen lightning endpoints (world): chief hit core -> victim core. */
  boltOriginX: { type: 'Float32', default: 0 },
  boltOriginY: { type: 'Float32', default: 0 },
  boltOriginZ: { type: 'Float32', default: 0 },
  boltTargetX: { type: 'Float32', default: 0 },
  boltTargetY: { type: 'Float32', default: 0 },
  boltTargetZ: { type: 'Float32', default: 0 },
  /** Remaining bolt-visual life (s); 0 = no bolt showing. */
  boltTimer: { type: 'Float32', default: 0 },
  /** Frozen sweep beam origin: the chief's hit-core world position. */
  originX: { type: 'Float32', default: 0 },
  originY: { type: 'Float32', default: 0 },
  originZ: { type: 'Float32', default: 0 },
  /** Frozen sweep aim endpoints (world, on the wall's sea face). */
  aimAX: { type: 'Float32', default: 0 },
  aimAY: { type: 'Float32', default: 0 },
  aimAZ: { type: 'Float32', default: 0 },
  aimBX: { type: 'Float32', default: 0 },
  aimBY: { type: 'Float32', default: 0 },
  aimBZ: { type: 'Float32', default: 0 },
});

/**
 * Thin command (薄命令) on the director: the chief head has been killed — clear the
 * field and win. ShellHitSystem writes it; LevelWaveSystem consumes it once (removes the
 * tag, disposes every attacker including the head, declares the level cleared).
 */
export const ChiefDown = createComponent('ChiefDown', {});

/**
 * Explicit tag: the current run is the endless level (endless 模式标记). Added in
 * beginLevel, removed in resetToWelcome / restartLevel; the wave-gap / chief-down
 * branches read it instead of declaring victory.
 */
export const EndlessMode = createComponent('EndlessMode', {});

/**
 * Thin command (薄命令) on the director: the endless wave has cleared — plan the next
 * one. LevelWaveSystem writes it when a wave-gap opens; EndlessPlannerSystem consumes it
 * in the SAME frame, composing one WaveSpec and appending it to endlessLevel.waves.
 */
export const NextWaveCommand = createComponent('NextWaveCommand', {});

/**
 * Explicit tag: the endless intermission window (波间歇) is open — the GET READY panel
 * shows while it sits on the director. Added when a wave gap begins, removed in
 * enterWave. Pure presentation: the player is never paused.
 */
export const WaveIntermission = createComponent('WaveIntermission', {});

/**
 * Partial-immersion sky dome for AR (部分沉浸穹顶). WebXR on Quest exposes no
 * passthrough-blend control, so a BackSide sphere unlit-pastes the shared sky HDR onto
 * a disc around the player's facing axis (world -z), with a noise-ragged rim.
 */
export const SkyDome = createComponent('SkyDome', {
  /** Ceiling of the dome's sky alpha over passthrough (1 = fully opaque). */
  maxAlpha: { type: 'Float32', default: 1.0 },
  /** Angular radius (deg) of the facing disc; past it, pure passthrough. */
  edgeDeg: { type: 'Float32', default: 56.25 },
  /** Smoothstep band (deg) inside the rim: fade starts at edgeDeg - fadeWidthDeg. */
  fadeWidthDeg: { type: 'Float32', default: 25 },
  /** Static noise amplitude on the rim (0 = clean geometric circle). */
  edgeNoise: { type: 'Float32', default: 0.4 },
  /** Noise cells across the dome's sky projection. */
  noiseScale: { type: 'Float32', default: 2.5 },
  /** Multiplier on the sampled HDR sky colour. */
  skyIntensity: { type: 'Float32', default: 1.0 },
  /** Exposure before the ACES tonemap (drives highlight roll-off and contrast). */
  exposure: { type: 'Float32', default: 1.0 },
  /** Elevation (deg) of the disc axis above the horizontal -z forward. */
  pitchUpDeg: { type: 'Float32', default: 7.5 },
});

export default defineComponents([
  OceanTag,
  WakeSource,
  LevelDirector,
  Wallet,
  UnitTag,
  ShipMovement,
  PropellerSpin,
  WingFlap,
  SpawnFade,
  Billboard,
  PanelScaleAnim,
  ShellTag,
  StoneTag,
  CannonFire,
  BallisticFlight,
  CannonAim,
  AimDragging,
  TrajectoryPreview,
  SplashFade,
  HitCore,
  Health,
  Destroyed,
  ShellFaction,
  PirateCannon,
  GameStarted,
  GamePaused,
  GameOver,
  HitFlashTag,
  HitFlash,
  DieBurstTag,
  DieBurst,
  Repairing,
  BuildOpen,
  RepairButton,
  DefensePad,
  HideHealthBar,
  BossTurret,
  LockTarget,
  GunCycle,
  LaserCycle,
  ChiefMount,
  ChiefPending,
  IslewrathChief,
  ChiefRise,
  ChiefDeathLight,
  ChiefDown,
  EndlessMode,
  NextWaveCommand,
  WaveIntermission,
  SkyDome,
  Taunt,
]);
