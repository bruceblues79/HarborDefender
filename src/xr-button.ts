/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { VisibilityState } from '@iwsdk/core';
import type { World } from '@iwsdk/core';

/**
 * Classic three.js-style XR entry button as a DOM corner overlay
 * (the same role as three/examples VRButton/XRButton).
 *
 * IWSDK does not ship a runtime DOM button: `xr.offer` relies on the
 * Horizon-Browser-only navigator.xr.offerSession(), which is a no-op on
 * desktop/mobile/PICO browsers. This element uses the standard
 * requestSession path via world.launchXR(), so it works on every
 * WebXR-capable platform (Quest, PICO, IWER emulation).
 *
 * The button is only appended when the configured session mode is
 * supported, so unsupported browsers show nothing.
 */
export function installXRButton(world: World): void {
  const xr = navigator.xr;
  if (!xr) return;

  const mode = world.xrDefaults?.sessionMode ?? 'immersive-vr';
  xr.isSessionSupported(mode)
    .then((supported) => {
      if (!supported) return;

      const button = document.createElement('button');
      button.id = 'iwsdk-xr-button';
      button.textContent = 'ENTER XR';
      Object.assign(button.style, {
        position: 'fixed',
        right: '20px',
        bottom: '20px',
        zIndex: '999',
        padding: '10px 18px',
        border: '1px solid rgba(255, 255, 255, 0.85)',
        borderRadius: '6px',
        background: 'rgba(0, 0, 0, 0.55)',
        color: '#ffffff',
        font: '600 14px/1 system-ui, sans-serif',
        letterSpacing: '0.5px',
        cursor: 'pointer',
        opacity: '0.85',
        touchAction: 'manipulation',
        transition: 'opacity 0.15s ease',
      } satisfies Partial<CSSStyleDeclaration>);
      button.addEventListener(
        'pointerenter',
        () => {
          button.style.opacity = '1';
        },
      );
      button.addEventListener(
        'pointerleave',
        () => {
          button.style.opacity = '0.85';
        },
      );

      button.addEventListener('click', () => {
        if (world.session != null) {
          world.exitXR();
        } else if (!world.sessionRequestPending) {
          world.launchXR();
        }
      });

      world.visibilityState.subscribe((visibilityState) => {
        const immersive =
          visibilityState !== VisibilityState.NonImmersive;
        button.textContent = immersive ? 'EXIT XR' : 'ENTER XR';
      });

      document.body.appendChild(button);
    })
    .catch(() => {
      // Probe rejected: treat as unsupported and stay hidden.
    });
}
