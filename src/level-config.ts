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
  /**
   * Concurrency cap per LAYER, not global: the director counts live
   * attackers by unitType, and a unit may only spawn while its own layer
   * holds fewer than this. Layers fill independently — 6 ships on the
   * water never hold back a flyer's slot.
   */
  maxConcurrentUnits: 6,
  /** Gap between dismissing the START panel and the first level. */
  postStartDelay: 1.0,
};

/**
 * Gameplay ocean footprint (stop line, splash band). The visual surface is a
 * single 15 × 15 m plane flush with the wall — see OCEAN_PLANE_SIZE and
 * battle-setup.ts. The x band attackers roam lives in SPAWN_FAN.
 */
export const OCEAN = {
  /** Lane length along z (m). */
  length: 10,
  /** Lane centre z (m). */
  centerZ: -6.5,
  /** Water surface y (m). */
  surfaceY: 0.675,
};

/**
 * Edge length (m) of the visual water plane. Its near edge sits on the wall's
 * sea face and the quad extends away from the harbour.
 */
export const OCEAN_PLANE_SIZE = 15;

/** World z of the ocean's far edge — where attackers emerge. */
export const OCEAN_FAR_Z: number = OCEAN.centerZ - OCEAN.length / 2;

/**
 * Harbor wall placement — kept in step with `harbor-wall.glb` (a
 * 3.4 × 0.5 × 0.4 m block) and its transform in battle-setup.ts. The block is
 * only 0.4 m deep in z and straddles the water's edge: its seaward face sits
 * exactly on the ocean's near edge (z = -1.5), so beyond it there is only wall.
 */
export const WALL_CENTER_Z = -1.3;
/** Wall width across x (m) — the berth band may span the wall's full face. */
export const WALL_WIDTH = 3.4;
export const WALL_DEPTH_Z = 0.4;
export const WALL_SEA_FACE_Z: number = WALL_CENTER_Z - WALL_DEPTH_Z / 2;
/** Land-side face; past it the wall no longer holds burst chunks up. */
export const WALL_LAND_FACE_Z: number = WALL_CENTER_Z + WALL_DEPTH_Z / 2;

/**
 * Defense slots — the fixed wall mounts (城防位) a defender unit can occupy.
 * Editing a slot's `unit` swaps what stands there; no system code changes.
 * x is the slot centre across the wall (m); every mount faces the sea (-Z).
 */
export type DefenseUnitId = 'cannon' | 'iron-guard';

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
export const PLACEABLE_UNITS: DefenseUnitId[] = ['cannon', 'iron-guard'];

/**
 * 全场唯一单位：这些 unit id 在任意槽位存活一只时，其余空槽一律禁建
 * （面板行置灰、点击拒绝），直到这只毁灭。唯一性是全局事实，不是每槽
 * 属性 —— 钢铁卫士的嘲讽由它独自承担，多只没有意义。
 */
export const UNIQUE_UNITS: ReadonlySet<DefenseUnitId> = new Set([
  'iron-guard',
]);

/**
 * 维修按钮：挂在每个守方炮台血条的左缘上方，只在血量不满且可维修时出现。
 * 图标是任务给定的白色 SVG path（运行时绘成 CanvasTexture），外圈是 dock
 * 同款灰底圆钮；命中盒比圆钮大一圈，鼠标 / 触摸 / XR 射线都不必落在图标上。
 * 维修中整组缩小、灰底换亮灰。
 *
 * 位置：按钮左缘对齐血条左缘，底缘离血条顶边 `gap` 米；尺寸是世界尺寸，
 * 不随守方血条的 0.6 缩放变化。
 */
export const REPAIR_BUTTON = {
  /** 圆钮直径（m）。 */
  diameter: 0.1,
  /** 图标平面边长（m）——白色 glyph 居中于圆钮。 */
  iconSize: 0.0525,
  /** 按钮底缘与血条顶边的间隙（m）。 */
  gap: 0.02,
  /** 维修中可见内容组的缩放（旧的缩小反馈）。 */
  activeScale: 0.75,
  /** dock 同款灰底圆钮。 */
  background: 0x5d646d,
  /** 维修中的亮灰底，替代旧的金色描边扳手。 */
  activeBackground: 0x8f98a3,
  /**
   * 不可见命中盒（m）：比圆钮大一圈，Z 向保持薄片，只提供射线平面。
   */
  proxy: { x: 0.1375, y: 0.1375, z: 0.04 },
  /**
   * 透明绘制顺序：血条底板 8 / 血量 9 之上，菜单与建造 dock（18/20）之下。
   */
  backgroundRenderOrder: 11,
  iconRenderOrder: 12,
};

/**
 * Empty-slot pedestal pads: a permanent Ø0.38 × 0.04 m disc under every
 * defense slot (defense-pad.glb, npm run export-assets). A slot with no
 * live occupant breathes and doubles as the build entry: DefensePadSystem
 * raises that pad's own material's emissiveIntensity sinusoidally — the GLB
 * bakes the warm-gold emissive colour at full strength, so the runtime
 * writes one scalar per pad; every empty pad pulses in lockstep (same phase
 * accumulator). DefensePadInputSystem keeps RayInteractable on empty pads
 * only and opens the build dock on press.
 */
export const DEFENSE_PAD = {
  /** Pad diameter (m) — the pedestal disc under every defense slot. */
  diameter: 0.38,
  /** Pad height (m): the step every mounted unit stands on. */
  height: 0.04,
  /** Breathing speed (rad/s) — ~0.6 Hz. */
  breatheSpeed: 3.8,
  /** Emissive-intensity amplitude: intensity sweeps 0..breatheAmp. */
  breatheAmp: 0.3,
};

/**
 * 发兵扇形（send-line fan）：远端发兵带总宽 `width`，越靠近城墙横向范围越窄，
 * 收窄到城墙全宽（±WALL_WIDTH/2）。航线仍是 spawn -> target 的直线，收窄感受
 * 由两点自然形成，行进逻辑不变。
 */
export const SPAWN_FAN = {
  /** 远端发兵带总宽（m）。 */
  width: 6,
  /** 停船带半宽（m）：与城墙同宽（3.4 m）。 */
  stopHalfWidth: WALL_WIDTH / 2,
};

/** 远端发兵带半宽（m）。 */
export const SPAWN_HALF_WIDTH: number = SPAWN_FAN.width / 2;

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
  /** Money drained per second while a unit repairs (修满 110 金). */
  repairCostPerSecond: 11,
  /**
   * Book value per unit id: the ONLY price knob — an empty or destroyed
   * slot builds at full value. There is no trade-in: a live occupant's
   * button simply stays hidden.
   */
  unitValues: {
    cannon: 200,
    // 钢铁卫士：2500 金一只（嘲讽承伤坦位，boss 承伤 90% 减免）。
    'iron-guard': 2500,
  } as Record<DefenseUnitId, number>,
};

/**
 * Kill-bounty tiers (击杀奖励档位): the ONLY reward knobs. Spawn writes one
 * tier onto each bounty-carrying HitCore; ShellHitSystem's kill site reads
 * the tier and pays the flat REWARD_TABLE cell — no per-branch price logic
 * anywhere. Defender cores default to None and never pay.
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

/**
 * Flat Islewrath bounty (怒岛号悬赏): every gun turret, the laser main gun
 * and the phase-two chief head each pay this. Briefly zeroed (v0.1.264) to
 * cut the run's biggest income spike; restored to the original 800 after
 * the zero-bounty boss fight starved the defence's economy (2026-10-30
 * 实测拍板); 2026-11-01 下调到 200，同日回调到 400；2026-11-02 上调到 500。
 * The RewardTier tags
 * stay on the spawn sites so a future achievement system can still read
 * part kills.
 */
export const BOSS_BOUNTY = 500;

export const REWARD_TABLE: Record<RewardTier, number> = {
  [RewardTier.None]: 0,
  [RewardTier.Stock]: ECONOMY.killReward,
  [RewardTier.BossTurret]: BOSS_BOUNTY,
  [RewardTier.BossChief]: BOSS_BOUNTY,
};

/**
 * Pirate hull envelope is ~1.2 m long with the bow on local -Z, so the bow
 * reaches 0.6 m ahead of the ship's origin.
 */
export const SHIP_LENGTH = 1.2;
export const SHIP_HALF_LENGTH: number = SHIP_LENGTH / 2;
/**
 * Clear water (m) kept between a stopped ship's bow and the wall's seaward
 * face — a hull length plus 1.3 m, so the near berth sits ~3.1 m out from the
 * wall. This is the knob to turn when attackers should close in / pull back.
 */
export const SHIP_STOP_MARGIN: number = SHIP_LENGTH + 1.3;

/**
 * Attackers stop on the pushed-out band: far edge 1.5 m beyond the ocean
 * midpoint, near edge ~3.1 m off the wall. The near stop keeps a full hull
 * length of clear water; everything derived from it (fire line, flyer bands,
 * boss berth) shifts out by the same 1.5 m.
 */
export const SHIP_STOP_Z_MIN: number = OCEAN.centerZ - 1.5;
export const SHIP_STOP_Z_MAX: number =
  WALL_SEA_FACE_Z - SHIP_HALF_LENGTH - SHIP_STOP_MARGIN;
/** Ships float just below the wave crest at the surface. */
export const SHIP_Y = 0.66;

/** Spin of the bombardier's rotor nodes, radians per second. */
export const PROPELLER_SPIN_RAD = 8;

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
 * Note the stop zone is 3.4 m by 3.4 m, so six simultaneous stops at this
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
 * Spawn-point best-candidate tries. The far edge is only 6 m wide, so a
 * plain random roll keeps landing new ships on top of ones that just emerged.
 * Roll a handful and keep the X furthest from every active attacker's current
 * X — same pattern as stop-point selection, one dimension simpler.
 */
export const SPAWN_ROLL_TRIES = 6;

/**
 * Designer's sandbox: one level, tuned by hand.
 *
 * The wave runs to completion: a longer wave would simply queue — the
 * director holds units until their own layer has room
 * (`PACING.maxConcurrentUnits` per unitType), which is what keeps the water
 * from flooding.
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

  // — 压力曲线（和旧 pressureMin/pressureMax 同名兼容，语义变了） —
  /** Pressure 曲线下限 / 上限；power=3 时 pressure=pressureMax。 */
  pressureMin: 0.7,
  pressureMax: 1.15,
  /** pressureMin + (pressureMax - pressureMin) × min(powerRatioMax, power/powerFull) */
  powerFull: 3,
  powerRatioMax: 2.5,

  // — 卫士 & 续航 —
  /** iron-guard 的 power 权重：承伤不输出，按 1.5×当前血量比计入。 */
  guardPowerWeight: 1.5,
  /** 剩余钱（修完 + 建完之后）转 sustainFactor：1 + min(sustainMax, excess / sustainDiv) */
  sustainDiv: 4000,
  sustainMax: 0.5,
  /** Boss 前一波额外 × 0.85，让玩家有机会修满/重建再进考场。 */
  preBossEase: 0.85,

  // — 侵略性（只放大数量，不动伤害矩阵） —
  aggressionPerWave: 0.06,
  aggressionMax: 2.2,

  // — 每层单位上限（随波次放开） —
  layerCapStart: 6,
  layerCapStep: 1,
  layerCapStepWaves: 3,
  layerCapMax: 12,

  // — 总体硬上限 —
  /** Hard unit cap per generated wave (overflow waits out the layer caps). */
  maxUnitsPerWave: 36,

  /**
   * Purchase pool for a generated wave: unitType -> budget cost, equal-weight
   * random picks among what the remaining budget affords. Keys are UNIT_TYPES
   * ids — the boss is deliberately absent.
   */
  cost: { 'pirate-ship': 1, bombardier: 0.9, ornithopter: 0.6 },
  /**
   * Boss cadence (6 波一 boss): every `bossEvery` waves IS a boss wave —
   * one lone boss rolled from `bossPool`, no escorts, phases of its own.
   * All other waves are budget-bought compositions.
   */
  bossEvery: 6,
  /** Boss pool: a boss wave rolls one at random. */
  bossPool: ['boss_islewrath'],
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
  /**
   * Gravity (m/s^2) for the parabolic flight — shared by every projectile:
   * city shells, dragless attacker intercepts and stones. The intercept
   * solver compensates exactly, so attacker arcs only steepen. Raised with
   * shellSpeed (2026-11-14) so max carry grows 5.8 -> ~7.25 m while the
   * flight time and arc shape stay unchanged.
   */
  gravity: 15.0,
  /**
   * Muzzle speed (m/s) — one gun fires everything. 13.75 + gravity 15.0 is
   * the 11.0 / 12.0 pair scaled by 1.25: drag-loaded arcs keep their layering
   * but reach ~7.25 m, enough for the pushed-out far berth (-8.0). Keep the
   * two values moving together — scaling both preserves the flight time and
   * only changes the reach.
   */
  shellSpeed: 13.75,
  /**
   * Linear air drag (1/s) on defender shells only: dv/dt = -drag·v + g.
   * Pirate and boss intercepts solve vacuum trajectories, so their shells
   * launch with drag 0 (the BallisticFlight default) and stay
   * guaranteed-hit. The trajectory guide samples the same closed form the
   * integration follows, so preview and flight stay in lockstep.
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
  /**
   * Spawn/reset barrel elevation, degrees — guns enter the battle (and
   * RESTART / MAIN re-entry) already part-raised, a quarter of the way
   * through the 0–80 elevation travel, so the battery reads ready rather
   * than parked.
   */
  aimPitchDefault: 22.5,
  /** Aim degrees per dragged pixel in the browser — retune by feel. */
  aimDegreesPerPixel: 0.4,
  /**
   * Aim degrees per metre of horizontal (yaw) wrist travel in XR — retune by
   * feel on device. 100 puts a full ±45° sweep at ~45 cm of hand travel;
   * 1 cm ≈ 1°. Halved from 200 so coarse horizontal steering feels steadier.
   */
  aimDegreesPerMeterYaw: 100,
  /** Aim degrees per metre of vertical (pitch) wrist travel in XR. */
  aimDegreesPerMeterPitch: 200,
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
   * Shell precision: a shell consumes a core only inside
   * `radius × shellHitRadiusScale`. The authored radii above stay the core's
   * geometric extent; this is the volume a shell actually claims, so tighter
   * aim is required without redefining the hull. TrajectoryPreviewSystem
   * tests with the same factor, so the guide's tint matches the flight.
   */
  shellHitRadiusScale: 3 / 4,
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
  /** Seconds between two bombs from one bombardier. */
  bombardierFireInterval: 2,
  /** Seconds between two stones from one ornithopter. */
  ornithopterFireInterval: 1.2,
  /**
   * Pool size for ornithopter stones (separate from the ball pool) — sized
   * for a full flapper layer (6 concurrent at the per-layer cap) firing
   * every ~1.4-1.7s with ~2s flights.
   */
  stonePoolSize: 12,
  /** Stone projectile radius (m) — reads as a fist-sized hurled rock. */
  stoneRadius: 0.05,
  /** Grey stone tint (roughness 0.9 / metalness 0 dielectric). */
  stoneColor: 0x8a8a86,
  /**
   * Pirate shells keep a constant horizontal speed (m/s); flight time is
   * distance / this and the vertical velocity is solved for an exact hit,
   * so the arc stays flat (~0.2-0.35 m apex) while mathematically landing
   * on the target core. Shares BallisticSystem's gravity.
   */
  pirateShellSpeed: 10,
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
  hitFlashRadius: 0.45,
  /** Attacker cores (pirate ships) bloom larger to cover the whole hull. */
  hitFlashShipRadius: 0.525,
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
 * Aim-drag trajectory guide (TrajectoryPreviewSystem), redrawn every frame
 * while a defense unit is being dragged. Sampling mirrors the live flight
 * exactly — launch vector from CannonFireSystem.fire, gravity and
 * terminations from BallisticSystem — resampled at uniform arc-length
 * spacing, so dot gaps stay constant from muzzle to splash.
 */
export const TRAJECTORY_PREVIEW = {
  /** Metres between two guide dots — uniform along the arc, speed-blind. */
  stepDistance: 0.12,
  /** Seconds between two closed-form march samples feeding the resample. */
  sampleStep: 0.02,
  /** InstancedMesh capacity; sized for the 7.25 m carry at 0.12 m spacing. */
  maxDots: 90,
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

/**
 * Explicit defender health-bar heights (carrier-local y, baked margin
 * included): measured GLB subtree top at the baked pose — cannon 0.186
 * (barrel level at rest) — plus the shared defender margin. The bar system
 * no longer derives heights from bounding boxes.
 */
export const DEFENDER_BAR_Y: Record<DefenseUnitId, number> = {
  cannon: 0.186 + COMBAT.healthBarDefenderMarginY,
  // 钢铁卫士：静态雕塑剪影，实测导出顶点 0.345（0.75x 定稿后的盔顶冠羽），
  // 共享 0.12 边距即可（不需要炮车那样为抬起的炮管预留的大边距）。
  'iron-guard': 0.345 + COMBAT.healthBarMarginY,
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
  'pirate-ship->cannon': COMBAT.pirateShellDamage,
  'bombardier->cannon': 10,
  'ornithopter->cannon': 6,
  // Boss Islewrath gun turrets (task 029). The `islewrath-turret` core
  // unitType is a damage-matrix key, deliberately distinct from the
  // UNIT_TYPES sheet key `boss_islewrath` (underscore) — never look rows up
  // by the sheet key.
  'islewrath-turret->cannon': 20,
  // Boss Islewrath turret incoming rows (task 028/031): a city cannon shell
  // chips a flat 2% of the turret's 100-point pool.
  'cannon->islewrath-turret': 2,
  // Pirate chief head (task 031): every defender shell chips a flat 2% of
  // its 100-point pool.
  'cannon->islewrath-chief': 2,
  // 钢铁卫士（iron-guard）：普通攻击者承伤固定 2% —— 一发只扣 2%。
  // boss 炮塔单独一行 0.2（boss 伤害 90% 减免，2026-11-01；boss 本就无视
  // 嘲讽——FreeLockTargetSystem 均匀随机索敌，不读 Taunt）。
  'pirate-ship->iron-guard': 2,
  'bombardier->iron-guard': 2,
  'ornithopter->iron-guard': 2,
  'islewrath-turret->iron-guard': 0.2,
};

/**
 * Bombardier cruise altitude, explicit designer data (one-cannon plan,
 * 2026-10-30): previously derived from the cannon's 45° apex, which would
 * drift with the retuned shellSpeed — the flyer's berth band and firing
 * geometry are tuned against this plane, so it is pinned instead of
 * re-derived. Value equals the last derived runtime result (v0 7.45 era).
 * Under the drag-loaded v0 12 lob the band stays bracketed: the near stop
 * takes the steepest lobs, the far stop a comfortable ~40-52° arc through
 * the core.
 */
export const FLYER_Y = 2.857;

/**
 * The bombardier's berth band, shifted 1.5 m out with the ship band: far out
 * at -6.2, near end at -4.65 (2026-11-14 推远后近停仰角变缓，炮口到目标的
 * 水平距离变长). MIN < MAX keeps the ship constants' reading — MIN far out,
 * MAX against the wall.
 */
export const FLYER_STOP_Z_MIN = -6.2;
export const FLYER_STOP_Z_MAX = -4.65;

/**
 * Ornithopter flight envelope. The middle-air band sits below the
 * bombardier's cruise plane but inside the city cannons' reach. The whole
 * band shifted 1.5 m out with the ship band (2026-11-14): far stop -6.75,
 * near stop -4.8, 1.95 m of depth — enough for the 6-unit cap at
 * STOP_MIN_GAP_Z = 1.5, still well inside the widened cannon reach.
 */
export const ORNITHOPTER = {
  /** Cruise altitude (m) — the unit's object-origin height. */
  y: 2.3,
  /** Berth band: far out at -6.75, nearest at -4.8. */
  stopZMin: -6.75,
  stopZMax: -4.8,
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
 * every turret is gone, the chief rises at the laser pivot and attacks the
 * wall with the chief death light (see DEATH_LIGHT).
 */
export const BOSS = {
  /** Straight-run berth point: centre line, 2 m beyond the ocean midpoint —
   * pushed out with the rest of the berth band. */
  targetX: 0,
  targetZ: OCEAN.centerZ - 0.5,
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
  /**
   * Hit-core radius (m) of a gun turret (baked hit_core helper).
   * boss 整体 1.5×：0.35 -> 0.525。
   */
  turretCoreRadius: 0.525,
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
  /**
   * Damage-corridor half-width (m) around the beam centre line. Applies to
   * collateral defenders only — the locked core always takes the hit.
   */
  laserDamageRadius: 0.35,
  /**
   * Fraction of the natural aim drop removed for a flatter bearing. This is
   * the authored cannon bearing (0 aims dead-on, 1 is fully level) — leave it
   * alone when a hull resize shifts the muzzle. Hit reliability is owned by
   * `lockedCoreIndex` in the damage pass, not by this angle.
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
 * stood; it takes 2% per defender hit (DAMAGE_MATRIX rows) and attacks the
 * defence itself through the chief death light (DEATH_LIGHT below) — the
 * ChiefDeathLightSystem owns that state machine, BossChiefSystem only mounts
 * the head and runs its rise.
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
  /**
   * Hit-core radius (m) of the head (baked hit_core helper).
   * boss 整体 1.5×：0.3 -> 0.45。
   */
  coreRadius: 0.45,
  /** Death-burst size ratio over the shared debris pool (turret-scale, smaller). */
  burstRatio: 0.3,
  /** Carrier-LOCAL rest height of the burst chunks (deck bounce, like turrets). */
  burstFloorY: -0.15,
};

/**
 * Chief death light (铁头死光, task 03) — the phase-two chief head's own
 * attack, run entirely by ChiefDeathLightSystem. The head never rotates for
 * it except the sweep's own yaw. Two attacks off one beat clock:
 *
 * - LIGHTNING (死光闪电): every `intervalSec` after the rise completes (the
 *   first beat fires at once), a jagged bolt snaps instantly between the
 *   chief's hit core and one random surviving defender core, deducting
 *   `damageRatio` of the victim's MAX Health. The bolt shows for
 *   `boltLifeSec` (pure fx — ChiefDeathLightFxSystem), no growth animation.
 * - SWEEP (死光扫射): every `sweepEveryBeats`-th beat (intervalSec x 4 = 12 s
 *   after the rise) replaces the lightning: the head yaws to one end of the
 *   wall, holds `aimHoldSec`, the red beam forms over `formSec` (no charge
 *   up), then sweeps across ALL five defense slots over `sweepSec` — a yaw
 *   arc tracking a point level with the mounted units' core centres (flat,
 *   barely dipping — the beam grazes the rampart line without digging into
 *   the wall). Every live defender core the beam crosses loses
 *   `sweepDamageRatio` of its MAX Health, once per unit per sweep. The beat
 *   count restarts when the sweep ends: the next lightning comes
 *   `intervalSec` after the sweep finishes.
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
  /**
   * Sweep aim line: the beam tracks a point on the wall's SEA face level
   * with the mounted units' core centres — flat, barely dipping, so the
   * graze never digs into the wall masonry — while its x walks the slot row
   * past both end slots (x ±1.2 plus a margin).
   */
  sweepAimY: 1.05,
  sweepSpanX: 1.35,
  /** Beam reach multiplier over the origin-to-aim distance (blows past the
   *  wall face like the boss laser's own boost). */
  beamLengthBoost: 1.2,
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
    // 整体 1.5（2026-11-14）：洋面放宽后 boss 相对过小，整体放大。
    scale: 1.5,
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
};
