/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createComponent, defineComponents } from '@iwsdk/core';

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
 * Sail-in behaviour for attacker ships: fade in at the ocean's far edge, then
 * sail a straight line to a rolled target point short of the wall. Plain
 * scalars so a designer can read a unit's real state from the inspector.
 */
export const ShipMovement = createComponent('ShipMovement', {
  /** Movement pattern id (see MovementPattern in level-config). */
  pattern: { type: 'String', default: 'default-ship' },
  /** 'spawning' | 'moving' | 'stopped' */
  state: { type: 'String', default: 'spawning' },
  /** Emerge progress 0..1; drives the wire-to-solid fade. */
  spawnFade: { type: 'Float32', default: 0 },
  /** Seconds the emerge animation takes. */
  spawnFadeDuration: { type: 'Float32', default: 0.9 },
  /** World x the ship emerged at (z is always the ocean's far edge). */
  spawnX: { type: 'Float32', default: 0 },
  /** World x of the sail target, rolled across the ocean width. */
  targetX: { type: 'Float32', default: 0 },
  /** World z of the sail target, rolled between SHIP_STOP_Z_MIN and _MAX. */
  targetZ: { type: 'Float32', default: 0 },
  /** Forward speed (m/s). */
  speed: { type: 'Float32', default: 0.5 },
  /** Gap (m) kept behind a same-type ship ahead along the travel direction. */
  stopDistance: { type: 'Float32', default: 1.1 },
  /** Lateral half-width (m) used for "ahead of me" obstacle checks. */
  laneHalfWidth: { type: 'Float32', default: 0.35 },
  /** Set while a ship ahead keeps this one waiting. */
  blocked: { type: 'Boolean', default: false },
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

export default defineComponents([
  OceanTag,
  WakeSource,
  LevelDirector,
  UnitTag,
  ShipMovement,
  Billboard,
  PanelScaleAnim,
]);
