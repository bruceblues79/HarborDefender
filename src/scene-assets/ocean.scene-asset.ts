/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  BoxGeometry,
  Mesh,
  Object3D,
  ShaderMaterial,
} from '@iwsdk/core';

const vertexShader = `
uniform float time;
varying vec3 vWorldNormal;
varying vec3 vLocalNormal;
varying vec3 vWorldPosition;

void main() {
  vec3 pos = position;

  // Low-poly waves on the top surface only (y > 0 in local box space)
  if (pos.y > 0.0) {
    float wave1 = sin(pos.x * 3.75 + time * 1.2) * 0.02;
    float wave2 = sin(pos.z * 5.25 + time * 0.9) * 0.0125;
    float wave3 = sin((pos.x + pos.z) * 2.25 + time * 0.6) * 0.0075;
    pos.y += wave1 + wave2 + wave3;
  }

  vec4 worldPos = modelMatrix * vec4(pos, 1.0);
  vWorldPosition = worldPos.xyz;
  vWorldNormal = normalize(normalMatrix * normal);
  vLocalNormal = normal;
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const fragmentShader = `
uniform sampler2D envMap;
uniform float reflectivity;
varying vec3 vWorldNormal;
varying vec3 vLocalNormal;
varying vec3 vWorldPosition;

#define PI 3.14159265359

// ShaderMaterial bypasses the renderer's linear -> sRGB output conversion
// (renderer.outputColorSpace is SRGBColorSpace), so apply it manually here.
vec3 linearToSRGB(vec3 c) {
  c = max(c, vec3(0.0));
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec3 color;

  // Fake reflection only on the +y surface (the water top).
  // Sample with the view reflection vector so the sky texture visibly
  // shifts with the camera angle instead of staying a single color.
  if (vLocalNormal.y > 0.5) {
    vec3 viewDir = normalize(vWorldPosition - cameraPosition);
    vec3 reflDir = reflect(viewDir, normalize(vWorldNormal));
    float theta = atan(reflDir.z, reflDir.x);
    float phi   = acos(clamp(reflDir.y, -1.0, 1.0));
    vec2 uv = vec2(theta / (2.0 * PI) + 0.5, phi / PI);

    color = texture2D(envMap, uv).rgb * reflectivity;
    color = mix(color, vec3(0.30, 0.52, 0.72), 0.18);
  } else {
    // Sides / bottom: deep water body color, no env mapping
    color = vec3(0.06, 0.11, 0.18);
  }

  gl_FragColor = vec4(linearToSRGB(color), 1.0);
}
`;

export function createOceanBody(): Object3D {
  // 3 m wide, 0.25 m thick, 6 m long
  // 10×1×20 segments keeps the top surface visibly low-poly
  const geometry = new BoxGeometry(3, 0.25, 6, 10, 1, 20);

  const material = new ShaderMaterial({
    uniforms: {
      time: { value: 0 },
      envMap: { value: null },
      reflectivity: { value: 1.0 },
    },
    vertexShader,
    fragmentShader,
  });

  const mesh = new Mesh(geometry, material);
  mesh.name = 'ocean-body-mesh';

  const root = new Object3D();
  root.name = 'ocean-body';
  root.add(mesh);

  return root;
}
