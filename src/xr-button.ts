/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { VisibilityState } from '@iwsdk/core';
import type { World } from '@iwsdk/core';

/**
 * Classic three.js-style XR entry button as a DOM overlay pinned to the
 * top-center of the screen (the same role as three/examples VRButton).
 *
 * IWSDK does not ship a runtime DOM button: `xr.offer` relies on the
 * Horizon-Browser-only navigator.xr.offerSession(), which is a no-op on
 * desktop/mobile/PICO browsers. This element uses the standard
 * requestSession path via world.launchXR(), so it works on every
 * WebXR-capable platform (Quest, PICO, IWER emulation).
 *
 * Following the VRButton convention the button always renders: it stays
 * disabled and greyed out while the support probe runs and when WebXR or
 * the configured session mode is unavailable, keeping the same label
 * throughout.
 */
export function installXRButton(world: World): void {
  const button = document.createElement('button');
  button.id = 'iwsdk-xr-button';
  button.textContent = 'ENTER XR';
  button.disabled = true;
  Object.assign(button.style, {
    position: 'fixed',
    top: '16px',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: '999',
    padding: '10px 18px',
    border: '1px solid rgba(255, 255, 255, 0.85)',
    borderRadius: '6px',
    background: 'rgba(0, 0, 0, 0.55)',
    color: '#ffffff',
    font: '600 14px/1 system-ui, sans-serif',
    letterSpacing: '0.5px',
    cursor: 'default',
    opacity: '0.4',
    touchAction: 'manipulation',
    transition: 'opacity 0.15s ease',
  } satisfies Partial<CSSStyleDeclaration>);

  button.addEventListener('click', () => {
    if (world.session != null) {
      world.exitXR();
    } else if (!world.sessionRequestPending) {
      world.launchXR();
    }
  });
  button.addEventListener('pointerenter', () => {
    if (!button.disabled) button.style.opacity = '1';
  });
  button.addEventListener('pointerleave', () => {
    if (!button.disabled) button.style.opacity = '0.85';
  });

  const enable = (): void => {
    button.disabled = false;
    button.style.opacity = '0.85';
    button.style.cursor = 'pointer';
    world.visibilityState.subscribe((visibilityState) => {
      const immersive = visibilityState !== VisibilityState.NonImmersive;
      button.textContent = immersive ? 'EXIT XR' : 'ENTER XR';
    });
  };

  const mode = world.xrDefaults?.sessionMode ?? 'immersive-vr';
  const probe: Promise<boolean> = navigator.xr
    ? navigator.xr.isSessionSupported(mode)
    : Promise.resolve(false);
  probe
    .then((supported) => {
      // Unsupported platforms keep the same label, just greyed out.
      if (supported) enable();
    })
    .catch(() => {
      // Probe rejected: treat as unsupported and stay greyed out.
    });

  document.body.appendChild(button);
}
