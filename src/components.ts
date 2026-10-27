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
 * Marks an entity as a source of concentric wake ripples on the ocean.
 * OceanSystem feeds active sources into the ocean shader's uniform array.
 * Toggle `active` to turn ripples on (sailing) or off (anchored / stopped).
 * Works for ships, shells, or any object that should disturb the surface.
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

/**
 * Single-instance director state for the level -> wave -> unit flow. Exactly
 * one entity carries it, owned and written by LevelWaveSystem.
 */
export const LevelDirector = createComponent('LevelDirector', {
  /** 'waiting-start' | 'dispatching' | 'clearing' | 'wave-gap' | 'level-gap' | 'game-cleared' | 'defeated' */
  phase: { type: 'String', default: 'waiting-start' },
  /** Index into the active level list. */
  levelIndex: { type: 'Int32', default: 0 },
  /** Index into the current level's waves. */
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
 * edge to a rolled target point short of the wall. Plain scalars so a
 * designer can read a unit's real state from the inspector.
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
  /**
   * This hull's own wake radius (m) — the unit sheet's wakeRadius at spawn.
   * ShipMovementSystem retargets the WakeSource between this and half of it;
   * per-entity so oversized hulls (the boss) churn ship-scaled ripples.
   */
  wakeRadius: { type: 'Float32', default: WAKE_RADIUS },
});

/**
 * Driven rotor of a flying unit (the bombardier's tandem propellers).
 * Presence of this component *is* the tag "has a spinning rotor":
 * PropellerSpinSystem resolves the model's `propellers` node and turns each
 * child rotor about its local +Y. A hovering flyer keeps its rotors turning,
 * so motion state does not gate the spin.
 */
export const PropellerSpin = createComponent('PropellerSpin', {
  /** Rotor speed, radians per second. */
  speed: { type: 'Float32', default: PROPELLER_SPIN_RAD },
});

/**
 * Flapping wings of a flying unit (the ornithopter's canvas pair). Presence
 * of this component *is* the tag "this unit has driven wings":
 * WingFlapSystem resolves the model's `wing_left` / `wing_right` nodes and
 * swings them about their root axle with mirrored rotation.z — pure scalar
 * sine, no physics. A hovering flyer keeps flapping; motion state does not
 * gate the animation.
 */
export const WingFlap = createComponent('WingFlap', {
  /** Flap frequency, radians per second. */
  speed: { type: 'Float32', default: ORNITHOPTER.flapSpeed },
  /** Swing amplitude, radians — each wing's full excursion is ±amplitude. */
  amplitude: { type: 'Float32', default: ORNITHOPTER.flapAmplitude },
});

/**
 * Materialisation countdown for a freshly dispatched unit. Carrying this
 * component *is* the tag "hull still fading in": SpawnFadeSystem drives the
 * materials and removes it once the unit is solid, so nothing downstream has
 * to know a fade ever happened. Movement runs in parallel, not after it.
 */
export const SpawnFade = createComponent('SpawnFade', {
  /** Seconds the materialisation takes. */
  duration: { type: 'Float32', default: 0.9 },
  /** Seconds elapsed so far. */
  elapsed: { type: 'Float32', default: 0 },
});

/**
 * Rotation-only billboard: BillboardSystem yaws the entity so its +Z face
 * looks at the viewer, without moving it. For world-anchored panels that must
 * stay put while turning to face the player — IWSDK's Follower is a
 * head-following panel and would drag the anchor with the player.
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
 * Marks a RayInteractable whose presses belong to its own UI — the flat-mode
 * camera rig (CameraOrbitSystem) refuses to orbit/pinch any pointer that is
 * pressed on an entity carrying this tag, exactly like it does for cannon
 * aim drags. Attach to the ROOT entity of a UIKitML panel so every child
 * element (rows, scroll areas, padding gaps) is covered by one tag.
 */
export const CameraBlocker = createComponent('CameraBlocker', {});

/**
 * Marks a pooled projectile — cannonball or straight ballista bolt, both
 * living in CannonFireSystem's pools (bolt copies additionally carry
 * BoltTag, which routes them to their own free query). A projectile is free
 * exactly while it does NOT carry `BallisticFlight` — presence of the
 * flight component is the "airborne" tag, so no separate in-use flag exists.
 */
export const ShellTag = createComponent('ShellTag', {});

/** Marks pooled copies of the ballista-bolt glb inside the ShellTag pool. */
export const BoltTag = createComponent('BoltTag', {});

/** Marks pooled stone projectiles inside the ShellTag pool (ornithopter). */
export const StoneTag = createComponent('StoneTag', {});

/**
 * Auto-fire ability of a cannon's muzzle: launch one pooled shell every
 * `interval` seconds. When the pool is empty the shot is skipped and retried
 * shortly, so a busy pool degrades to a slower fire rate, never a stall.
 */
export const CannonFire = createComponent('CannonFire', {
  /** Seconds between two shots. */
  interval: { type: 'Float32', default: COMBAT.fireInterval },
  /** Countdown to the next shot; written only by CannonFireSystem. */
  cooldown: { type: 'Float32', default: 0 },
  /**
   * Attacker unit id stamped onto fired shells (ShellFaction.unitType) so
   * ShellHitSystem can look the damage up in DAMAGE_MATRIX.
   */
  unitType: { type: 'String', default: '' },
  /**
   * Gravity multiplier for this gun's shots: 1 = the standard lob; the sky
   * ballista fires 0 — bolts fly dead straight along the barrel, the flight
   * model the flyer's berth band (FLYER_STOP_Z_*) is derived from.
   */
  gravityScale: { type: 'Float32', default: 1 },
  /**
   * True when this gun fires the straight bolt mesh (ballista) instead of a
   * cannonball: CannonFireSystem picks the pool and aligns the mesh with it.
   */
  bolt: { type: 'Boolean', default: false },
});

/**
 * Parabolic flight for a shell: carrying this *is* the tag "shell airborne".
 * Plain scalars so a shell's velocity stays inspector-readable; BallisticSystem
 * is the only writer. Removed on splash-down, returning the shell to the pool.
 */
export const BallisticFlight = createComponent('BallisticFlight', {
  vx: { type: 'Float32', default: 0 },
  vy: { type: 'Float32', default: 0 },
  vz: { type: 'Float32', default: 0 },
  /** Gravity multiplier: 1 standard; 0 = dead straight flight (bolts). */
  gravityScale: { type: 'Float32', default: 1 },
});

/**
 * Cannon aim state — the single truth for traverse and elevation.
 * CannonAimSystem writes it from drag input (browser drag / XR pinch-drag via
 * the native `Pressed` tag) and applies it every frame: yaw on the cannon
 * root, pitch on the gun_rotate pivot. Pitch limits are per-entity scalars so
 * a sky ballista (fixed high elevation) can share the component with cannons;
 * the defaults reproduce the stock cannon envelope.
 */
export const CannonAim = createComponent('CannonAim', {
  /** Whole-cannon traverse, degrees, clamped ±COMBAT.aimYawRange. */
  yawDeg: { type: 'Float32', default: 0 },
  /** Barrel elevation, degrees, clamped [pitchMinDeg, pitchMaxDeg]. */
  pitchDeg: { type: 'Float32', default: COMBAT.aimPitchDefault },
  /** Per-entity elevation floor (deg) — stock cannon: COMBAT.aimPitchMin. */
  pitchMinDeg: { type: 'Float32', default: COMBAT.aimPitchMin },
  /** Per-entity elevation ceiling (deg) — stock cannon: COMBAT.aimPitchMax. */
  pitchMaxDeg: { type: 'Float32', default: COMBAT.aimPitchMax },
  /**
   * Vertical drag sign for a gun_rotate-zone drag: false keeps the shared
   * "pull down -> muzzle down" mapping; true inverts it (the sky ballista's
   * body pulls down -> muzzle lifts). Horizontal mapping is never inverted.
   */
  pitchDragInvert: { type: 'Boolean', default: false },
});

/**
 * Splash ripple countdown. Carrying this *is* the tag "ripple still fading":
 * SplashSystem drives the WakeSource strength 1 -> 0 over `duration`, then
 * disposes the entity so it leaves OceanSystem's wake list for good.
 */
export const SplashFade = createComponent('SplashFade', {
  /** Seconds the ripple takes to fade out. */
  duration: { type: 'Float32', default: COMBAT.splashDuration },
  /** Seconds elapsed so far. */
  elapsed: { type: 'Float32', default: 0 },
});

/**
 * The hittable core of a combatant (pirate ship, city cannon). An invisible
 * `hit_core` helper sits at the model's bounding-box centre; ShellHitSystem
 * consumes any airborne shell of a different faction that comes within
 * `radius` (3D distance). Presence of this component *is* the "can be hit"
 * tag.
 */
export const HitCore = createComponent('HitCore', {
  /** Consume distance (m) from the hit_core centre. */
  radius: { type: 'Float32', default: 0.5 },
  /** 'attacker' | 'defender' — only opposing-faction shells are consumed. */
  faction: { type: 'String', default: 'attacker' },
  /** Unit id of the hittable combatant ('cannon', 'pirate-ship'…). */
  unitType: { type: 'String', default: '' },
  /**
   * Exact name of the hit-core node in the carrier's subtree. Multi-seat
   * assets must use unique names per seat (GLTFLoader de-duplicates
   * same-name nodes with numeric suffixes at load time, so a bare
   * 'hit_core' only reliably resolves on single-seat assets — the default).
   */
  nodeName: { type: 'String', default: 'hit_core' },
});

/**
 * Damage pool of a hittable combatant (pirate ship, city cannon). Carried by
 * every HitCore entity; ShellHitSystem is the only writer of `current`.
 * Reaching zero kills the unit: attackers sink (dispose), defender cannons
 * are tagged Destroyed.
 */
export const Health = createComponent('Health', {
  /** Hits remaining before the unit dies. */
  current: { type: 'Float32', default: 1 },
  /** Hits the unit starts with; the RESTART restore target. */
  max: { type: 'Float32', default: 1 },
  /**
   * Explicit bar height in the carrier's LOCAL space. HealthBarSystem pins
   * the bar here verbatim — there is no bounding-box fallback: a derivation
   * on a deep child spawned mid-frame reads a stale ancestor matrixWorld and
   * floats the bar. Every Health carrier sets it (hulls: the unit sheet's
   * measured top + margin; boss armour parts: the baked-geometry constants).
   */
  barY: { type: 'Float32', default: 0 },
});

/**
 * Explicit tag: a defender cannon is knocked out. Written once by
 * ShellHitSystem at the killing hit — the tag gates every consumer (fire,
 * aim, targeting, hit detection exclude it) so the cannon leaves the fight
 * without its components being stripped. The cannon object stays in the
 * world, hidden; restoreCannons (battle-setup) removes the tag on RESTART.
 */
export const Destroyed = createComponent('Destroyed', {});

/**
 * Faction carried by an airborne shell. Added on fire, removed on every
 * recycle path (splash or hit) so a pooled shell can never keep a stale side.
 */
export const ShellFaction = createComponent('ShellFaction', {
  /** 'attacker' | 'defender'. */
  faction: { type: 'String', default: 'defender' },
  /** Attacker unit id for the DAMAGE_MATRIX lookup ('cannon', 'bombardier'…). */
  unitType: { type: 'String', default: '' },
});

/**
 * Pirate-ship cannon ability. A stopped ship picks one random defender
 * HitCore as its target, yaws onto it, and lobs guaranteed-hit shells on a
 * cooldown. PirateFireSystem is the only writer.
 */
export const PirateCannon = createComponent('PirateCannon', {
  /** Seconds between two shots. */
  interval: { type: 'Float32', default: COMBAT.pirateFireInterval },
  /**
   * Seaward-most world z this unit may fire from — the far edge of its own
   * berth band (ships SHIP_STOP_Z_MIN, the bombardier FLYER_STOP_Z_MIN).
   * LevelWaveSystem writes it from the unit sheet at spawn; this system only
   * reads it, so "crossing the fire line" stays one per-unit fact.
   */
  fireLineZ: { type: 'Float32', default: SHIP_STOP_Z_MIN },
  /** Countdown to the next shot; ticks only while stopped and the game runs. */
  cooldown: { type: 'Float32', default: 0 },
  /** Set once a defender target has been acquired. */
  hasTarget: { type: 'Boolean', default: false },
  /**
   * Entity index of the defender core this cannon has locked. PirateFireSystem
   * re-validates it every frame against the live core query (which drops
   * Destroyed cannons): gone means re-acquire a random surviving target.
   */
  targetCoreIndex: { type: 'Int32', default: -1 },
  /** Target hit_core world position snapshot (city cannons never move). */
  targetX: { type: 'Float32', default: 0 },
  targetY: { type: 'Float32', default: 0 },
  targetZ: { type: 'Float32', default: 0 },
  /**
   * True when this unit hurls pooled stones (ornithopter) instead of
   * cannonballs: PirateFireSystem picks the free-stone pool for the shot.
   */
  stone: { type: 'Boolean', default: false },
});

/**
 * Explicit tag: the START gate has opened and the level flow is live. Added
 * by LevelWaveSystem.beginLevel, removed by resetToWelcome — MenuSystem
 * watches its qualify/dismiss to show and hide the call-menu button.
 */
export const GameStarted = createComponent('GameStarted', {});

/**
 * Explicit pause tag on the director entity. MenuSystem is the only writer;
 * every simulation system early-returns while it is present. UI, camera,
 * billboard and follower systems ignore it, so pausing never blocks input.
 */
export const GamePaused = createComponent('GamePaused', {});

/**
 * Explicit tag: the run has ended — director phase is 'game-cleared'
 * (victory) or 'defeated' (battery wiped out). LevelWaveSystem is the only
 * writer, adding it on the outcome frame and removing it in beginLevel /
 * restartLevel / resetToWelcome. The result panel qualifies on it; the
 * fire/aim systems hold while it is present.
 */
export const GameOver = createComponent('GameOver', {});

/**
 * Marks a pooled hit-flash sphere. The pool lives in HitFlashSystem; a flash
 * is free exactly while it does NOT carry `HitFlash` — presence of the state
 * component is the "playing" tag, so no separate in-use flag exists.
 */
export const HitFlashTag = createComponent('HitFlashTag', {});

/**
 * Playing state of a pooled hit-flash sphere. ShellHitSystem claims a free
 * flash by adding this component (the thin spawn command); HitFlashSystem is
 * the only writer afterwards, deriving scale and opacity from `elapsed`.
 * Removal returns the sphere to the pool.
 */
export const HitFlash = createComponent('HitFlash', {
  /** Seconds the bloom-and-fade takes. */
  duration: { type: 'Float32', default: COMBAT.hitFlashDuration },
  /** Seconds elapsed so far. */
  elapsed: { type: 'Float32', default: 0 },
  /**
   * Full-size multiplier over the shared base geometry: defender cores play
   * at 1 (hitFlashRadius), attacker ships at hitFlashShipRadius /
   * hitFlashRadius. Set by the spawner, read-only for the animator.
   */
  peakScale: { type: 'Float32', default: 1 },
});

/**
 * Marks a pooled death-burst InstancedMesh. The pool lives in
 * DieBurstSystem; a burst is free exactly while it does NOT carry
 * `DieBurst` — presence of the state component is the "playing" tag, so no
 * separate in-use flag exists.
 */
export const DieBurstTag = createComponent('DieBurstTag', {});

/**
 * Playing state of a pooled death-burst: the wood-and-iron chunk cloud a
 * unit explodes into when it dies. ShellHitSystem claims a free burst by
 * adding this component (the thin spawn command); DieBurstSystem is the
 * only writer afterwards — its `qualify` callback randomises the per-chunk
 * state, `update` integrates it, and removal returns the mesh to the pool.
 */
export const DieBurst = createComponent('DieBurst', {
  /** Seconds the burst takes from spawn to fully recycled. */
  duration: { type: 'Float32', default: COMBAT.dieBurstDuration },
  /** Seconds elapsed so far. */
  elapsed: { type: 'Float32', default: 0 },
  /**
   * Full-size multiplier over the shared base geometry: pirate ships burst
   * at dieBurstShipRatio, wall cannons at dieBurstCannonRatio. Set by the
   * spawner, read-only for the animator.
   */
  sizeRatio: { type: 'Float32', default: 1 },
  /**
   * Rest height in the pooled mesh's LOCAL space: slightly below the core
   * for a cannon (chunks settle on the wall stone) and just under the water
   * line for a sinking ship. Spawn converts world heights to this local
   * value once.
   */
  floorY: { type: 'Float32', default: 0 },
  /**
   * Vertical bounce factor on reaching `floorY`. > 0 chunks rebound and
   * settle (wall top); 0 chunks are hidden the moment they touch (sunk
   * beneath the waves).
   */
  floorBounce: { type: 'Float32', default: 0 },
});

/**
 * Player wallet — the economy's single truth, carried by the director entity
 * next to LevelDirector. RepairSystem is the only per-frame writer (repair
 * drain); BuildPanelSystem deducts on a build; LevelWaveSystem resets it to
 * ECONOMY.startMoney on begin / restart / welcome.
 */
export const Wallet = createComponent('Wallet', {
  /** Money the player currently holds. */
  money: { type: 'Float32', default: ECONOMY.startMoney },
});

/**
 * Explicit tag: this defender is under active repair — health rises and
 * money drains until the pool is full, the wallet empties, the unit dies or
 * the player toggles the repair button again. Added/removed by
 * DefenseButtonSystem (the button command), drained by RepairSystem.
 */
export const Repairing = createComponent('Repairing', {});

/**
 * Explicit tag: the shared build panel is open, targeting the defense slot
 * in `slot`. Added/removed by DefenseButtonSystem (build button click:
 * open, switch slot, toggle close), removed by BuildPanelSystem (row
 * purchased) — its presence shrinks the open slot's build icon.
 */
export const BuildOpen = createComponent('BuildOpen', {
  /** Index into DEFENSE_SLOTS the open panel builds into. */
  slot: { type: 'Int32', default: 0 },
});

/**
 * One world-space build/repair button on the wall's land face: a flat
 * low-poly icon extrusion with an invisible enlarged hit proxy. Defense-
 * ButtonSystem owns the visuals (repair breathes via icon scale, the open
 * slot's build icon shrinks via icon scale); the press itself is
 * InputSystem's `Pressed` tag (mouse / touch / XR ray share the path).
 */
export const DefenseButton = createComponent('DefenseButton', {
  /** Index into DEFENSE_SLOTS this button serves. */
  slot: { type: 'Int32', default: 0 },
  /** 'build' | 'repair'. */
  kind: { type: 'String', default: 'build' },
});

/**
 * Explicit tag (no fields): `HideHealthBar` — HealthBarSystem skips carriers.
 */
export const HideHealthBar = createComponent('HideHealthBar', {});

/**
 * Explicit tag (no fields): `BossTurret` — lifecycle marker on the boss's
 * four baked turret child entities. Each turret carries its own Health pool
 * (so its own bar via HealthBarSystem) but has no UnitTag/ShipMovement, so
 * the attackers query never sees them; reset and restart tear them down
 * through this tag, because Entity.dispose() does not cascade into child
 * entities and they must die with their hull.
 */
export const BossTurret = createComponent('BossTurret', {});

/**
 * Per-gun targeting slot (索敌组件). ANY gun entity carries one; the carrier
 * hull never needs to know its guns exist. FreeLockTargetSystem is the ONLY
 * writer — it re-rolls a live uniform-random defender core whenever the slot
 * is empty or its target has died; a fire cycle clears the slot after each
 * shot to request the next roll. Repeats are legal, especially when one
 * defender is left.
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
 * Per-gun fire state machine (发射状态机). ANY gun entity carries one and
 * runs the `cooldown -> turning -> hold -> fire` loop independently:
 * swing its gun_rotate onto the LockTarget snapshot (turnSpeedDeg until the
 * error is under turnThresholdDeg), hold the aim for aimHoldSec, launch one
 * pooled shell on the closed-form intercept (shellSpeed, stamped
 * shellUnitType for the damage matrix), then wait fireInterval (+ jitter)
 * and clear the LockTarget slot for the next random roll. GunCycleSystem is
 * the only writer; all rhythm values are per-gun data set at assembly.
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
   * Exact node names of this gun's yaw pivot and muzzle inside its own
   * subtree. Unique per seat in the GLB (see HitCore.nodeName for why);
   * written at assembly — no shared names, no runtime guessing.
   */
  pivotName: { type: 'String', default: 'gun_rotate' },
  muzzleName: { type: 'String', default: 'muzzle' },
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
  BoltTag,
  StoneTag,
  CannonFire,
  BallisticFlight,
  CannonAim,
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
  DefenseButton,
  HideHealthBar,
  BossTurret,
  LockTarget,
  GunCycle,
]);
