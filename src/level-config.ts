/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/** Movement pattern ids understood by ShipMovementSystem. */
export type MovementPattern = 'default-ship' | 'default-flyer';

/** The director only ever dispatches attackers. */
export type Faction = 'attacker' | 'defender';

export interface UnitTypeDef {
  /** Asset manifest id instantiated for this unit (see src/assets.ts). */
  assetId: string;
  /** Uniform model scale applied to every spawned clone (1 keeps GLB size). */
  scale: number;
  movement: MovementPattern;
  faction: Faction;
  /** World y the unit holds while under way (its object-origin height). */
  cruiseY: number;
  /** Carries the deck-cannon ability (fires once anchored). */
  armed: boolean;
  /**
   * Seconds between two shots for an armed unit, rolled into PirateCannon at
   * spawn (PirateFireSystem re-rolls from the component). Only if `armed`.
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
  /** Ripple radius (m); defaults to the shared WAKE_RADIUS, only oversized hulls override it. */
  wakeRadius?: number;
  /** Berth z bounds rolled for this unit's stop point (MIN far, MAX near). */
  stopZMin: number;
  stopZMax: number;
  /** Boss flag: spawn skips the generic root HitCore/Health; the gun turrets are separate parts. */
  boss?: boolean;
  /** Fixed sail target instead of a rolled berth stop (absent: normal berth cascade). */
  fixedTarget?: { x: number; z: number };
  /** Health-bar height in carrier-LOCAL GLB units; required for every Health carrier (no bbox fallback). */
  barY?: number;
}

/** A wave sends its units out one at a time, in listed order. */
export interface WaveSpec {
  /** unitType ids, drawn from UNIT_TYPES. */
  units: string[];
}

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
  /** Concurrency cap per unitType LAYER, not global — 6 ships never hold back a flyer's slot. */
  maxConcurrentUnits: 6,
  /** Gap between dismissing the START panel and the first level. */
  postStartDelay: 1.0,
};

/** Ocean body footprint, kept in step with the ocean GLB placement in battle-setup.ts. */
export const OCEAN = {
  width: 3,
  length: 10,
  centerZ: -6.5,
  /** Top-surface y (m): 0.55 lift + half of the 0.25 m thickness. */
  surfaceY: 0.675,
};

/** World z of the ocean's far edge — where attackers emerge. */
export const OCEAN_FAR_Z: number = OCEAN.centerZ - OCEAN.length / 2;

/**
 * Wall placement kept in step with `harbor-wall.glb` (3.4 × 0.5 × 0.4 m) and
 * battle-setup.ts; the seaward face sits on the ocean's near edge.
 */
export const WALL_CENTER_Z = -1.3;
export const WALL_DEPTH_Z = 0.4;
export const WALL_SEA_FACE_Z: number = WALL_CENTER_Z - WALL_DEPTH_Z / 2;
/** Land-side face; past it the wall no longer holds burst chunks up. */
export const WALL_LAND_FACE_Z: number = WALL_CENTER_Z + WALL_DEPTH_Z / 2;

/** Defense slots — the fixed wall mounts (城防位); every mount faces the sea (-Z). */
export type DefenseUnitId = 'cannon' | 'iron-guard';

export interface DefenseSlotDef {
  x: number;
  /** Unit standing in the slot at battle entry; null = starts empty. */
  unit: DefenseUnitId | null;
}

/** Five slots evenly spaced across the wall's central 3 m (0.2 m margin each side). */
export const DEFENSE_SLOTS: DefenseSlotDef[] = [
  { x: -1.2, unit: null },
  { x: -0.6, unit: 'cannon' },
  { x: 0, unit: 'cannon' },
  { x: 0.6, unit: 'cannon' },
  { x: 1.2, unit: null },
];

/** Unit ids the build panel can mount into a slot — the row order it renders. */
export const PLACEABLE_UNITS: DefenseUnitId[] = ['cannon', 'iron-guard'];

/**
 * 全场唯一单位：任意槽位存活一只时，其余空槽一律禁建（置灰并拒绝点击），
 * 直到这只毁灭 —— 唯一性是全局事实，不是每槽属性。
 */
export const UNIQUE_UNITS: ReadonlySet<DefenseUnitId> = new Set([
  'iron-guard',
]);

/**
 * 维修按钮：挂在守方炮台血条左缘上方，仅血量不满且可维修时出现；尺寸是世界尺寸，
 * 不随守方血条的 0.6 缩放变化；命中盒比圆钮大一圈，落在图标外也能命中。
 */
export const REPAIR_BUTTON = {
  diameter: 0.1,
  /** 图标平面边长（m），白色 glyph 居中于圆钮。 */
  iconSize: 0.0525,
  /** 按钮底缘与血条顶边的间隙（m）。 */
  gap: 0.02,
  /** 维修中可见内容组的缩放。 */
  activeScale: 0.75,
  /** dock 同款灰底圆钮。 */
  background: 0x5d646d,
  /** 维修中的亮灰底。 */
  activeBackground: 0x8f98a3,
  /** 不可见命中盒（m）：比圆钮大一圈，Z 向保持薄片，只提供射线平面。 */
  proxy: { x: 0.1375, y: 0.1375, z: 0.04 },
  /** 透明绘制顺序：血条底板 8 / 血量 9 之上，菜单与建造 dock（18/20）之下。 */
  backgroundRenderOrder: 11,
  iconRenderOrder: 12,
};

/**
 * Empty-slot pedestal pads: a permanent Ø0.38 × 0.04 m disc under every defense
 * slot. DefensePadSystem breathes the pad's emissiveIntensity; DefensePadInputSystem
 * keeps RayInteractable on empty pads only and opens the build dock on press.
 */
export const DEFENSE_PAD = {
  /** Pad height (m): the step every mounted unit stands on. */
  height: 0.04,
  /** Breathing speed (rad/s) — ~0.6 Hz. */
  breatheSpeed: 3.8,
  /** Emissive-intensity amplitude: intensity sweeps 0..breatheAmp. */
  breatheAmp: 0.3,
};

/** Economy knobs: starting money, kill bounties, repair throughput/cost and unit book values. */
export const ECONOMY = {
  /** Money the run starts (and every RESTART / MAIN re-entry) with. */
  startMoney: 200,
  /** Bounty credited the instant an attacker unit dies (unified price). */
  killReward: 200,
  /** Health points restored per second while a unit repairs (100 pool). */
  repairHpPerSecond: 10,
  /** Money drained per second while a unit repairs (修满 110 金). */
  repairCostPerSecond: 11,
  /** Book value per unit id — an empty or destroyed slot builds at full value; no trade-in. */
  unitValues: {
    cannon: 200,
    // 钢铁卫士：2500 金一只（嘲讽承伤坦位，boss 承伤 90% 减免）。
    'iron-guard': 2500,
  } as Record<DefenseUnitId, number>,
};

/**
 * Kill-bounty tiers (击杀奖励档位): spawn writes one tier per bounty-carrying
 * HitCore, ShellHitSystem pays the flat REWARD_TABLE cell. Defender cores never pay.
 */
export enum RewardTier {
  /** Not a bounty carrier (defender cores, decor). */
  None = 'none',
  /** Stock attacker (pirate ship, bombardier, ornithopter). */
  Stock = 'stock',
  /** Islewrath gun turret / laser main gun. */
  BossTurret = 'boss-turret',
  /** Islewrath phase-two chief head (黑铁机械武士头). */
  BossChief = 'boss-chief',
}

/** Flat Islewrath bounty (怒岛号悬赏): every turret, the laser main gun and the chief head pay this. */
export const BOSS_BOUNTY = 500;

export const REWARD_TABLE: Record<RewardTier, number> = {
  [RewardTier.None]: 0,
  [RewardTier.Stock]: ECONOMY.killReward,
  [RewardTier.BossTurret]: BOSS_BOUNTY,
  [RewardTier.BossChief]: BOSS_BOUNTY,
};

/** Pirate hull is ~1.2 m long with the bow on local -Z, so the bow leads by 0.6 m. */
export const SHIP_LENGTH = 1.2;
export const SHIP_HALF_LENGTH: number = SHIP_LENGTH / 2;
/** Clear water (m) between a stopped ship's bow and the wall's seaward face. */
export const SHIP_STOP_MARGIN: number = SHIP_LENGTH;

/**
 * Stop band: midpoint toward the wall, bow kept just short of it. Derived from
 * hull length — measuring from the wall's land end would drive the bow through it.
 */
export const SHIP_STOP_Z_MIN: number = OCEAN.centerZ;
export const SHIP_STOP_Z_MAX: number =
  WALL_SEA_FACE_Z - SHIP_HALF_LENGTH - SHIP_STOP_MARGIN;
/** Ships float just below the wave crest at the surface. */
export const SHIP_Y = 0.66;

/** Spin of the bombardier's rotor nodes, radians per second. */
export const PROPELLER_SPIN_RAD = 8;

/** Wake strength is the amplitude multiplier; a halted ship also halves its radius. */
export const WAKE_STRENGTH_MOVING = 1.0;
export const WAKE_STRENGTH_HALTED = 0.75;
export const WAKE_RADIUS = 1.25;

/** Seconds a dispatched unit takes to materialise (hull opacity 0 -> 1). */
export const SPAWN_FADE_DURATION = 0.9;

/**
 * Elliptical stop separation: 0.8 m across the beam, 1.5 m along the keel for a
 * ~0.4 × 1.2 m hull. Six stops nearly fills the zone, so slight overlap is expected.
 */
export const STOP_MIN_GAP_X = 0.8;
export const STOP_MIN_GAP_Z = 1.5;

/** Random candidates per dispatch; the roomiest wins, so more tries spread the fleet better. */
export const STOP_ROLL_TRIES = 8;

/** Spawn-point candidates: roll a handful and keep the X furthest from live attackers. */
export const SPAWN_ROLL_TRIES = 6;

/**
 * Designer's sandbox: one level, tuned by hand — the Islewrath comes down the
 * centre line and the battery starts fully crewed with deep pockets.
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
 * Endless mode seed: three cannons and a 200 g purse, first wave fixed at three
 * ships; EndlessPlannerSystem appends later waves at runtime.
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

/** Endless dynamic-difficulty tuning (DDT 发兵调参). */
export const ENDLESS = {
  /** Seconds the GET READY intermission panel shows (纯展示，非暂停). */
  intermissionSec: 3,
  /** Budget of wave 2; each later wave adds `budgetPerWave`. */
  baseBudgetWave2: 2,
  budgetPerWave: 0.75,

  /** Pressure 曲线下限 / 上限；power=3 时 pressure=pressureMax。 */
  pressureMin: 0.7,
  pressureMax: 1.15,
  /** pressureMin + (pressureMax - pressureMin) × min(powerRatioMax, power/powerFull) */
  powerFull: 3,
  powerRatioMax: 2.5,

  /** iron-guard 的 power 权重：承伤不输出，按 1.5×当前血量比计入。 */
  guardPowerWeight: 1.5,
  /** 剩余钱（修完 + 建完之后）转 sustainFactor：1 + min(sustainMax, excess / sustainDiv) */
  sustainDiv: 4000,
  sustainMax: 0.5,
  /** Boss 前一波额外 × 0.85，让玩家有机会修满/重建再进考场。 */
  preBossEase: 0.85,

  aggressionPerWave: 0.06,
  aggressionMax: 2.2,

  layerCapStart: 6,
  layerCapStep: 1,
  layerCapStepWaves: 3,
  layerCapMax: 12,

  /** Hard unit cap per generated wave (overflow waits out the layer caps). */
  maxUnitsPerWave: 36,

  /** Purchase pool: unitType -> budget cost, equal-weight picks; the boss is absent. */
  cost: { 'pirate-ship': 1, bombardier: 0.9, ornithopter: 0.6 },
  /** Every `bossEvery` waves is a lone boss from `bossPool`; other waves are budget-bought. */
  bossEvery: 6,
  /** Boss pool: a boss wave rolls one at random. */
  bossPool: ['boss_islewrath'],
};

/** Combat tuning: cannon fire, shell ballistics, splash ripples and aim drag. */
export const COMBAT = {
  /** Pooled shells shared by every cannon; idle shells are invisible and cost nothing per frame. */
  shellPoolSize: 48,
  /** Shell sphere radius (m) — reads as a ball for the 0.18 m-wide barrel. */
  shellRadius: 0.0375,
  /** Medieval black-iron cannonball tint (metalness/roughness stay 1 / 0.6). */
  shellColor: 0x222222,
  /** Seconds between two shots from one cannon — the base of every roll. */
  fireInterval: 2.5,
  /** Per-shot jitter (s): every cooldown, including the first, rolls `fireInterval + [min, max]`. */
  fireJitterMin: 0.2,
  fireJitterMax: 0.5,
  /**
   * Gravity (m/s^2) shared by every projectile; the intercept solver compensates,
   * so attacker arcs only steepen. 12.0 drops shots harder and shortens carry to ~5.8 m @ 33°.
   */
  gravity: 12.0,
  /**
   * Muzzle speed (m/s) — one gun fires everything; with `shellDrag` the ball visibly
   * sheds speed: ~30° ≈ 7 m carry, 60° ≈ 4.9 m, 80° lobs die at ~1.8 m.
   */
  shellSpeed: 11.0,
  /**
   * Linear air drag (1/s) on defender shells only: dv/dt = -drag·v + g. Pirate and
   * boss intercepts solve vacuum trajectories (drag 0, guaranteed hit).
   */
  shellDrag: 1.0,
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
  /** Barrel elevation clamp, degrees — 80° lobs cover the flyer band's near half. */
  aimPitchMin: 0,
  aimPitchMax: 80,
  /** Spawn/reset barrel elevation (degrees) — a quarter of the 0–80 travel, so guns read ready. */
  aimPitchDefault: 22.5,
  /** Aim degrees per dragged pixel in the browser — retune by feel. */
  aimDegreesPerPixel: 0.4,
  /** Aim degrees per metre of yaw wrist travel in XR — 100 puts a full ±45° sweep at ~45 cm. */
  aimDegreesPerMeterYaw: 100,
  /** Aim degrees per metre of vertical (pitch) wrist travel in XR. */
  aimDegreesPerMeterPitch: 200,
  /**
   * Hit-core radii (m): a shell within this 3D distance of an opposing core is consumed.
   * Attacker 0.5 covers the hull; defender 0.22 covers a cannon's carriage half-diagonal.
   */
  attackerCoreRadius: 0.5,
  defenderCoreRadius: 0.22,
  /**
   * A shell claims a core only inside `radius × shellHitRadiusScale`; the authored
   * radii stay geometric. TrajectoryPreviewSystem uses the same factor.
   */
  shellHitRadiusScale: 3 / 4,
  /** City-cannon shell damage (20% of a 100-point health pool). */
  shellDamage: 20,
  /** Pirate-ship shell damage (15% of a 100-point health pool). */
  pirateShellDamage: 15,
  /** Health pool every combatant shares (ships and cannons alike). */
  unitHealth: 100,
  /** Seconds between two shots from one pirate ship that is in fire range. */
  pirateFireInterval: 3.0,
  /** Seconds between two bombs from one bombardier. */
  bombardierFireInterval: 2,
  /** Seconds between two stones from one ornithopter. */
  ornithopterFireInterval: 1.2,
  /** Stone pool (separate from balls) — sized for a full flapper layer firing every ~1.4-1.7 s. */
  stonePoolSize: 12,
  /** Stone projectile radius (m) — reads as a fist-sized hurled rock. */
  stoneRadius: 0.05,
  /** Grey stone tint (roughness 0.9 / metalness 0 dielectric). */
  stoneColor: 0x8a8a86,
  /** Pirate shells keep a constant horizontal speed (m/s); the arc is solved flat for an exact hit. */
  pirateShellSpeed: 8,
  /** Hit-flash pool: spheres bloom while fading; each carries its own material for opacity. */
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
  /** Death-burst pool: each burst is an InstancedMesh of chunks sharing one geometry AND one material. */
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
  /** Bar back-plate width (m) — reads across both cannon and ship hulls. */
  healthBarWidth: 0.5,
  /** Bar height (m). */
  healthBarHeight: 0.06,
  /** Gap (m) between the unit's bounding-box top and the bar's bottom edge. */
  healthBarMarginY: 0.12,
  /** Defender cannons draw a smaller bar, floated higher — the raised barrel would poke through the stock gap. */
  healthBarDefenderScale: 0.6,
  healthBarDefenderMarginY: 0.28,
  /** Back-plate colour (sRGB hex) — the "missing health" showing through. */
  healthBarBackColor: 0xc42424,
  /** Fill colour (sRGB hex) — the remaining health. */
  healthBarFillColor: 0x35c94f,
};

/**
 * Aim-drag trajectory guide (TrajectoryPreviewSystem): sampling mirrors the live
 * flight (same launch, gravity, terminations) at uniform arc-length spacing.
 */
export const TRAJECTORY_PREVIEW = {
  /** Metres between two guide dots — uniform along the arc, speed-blind. */
  stepDistance: 0.12,
  /** Seconds between two closed-form march samples feeding the resample. */
  sampleStep: 0.02,
  /** InstancedMesh capacity; the longest lob stays well under this. */
  maxDots: 72,
  /** Cube edge (m) at the tail (full size) — under half a core radius. */
  dotSize: 0.054,
  /** Cube edge scale at the muzzle end (x dotSize); grows linearly to 1 at the water end. */
  dotScaleNear: 0.4,
  /** Warm gold (sRGB hex) — the shared accent (defense pads). */
  color: 0xffc46a,
  /** Hit tint: full-saturation, full-brightness cool green (hue ≈168°). */
  hitColor: 0x00ffc8,
  /** Seconds the guide stays green after the last frame a sample touched a core. */
  hitHoldSec: 0.15,
};

/** Explicit defender bar heights (carrier-local y, margin baked in), measured from the GLB at rest. */
export const DEFENDER_BAR_Y: Record<DefenseUnitId, number> = {
  cannon: 0.186 + COMBAT.healthBarDefenderMarginY,
  // 钢铁卫士：静态雕塑剪影，实测导出顶点 0.345（0.75x 定稿后的盔顶冠羽），
  // 共享 0.12 边距即可（不需要炮车那样为抬起的炮管预留的大边距）。
  'iron-guard': 0.345 + COMBAT.healthBarMarginY,
};

/**
 * Attacker->target damage table, keyed `${attackerUnitType}->${targetUnitType}`:
 * one shot as a percentage of the target's 100-point pool; unknown pairs read 0.
 */
export const DAMAGE_MATRIX: Record<string, number> = {
  'cannon->pirate-ship': COMBAT.shellDamage,
  'cannon->bombardier': 25,
  'cannon->ornithopter': 25,
  'pirate-ship->cannon': COMBAT.pirateShellDamage,
  'bombardier->cannon': 10,
  'ornithopter->cannon': 6,
  // Boss Islewrath gun turrets. The `islewrath-turret` core unitType is a
  // damage-matrix key, deliberately distinct from the UNIT_TYPES sheet key
  // `boss_islewrath` (underscore) — never look rows up by the sheet key.
  'islewrath-turret->cannon': 20,
  // Boss Islewrath turret incoming rows: a city cannon shell chips a flat
  // 2% of the turret's 100-point pool.
  'cannon->islewrath-turret': 2,
  // Pirate chief head: every defender shell chips a flat 2% of its 100-point
  // pool.
  'cannon->islewrath-chief': 2,
  // 钢铁卫士（iron-guard）：普通攻击者承伤固定 2% —— 一发只扣 2%。
  // boss 炮塔单独一行 0.2（boss 伤害 90% 减免，2026-11-01；boss 本就无视
  // 嘲讽——FreeLockTargetSystem 均匀随机索敌，不读 Taunt）。
  'pirate-ship->iron-guard': 2,
  'bombardier->iron-guard': 2,
  'ornithopter->iron-guard': 2,
  'islewrath-turret->iron-guard': 0.2,
};

/** Bombardier cruise altitude, pinned designer data — the berth band and firing arc are tuned to it. */
export const FLYER_Y = 2.857;

/** Bombardier berth band: far -4.7, near -3.15 (1.55 m span, covers STOP_MIN_GAP_Z = 1.5). */
export const FLYER_STOP_Z_MIN = -4.7;
export const FLYER_STOP_Z_MAX = -3.15;

/**
 * Ornithopter flight envelope: below the bombardier's cruise plane, inside cannon reach.
 * Far edge -5.25 lets a full layer of 6 fly 3 × 2; near stop -3.3.
 */
export const ORNITHOPTER = {
  /** Cruise altitude (m) — the unit's object-origin height. */
  y: 2.3,
  /** Berth band: far out at -5.25, nearest at -3.3. */
  stopZMin: -5.25,
  stopZMax: -3.3,
  /** Uniform model scale — 0.9 reads 10% smaller next to the bombardier. */
  scale: 0.9,
  /** Wing flap frequency (rad/s) and swing amplitude (rad). */
  flapSpeed: 40,
  flapAmplitude: 0.35,
};

/** Boss Islewrath (怒岛号): four independent gun turrets, a laser main cannon and a phase-two chief head. */
export const BOSS = {
  /** Straight-run berth point: centre line, one unit nearer the wall than
   * the ocean midpoint — the wake rings and broadside read better there. */
  targetX: 0,
  targetZ: OCEAN.centerZ + 1,
  /** Ripple radius (m) of the boss's wake — 3× the shared WAKE_RADIUS; the shader clips the excess. */
  wakeRadius: 3.75,
  /**
   * Explicit bar heights (carrier-local y) for the armour-part wrappers: baked geometry
   * tops + the shared margin — a bbox derivation floats the bar on mid-frame children.
   */
  turretBarY: 0.176 + COMBAT.healthBarMarginY,
  laserBarY: 0.465 + COMBAT.healthBarMarginY,
  /**
   * Turret fire rhythm: fire -> pause -> retarget/turn -> hold -> fire, each shot a
   * guaranteed-hit intercept from the muzzle.
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
   * Opening fanfare: base delay after berthing plus a per-seat stagger, so the four
   * guns open as a ripple. Timers only tick once the hull has berthed.
   */
  openFireDelay: 0.8,
  openFireStagger: 0.45,
  /** Hit-core radius (m) of a gun turret (baked hit_core helper). */
  turretCoreRadius: 0.35,
  /**
   * Turret death burst: scaled-down shatter of the shared debris pool; turretBurstFloorY
   * is a carrier-LOCAL rest height, so chunks settle on the deck and rebound.
   */
  turretBurstRatio: 0.45,
  turretBurstFloorY: -0.15,
  /**
   * Laser main cannon: lock the beam axis at aim convergence, charge, sweep, then
   * cooldown. Its own tighter threshold because a hitscan beam has no shell radius.
   */
  laserChargeSec: 2,
  laserFireSec: 1,
  laserCooldownSec: 5,
  /** Turn rate while acquiring (deg/s) — shared with the gun turrets. */
  laserTurnSpeedDeg: 120,
  /** Aim error under this (deg) ends the swing and freezes the beam axis. */
  laserTurnThresholdDeg: 0.75,
  /** Hold at aim convergence before the charge (s) — axis already frozen. */
  laserAimHoldSec: 0.5,
  /** Fraction of the victim's max Health deducted per beam emission. */
  laserDamageRatio: 0.6,
  /** Damage-corridor half-width (m) around the beam centre line. */
  laserDamageRadius: 0.35,
  /**
   * Fraction of the natural aim drop removed. The muzzle sits ~0.9 m above the core
   * at ~4.2 m; 0.5 halves that (0 dead-on, 1 fully level).
   */
  laserPitchFlatten: 0.5,
  /** Beam reach multiplier over the locked target distance, so the column overshoots the wall line. */
  laserBeamLengthBoost: 1.44,
};

/**
 * Phase-two pirate chief: the head rises where the laser citadel stood; its attack is
 * DEATH_LIGHT (ChiefDeathLightSystem owns the state machine, BossChiefSystem the rise).
 */
export const BOSS_CHIEF = {
  /** Seconds between all turrets dying and the rise starting (0.5 s). */
  riseDelay: 0.5,
  /** Hull-local depth the head starts sunk into the citadel drum — the helmet crest still peeks out. */
  riseSink: 0.22,
  /** Hull-local y at rest relative to the laser pivot; 0 sits on the drum (flange leaves a 0.004 gap). */
  riseY: 0,
  /** Seconds the emerge-from-the-citadel rise takes. */
  riseSec: 1.2,
  /** Health pool: the same normalised 100-point sheet as every unit. */
  health: COMBAT.unitHealth,
  /** Hit-core radius (m) of the head (baked hit_core helper). */
  coreRadius: 0.3,
  /** Death-burst size ratio over the shared debris pool (turret-scale, smaller). */
  burstRatio: 0.3,
  /** Carrier-LOCAL rest height of the burst chunks (deck bounce, like turrets). */
  burstFloorY: -0.15,
};

/**
 * Chief death light (铁头死光), run by ChiefDeathLightSystem: every `intervalSec` a
 * lightning bolt hits one random defender core for `damageRatio` of MAX Health;
 * every `sweepEveryBeats`-th beat instead sweeps the beam across all five slots,
 * damaging each live defender once. The beat count restarts after a sweep.
 */
export const DEATH_LIGHT = {
  /** Seconds between two beats (lightning tempo). */
  intervalSec: 3,
  /** Fraction of the victim's MAX Health a lightning bolt deducts. */
  damageRatio: 0.75,
  /** Seconds the bolt visual stays up (instant on, instant off). */
  boltLifeSec: 0.2,
  /** The beat that fires the sweep instead of a lightning (1-based). */
  sweepEveryBeats: 4,
  /** Head yaw speed while swinging onto the sweep's start end (deg/s). */
  aimTurnSpeedDeg: 120,
  /** Hold at the start end between aim convergence and the beam form (s). */
  aimHoldSec: 0.5,
  /** Seconds the sweep beam takes to form (width scale-in, no charge). */
  formSec: 0.1,
  /** Seconds the wall-to-wall sweep takes. */
  sweepSec: 1,
  /** Fraction of MAX Health a defender loses when the sweep crosses it. */
  sweepDamageRatio: 0.5,
  /** Damage-corridor half-width (m) around the sweeping beam's centre line. */
  sweepDamageRadius: 0.3,
  /** Sweep aim line: flat across the wall's sea face at the mounted cores' level, x past both end slots. */
  sweepAimY: 1.05,
  sweepSpanX: 1.35,
  /** Beam reach multiplier over the origin-to-aim distance (blows past the wall face). */
  beamLengthBoost: 1.2,
};

/** Unit registry keyed by the unitType string used in level data; one entry per enemy plus its asset. */
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
    // Waterline seat: the surface cuts the model at +0.35, so the mesa rises straight
    // out of the sea while the hull skirt stays buried.
    cruiseY: OCEAN.surfaceY - 0.35,
    // Unarmed at the sheet level: the boss systems drive the turrets, the shared
    // PirateCannon deck-gun path never touches this hull.
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
};
