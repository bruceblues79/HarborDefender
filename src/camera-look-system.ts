/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createSystem, VisibilityState } from '@iwsdk/core';

/**
 * Browser-mode camera look-around system.
 *
 * Camera is fixed at the position configured in iwsdk.config.json
 * (0, 1.5, 0). Dragging with pointer (mouse/touch) rotates yaw and
 * pitch to simulate looking around from a standing position.
 * Automatically disabled during XR sessions.
 */
export class CameraLookSystem extends createSystem({}) {
  private yaw = 0;
  private pitch = 0;
  private isDragging = false;
  private lastX = 0;
  private lastY = 0;

  init(): void {
    const canvas = this.world.renderer.domElement;
    canvas.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);

    this.cleanupFuncs.push(
      () => canvas.removeEventListener('pointerdown', this.onPointerDown),
      () => window.removeEventListener('pointermove', this.onPointerMove),
      () => window.removeEventListener('pointerup', this.onPointerUp),
    );
  }

  private onPointerDown = (e: PointerEvent): void => {
    this.isDragging = true;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.isDragging) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.yaw -= dx * 0.005;
    this.pitch -= dy * 0.005;
    // Clamp pitch to avoid gimbal lock flip
    this.pitch = Math.max(
      -Math.PI / 2 + 0.1,
      Math.min(Math.PI / 2 - 0.1, this.pitch),
    );
    this.lastX = e.clientX;
    this.lastY = e.clientY;
  };

  private onPointerUp = (): void => {
    this.isDragging = false;
  };

  update(): void {
    if (this.world.visibilityState.peek() !== VisibilityState.NonImmersive) {
      return;
    }
    const camera = this.world.camera;
    camera.rotation.order = 'YXZ';
    camera.rotation.y = this.yaw;
    camera.rotation.x = this.pitch;
  }
}
