import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(dir, { recursive: true });

const svg = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
    <rect width="512" height="512" fill="#18181b" rx="96"/>
    <text x="256" y="340" font-family="system-ui, sans-serif" font-size="240" font-weight="800" fill="#f4f4f5" text-anchor="middle">HD</text>
  </svg>`,
);

await Promise.all([
  sharp(svg).resize(512, 512).png().toFile(path.join(dir, 'icon-512.png')),
  sharp(svg).resize(192, 192).png().toFile(path.join(dir, 'icon-192.png')),
]);

console.log('PWA icons created:', dir);
