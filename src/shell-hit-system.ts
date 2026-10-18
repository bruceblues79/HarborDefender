/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createSystem, Object3D, Vector3 } from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';
import {
  BallisticFlight,
  Destroyed,
  GamePaused,
  Health,
  HitCore,
  HitFlash,
  HitFlashTag,
  LevelDirector,
  ShellFaction,
  ShellTag,
  SplashFade,
  WakeSource,
} from './components.js';
import { COMBAT, OCEAN } from './level-config.js';

/**
 * Distance-based hit resolution between airborne shells and combatants'
 * hit cores. A shell whose faction differs from a core's is consumed the
 * moment its centre comes within the core radius: flight and faction tags
 * are removed and the mesh hides, returning the shell to the shared pool
 * exactly like a splash-down — but no water ripple is spawned, because the
 * ball struck a solid target. Instead a pooled hit-flash sphere blooms at
 * the struck core's centre — not the contact point, which sits inside the
 * core radius and reads as a dented hull edge rather than a clean hit.
 *
 * The hit also deals damage to the core's Health: a defender shell costs
 * COMBAT.shellDamage, a pirate shell COMBAT.pirateShellDamage. At zero the
 * unit dies — an attacker sinks (entity disposed, a splash ripple marks the
 * spot on the surface) and a defender cannon is tagged Destroyed (hidden,
 * out of every combat query; LevelWaveSystem reads the tags for defeat).
 *
 * Runs after BallisticSystem so each frame's motion is tested at its end
 * position. Hits are collected during the sweep and resolved afterwards.
 */
export class ShellHitSystem extends createSystem({
  shells: { required: [ShellTag, BallisticFlight, ShellFaction] },
  cores: { required: [HitCore, Health], excluded: [Destroyed] },
  freeFlashes: { required: [HitFlashTag], excluded: [HitFlash] },
  directors: { required: [LevelDirector] },
}) {
  /** hit_core node per core entity index, resolved once on qualify. */
  private readonly coreNodes = new Map<number, Object3D>();
  /** Reusable world position per core; allocated on qualify, never in update. */
  private readonly corePositions = new Map<number, Vector3>();
  /** Shells consumed this frame; resolved after the sweep, not inside it. */
  private readonly hit: Entity[] = [];
  /** Core entity per `hit` entry; its cached position feeds the flash. */
  private readonly hitCores: Entity[] = [];
  /** Peak scale per `hit` entry: defender cores at base size, ships larger. */
  private readonly hitPeakScales: number[] = [];
  /** Damage per `hit` entry, read from the shell's faction. */
  private readonly hitDamages: number[] = [];
  /** Flashes handed out this frame; the free-flash query refreshes next frame. */
  private readonly claimedFlashes = new Set<number>();

  init(): void {
    this.queries.cores.subscribe('qualify', (entity) => {
      const node = entity.object3D?.getObjectByName('hit_core');
      if (!node) return;
      this.coreNodes.set(entity.index, node);
      this.corePositions.set(entity.index, new Vector3());
    });
    // A sunk ship (or hidden cannon) leaves the query — drop its cached
    // world position so the maps never pin a disposed object.
    this.queries.cores.subscribe('disqualify', (entity) => {
      this.coreNodes.delete(entity.index);
      this.corePositions.delete(entity.index);
    });
  }

  /** True while the pause-menu tag sits on the director entity. */
  private paused(): boolean {
    for (const director of this.queries.directors.entities) {
      return director.hasComponent(GamePaused);
    }
    return false;
  }

  update(): void {
    if (this.paused()) return;
    this.hit.length = 0;
    this.hitCores.length = 0;
    this.hitPeakScales.length = 0;
    this.hitDamages.length = 0;
    this.claimedFlashes.clear();

    // Core world positions once per frame (pirate ships yaw after stopping).
    for (const [index, node] of this.coreNodes) {
      node.getWorldPosition(this.corePositions.get(index)!);
    }

    for (const shell of this.queries.shells.entities) {
      const shellObject = shell.object3D;
      if (!shellObject) continue;
      const faction = String(shell.getValue(ShellFaction, 'faction'));
      const sx = shellObject.position.x;
      const sy = shellObject.position.y;
      const sz = shellObject.position.z;
      for (const core of this.queries.cores.entities) {
        if (String(core.getValue(HitCore, 'faction')) === faction) continue;
        const position = this.corePositions.get(core.index);
        if (!position) continue;
        const radius = Number(core.getValue(HitCore, 'radius'));
        const dx = sx - position.x;
        const dy = sy - position.y;
        const dz = sz - position.z;
        if (dx * dx + dy * dy + dz * dz <= radius * radius) {
          this.hit.push(shell);
          this.hitCores.push(core);
          // Ship cores bloom larger than harbour-cannon cores; the shared
          // pool geometry is the defender size, so scale is a ratio.
          this.hitPeakScales.push(
            faction === 'attacker' // a pirate shell struck a defender core
              ? 1
              : COMBAT.hitFlashShipRadius / COMBAT.hitFlashRadius,
          );
          this.hitDamages.push(
            faction === 'defender'
              ? COMBAT.shellDamage
              : COMBAT.pirateShellDamage,
          );
          break;
        }
      }
    }

    for (let i = 0; i < this.hit.length; i++) {
      const shell = this.hit[i];
      // BallisticSystem may have recycled it this same frame; never double-remove.
      if (!shell.hasComponent(BallisticFlight)) continue;
      shell.removeComponent(BallisticFlight);
      shell.removeComponent(ShellFaction);
      const core = this.hitCores[i];
      const corePosition = this.corePositions.get(core.index);
      if (shell.object3D && corePosition) {
        // Bloom at the struck core's centre: positions were refreshed at the
        // top of this frame, so the map is current for every hit this sweep.
        this.spawnHitFlash(corePosition, this.hitPeakScales[i]);
        shell.object3D.visible = false;
      }
      this.applyDamage(core, this.hitDamages[i]);
    }
  }

  /**
   * Charge one hit of damage. At zero health the unit dies: an attacker's
   * hull is disposed (its materials are per-ship clones) and a splash ripple
   * marks the sinking spot; a defender cannon is tagged Destroyed and hidden
   * — the tag, not a component strip, takes it out of every combat query.
   */
  private applyDamage(core: Entity, damage: number): void {
    const hp = Number(core.getValue(Health, 'current')) - damage;
    core.setValue(Health, 'current', Math.max(0, hp));
    if (hp > 0) return;
    if (String(core.getValue(HitCore, 'faction')) === 'attacker') {
      const at = this.corePositions.get(core.index);
      if (at) this.spawnSinkRipple(at.x, at.z);
      // Keep the shared prototype resources alive: ships are prototype
      // clones, and the default resource sweep would free geometry/materials/
      // textures every later spawn clones from.
      core.dispose({ disposeResources: false });
    } else {
      core.addComponent(Destroyed);
      if (core.object3D) core.object3D.visible = false;
    }
  }

  /**
   * Claim a free pooled flash and land its starting state at the struck
   * core's centre: position, start scale, visible, then the HitFlash tag
   * that hands animation to HitFlashSystem. Pool empty: skip silently — a
   * busy battle loses the odd bloom, never a hit.
   */
  private spawnHitFlash(position: Vector3, peakScale: number): void {
    for (const flash of this.queries.freeFlashes.entities) {
      if (this.claimedFlashes.has(flash.index)) continue;
      // Live guard: another spawn this frame may have claimed it already,
      // since the free-flash query only refreshes next frame.
      if (flash.hasComponent(HitFlash)) continue;
      this.claimedFlashes.add(flash.index);
      const object = flash.object3D;
      if (!object) return;
      object.position.copy(position);
      object.scale.setScalar(COMBAT.hitFlashStartScale * peakScale);
      object.visible = true;
      flash.addComponent(HitFlash, {
        duration: COMBAT.hitFlashDuration,
        peakScale,
      });
      return;
    }
  }

  /**
   * Surface ripple where a ship went down — the same pooled-splash pattern
   * BallisticSystem uses for splash-downs; SplashSystem owns the fade-out.
   * The hull itself is disposed, so the ripple is the sinking's only trace.
   */
  private spawnSinkRipple(x: number, z: number): void {
    const ripple = new Object3D();
    ripple.position.set(x, OCEAN.surfaceY, z);
    this.world
      .createTransformEntity(ripple)
      .addComponent(WakeSource, {
        strength: 1,
        targetStrength: 1,
        radius: COMBAT.splashRadius,
        targetRadius: COMBAT.splashRadius,
        amplitude: COMBAT.splashAmplitude,
        frequency: COMBAT.splashFrequency,
        speed: COMBAT.splashSpeed,
      })
      .addComponent(SplashFade, { duration: COMBAT.splashDuration });
  }
}
