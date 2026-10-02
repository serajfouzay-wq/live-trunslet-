// Draws the app icon (build/icon.png + build/icon.ico). Dev-time only: node scripts/make-icon.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(process.env.PLAYWRIGHT_MODULES || '/opt/node22/lib/node_modules/');
const { chromium } = require('playwright');
const pngToIco = (await import('png-to-ico')).default;

const svg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2f7dff"/><stop offset="1" stop-color="#8a5cff"/></linearGradient>
    <linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".28"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect x="16" y="16" width="480" height="480" rx="112" fill="url(#g)"/>
  <rect x="16" y="16" width="480" height="240" rx="112" fill="url(#s)"/>
  <path d="M96 150a46 46 0 0 1 46-46h138a46 46 0 0 1 46 46v86a46 46 0 0 1-46 46h-70l-62 52v-52h-6a46 46 0 0 1-46-46z" fill="#fff"/>
  <text x="211" y="231" font-family="Segoe UI, Arial, sans-serif" font-weight="800" font-size="104" text-anchor="middle" fill="#2f6bff">A</text>
  <path d="M236 292a46 46 0 0 1 46-46h88a46 46 0 0 1 46 46v66a46 46 0 0 1-46 46h-6v48l-58-48h-24a46 46 0 0 1-46-46z" fill="#0b1226" fill-opacity=".92" transform="translate(30 20)"/>
  <text x="352" y="381" font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif" font-weight="800" font-size="92" text-anchor="middle" fill="#fff">文</text>
</svg>`;

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
const sizes = [512, 256, 128, 64, 48, 32, 16];
const files = {};
for (const s of sizes) {
  await page.setViewportSize({ width: s, height: s });
  await page.setContent(`<body style="margin:0;background:transparent">${svg(s)}</body>`);
  files[s] = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: s, height: s } });
}
fs.mkdirSync('build', { recursive: true });
fs.writeFileSync('build/icon.png', files[512]);
fs.writeFileSync('build/icon.ico', await pngToIco([256, 128, 64, 48, 32, 16].map((s) => files[s])));
await browser.close();
console.log('icon written');
