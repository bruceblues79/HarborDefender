/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  createSystem,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';
import {
  GameOver,
  GamePaused,
  Health,
  HideHealthBar,
  HitCore,
  LevelDirector,
} from './components.js';
import { COMBAT } from './level-config.js';

/**
 * World-space health bars for every combat unit (pirate ships, city cannons).
 *
 * Ownership: `Health` stays the single truth — this system is a pure view.
 * Each `Health` carrier qualifies with a rig built as a *child* of the unit's
 * object, so following the unit costs nothing; a `disqualify` (sunk ship)
 * disposes only the rig's per-unit material clones, never the shared geometry.
 *
 * Billboard: the rig yaws toward the camera every frame. Because the rig is a
 * child of a unit that itself yaws (sailing ships, traversing cannons), the
 * local quaternion composes the desired world yaw with the inverse of the
 * parent's world rotation — the same end result as BillboardSystem's
 * root-level math, which cannot be reused here (it writes local rotation,
 * correct only for scene-root entities). Yaw-only, like `Billboard(lockY)`:
 * bars stay upright and readable under the orbiting browser camera and in XR.
 *
 * Fill: the green quad's geometry is pre-translated so its origin sits on its
 * left edge; `scale.x = current / max` shrinks it from the right while the
 * left edge stays pinned, exposing the red back plate.
 *
 * Fade: rig materials are per-unit clones of the module templates, so
 * SpawnFadeSystem's hull traverse drives the bar's opacity in lockstep with
 * the ship it belongs to, and concurrent ship fades never cross-talk.
 */

const WIDTH = COMBAT.healthBarWidth;
const HEIGHT = COMBAT.healthBarHeight;

/** Shared back-plate geometry — a plain centred quad. */
const backGeometry = new PlaneGeometry(WIDTH, HEIGHT);
/**
 * Shared fill geometry, origin moved to its left edge so scale.x shrinks the
 * green toward the left rim instead of toward the centre.
 */
const fillGeometry = new PlaneGeometry(WIDTH, HEIGHT);
fillGeometry.translate(WIDTH / 2, 0, 0);

/**
 * Material templates. Per-unit clones keep SpawnFade's per-ship opacity ramp
 * isolated; `toneMapped: false` keeps the status colours exact under the
 * scene's tone mapping, like any other unlit UI surface.
 */
const backMaterial = new MeshBasicMaterial({
  color: COMBAT.healthBarBackColor,
  transparent: true,
  depthWrite: false,
  side: DoubleSide,
  toneMapped: false,
});
const fillMaterial = new MeshBasicMaterial({
  color: COMBAT.healthBarFillColor,
  transparent: true,
  depthWrite: false,
  side: DoubleSide,
  toneMapped: false,
});

/**
 * Transparent draw order: the fill must paint after its own back plate, and
 * both must stay under the hit-flash bloom (renderOrder 10) so a flash
 * blooming at a core never reads as dimmed by a bar above it. The menu UI
 * (call button / pause menu) renders at 20 — uikit surfaces are
 * depthWrite-off like these bars, so draw order alone decides, and a bar
 * crossing the call button in flight must never cover the UI. The panel-up
 * gate below hides the bars for full-screen panels; the call button shows
 * during battle, so only its render-order keeps the layering right.
 */
const BACK_RENDER_ORDER = 8;
const FILL_RENDER_ORDER = 9;
/** Fill sits a hair in front of the back plate — no z-fighting. */
const FILL_Z_OFFSET = 0.002;

export class HealthBarSystem extends createSystem({
  // Carriers may suppress their bar with the explicit HideHealthBar tag —
  // the mechanism stays available for special units (e.g. a part whose bar
  // would visually double a hull bar it belongs to).
  units: { required: [Health], excluded: [HideHealthBar] },
  directors: { required: [LevelDirector] },
}) {
  /** health-bar rig per unit entity index; the unit object is its parent. */
  private readonly rigs = new Map<number, Object3D>();
  /** Green fill mesh per unit entity index; scale.x carries the ratio. */
  private readonly fills = new Map<number, Mesh>();
  // Pre-allocated math scratch — update() never allocates.
  private readonly viewer = new Vector3();
  private readonly rigWorld = new Vector3();
  private readonly parentWorldQuat = new Quaternion();
  private readonly yawQuat = new Quaternion();
  private readonly up = new Vector3(0, 1, 0);

  init(): void {
    this.queries.units.subscribe('qualify', (entity) => {
      const unit = entity.object3D;
      if (!unit) return;
      // Per-faction sizing: cannons draw smaller and float higher than the
      // shared default — the defender margin is baked into their barY.
      const defender =
        String(entity.getValue(HitCore, 'faction')) === 'defender';
      // Head height: the carrier's explicit local barY — unit-sheet data for
      // hulls (measured GLB top + margin), baked-geometry constants for boss
      // armour parts. No bounding-box derivation: a deep child spawned
      // mid-frame reads a stale ancestor matrixWorld and floats the bar.
      const rig = new Object3D();
      rig.name = 'health-bar';
      rig.position.y = Number(entity.getValue(Health, 'barY'));
      rig.scale.setScalar(
        defender ? COMBAT.healthBarDefenderScale : 1,
      );

      const back = new Mesh(backGeometry, backMaterial.clone());
      back.renderOrder = BACK_RENDER_ORDER;
      const fill = new Mesh(fillGeometry, fillMaterial.clone());
      fill.renderOrder = FILL_RENDER_ORDER;
      fill.position.set(-WIDTH / 2, 0, FILL_Z_OFFSET);
      for (const mesh of [back, fill]) {
        // Status quads cast no shadow; userData.skipShadow opts them out of
        // SpawnFadeSystem's fade-end castShadow sweep as well.
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        mesh.userData.skipShadow = true;
      }
      rig.add(back, fill);
      unit.add(rig);

      this.rigs.set(entity.index, rig);
      this.fills.set(entity.index, fill);
      fill.scale.x = this.fillRatio(entity);
    });
    // A sunk ship (or any Health loss) leaves the query: drop the cache and
    // dispose the rig's cloned materials. The shared geometry/templates must
    // survive — later units clone from them again (ships are prototype
    // clones disposed with disposeResources: false, which frees nothing).
    this.queries.units.subscribe('disqualify', (entity) => {
      const rig = this.rigs.get(entity.index);
      if (rig) {
        for (const child of rig.children) {
          // Bar meshes carry exactly one material each (single, not array).
          ((child as Mesh).material as MeshBasicMaterial).dispose();
        }
        rig.removeFromParent();
      }
      this.rigs.delete(entity.index);
      this.fills.delete(entity.index);
    });
  }

  update(): void {
    // Panel gate: while the START panel, pause menu or result panel owns the
    // screen, the bars hide entirely — the director entity is the single
    // truth, and hiding the rigs sidesteps every transparent draw-order
    // conflict with the panels instead of fighting renderOrder.
    const panelsUp = this.panelsUp();
    this.world.camera.getWorldPosition(this.viewer);
    for (const entity of this.queries.units.entities) {
      const rig = this.rigs.get(entity.index);
      const fill = this.fills.get(entity.index);
      if (!rig || !fill) continue;
      rig.visible = !panelsUp;
      if (panelsUp) continue;
      fill.scale.x = this.fillRatio(entity);

      const parent = rig.parent;
      if (!parent) continue;
      // World yaw toward the viewer, recomposed into the unit's local space:
      // local = parentWorld⁻¹ × worldYaw. getWorld* refresh ancestor matrices
      // first, so the yaw tracks this frame's movement and camera alike.
      parent.getWorldQuaternion(this.parentWorldQuat).invert();
      rig.getWorldPosition(this.rigWorld);
      this.yawQuat.setFromAxisAngle(
        this.up,
        Math.atan2(
          this.viewer.x - this.rigWorld.x,
          this.viewer.z - this.rigWorld.z,
        ),
      );
      rig.quaternion.copy(this.parentWorldQuat).multiply(this.yawQuat);
    }
  }

  /** True while a blocking panel (START / pause menu / result) is on screen. */
  private panelsUp(): boolean {
    for (const director of this.queries.directors.entities) {
      return (
        director.hasComponent(GamePaused) ||
        director.hasComponent(GameOver) ||
        String(director.getValue(LevelDirector, 'phase')) === 'waiting-start'
      );
    }
    return false;
  }

  /** Remaining health as 0..1, clamped — the fill's scale.x. */
  private fillRatio(entity: Entity): number {
    const current = Number(entity.getValue(Health, 'current'));
    const max = Number(entity.getValue(Health, 'max'));
    return max > 0 ? Math.min(1, Math.max(0, current / max)) : 0;
  }
}
