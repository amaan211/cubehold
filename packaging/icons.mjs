/**
 * Render every icon from the logo drawing (packaging/assets/icon.svg and
 * icon-maskable.svg; logo-source.jpg is the original artwork they follow):
 *
 *   apps/web/public   favicon.svg, icon-192/512.png, icon-maskable-512.png, apple-touch-icon.png
 *   docs/public       logo.svg
 *   packaging/assets  icon.ico (app, installer and tray; PNG entries 16 to 256 px)
 *
 * Run after editing the SVGs: pnpm icons
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const { chromium } = createRequire(path.join(root, "package.json"))("playwright");
const assets = path.join(root, "packaging/assets");
const pub = path.join(root, "apps/web/public");
const icon = fs.readFileSync(path.join(assets, "icon.svg"), "utf8");
const maskable = fs.readFileSync(path.join(assets, "icon-maskable.svg"), "utf8");
const STROKE = 'stroke-width="2.7"';
if (!icon.includes(STROKE)) throw new Error(`icon.svg must use ${STROKE} for the cube`);

fs.copyFileSync(path.join(assets, "icon.svg"), path.join(pub, "favicon.svg"));
fs.copyFileSync(path.join(assets, "icon.svg"), path.join(root, "docs/public/logo.svg"));

const browser = await chromium.launch();
const page = await browser.newPage();

/** A PNG of the SVG at a size; small sizes get heavier lines so the cube stays visible. */
async function render(svg, size) {
  const stroke = size <= 24 ? 4.4 : size <= 40 ? 3.4 : 2.7;
  const sized = svg
    .replace(STROKE, `stroke-width="${stroke}"`)
    .replace("<svg ", `<svg width="${size}" height="${size}" `);
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<html><body style="margin:0;background:transparent">${sized}</body></html>`,
  );
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}

fs.writeFileSync(path.join(pub, "icon-192.png"), await render(icon, 192));
fs.writeFileSync(path.join(pub, "icon-512.png"), await render(icon, 512));
fs.writeFileSync(path.join(pub, "icon-maskable-512.png"), await render(maskable, 512));
fs.writeFileSync(path.join(pub, "apple-touch-icon.png"), await render(maskable, 180));

// ICO with PNG entries (supported since Windows Vista).
const sizes = [16, 20, 24, 32, 40, 48, 64, 256];
const pngs = [];
for (const size of sizes) pngs.push(await render(icon, size));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
const dir = Buffer.alloc(16 * sizes.length);
let offset = 6 + dir.length;
sizes.forEach((size, i) => {
  const e = i * 16;
  dir.writeUInt8(size >= 256 ? 0 : size, e);
  dir.writeUInt8(size >= 256 ? 0 : size, e + 1);
  dir.writeUInt16LE(1, e + 4);
  dir.writeUInt16LE(32, e + 6);
  dir.writeUInt32LE(pngs[i].length, e + 8);
  dir.writeUInt32LE(offset, e + 12);
  offset += pngs[i].length;
});
fs.writeFileSync(path.join(assets, "icon.ico"), Buffer.concat([header, dir, ...pngs]));
await browser.close();
console.log("icons written");
