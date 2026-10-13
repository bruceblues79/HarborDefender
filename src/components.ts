/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createComponent, defineComponents } from '@iwsdk/core';

/** Marks the ocean body entity so OceanSystem can find it via query. */
export const OceanTag = createComponent('OceanTag', {});

export default defineComponents([OceanTag]);
