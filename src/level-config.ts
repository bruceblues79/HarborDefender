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
export type MovementPattern = 'default-ship' | 'default-flyer';

/** Side a unit fights for. The director only ever dispatches attackers. */
export type Faction = 'attacker' | 'defender';

/**
 * One unit type: what to spawn and how it behaves. The unit sheet is the
 * single truth the spawner reads — altitude, armament, rotor, wake and the
 * berth band are all designer data, never system hard-coding.
 */
export interface UnitTypeDef {
  /** Asset manifest id instantiated for this unit (see src/assets.ts). */
  assetId: string;
  /** Movement behaviour applied when the unit spawns. */
  movement: MovementPattern;
  /** Side this unit fights for. */
  faction: Faction;
  /** World y the unit holds while under way (its object-origin height). */
  cruiseY: number;
  /** Carries the deck-cannon ability (fires once anchored). */
  armed: boolean;
  /**
   * Seconds between two shots for an armed unit, rolled into PirateCannon
   * at spawn (PirateFireSystem re-rolls from the component, not a constant).
   * Only meaningful when `armed` is true.
   */
  fireInterval: number;
  /** Driven rotor node — PropellerSpinSystem spins `propellers` children. */
  rotor: boolean;
  /** Disturbs the ocean surface (WakeSource); flyers never touch water. */
  wake: boolean;
  /** Berth z bounds rolled for this unit's stop point (MIN far, MAX near). */
  stopZMin: number;
  stopZMax: number;
}

/**
 * Unit registry keyed by the unitType string used in level data. Declared
 * after the constants it reads (module const order is evaluation order).
 * Adding a new enemy (goblin flyer, boss) is one entry here plus its asset
 * manifest entry.
 */

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
  spawnInterval: 2.0,
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
 * placement in battle-setup.ts (10 m body centred at z = -6, lifted 0.55).
 */
export const OCEAN = {
  /** Body width along x (m). */
  width: 3,
  /** Body length along z (m). */
  length: 10,
  /** Body centre z (m). */
  centerZ: -6,
  /** Top-surface y (m): 0.55 lift + half of the 0.25 m thickness. */
  surfaceY: 0.675,
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
/** Land-side face; past it the wall no longer holds burst chunks up. */
export const WALL_LAND_FACE_Z: number = WALL_CENTER_Z + WALL_DEPTH_Z / 2;

/**
 * Defense slots — the fixed wall mounts (城防位) a defender unit can occupy.
 * Editing a slot's `unit` swaps what stands there; no system code changes.
 * x is the slot centre across the wall (m); every mount faces the sea (-Z).
 */
export type DefenseUnitId = 'cannon' | 'sky-ballista';

export interface DefenseSlotDef {
  /** Slot centre x across the wall (m). */
  x: number;
  /** Unit standing in the slot. */
  unit: DefenseUnitId;
}

/**
 * Five slots evenly spaced across the central 3 m of the 3.4 m wall
 * (0.2 m margin each side), matching the historical cannon row.
 */
export const DEFENSE_SLOTS: DefenseSlotDef[] = [
  { x: -1.2, unit: 'cannon' },
  { x: -0.6, unit: 'cannon' },
  { x: 0, unit: 'sky-ballista' },
  { x: 0.6, unit: 'cannon' },
  { x: 1.2, unit: 'cannon' },
];

/**
 * Anti-air ballista aim envelope: fixed high elevation against flyers —
 * default 75° up, at most 20° of depression, never above 75°.
 */
export const SKY_BALLISTA = {
  pitchDefault: 75,
  pitchMin: 55,
  pitchMax: 75,
};

/**
 * Pirate hull envelope is ~1.2 m long with the bow on local -Z, so the bow
 * reaches 0.6 m ahead of the ship's origin.
 */
export const SHIP_LENGTH = 1.2;
export const SHIP_HALF_LENGTH: number = SHIP_LENGTH / 2;
/**
 * Clear water (m) kept between a stopped ship's bow and the wall's seaward
 * face — a full hull length of open water, so the wall never reads as a
 * bumping post. This is the knob to turn when attackers should close in.
 */
export const SHIP_STOP_MARGIN: number = SHIP_LENGTH;

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
export const SHIP_Y = 0.66;

/** Spin of the bombardier's rotor nodes, radians per second. */
export const PROPELLER_SPIN_RAD = 8;

/**
 * Sky-ballista muzzle geometry the flyer's stop band is derived from, kept
 * in step with sky-ballista.glb and its battle-setup placement:
 * - the mount stands on the wall top (y 0.8) at the wall centre z (-0.8);
 * - the `gun_rotate` pivot rides 0.21 above the floor;
 * - the loaded bolt tip (the muzzle) sits at gun_rotate-local
 *   (0, 0.063, -0.157) — assembly-local (0, 0.0525, -0.131) x the 1.2 scale.
 * battle-setup hangs the runtime `muzzle` node at exactly this offset, so
 * these constants stay the muzzle's single truth for both the node and the
 * band math below.
 */
const BALLISTA_PIVOT_Y = 0.8 + 0.21;
const BALLISTA_ROOT_Z = -0.8;
/**
 * The muzzle helper battle-setup hangs under the ballista's gun_rotate pivot
 * (the loaded bolt tip). Exported so the runtime node and the band math in
 * `ballistaBoltCrossZ` share one truth.
 */
export const BALLISTA_MUZZLE_LOCAL_Y = 0.063;
export const BALLISTA_MUZZLE_LOCAL_Z = -0.157;

/**
 * z where a bolt fired at `pitchDeg` elevation crosses the flyer's cruise
 * plane. The muzzle offset rotates with the barrel (CannonAimSystem writes
 * rotation.x = pitch) and the bolt then flies along the muzzle direction
 * (0, sin e, -cos e) with no decay, so the crossing is plain trigonometry.
 */
function ballistaBoltCrossZ(pitchDeg: number): number {
  const e = (pitchDeg * Math.PI) / 180;
  const muzzleY =
    BALLISTA_PIVOT_Y +
    BALLISTA_MUZZLE_LOCAL_Y * Math.cos(e) -
    BALLISTA_MUZZLE_LOCAL_Z * Math.sin(e);
  const muzzleZ =
    BALLISTA_ROOT_Z +
    BALLISTA_MUZZLE_LOCAL_Y * Math.sin(e) +
    BALLISTA_MUZZLE_LOCAL_Z * Math.cos(e);
  return muzzleZ - (FLYER_Y - muzzleY) / Math.tan(e);
}

/**
 * Ripples a moving unit drags across the surface. Strength is the wake's
 * amplitude multiplier; the ship halves its radius while it is not under way.
 */
export const WAKE_STRENGTH_MOVING = 1.0;
export const WAKE_STRENGTH_HALTED = 0.75;
export const WAKE_RADIUS = 1.25;

/** Seconds a dispatched unit takes to materialise (hull opacity 0 -> 1). */
export const SPAWN_FADE_DURATION = 0.9;

/**
 * Separation a new stop must clear of every stop already claimed, measured as
 * an ellipse rather than a circle because a hull is about 0.4 m across but
 * 1.2 m long: 0.8 m across the beam, 1.5 m along the keel. An elliptical test
 * packs this small patch of water noticeably tighter than one isotropic radius.
 *
 * Note the stop zone is 2.4 m by 3.2 m, so six simultaneous stops at this
 * spacing is close to the limit — the last ships out will settle a little
 * inside the minimum, which is expected behaviour, not a fault. Loosen these
 * two numbers to let the fleet cluster more freely.
 */
export const STOP_MIN_GAP_X = 0.8;
export const STOP_MIN_GAP_Z = 1.5;

/**
 * Random candidates rolled per dispatch. The roomiest one is kept, so more
 * tries means a better spread — and a denser fleet needs more of them.
 */
export const STOP_ROLL_TRIES = 8;

/**
 * Spawn-point best-candidate tries. The far edge is only 3 m wide, so a plain
 * random roll keeps landing new ships on top of ones that just emerged. Roll a
 * handful and keep the X furthest from every active attacker's current X —
 * same pattern as stop-point selection, one dimension simpler.
 */
export const SPAWN_ROLL_TRIES = 6;

/**
 * Designer's sandbox: one level, tuned by hand.
 *
 * The wave is as long as `PACING.maxConcurrentUnits`, so the level runs to
 * completion. A longer wave would simply queue: the director holds units until
 * slots free up, which is what keeps the water from flooding.
 */
export const designList: LevelSpec[] = [
  {
    name: 'design',
    waves: [
      {
        units: [
          'pirate-ship',
          'pirate-ship',
          'pirate-ship',
          'bombardier',
          'bombardier',
        ],
      },
    ],
  },
];

/** Authored campaign levels. Empty until the design list is promoted. */
export const gameLevels: LevelSpec[] = [];

/** The list the director runs. Flip to gameLevels to ship a campaign. */
export const activeLevelList: LevelSpec[] = designList;

/**
 * Combat tuning: cannon fire, shell ballistics, splash ripples and aim drag.
 * Every knob a designer touches lives here; the combat systems hold no numbers.
 */
export const COMBAT = {
  /**
   * Pooled shells shared by every cannon, player and (future) pirate alike.
   * Sustained flight peaks at ~6 shells today and roughly triples once pirate
   * ships return fire; 48 keeps ample headroom — idle shells are invisible
   * meshes with shared geometry/material, so the pool costs nothing per frame.
   */
  shellPoolSize: 48,
  /** Shell sphere radius (m) — reads as a ball for the 0.18 m-wide barrel. */
  shellRadius: 0.0375,
  /** Medieval black-iron cannonball tint (metalness/roughness stay 1 / 0.6). */
  shellColor: 0x222222,
  /** Seconds between two shots from one cannon — the base of every roll. */
  fireInterval: 2.5,
  /**
   * Per-shot jitter (s): each cannon re-rolls its cooldown as
   * `fireInterval + [fireJitterMin, fireJitterMax]` after every shot, and the
   * first volley rolls the same way at mount time — the battery drifts out
   * of lockstep from the very first round.
   */
  fireJitterMin: 0.2,
  fireJitterMax: 0.5,
  /** Gravity (m/s^2) for the parabolic flight. */
  gravity: 9.8,
  /**
   * Muzzle speed (m/s). Tuned so a flat shot (0°) reaches z ≈ -2.4 — just
   * past the dock line — and the maximum pitch (45°) lands at z ≈ -6.9:
   *   launch at 45° ≈ (x, 0.941, -0.941) — the muzzle swings up on its pivot;
   *   splash y = surfaceY - splashMargin ≈ 0.625, travel Δz ≈ 5.96
   *   s = v/√2;  s·[s + √(s² + 2g·0.316)] / g = 5.96  ->  v ≈ 7.45
   * A slow, lobbed cannonball arc (~26% of the original 29 m/s).
   */
  shellSpeed: 7.45,
  /** Shells recycle this far (m) below the ocean surface. */
  splashMargin: 0.05,
  /** Splash ripple: strength 1 -> 0 over this many seconds, then disposed. */
  splashDuration: 1.0,
  /** Splash ripple shape: tighter and punchier than a ship wake. */
  splashRadius: 0.6,
  splashAmplitude: 0.04,
  splashFrequency: 18,
  splashSpeed: 4,
  /** Whole-cannon traverse clamp, degrees (±) — wide enough to flank the wall. */
  aimYawRange: 45,
  /** Barrel elevation clamp, degrees. */
  aimPitchMin: 0,
  aimPitchMax: 45,
  /**
   * Spawn/reset barrel elevation, degrees — guns enter the battle (and
   * RESTART / MAIN re-entry) already half-raised, midway through the
   * 0–45 elevation travel, so the battery reads ready rather than parked.
   */
  aimPitchDefault: 22.5,
  /** Aim degrees per dragged pixel in the browser — retune by feel. */
  aimDegreesPerPixel: 0.1,
  /**
   * Aim degrees per metre of wrist travel in XR — retune by feel on device.
   * 200 puts a full ±45° sweep at ~23 cm of hand travel; 1 cm ≈ 2°.
   */
  aimDegreesPerMeter: 200,
  /**
   * Hit-core radii (m): a shell within this 3D distance of an opposing
   * faction's hit_core is consumed. The pirate core sits at bounding-box
   * centre (hull + sail, ~0.38 m above the waterline), so 0.5 reaches down
   * to the hull and most of its 1.25 m length; the defender core covers a
   * city cannon's carriage-and-barrel half-diagonal (~0.22 m).
   */
  attackerCoreRadius: 0.5,
  defenderCoreRadius: 0.22,
  /**
   * Normalised combat numbers: every unit's health pool is 100 points, and
   * all damage is a percentage of that pool — 20 = 20% of a hull.
   */
  /** City-cannon shell damage (20% of a 100-point health pool). */
  shellDamage: 20,
  /** Pirate-ship shell damage (15% of a 100-point health pool). */
  pirateShellDamage: 15,
  /** Health pool every combatant shares (ships and cannons alike). */
  unitHealth: 100,
  /** Seconds between two shots from one pirate ship that is in fire range. */
  pirateFireInterval: 3.0,
  /** Seconds between two bolts from one sky ballista (anti-air mount). */
  ballistaFireInterval: 1.5,
  /** Seconds between two bombs from one bombardier. */
  bombardierFireInterval: 2,
  /**
   * World y a shot never crosses: straight bolts (gravityScale 0 — the
   * flight model the flyer's berth band is derived from) are never pulled
   * down, so once one climbs past this ceiling BallisticSystem recycles it
   * silently. The ballistic arcs never get this high, so the same check is
   * safe for every pooled projectile.
   */
  boltReclaimY: 3.25,
  /** Pool size for straight ballista bolts (separate from the ball pool). */
  boltPoolSize: 12,
  /**
   * Pirate shells keep a constant horizontal speed (m/s); flight time is
   * distance / this and the vertical velocity is solved for an exact hit,
   * so the arc stays flat (~0.2-0.35 m apex) while mathematically landing
   * on the target core. Shares BallisticSystem's gravity.
   */
  pirateShellSpeed: 8,
  /**
   * Hit-flash pool shared by every impact: spheres bloom from `startScale`
   * to full size while fading out with an EaseOut curve over `duration`.
   * Pool entities share one geometry; each carries its own material so the
   * opacity animation stays per-instance.
   */
  hitFlashPoolSize: 8,
  /** Seconds for one hit flash to expand and fade. */
  hitFlashDuration: 0.5,
  /** Base sphere radius (m) at scale 1 — defender cores (harbour cannons). */
  hitFlashRadius: 0.3,
  /** Attacker cores (pirate ships) bloom larger to cover the whole hull. */
  hitFlashShipRadius: 0.35,
  /** Starting fraction of full size ("initial 0.5 volume"). */
  hitFlashStartScale: 0.5,
  /** Fresnel centre colour (hot yellow, sRGB hex). */
  hitFlashCenterColor: 0xffd84d,
  /** Fresnel rim colour (dark red, sRGB hex). */
  hitFlashEdgeColor: 0x8a1400,
  /**
   * Death-burst pool shared by every unit death: one pooled entity per
   * burst, each an InstancedMesh of small wood-and-iron chunks that fly
   * apart under gravity. Pool entities share one geometry AND one material
   * — per-chunk colour comes from the mesh's instanceColor, so nothing is
   * allocated per burst at play time.
   */
  dieBurstPoolSize: 4,
  /** Chunks per burst: 8 wood + 4 iron. */
  dieBurstChunkCount: 12,
  /** Seconds one burst lives before its entity returns to the pool. */
  dieBurstDuration: 1.1,
  /** Chunk gravity (m/s²) — full 9.8 reads too fast at this unit scale. */
  dieBurstGravity: 4.5,
  /** Random horizontal-ish launch speed range (m/s). */
  dieBurstSpeedMin: 0.8,
  dieBurstSpeedMax: 1.8,
  /** Random extra upward velocity range (m/s) on top of the launch speed. */
  dieBurstUpBiasMin: 0.7,
  dieBurstUpBiasMax: 1.6,
  /** Random spin magnitude (rad/s) per axis. */
  dieBurstSpin: 8,
  /** Chunk size range (m) — 6-12% of the ~0.9 m ship length. */
  dieBurstChunkMin: 0.05,
  dieBurstChunkMax: 0.11,
  /** Vertical bounce factor when chunks land on the cannon's wall top. */
  dieBurstFloorBounce: 0.35,
  /** Final seconds of a burst during which all remaining chunks shrink out. */
  dieBurstShrinkTail: 0.15,
  /** Full-size multiplier: pirate ships burst large, wall cannons smaller. */
  dieBurstShipRatio: 1.0,
  dieBurstCannonRatio: 0.6,
  /** Wood plank tints (sRGB hex), picked per chunk. */
  dieBurstWoodColors: [0x8a5a2b, 0x6b4423],
  /** Iron block tints (sRGB hex), picked per chunk. */
  dieBurstIronColors: [0x3d4247, 0x2b2f33],
  /**
   * World-space health bar above every combat unit's head: a red back plate
   * with a green fill quad that shrinks from the left edge as
   * `Health.current / max` drops, exposing the red beneath. HealthBarSystem
   * builds one rig per unit as a child of the unit's object so it follows
   * for free, and yaws it toward the camera each frame (yaw-only billboard —
   * bars stay upright under the orbiting browser camera and in XR).
   */
  /** Bar back-plate width (m) — reads across both cannon and ship hulls. */
  healthBarWidth: 0.5,
  /** Bar height (m). */
  healthBarHeight: 0.06,
  /** Gap (m) between the unit's bounding-box top and the bar's bottom edge. */
  healthBarMarginY: 0.12,
  /**
   * Defender cannons draw a smaller bar (uniform rig scale — 0.6 puts the
   * plate at 0.3 m against a 0.4 m carriage) floated higher: their bounding
   * box tops out at the raised barrel tip, and the stock gap let the gun
   * poke through the plate.
   */
  healthBarDefenderScale: 0.6,
  healthBarDefenderMarginY: 0.28,
  /** Back-plate colour (sRGB hex) — the "missing health" showing through. */
  healthBarBackColor: 0xc42424,
  /** Fill colour (sRGB hex) — the remaining health. */
  healthBarFillColor: 0x35c94f,
};

/**
 * Attacker->target damage table, keyed `${attackerUnitType}->${targetUnitType}`:
 * one shot's damage as a percentage of the target's 100-point pool. Unknown
 * pairs read 0 — immunity is explicit data, never a guessed default. Mirrors
 * docs/design/combat.md; change both together. The two stock pairs stay on
 * their named COMBAT constants (shellDamage / pirateShellDamage).
 */
export const DAMAGE_MATRIX: Record<string, number> = {
  'cannon->pirate-ship': COMBAT.shellDamage,
  'cannon->bombardier': 25,
  'sky-ballista->pirate-ship': 10,
  'sky-ballista->bombardier': 20,
  'pirate-ship->cannon': COMBAT.pirateShellDamage,
  'pirate-ship->sky-ballista': 17.5,
  'bombardier->cannon': 10,
  'bombardier->sky-ballista': 15,
};

/**
 * Bombardier flight envelope. The flyer must sit above every cannonball the
 * city battery can throw — its cruise plane is derived from the shell
 * ballistics, not chosen by hand:
 * - a cannon's gun_rotate pivot rides the wall top (y 0.8) and the muzzle
 *   hangs gun_rotate-local z -0.2 (same offset as the level-wave-system
 *   muzzle helper), so a 45° barrel launches from y 0.8 + 0.2·sin45° ≈ 0.941
 *   — matching the shellSpeed tuning note above;
 * - the barrel clamps at aimPitchMax 45°, and over [0°, 45°] both the muzzle
 *   height and the vertical speed component rise together, so 45° is the
 *   global worst case;
 * - apex rise = (v·sin45°)² / 2g ≈ 1.42 → the shell tops out at y ≈ 2.36.
 * Pirate cannons are flatter still: their arc solves for an exact hit with a
 * ~0.2-0.35 m apex, nowhere near this plane.
 */
const CANNON_MUZZLE_LOCAL_Z = -0.2;
const CANNON_MUZZLE_Y_45 = 0.8 - CANNON_MUZZLE_LOCAL_Z * Math.sin(Math.PI / 4);
const CANNON_APEX_Y =
  CANNON_MUZZLE_Y_45 +
  (COMBAT.shellSpeed * Math.sin(Math.PI / 4)) ** 2 / (2 * COMBAT.gravity);
/** Safety margin above the shell apex, also covering radius differences. */
const FLYER_CLEARANCE = 0.2;
/** Extra designer headroom above the ballistic bound. */
const FLYER_EXTRA_ALTITUDE = 0.3;
export const FLYER_Y =
  CANNON_APEX_Y + FLYER_CLEARANCE + FLYER_EXTRA_ALTITUDE;

/**
 * The flyer's berth band, projected by the sky ballista's elevation envelope
 * onto the cruise plane: at pitchMax (75°) the bolt crosses nearest the wall
 * (≈ -1.23, a hand's width off the sea face but clear of it); at pitchMin
 * (60°, the default's full 15° of depression) it crosses farthest out
 * (≈ -1.80). Anywhere inside the band some elevation in [60°, 75°] reaches
 * the flyer, so the ballista can hit it once it attacks. MIN < MAX keeps the
 * ship constants' reading — MIN far out, MAX against the wall.
 */
export const FLYER_STOP_Z_MIN = ballistaBoltCrossZ(SKY_BALLISTA.pitchMin);
export const FLYER_STOP_Z_MAX = ballistaBoltCrossZ(SKY_BALLISTA.pitchMax);

/**
 * Unit registry keyed by the unitType string used in level data. Adding a new
 * enemy (goblin flyer, boss) is one entry here plus its asset manifest entry.
 */
export const UNIT_TYPES: Record<string, UnitTypeDef> = {
  'pirate-ship': {
    assetId: 'pirate-ship',
    movement: 'default-ship',
    faction: 'attacker',
    cruiseY: SHIP_Y,
    armed: true,
    fireInterval: COMBAT.pirateFireInterval,
    rotor: false,
    wake: true,
    stopZMin: SHIP_STOP_Z_MIN,
    stopZMax: SHIP_STOP_Z_MAX,
  },
  bombardier: {
    assetId: 'bombardier',
    movement: 'default-flyer',
    faction: 'attacker',
    cruiseY: FLYER_Y,
    armed: true,
    fireInterval: COMBAT.bombardierFireInterval,
    rotor: true,
    wake: false,
    stopZMin: FLYER_STOP_Z_MIN,
    stopZMax: FLYER_STOP_Z_MAX,
  },
};
