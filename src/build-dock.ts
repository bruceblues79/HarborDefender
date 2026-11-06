/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { Entity } from '@iwsdk/core';
import { BuildOpen } from './components.js';

/**
 * The only write path for BuildOpen. BuildPanelSystem owns the dock and reads
 * the tag through its openDirectors query; the pad toggles it here, a level
 * reset and the panel itself close it here.
 */

export function closeBuildDock(director: Entity): void {
  director.removeComponent(BuildOpen);
}

/**
 * Closed opens at `slot`; open on the same slot closes; open on another slot
 * closes and reopens into it in one frame, so the panel sees disqualify (hide)
 * then qualify (reposition + reprice).
 */
export function toggleBuildDock(director: Entity, slot: number): void {
  if (!director.hasComponent(BuildOpen)) {
    director.addComponent(BuildOpen, { slot });
    return;
  }
  const openSlot = Number(director.getValue(BuildOpen, 'slot'));
  director.removeComponent(BuildOpen);
  if (openSlot !== slot) director.addComponent(BuildOpen, { slot });
}
