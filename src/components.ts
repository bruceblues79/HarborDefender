/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createComponent, defineComponents } from '@iwsdk/core';

/** Marks the ocean body entity so OceanSystem can find it via query. */
export const OceanTag = createComponent('OceanTag', {});

/**
 * Marks an entity as a source of concentric wake ripples on the ocean.
 * OceanSystem feeds active sources into the ocean shader's uniform array.
 * Toggle `active` to turn ripples on (sailing) or off (anchored / stopped).
 * Works for ships, shells, or any object that should disturb the surface.
 */
export const WakeSource = createComponent('WakeSource', {
  /** Whether this source currently produces ripples. */
  active: { type: 'Boolean', default: true },
  /** Radius (m) of the ripple's influence on the surface. */
  radius: { type: 'Float32', default: 2.0 },
  /** Peak-to-peak wave height (m) at the centre of the ripple. */
  amplitude: { type: 'Float32', default: 0.015 },
  /** Spatial frequency of the concentric rings (waves per metre). */
  frequency: { type: 'Float32', default: 15.0 },
  /** How fast the rings travel outward (m/s). */
  speed: { type: 'Float32', default: 3.0 },
});

export default defineComponents([OceanTag, WakeSource]);
