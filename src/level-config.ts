/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Level authoring data — the single editable source of truth for the defence.
 *
 * Ordering is level -> wave -> unit: a level holds waves, a wave holds the
 * units sent out one at a time. Redesigning the defence means editing this
 * file only; no system code has to change.
 */

/** Movement pattern ids understood by ShipMovementSystem. */
export type MovementPattern = 'default-ship';

/** Side a unit fights for. The director only ever dispatches attackers. */
export type Faction = 'attacker' | 'defender';

/** One unit type: what to spawn and how it behaves on the water. */
export interface UnitTypeDef {
  /** Asset manifest id instantiated for this unit (see src/assets.ts). */
  assetId: string;
  /** Movement behaviour applied when the unit spawns. */
  movement: MovementPattern;
  /** Side this unit fights for. */
  faction: Faction;
}

/**
 * Unit registry keyed by the unitType string used in level data. Adding a new
 * enemy (goblin flyer, boss) is one entry here plus its asset manifest entry.
 */
export const UNIT_TYPES: Record<string, UnitTypeDef> = {
  'pirate-ship': {
    assetId: 'pirate-ship',
    movement: 'default-ship',
    faction: 'attacker',
  },
};

/** A wave sends its units out one at a time, in listed order. */
export interface WaveSpec {
  /** unitType ids, drawn from UNIT_TYPES. */
  units: string[];
}

/** A level is a sequence of waves. */
export interface LevelSpec {
  name: string;
  waves: WaveSpec[];
}

/** Director pacing in seconds. Retune the rhythm of the defence here. */
export const PACING = {
  /** Gap between two units inside one wave. */
  spawnInterval: 1.5,
  /** Gap after a wave is cleared before the next wave starts. */
  postWaveDelay: 3.0,
  /** Gap after a level is cleared before the next level starts. */
  postLevelDelay: 5.0,
  /** Units the director may keep on the water at once, of any type. */
  maxConcurrentUnits: 6,
  /** Gap between dismissing the START panel and the first level. */
  postStartDelay: 1.0,
};

/**
 * Ocean body footprint in world space. Kept in step with the ocean GLB
 * placement in battle-setup.ts (10 m body centred at z = -6, lifted 0.35).
 */
export const OCEAN = {
  /** Body width along x (m). */
  width: 3,
  /** Body length along z (m). */
  length: 10,
  /** Body centre z (m). */
  centerZ: -6,
  /** Top-surface y (m): 0.35 lift + half of the 0.25 m thickness. */
  surfaceY: 0.475,
};

/** World z of the ocean's far edge — where attackers emerge. */
export const OCEAN_FAR_Z: number = OCEAN.centerZ - OCEAN.length / 2;

/**
 * Harbor wall placement — kept in step with `harbor-wall.glb` (a
 * 3.4 × 0.5 × 0.4 m block) and its transform in battle-setup.ts. The block is
 * only 0.4 m deep in z and straddles the water's edge: its seaward face sits
 * exactly on the ocean's near edge (z = -1), so beyond it there is only wall.
 */
export const WALL_CENTER_Z = -0.8;
export const WALL_DEPTH_Z = 0.4;
export const WALL_SEA_FACE_Z: number = WALL_CENTER_Z - WALL_DEPTH_Z / 2;

/**
 * Pirate hull envelope is ~1.2 m long with the bow on local -Z, so the bow
 * reaches 0.6 m ahead of the ship's origin.
 */
export const SHIP_HALF_LENGTH = 0.6;
/** Gap (m) left between a stopped ship's bow and the wall's seaward face. */
export const SHIP_STOP_MARGIN = 0.1;

/**
 * Attackers stop in the wall-side half of the ocean: from the midpoint
 * toward the wall, but with the bow kept just short of the wall. The stop
 * line has to be derived from the hull's own length — the wall is shallower
 * in z than half a hull, so any formula that measures from the wall's land
 * end would drive the bow clean through the wall block.
 */
export const SHIP_STOP_Z_MIN: number = OCEAN.centerZ;
export const SHIP_STOP_Z_MAX: number =
  WALL_SEA_FACE_Z - SHIP_HALF_LENGTH - SHIP_STOP_MARGIN;
/** Ships float just below the wave crest at the surface. */
export const SHIP_Y = 0.46;

/** Designer's sandbox: one level, tuned by hand. */
export const designList: LevelSpec[] = [
  {
    name: 'design',
    waves: [
      {
        units: [
          'pirate-ship',
          'pirate-ship',
          'pirate-ship',
          'pirate-ship',
          'pirate-ship',
          'pirate-ship',
        ],
      },
    ],
  },
];

/** Authored campaign levels. Empty until the design list is promoted. */
export const gameLevels: LevelSpec[] = [];

/** The list the director runs. Flip to gameLevels to ship a campaign. */
export const activeLevelList: LevelSpec[] = designList;
