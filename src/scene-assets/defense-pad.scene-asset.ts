/**
 * 建造空位底座：16 面水泥鼓盘，顶点色烘焙污渍与噪点，发光强度由运行时写入。
 * 契约：原点在盘心，y = 0 为贴合面；盘半径 0.189，高 0.04。单位：米。
 */

import {
  BufferAttribute,
  Color,
  CylinderGeometry,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  SRGBColorSpace,
} from '@iwsdk/core';

const SEED = 20261024;

type Blotch = {
  cx: number;
  cy: number;
  cz: number;
  radius: number;
  strength: number;
};

function makeRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smooth = (t: number): number => t * t * (3 - 2 * t);

/** Stateless 3D lattice hash — deterministic across runs and realms. */
function hash3(x: number, y: number, z: number): number {
  let h =
    (Math.imul(x, 374761393) ^
      Math.imul(y, 668265263) ^
      Math.imul(z, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function valueNoise3(x: number, y: number, z: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const u = smooth(x - xi);
  const v = smooth(y - yi);
  const w = smooth(z - zi);
  let acc = 0;
  for (let dz = 0; dz <= 1; dz++) {
    for (let dy = 0; dy <= 1; dy++) {
      for (let dx = 0; dx <= 1; dx++) {
        const weight =
          (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w);
        acc += hash3(xi + dx, yi + dy, zi + dz) * weight;
      }
    }
  }
  return acc;
}

export function createDefensePad(): Object3D {
  const rand = makeRandom(SEED);

  // 16 边形鼓盘：CylinderGeometry(16) 正好 64 个三角形（32 侧 + 32 盖），
  // 自带 45° 自动光滑法线——侧壁是一圈连续曲面，盖面有独立轴法线，
  // 90° 盘缘保持硬边。不要 toNonIndexed + computeVertexNormals。
  const geometry = new CylinderGeometry(0.1893375, 0.1893375, 0.04, 16);
  geometry.translate(0, 0.02, 0); // y = 0 是贴合面

  // 大面积低对比水泥斑驳烘焙进顶点色：软值噪声 + 几块大污渍。
  const pos = geometry.attributes.position as BufferAttribute;
  const blotches: Blotch[] = [];
  for (let b = 0; b < 8; b++) {
    blotches.push({
      cx: (rand() - 0.5) * 0.62,
      cy: rand() * 0.26,
      cz: (rand() - 0.5) * 0.62,
      radius: 0.12 + rand() * 0.2,
      strength: 0.3 + rand() * 0.3,
    });
  }
  const colors = new Float32Array(pos.count * 3);
  const color = new Color();
  for (let i = 0; i < pos.count; i++) {
    const px = pos.getX(i);
    const py = pos.getY(i);
    const pz = pos.getZ(i);

    const h =
      valueNoise3(px * 3, py * 3, pz * 3) * 0.6 +
      valueNoise3(px * 8, py * 8, pz * 8) * 0.4;

    let stain = 0;
    for (const b of blotches) {
      const dx = px - b.cx;
      const dy = py - b.cy;
      const dz = pz - b.cz;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const t = d / b.radius;
      const f = t < 0.75 ? 1 : 1 - (t - 0.75) / 0.25;
      const v = Math.max(0, f) * b.strength;
      if (v > stain) stain = v;
    }

    const jitter = (rand() - 0.5) * 0.04;
    const brightness = 0.84 + h * 0.16 + jitter;
    const stainShade = 1 - stain * 0.12;
    color.setRGB(
      0.62 * brightness * stainShade,
      0.62 * brightness * stainShade,
      0.61 * brightness * stainShade,
      SRGBColorSpace,
    );
    colors[i * 3 + 0] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  geometry.setAttribute('color', new BufferAttribute(colors, 3));

  const material = new MeshStandardMaterial({
    name: 'defense-pad',
    color: 0xffffff,
    roughness: 0.75,
    metalness: 0,
    vertexColors: true,
    // 空位发光烘焙到最亮，运行时只写一个 emissiveIntensity 标量。
    emissive: 0xffc46a,
    emissiveIntensity: 1,
  });

  const mesh = new Mesh(geometry, material);
  mesh.name = 'defense-pad-mesh';

  const root = new Object3D();
  root.name = 'defense-pad';
  root.add(mesh);
  return root;
}
