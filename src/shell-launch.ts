/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { Vector3 } from '@iwsdk/core';

/**
 * Closed-form intercept for a guaranteed-hit lobbed shell, shared by every
 * attacker gun (pirate deck cannon, boss turrets): with constant horizontal
 * speed v, flight time tau = d / v and
 *   vy = (ty - my) / tau + 0.5 * g * tau
 * makes the shell arrive exactly at (tx, ty, tz) under BallisticSystem's
 * gravity. Writes the velocity into `out` and returns the flight time, or
 * -1 when the muzzle sits directly over the target (no direction to solve).
 */
export function solveIntercept(
  muzzlePos: Vector3,
  targetX: number,
  targetY: number,
  targetZ: number,
  horizontalSpeed: number,
  gravity: number,
  out: { vx: number; vy: number; vz: number },
): number {
  const dx = targetX - muzzlePos.x;
  const dz = targetZ - muzzlePos.z;
  const horizontal = Math.hypot(dx, dz);
  if (horizontal < 1e-6) return -1;
  const tau = horizontal / horizontalSpeed;
  out.vx = dx / tau;
  out.vy = (targetY - muzzlePos.y) / tau + 0.5 * gravity * tau;
  out.vz = dz / tau;
  return tau;
}
