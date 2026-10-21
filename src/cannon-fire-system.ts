/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  AssetManager,
  createSystem,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
  Vector3,
} from '@iwsdk/core';
import type { Entity, Object3D } from '@iwsdk/core';
import {
  BallisticFlight,
  BoltTag,
  CannonFire,
  Destroyed,
  GameOver,
  GamePaused,
  LevelDirector,
  ShellFaction,
  ShellTag,
} from './components.js';
import { COMBAT } from './level-config.js';

/**
 * Owns the shared projectile pools and the cannons' fire rhythm.
 *
 * Pools: `COMBAT.shellPoolSize` cannonballs created synchronously at init,
 * plus `COMBAT.boltPoolSize` straight ballista bolts cloned from the
 * ballista-bolt glb once it loads (until then that pool is simply empty and
 * fire() retries shortly). All copies share geometry/materials and carry
 * ShellTag; bolts additionally carry BoltTag, which routes them to their own
 * free query so a ball-firing gun can never grab a bolt mesh and vice versa.
 * A projectile is free exactly while it does not carry BallisticFlight.
 * Firing never allocates — it repositions a free projectile at the muzzle
 * and hands it to BallisticSystem by adding BallisticFlight.
 *
 * The muzzle is the `muzzle` child battle-setup hangs under each cannon's
 * gun_rotate pivot, so the launch direction always follows the current aim.
 */
export class CannonFireSystem extends createSystem({
  cannons: { required: [CannonFire], excluded: [Destroyed] },
  freeShells: { required: [ShellTag], excluded: [BallisticFlight, BoltTag] },
  freeBolts: {
    required: [ShellTag, BoltTag],
    excluded: [BallisticFlight],
  },
  airborne: { required: [ShellTag, BallisticFlight] },
  directors: { required: [LevelDirector] },
}) {
  /** Muzzle object per cannon entity index, resolved once on qualify. */
  private readonly muzzles = new Map<number, Object3D>();
  /** Shells handed out this frame; the free-shell query only refreshes next frame. */
  private readonly claimed = new Set<number>();
  /** Snapshot buffer for bulk recall; allocated once, reused per call. */
  private readonly retiring: Entity[] = [];
  private readonly muzzlePos = new Vector3();
  private readonly muzzleDir = new Vector3();
  /** lookAt target for bolt alignment; allocated once, reused per shot. */
  private readonly boltAim = new Vector3();

  init(): void {
    const geometry = new SphereGeometry(COMBAT.shellRadius, 8, 6);
    const material = new MeshStandardMaterial({
      color: COMBAT.shellColor,
      metalness: 1,
      roughness: 0.6,
    });
    for (let i = 0; i < COMBAT.shellPoolSize; i++) {
      const shell = new Mesh(geometry, material);
      shell.castShadow = true;
      shell.visible = false;
      this.world.createTransformEntity(shell).addComponent(ShellTag);
    }
    // Bolt pool: clones of the vertex-coloured ballista-bolt glb (head along
    // its local +Z). Loads asynchronously — the pool starts empty and fire()
    // retries until the copies exist.
    AssetManager.loadGLTFById('ballista-bolt').then((gltf) => {
      for (let i = 0; i < COMBAT.boltPoolSize; i++) {
        const bolt = gltf.scene.clone();
        bolt.traverse((node) => {
          node.castShadow = true;
        });
        bolt.visible = false;
        this.world
          .createTransformEntity(bolt)
          .addComponent(ShellTag)
          .addComponent(BoltTag);
      }
    });
    this.queries.cannons.subscribe('qualify', (entity) => {
      const muzzle = entity.object3D?.getObjectByName('muzzle');
      if (muzzle) this.muzzles.set(entity.index, muzzle);
      // Roll the first cooldown too: the opening volley starts staggered.
      entity.setValue(CannonFire, 'cooldown', this.rollInterval(entity));
    });
  }

  update(delta: number): void {
    // Hold fire until the START gate opens: LevelDirector.phase is the single
    // truth for game flow. Cooldowns were rolled at mount time and tick only
    // once the level begins. GamePaused freezes the rhythm without touching
    // any cooldown value; GameOver holds it for good after the outcome.
    if (this.paused() || this.over() || !this.gameRunning()) return;
    this.claimed.clear();
    for (const entity of this.queries.cannons.entities) {
      let cooldown = Number(entity.getValue(CannonFire, 'cooldown')) - delta;
      if (cooldown <= 0) {
        // Pool empty: retry shortly instead of banking negative time, which
        // would burst several shells out the moment one comes back.
        cooldown = this.fire(entity) ? this.rollInterval(entity) : 0.1;
      }
      entity.setValue(CannonFire, 'cooldown', cooldown);
    }
  }

  /** Every cooldown is a fresh roll: the cannon's interval plus a jitter. */
  private rollInterval(cannon: Entity): number {
    return (
      Number(cannon.getValue(CannonFire, 'interval')) +
      COMBAT.fireJitterMin +
      Math.random() * (COMBAT.fireJitterMax - COMBAT.fireJitterMin)
    );
  }

  /** Launch one free projectile along the muzzle's world -Z. False when none is free. */
  private fire(cannon: Entity): boolean {
    const muzzle = this.muzzles.get(cannon.index);
    if (!muzzle) return false;
    const isBolt = Boolean(cannon.getValue(CannonFire, 'bolt'));
    const shell = isBolt ? this.firstFreeBolt() : this.firstFreeShell();
    const shellObject = shell?.object3D;
    if (!shell || !shellObject) return false;

    muzzle.getWorldPosition(this.muzzlePos);
    // Object3D.getWorldDirection returns +Z; the barrel fires down its -Z.
    muzzle.getWorldDirection(this.muzzleDir).negate();
    shellObject.position.copy(this.muzzlePos);
    if (isBolt) {
      // Straight bolt: point the mesh's modelled-forward +Z along the launch
      // direction so it flies nose-first; no spin, fins keep it stable.
      this.boltAim.copy(this.muzzlePos).add(this.muzzleDir);
      shellObject.lookAt(this.boltAim);
    }
    shellObject.visible = true;
    shell.addComponent(BallisticFlight, {
      vx: this.muzzleDir.x * COMBAT.shellSpeed,
      vy: this.muzzleDir.y * COMBAT.shellSpeed,
      vz: this.muzzleDir.z * COMBAT.shellSpeed,
      gravityScale: Number(cannon.getValue(CannonFire, 'gravityScale')),
    });
    // City batteries fight for the defender side; ShellHitSystem uses the
    // faction to pick consumable cores and the unit type to pick the damage
    // matrix row.
    shell.addComponent(ShellFaction, {
      faction: 'defender',
      unitType: String(cannon.getValue(CannonFire, 'unitType')),
    });
    return true;
  }

  /**
   * First pooled shell that is neither airborne nor already claimed this
   * frame. The live hasComponent check also guards against PirateFireSystem
   * claiming the same shell on this frame, since queries refresh next frame.
   */
  private firstFreeShell(): Entity | undefined {
    for (const shell of this.queries.freeShells.entities) {
      if (this.claimed.has(shell.index)) continue;
      if (shell.hasComponent(BallisticFlight)) continue;
      this.claimed.add(shell.index);
      return shell;
    }
    return undefined;
  }

  /** Same discipline as firstFreeShell, over the bolt pool. */
  private firstFreeBolt(): Entity | undefined {
    for (const bolt of this.queries.freeBolts.entities) {
      if (this.claimed.has(bolt.index)) continue;
      if (bolt.hasComponent(BallisticFlight)) continue;
      this.claimed.add(bolt.index);
      return bolt;
    }
    return undefined;
  }

  /** True once the START hand-off has moved the director past waiting-start. */
  private gameRunning(): boolean {
    for (const director of this.queries.directors.entities) {
      return (
        String(director.getValue(LevelDirector, 'phase')) !== 'waiting-start'
      );
    }
    return false;
  }

  /** True while the pause-menu tag sits on the director entity. */
  private paused(): boolean {
    for (const director of this.queries.directors.entities) {
      return director.hasComponent(GamePaused);
    }
    return false;
  }

  /** True once the run has ended (victory or defeat) — the guns fall silent. */
  private over(): boolean {
    for (const director of this.queries.directors.entities) {
      return director.hasComponent(GameOver);
    }
    return false;
  }

  /**
   * Recall every airborne shell to the pool (RESTART / MAIN reset): hide the
   * mesh and drop the flight + faction tags so the shell is free again. The
   * pool itself is never rebuilt.
   */
  recycleAirborneShells(): void {
    this.retiring.length = 0;
    for (const shell of this.queries.airborne.entities) {
      this.retiring.push(shell);
    }
    for (const shell of this.retiring) {
      shell.removeComponent(BallisticFlight);
      shell.removeComponent(ShellFaction);
      if (shell.object3D) shell.object3D.visible = false;
    }
  }
}
