/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createComponent, defineComponents } from '@iwsdk/core';
import { COMBAT } from './level-config.js';

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
  /** 'waiting-start' | 'dispatching' | 'clearing' | 'wave-gap' | 'level-gap' | 'game-cleared' */
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
  /** Gap (m) kept behind a same-type ship ahead along the travel direction. */
  stopDistance: { type: 'Float32', default: 1.1 },
  /** Lateral half-width (m) used for "ahead of me" obstacle checks. */
  laneHalfWidth: { type: 'Float32', default: 0.35 },
  /** Set while a ship ahead keeps this one waiting. */
  blocked: { type: 'Boolean', default: false },
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
 * Marks a pooled cannon shell. The pool lives in CannonFireSystem; a shell is
 * free exactly while it does NOT carry `BallisticFlight` — presence of the
 * flight component is the "airborne" tag, so no separate in-use flag exists.
 */
export const ShellTag = createComponent('ShellTag', {});

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
});

/**
 * Cannon aim state — the single truth for traverse and elevation.
 * CannonAimSystem writes it from drag input (browser drag / XR pinch-drag via
 * the native `Pressed` tag) and applies it every frame: yaw on the cannon
 * root, pitch on the gun_rotate pivot.
 */
export const CannonAim = createComponent('CannonAim', {
  /** Whole-cannon traverse, degrees, clamped ±COMBAT.aimYawRange. */
  yawDeg: { type: 'Float32', default: 0 },
  /** Barrel elevation, degrees, clamped [COMBAT.aimPitchMin, aimPitchMax]. */
  pitchDeg: { type: 'Float32', default: 0 },
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
});

/**
 * Faction carried by an airborne shell. Added on fire, removed on every
 * recycle path (splash or hit) so a pooled shell can never keep a stale side.
 */
export const ShellFaction = createComponent('ShellFaction', {
  /** 'attacker' | 'defender'. */
  faction: { type: 'String', default: 'defender' },
});

/**
 * Pirate-ship cannon ability. A stopped ship picks one random defender
 * HitCore as its target, yaws onto it, and lobs guaranteed-hit shells on a
 * cooldown. PirateFireSystem is the only writer.
 */
export const PirateCannon = createComponent('PirateCannon', {
  /** Seconds between two shots. */
  interval: { type: 'Float32', default: COMBAT.pirateFireInterval },
  /** Countdown to the next shot; ticks only while stopped and the game runs. */
  cooldown: { type: 'Float32', default: 0 },
  /** Set once a defender target has been acquired. */
  hasTarget: { type: 'Boolean', default: false },
  /** Target hit_core world position snapshot (city cannons never move). */
  targetX: { type: 'Float32', default: 0 },
  targetY: { type: 'Float32', default: 0 },
  targetZ: { type: 'Float32', default: 0 },
});

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
});

export default defineComponents([
  OceanTag,
  WakeSource,
  LevelDirector,
  UnitTag,
  ShipMovement,
  SpawnFade,
  Billboard,
  PanelScaleAnim,
  ShellTag,
  CannonFire,
  BallisticFlight,
  CannonAim,
  SplashFade,
  HitCore,
  ShellFaction,
  PirateCannon,
  HitFlashTag,
  HitFlash,
]);
