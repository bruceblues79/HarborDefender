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
  /** Uniform model scale applied to every spawned clone (1 keeps GLB size). */
  scale: number;
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
  /** Driven wing pivots — WingFlapSystem swings `wing_left`/`wing_right`. */
  flap: boolean;
  /** Hurls pooled stones — PirateFireSystem picks the free-stone pool. */
  stone: boolean;
  /** Disturbs the ocean surface (WakeSource); flyers never touch water. */
  wake: boolean;
  /**
   * Ripple radius (m) this unit drags across the surface. Optional: falls
   * back to the shared WAKE_RADIUS — only oversized hulls (the boss) set it.
   */
  wakeRadius?: number;
  /** Berth z bounds rolled for this unit's stop point (MIN far, MAX near). */
  stopZMin: number;
  stopZMax: number;
  /**
   * Boss-carrier flag: the spawn pipeline skips the generic root HitCore and
   * Health (the boss's four gun turrets are assembled as independent combat
   * parts instead; the hull itself is not a target). Carries no behaviour of
   * its own.
   */
  boss?: boolean;
  /**
   * Fixed sail target (designer data): the unit runs a straight line to this
   * point instead of a rolled berth-band stop. Absent: the berth cascade
   * picks the stop like every other attacker.
   */
  fixedTarget?: { x: number; z: number };
  /**
   * Explicit health-bar height in the carrier's LOCAL space (GLB units, so
   * `scale` carries it naturally). Every Health-carrying unit must set it:
   * measured GLB subtree top plus the shared bar margin — the bar system
   * has no bounding-box fallback. Boss hulls carry no Health and skip it.
   */
  barY?: number;
  /**
   * Kamikaze ability (task 031): the summoned ornithopter variant. Flight
   * and attack are the shared armed-flyer behaviour; KamikazeSystem adds
   * the timed crash into a surviving defender once the unit has stopped.
   */
  kamikaze?: boolean;
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
  /**
   * Money the run starts (and every RESTART) with for this level. Absent:
   * ECONOMY.startMoney applies.
   */
  startMoney?: number;
  /**
   * Units mounted per DEFENSE_SLOTS index at first battlefield build,
   * overriding the slots' own static `unit` fields for this level. Absent:
   * the slots' own units stand.
   */
  initialUnits?: (DefenseUnitId | null)[];
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
  /** Unit standing in the slot at battle entry; null = starts empty. */
  unit: DefenseUnitId | null;
}

/**
 * Five slots evenly spaced across the central 3 m of the 3.4 m wall
 * (0.2 m margin each side), matching the historical cannon row. The run
 * starts with three cannons; the two remaining slots open empty — the
 * player builds them up from the starting gold.
 */
export const DEFENSE_SLOTS: DefenseSlotDef[] = [
  { x: -1.2, unit: null },
  { x: -0.6, unit: 'cannon' },
  { x: 0, unit: 'cannon' },
  { x: 0.6, unit: 'cannon' },
  { x: 1.2, unit: null },
];

/** Unit ids the build panel can mount into a slot — the row order it renders. */
export const PLACEABLE_UNITS: DefenseUnitId[] = ['cannon', 'sky-ballista'];

/**
 * Build/repair buttons, two per defense slot, mounted on the wall's land
 * (+Z) face below each unit: build on the left, repair on the right. Icons
 * are designed GLB assets (npm run export-assets) — flat mechanical glyphs
 * with colour zones baked into vertex colors — facing +Z, with an enlarged
 * invisible hit proxy over each, so a thumb or XR ray never has to hit the
 * glyph itself.
 */
export const DEFENSE_BUTTONS = {
  /** Button centre height — a small lift above the wall's land face (y 0.8). */
  y: 0.65,
  /** Button centre z — a hand's width off the wall's land face (z -0.6). */
  z: -0.48,
  /** Half-gap between the build and repair buttons around the slot centre. */
  spacingX: 0.115,
  /**
   * Invisible hit proxies (m), one per kind: tall boxes sized over the 1.2x
   * glyphs (hammer wide, wrench narrow) and trimmed in X so the build/repair
   * pair — and neighbouring slots — never overlap. The Z depth stays thin:
   * just enough plane for ray detection, no thick invisible wall.
   */
  proxyBuild: { x: 0.18, y: 0.2, z: 0.04 },
  proxyRepair: { x: 0.11, y: 0.2, z: 0.04 },
  /**
   * Build-icon scale while its slot's dock is open — the shrunk "open" pose
   * (pure transform, materials and hit proxies never change). Pressing the
   * shrunk icon again toggles the dock closed.
   */
  openScale: 0.75,
  /**
   * Repair-active pose: the wrench shrinks to openScale (the same shrunk
   * pose as the build button's open dock) and glows — its own material
   * clone raises emissiveIntensity to repairGlow in repairGlowColor (the
   * GLB bakes black emissive, so the runtime owns the colour). Same visual
   * language as the empty-slot pads' warm-gold emissive. Deactivating the
   * repair restores scale 1 and intensity 0.
   */
  repairGlowColor: 0xffc46a,
  repairGlow: 0.6,
};

/**
 * Empty-slot pedestal pads: a permanent Ø0.38 × 0.04 m disc under every
 * defense slot (defense-pad.glb, npm run export-assets). Pure scenery —
 * no ray, no click path; the build buttons stay the build entry. A slot
 * with no live occupant breathes: DefensePadSystem raises that pad's own
 * material's emissiveIntensity sinusoidally — the GLB bakes the warm-gold
 * emissive colour at full strength, so the runtime writes one scalar per
 * pad; every empty pad pulses in lockstep (same phase accumulator).
 */
export const DEFENSE_PAD = {
  /** Pad height (m): the step every mounted unit stands on. */
  height: 0.04,
  /** Breathing speed (rad/s) — ~0.6 Hz. */
  breatheSpeed: 3.8,
  /** Emissive-intensity amplitude: intensity sweeps 0..breatheAmp. */
  breatheAmp: 0.3,
};

/**
 * Economy knobs: money the player starts with, kill bounties, repair
 * throughput/cost and unit book values. Mirrors docs/design/combat.md —
 * change both together.
 */
export const ECONOMY = {
  /** Money the run starts (and every RESTART / MAIN re-entry) with. */
  startMoney: 200,
  /** Bounty credited the instant an attacker unit dies (unified price). */
  killReward: 200,
  /** Health points restored per second while a unit repairs (100 pool). */
  repairHpPerSecond: 10,
  /** Money drained per second while a unit repairs. */
  repairCostPerSecond: 8,
  /**
   * Replace discount: while a slot's unit is alive (not Destroyed), its
   * book value (unitValues) × this factor is credited off the new unit's
   * price — 200 × 0.3 = a flat 60 trade-in credit. Recycling a live unit
   * pays out the same factor as an instant refund, so replace ≡ recycle +
   * rebuild.
   */
  replaceDiscount: 0.3,
  /**
   * Book value per unit id: the ONLY price knob — an empty or destroyed
   * slot builds at full value, a live swap pays the value difference.
   */
  unitValues: {
    cannon: 200,
    'sky-ballista': 200,
  } as Record<DefenseUnitId, number>,
};

/**
 * Kill-bounty tiers (击杀奖励档位): the ONLY reward knobs. Spawn writes one
 * tier onto each bounty-carrying HitCore; ShellHitSystem's kill site reads
 * the tier and pays — no per-branch price logic anywhere (the one exception:
 * BossTurret walks BOSS_TURRET_REWARD_LADDER at the kill site). Defender
 * cores default to None and never pay.
 */
export enum RewardTier {
  /** Not a bounty carrier (defender cores, decor). */
  None = 'none',
  /** Stock attacker (pirate ship, bombardier, ornithopter, kamikaze, chief head). */
  Stock = 'stock',
  /** Endless elite variant. */
  Elite = 'elite',
  /** Islewrath gun turret / laser main gun — paid off the destruction-order ladder. */
  BossTurret = 'boss-turret',
}

/**
 * Islewrath turret kill-bounty ladder (怒岛号五座炮塔递减): the 4 secondary
 * guns + the laser main gun pay in destruction order — the first turret
 * destroyed takes LADDER[0], every later kill steps down 200g, the last
 * takes LADDER[4]. ShellHitSystem picks the step at the kill instant from
 * how many turrets are still alive.
 */
export const BOSS_TURRET_REWARD_LADDER = [1200, 1000, 800, 600, 400];

export const REWARD_TABLE: Record<RewardTier, number> = {
  [RewardTier.None]: 0,
  [RewardTier.Stock]: ECONOMY.killReward,
  [RewardTier.Elite]: 1000,
  // Base (first-kill) step; the kill site walks the ladder, not this cell.
  [RewardTier.BossTurret]: BOSS_TURRET_REWARD_LADDER[0],
};

/**
 * Anti-air ballista aim envelope: against flyers — default rests at the
 * mid-range 50° between the 25° floor and the 75° ceiling. The deep 25°
 * floor lets the bolts reach the ornithopter's middle-air band (y ≈ 2.3 at
 * z -4.4..-2.8) instead of only the higher bombardier plane.
 */
export const SKY_BALLISTA = {
  pitchDefault: 50,
  pitchMin: 25,
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
 * Sky-ballista muzzle geometry, kept in step with sky-ballista.glb and its
 * battle-setup placement: the mount stands on the wall top (y 0.8) at the
 * wall centre z (-0.8), the `gun_rotate` pivot rides 0.21 above the floor,
 * and the loaded bolt tip (the muzzle) sits at gun_rotate-local
 * (0, 0.063, -0.157) — assembly-local (0, 0.0525, -0.131) x the 1.2 scale.
 * battle-setup hangs the runtime `muzzle` node at exactly this offset, so
 * these constants stay the muzzle's single truth.
 */
export const BALLISTA_MUZZLE_LOCAL_Y = 0.063;
export const BALLISTA_MUZZLE_LOCAL_Z = -0.157;

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
 *
 * Boss sandbox (task 028): the Islewrath comes down the centre line and the
 * battery starts fully crewed with deep pockets — a pure boss-fight stage.
 */
export const designList: LevelSpec[] = [
  {
    name: 'design',
    startMoney: 9999,
    initialUnits: ['cannon', 'cannon', 'cannon', 'cannon', 'cannon'],
    waves: [
      {
        units: ['boss_islewrath'],
      },
    ],
  },
];

/** Authored campaign levels. Empty until the design list is promoted. */
export const gameLevels: LevelSpec[] = [];

/**
 * Endless mode (动态难度 endless 关卡): three cannons and a 200 g purse, the
 * first wave fixed at three pirate ships. Waves 2+ are NOT authored here —
 * EndlessPlannerSystem appends one dynamically generated WaveSpec per
 * intermission, so this file's single entry is only the seed. `waves` is the
 * runtime truth of the endless run: waveIndex walks it forever.
 */
export const endlessLevel: LevelSpec = {
  name: 'endless',
  startMoney: 200,
  // 守方 3 加农炮：省略 initialUnits，沿用 DEFENSE_SLOTS 默认（中央三炮，
  // 两翼 x±1.2 空位留给玩家自建）。
  waves: [{ units: ['pirate-ship', 'pirate-ship', 'pirate-ship'] }],
};
export const endlessList: LevelSpec[] = [endlessLevel];

/** Crop the endless wave list back to its seed wave (begin / restart / MAIN). */
export function resetEndlessWaves(): void {
  endlessLevel.waves.length = 1;
}

/** The list the director runs. beginLevel activates the endless list;
 *  designList stays available for designer-sandbox sessions on request. */
export let activeLevelList: LevelSpec[] = endlessList;
export function setActiveLevelList(list: LevelSpec[]): void {
  activeLevelList = list;
}

/**
 * Endless dynamic-difficulty tuning (DDT 发兵调参). The planner reads this
 * block only — every knob a designer touches lives here.
 */
export const ENDLESS = {
  /** Seconds the GET READY intermission panel shows (纯展示，非暂停). */
  intermissionSec: 3,
  /** Budget of wave 2; each later wave adds `budgetPerWave`. */
  baseBudgetWave2: 2,
  budgetPerWave: 0.75,
  /**
   * Defender pressure: the surviving battery's book value (unitValues ×
   * alive count) over `pressureMoneyFull` interpolates the budget multiplier
   * from `pressureMin` (empty wall) to `pressureMax` (full battery) — a
   * stronger defence draws a stronger wave.
   */
  pressureMoneyFull: 600,
  pressureMin: 0.7,
  pressureMax: 1.15,
  /**
   * Money grind: the wallet adds money / `moneyDiv` to the budget multiplier
   * (200 g ≈ +12.5%, 800 g hits the cap) — 存款越多，下一波越重.
   */
  moneyDiv: 1600,
  moneyBonusMax: 0.5,
  /** Hard unit cap per generated wave (overflow waits out the concurrency cap). */
  maxUnitsPerWave: 8,
  /**
   * Purchase pool for a generated wave: unitType -> budget cost, equal-weight
   * random picks among what the remaining budget affords. Keys are UNIT_TYPES
   * ids — bosses and the kamikaze variant are deliberately absent.
   */
  cost: { 'pirate-ship': 1, bombardier: 0.9, ornithopter: 0.6 },
  /**
   * Special cadence (精英/boss 交替): every `specialEvery` waves the wave is
   * special — waveNumber/4 odd (4, 12, 20, …) IS a lone-elite wave — one
   * pooled unit down the centre line, scaled by `eliteScale`, no escorts.
   * The pool stays normalised (100, no oversized health pools): the elite's
   * toughness is a FIXED bite per landed hit — `eliteHitLifeFraction` of its
   * own max life (0.02 → 50 hits from full), whatever fires at it — and its
   * bite is `eliteDamageRatio` on outgoing shells. waveNumber/4 even (8, 16,
   * 24, …) is a boss wave — one lone boss rolled from the pool, phases of
   * its own.
   */
  specialEvery: 4,
  eliteScale: 1.75,
  /** Elite HitCore radius growth — linear with eliteScale, so the core
   *  bubble hugs the hull at any size. */
  eliteCoreScale: 1.75,
  eliteHitLifeFraction: 0.02,
  eliteDamageRatio: 1.5,
  /** Boss pool: a boss wave rolls one at random. */
  bossPool: ['boss_islewrath'],
  /** Wave-list entry prefix marking an elite variant of the named unit. */
  elitePrefix: 'elite:',
};

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
  aimDegreesPerPixel: 0.4,
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
  ballistaFireInterval: 1.0,
  /** Seconds between two bombs from one bombardier. */
  bombardierFireInterval: 2,
  /** Seconds between two stones from one ornithopter. */
  ornithopterFireInterval: 1.2,
  /**
   * Pool size for ornithopter stones (separate from the ball pool) — sized
   * for three concurrent flappers firing every ~1.4-1.7s with ~2s flights.
   */
  stonePoolSize: 8,
  /** Stone projectile radius (m) — reads as a fist-sized hurled rock. */
  stoneRadius: 0.05,
  /** Grey stone tint (roughness 0.9 / metalness 0 dielectric). */
  stoneColor: 0x8a8a86,
  /**
   * World y a shot never crosses: straight bolts (gravityScale 0) are never
   * pulled down, so once one climbs past this ceiling BallisticSystem recycles it
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
 * Aim-drag trajectory guide (TrajectoryPreviewSystem): a sparse row of small
 * unlit cubes redrawn every frame while a defense unit is being dragged.
 * Sampling mirrors the live flight exactly — launch vector from
 * CannonFireSystem.fire, gravity and terminations from BallisticSystem — and
 * because horizontal speed is constant (no drag), equal time steps land at
 * equal horizontal gaps, so the dots read evenly spaced along any arc.
 */
export const TRAJECTORY_PREVIEW = {
  /** Seconds between two guide dots — horizontal gap = shellSpeed_h × this. */
  timeStep: 0.06,
  /** InstancedMesh capacity; the longest lob stays well under this. */
  maxDots: 48,
  /** Cube edge (m) — a touch larger than a 0.0375 shell, reads as a marker. */
  dotSize: 0.05,
  /** Warm gold (sRGB hex) — the shared accent (defense pads / repair glow). */
  color: 0xffc46a,
};

/**
 * Explicit defender health-bar heights (carrier-local y, baked margin
 * included): measured GLB subtree tops at the baked pose — cannon 0.186
 * (barrel level at rest), sky ballista 0.2874 — plus the shared defender
 * margin. The bar system no longer derives heights from bounding boxes.
 */
export const DEFENDER_BAR_Y: Record<DefenseUnitId, number> = {
  cannon: 0.186 + COMBAT.healthBarDefenderMarginY,
  'sky-ballista': 0.2874 + COMBAT.healthBarDefenderMarginY,
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
  'cannon->ornithopter': 25,
  'sky-ballista->pirate-ship': 10,
  'sky-ballista->bombardier': 20,
  'sky-ballista->ornithopter': 20,
  'pirate-ship->cannon': COMBAT.pirateShellDamage,
  'pirate-ship->sky-ballista': 17.5,
  'bombardier->cannon': 10,
  'bombardier->sky-ballista': 12.5,
  'ornithopter->cannon': 6,
  'ornithopter->sky-ballista': 8,
  // Boss Islewrath gun turrets (task 029). The `islewrath-turret` core
  // unitType is a damage-matrix key, deliberately distinct from the
  // UNIT_TYPES sheet key `boss_islewrath` (underscore) — never look rows up
  // by the sheet key.
  'islewrath-turret->cannon': 20,
  'islewrath-turret->sky-ballista': 20,
  // Boss Islewrath turret incoming rows (task 028/031): a city cannon shell
  // chips a flat 2% of the turret's 100-point pool, a sky-ballista bolt 1%.
  'cannon->islewrath-turret': 2,
  'sky-ballista->islewrath-turret': 1,
  // Pirate chief head (task 031): every defender hit — shell or bolt —
  // chips a flat 2% of its 100-point pool.
  'cannon->islewrath-chief': 2,
  'sky-ballista->islewrath-chief': 2,
  // Kamikaze ornithopter (task 031): identical combat values to the plain
  // ornithopter on BOTH directions — it takes the same incoming rows and
  // its stones land through its own attacker rows (the stone shell carries
  // the shooter's unitType). Its 40%-of-max crash payload is NOT a matrix
  // row — KamikazeSystem writes it directly.
  'ornithopter_kamikaze->cannon': 6,
  'ornithopter_kamikaze->sky-ballista': 8,
  'cannon->ornithopter_kamikaze': 25,
  'sky-ballista->ornithopter_kamikaze': 20,
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
 * The bombardier's berth band, now designer data instead of a bolt-line
 * derivation: with the ballista's depression floor opened to 25° the derived
 * far edge (≈ -4.62) would reach deep into the ornithopter's own band, so
 * the flyer keeps its tuned explicit range — far out at -2.6, snug against
 * the wall at -1.23 (the old 75° crossing). MIN < MAX keeps the ship
 * constants' reading — MIN far out, MAX against the wall.
 */
export const FLYER_STOP_Z_MIN = -2.6;
export const FLYER_STOP_Z_MAX = -1.23;

/**
 * Ornithopter flight envelope. The middle-air band sits below the
 * bombardier's cruise plane but inside the city cannons' reach: a 45° shell
 * launched from y 0.941 crosses y 2.3 on its descent between z ≈ -3.0 and
 * -5.0, so a flyer berthed in the band's core [-4.4, -3.0] stays in the
 * 45° envelope's kill corridor, while the forward extension [-3.0, -2.8]
 * sits this side of it — still well inside cannon range. The 25° ballista
 * bolt line from its muzzle (y 1.134, z -0.916) crosses the band's core
 * height range [1.8, 2.8] throughout, so the anti-air mount covers it too.
 */
export const ORNITHOPTER = {
  /** Cruise altitude (m) — the unit's object-origin height. */
  y: 2.3,
  /** Berth band: far out at -4.4, nearest at -2.8. */
  stopZMin: -4.4,
  stopZMax: -2.8,
  /** Uniform model scale — 0.9 reads 10% smaller next to the bombardier. */
  scale: 0.9,
  /** Wing flap frequency (rad/s) and swing amplitude (rad). */
  flapSpeed: 40,
  flapAmplitude: 0.35,
};

/**
 * Boss Islewrath (怒岛号) — the island-ship warlord. Task 029 arms the four
 * gun turrets: each runs an independent fire cycle with its own targeting
 * slot. Task 030 arms the laser main cannon: aim -> charge -> beam -> pause,
 * locking a defense-slot direction at aim convergence (a target dying during
 * charge/fire never re-aims). Task 031 adds the phase-two chief head: once
 * every turret is gone, the chief rises at the laser pivot and summons
 * kamikaze ornithopters.
 */
export const BOSS = {
  /** Straight-run berth point: centre line, one unit nearer the wall than
   * the ocean midpoint — the wake rings and broadside read better there. */
  targetX: 0,
  targetZ: OCEAN.centerZ + 1,
  /**
   * Ripple radius (m) of the boss's wake. The hull is 3-4x a raider's beam,
   * so its wake dwarfs the shared WAKE_RADIUS (1.25 × 3 = 3.75); a radius
   * wider than the ocean body is fine — the surface shader simply clips
   * what it can't show.
   */
  wakeRadius: 3.75,
  /**
   * Explicit bar heights (carrier-local y) for the armour-part wrappers'
   * health bars. The turret subtrees are deterministic baked geometry, so
   * the bars pin to known tops (gun barrel top 0.176, laser barrel top
   * 0.465) plus the shared bar margin (0.12) instead of deriving from
   * runtime bounding boxes — a deep child spawned mid-frame carries a stale
   * ancestor matrix, and the bbox path would float the bar.
   */
  turretBarY: 0.176 + COMBAT.healthBarMarginY,
  laserBarY: 0.465 + COMBAT.healthBarMarginY,
  /**
   * Turret fire rhythm (task 029): each gun loops
   * fire -> pause -> retarget/turn -> hold -> fire. Every shot is a
   * guaranteed-hit intercept solved from the muzzle, exactly like the pirate
   * deck guns; only the horizontal speed differs.
   */
  /** Muzzle horizontal speed (m/s) — shared solver, flat arc. */
  shellSpeed: COMBAT.pirateShellSpeed,
  /** Base seconds between two shots from one turret (pause 1). */
  fireInterval: 3.0,
  /** Turn rate while swinging onto a fresh target (deg/s). */
  turnSpeedDeg: 120,
  /** Aim error under this (deg) ends the swing and starts the hold beat. */
  turnThresholdDeg: 3,
  /** Hold-beat seconds between "on target" and the shot (pause 2). */
  aimHoldSec: 0.35,
  /**
   * Opening fanfare: base delay after berthing, plus a per-seat offset so
   * the four guns open in a rolling ripple (t0, t0+0.45, t0+0.9, t0+1.35)
   * instead of a salvo. Timers only tick once the hull has berthed, so the
   * stagger survives the whole sail-in.
   */
  openFireDelay: 0.8,
  openFireStagger: 0.45,
  /**
   * Per-shot jitter reuses COMBAT.fireJitterMin/Max — one jitter truth for
   * every gun in the game, boss included.
   */
  /** Hit-core radius (m) of a gun turret (baked hit_core helper). */
  turretCoreRadius: 0.4,
  /**
   * Turret death burst: scaled-down shatter of the shared debris pool.
   * turretBurstFloorY is a carrier-LOCAL rest height relative to the burst
   * centre (same convention as the defender cannons' -0.085): chunks settle
   * on the deck around the gone turret, and they rebound (wall-top bounce)
   * instead of sinking.
   */
  turretBurstRatio: 0.45,
  turretBurstFloorY: -0.15,
  /**
   * Laser main cannon rhythm (task 030): each emission locks the beam axis
   * at aim convergence, gathers energy for laserChargeSec, sweeps for
   * laserFireSec, then waits laserCooldownSec (+ shared jitter) before the
   * next cycle. Convergence uses its own tighter threshold — a hitscan beam
   * has no shell radius to absorb residual aim error.
   */
  laserChargeSec: 2,
  laserFireSec: 1,
  laserCooldownSec: 5,
  /** Turn rate while acquiring (deg/s) — shared with the gun turrets. */
  laserTurnSpeedDeg: 120,
  /** Aim error under this (deg) ends the swing and freezes the beam axis. */
  laserTurnThresholdDeg: 0.75,
  /**
   * Hold at aim convergence before the charge beats in (s) — the axis is
   * already frozen; the cannon pauses on target, then charge/fire run
   * unchanged (mirrors the gun turrets' aimHoldSec beat).
   */
  laserAimHoldSec: 0.5,
  /** Fraction of the victim's max Health deducted per beam emission. */
  laserDamageRatio: 0.6,
  /** Damage-corridor half-width (m) around the beam centre line. */
  laserDamageRadius: 0.35,
  /**
   * Fraction of the natural aim drop removed for a flatter bearing. The
   * muzzle sits ~0.9 m above a defender core at ~4.2 m (≈12° depression);
   * 0.5 halves that to ≈6°, and the flattened beam still sweeps the damage
   * corridor over the aimed core (passes ~0.45 m above it against a
   * 0.22 + laserDamageRadius reach). 0 aims dead-on, 1 is fully level.
   */
  laserPitchFlatten: 0.5,
  /**
   * Beam reach multiplier over the locked target distance — the visual
   * column overshoots the wall line instead of stopping at the core.
   */
  laserBeamLengthBoost: 1.44,
};

/**
 * Phase-two pirate chief (task 031). The head rises where the laser citadel
 * stood, never attacks, chips 2% per defender hit (DAMAGE_MATRIX rows), and
 * paces the kamikaze summons.
 */
export const BOSS_CHIEF = {
  /** Seconds between all turrets dying and the rise starting (0.5 s). */
  riseDelay: 0.5,
  /** Hull-local depth the head starts SUNK into the citadel drum — a short
   *  travel for the stocky bust: the helmet crest still peeks above the
   *  rim at the start of the rise. */
  riseSink: 0.22,
  /** Hull-local y at rest relative to the laser pivot seat — 0: the bust
   *  sits DIRECTLY on the drum (no neck; the model's flange bottom leaves a
   *  0.004 local gap so it never z-fights the drum cap). */
  riseY: 0,
  /** Seconds the emerge-from-the-citadel rise takes. */
  riseSec: 1.2,
  /** Health pool: the same normalised 100-point sheet as every unit. */
  health: COMBAT.unitHealth,
  /** Hit-core radius (m) of the head (baked hit_core helper). */
  coreRadius: 0.3,
  /** Seconds between two summon batches — the first fires the instant the
   *  rise completes, then every interval after. */
  summonInterval: 30,
  /** Kamikaze ornithopters per summon batch. */
  summonBatch: 3,
  /** Death-burst size ratio over the shared debris pool (turret-scale, smaller). */
  burstRatio: 0.3,
  /** Carrier-LOCAL rest height of the burst chunks (deck bounce, like turrets). */
  burstFloorY: -0.15,
};

/**
 * Kamikaze ornithopter (task 031). Identical flight and stone attack to the
 * plain ornithopter; once it has stopped it starts a fuse, then dives into
 * one surviving defender. The target is snapshotted at dive start and never
 * re-acquired — a target that dies mid-dive still eats the crash at its last
 * position (the ornithopter shatters on the wall). The crash deducts
 * `damageRatio` of the victim's max Health and destroys the flyer with no
 * kill bounty (self-destruction must not pay the player).
 */
export const KAMIKAZE = {
  /** Fuse seconds after the flyer has stopped (12 s). */
  waitSec: 12,
  /** Straight-line dive speed (m/s). */
  diveSpeed: 2.0,
  /** Fraction of the victim's max Health deducted on impact. */
  damageRatio: 0.4,
  /** Distance (m) under which the flyer counts as crashed into the target. */
  arriveRadius: 0.15,
};

/**
 * Unit registry keyed by the unitType string used in level data. Adding a new
 * enemy (goblin flyer, boss) is one entry here plus its asset manifest entry.
 */
export const UNIT_TYPES: Record<string, UnitTypeDef> = {
  'pirate-ship': {
    assetId: 'pirate-ship',
    scale: 1,
    // Measured GLB subtree top 0.8775 (mast cap) + the shared bar margin.
    barY: 0.8775 + COMBAT.healthBarMarginY,
    movement: 'default-ship',
    faction: 'attacker',
    cruiseY: SHIP_Y,
    armed: true,
    fireInterval: COMBAT.pirateFireInterval,
    rotor: false,
    flap: false,
    stone: false,
    wake: true,
    stopZMin: SHIP_STOP_Z_MIN,
    stopZMax: SHIP_STOP_Z_MAX,
  },
  bombardier: {
    assetId: 'bombardier',
    scale: 1,
    // Measured GLB subtree top 0.359 (propeller disc) + the shared bar margin.
    barY: 0.359 + COMBAT.healthBarMarginY,
    movement: 'default-flyer',
    faction: 'attacker',
    cruiseY: FLYER_Y,
    armed: true,
    fireInterval: COMBAT.bombardierFireInterval,
    rotor: true,
    flap: false,
    stone: false,
    wake: false,
    stopZMin: FLYER_STOP_Z_MIN,
    stopZMax: FLYER_STOP_Z_MAX,
  },
  ornithopter: {
    assetId: 'ornithopter',
    scale: ORNITHOPTER.scale,
    // Measured GLB subtree top 0.165 (wing shoulders at rest) + the shared
    // bar margin. Local GLB units — `scale` 0.9 carries it at spawn.
    barY: 0.165 + COMBAT.healthBarMarginY,
    movement: 'default-ship',
    faction: 'attacker',
    cruiseY: ORNITHOPTER.y,
    armed: true,
    fireInterval: COMBAT.ornithopterFireInterval,
    rotor: false,
    flap: true,
    stone: true,
    wake: false,
    stopZMin: ORNITHOPTER.stopZMin,
    stopZMax: ORNITHOPTER.stopZMax,
  },
  'boss_islewrath': {
    assetId: 'boss-islewrath',
    scale: 1,
    movement: 'default-ship',
    faction: 'attacker',
    // Waterline seat (v0.1.180): two draft orders consolidated — the surface
    // cuts the mesa at model +0.35, so the hull skirt is fully buried and
    // the basalt mesa itself rises straight out of the sea, the floating-
    // island read. Going deeper would drown the mesa base and the front
    // gun seats, and sink the bow ram's visible tip below the waves.
    cruiseY: OCEAN.surfaceY - 0.35,
    // Unarmed at the sheet level: the boss systems drive the turrets, the
    // shared PirateCannon deck-gun path never touches this hull. The turret
    // cadence lives in BOSS's rhythm knobs, not the unit sheet.
    armed: false,
    fireInterval: 0,
    rotor: false,
    flap: false,
    stone: false,
    wake: true,
    wakeRadius: BOSS.wakeRadius,
    // Collapsed berth band + fixed target: the straight centre-line run.
    stopZMin: BOSS.targetZ,
    stopZMax: BOSS.targetZ,
    boss: true,
    fixedTarget: { x: BOSS.targetX, z: BOSS.targetZ },
  },
  'ornithopter_kamikaze': {
    // The summoned kamikaze variant (task 031): same glTF prototype, flight
    // envelope and stone attack as the plain ornithopter — the sheet only
    // flips the `kamikaze` ability on. Summoned by the phase-two chief head,
    // never part of a wave sheet.
    assetId: 'ornithopter',
    scale: ORNITHOPTER.scale,
    barY: 0.165 + COMBAT.healthBarMarginY,
    movement: 'default-ship',
    faction: 'attacker',
    cruiseY: ORNITHOPTER.y,
    armed: true,
    fireInterval: COMBAT.ornithopterFireInterval,
    rotor: false,
    flap: true,
    stone: true,
    wake: false,
    stopZMin: ORNITHOPTER.stopZMin,
    stopZMax: ORNITHOPTER.stopZMax,
    kamikaze: true,
  },
};
