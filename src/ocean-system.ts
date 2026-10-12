/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createSystem } from '@iwsdk/core';
import type { Mesh, ShaderMaterial } from '@iwsdk/core';

export class OceanSystem extends createSystem({}) {
  private oceanMesh: Mesh | null = null;

  setOceanMesh(mesh: Mesh): void {
    this.oceanMesh = mesh;
  }

  update(_delta: number, time: number): void {
    if (this.oceanMesh) {
      const mat = this.oceanMesh.material as ShaderMaterial;
      mat.uniforms.time.value = time;
    }
  }
}
