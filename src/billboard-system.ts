/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createSystem, Vector3 } from '@iwsdk/core';
import { Billboard } from './components.js';

/**
 * Yaws billboard entities so their +Z face looks at the viewer, without moving them.
 * UIKitML panels are single-sided and face +Z, so `atan2(dx, dz)` needs no 180° term.
 * Registered in the UI tier after the camera update, so it tracks this frame's viewpoint.
 */
export class BillboardSystem extends createSystem({
  billboards: { required: [Billboard] },
}) {
  private readonly viewer = new Vector3();
  private readonly anchor = new Vector3();

  update(): void {
    this.world.camera.getWorldPosition(this.viewer);
    for (const entity of this.queries.billboards.entities) {
      const object = entity.object3D;
      if (!object) continue;
      object.getWorldPosition(this.anchor);
      if (entity.getValue(Billboard, 'lockY')) {
        object.rotation.set(
          0,
          Math.atan2(this.viewer.x - this.anchor.x, this.viewer.z - this.anchor.z),
          0,
        );
      } else {
        object.lookAt(this.viewer);
      }
    }
  }
}
