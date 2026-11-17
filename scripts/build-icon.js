'use strict';
// Renders assets/icon.svg to PNGs and a multi-size Windows .ico.
// Run with: npx electron scripts/build-icon.js
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const assets = path.join(__dirname, '..', 'assets');

function buildIco(pngs) {
  // ICO with PNG-compressed entries (supported since Windows Vista).
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = 6 + dir.length;
  pngs.forEach(({ size, data }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o);
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt8(0, o + 2);
    dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([header, dir, ...pngs.map((p) => p.data)]);
}

app.whenReady().then(async () => {
  try {
    const svg = fs.readFileSync(path.join(assets, 'icon.svg'), 'utf8');
    const win = new BrowserWindow({ show: false, width: 512, height: 512, useContentSize: true, frame: false, transparent: true, backgroundColor: '#00000000' });
    const html = `<html><body style="margin:0;background:transparent;overflow:hidden">${svg.replace('<svg ', '<svg width="512" height="512" ')}</body></html>`;
    await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
    await new Promise((r) => setTimeout(r, 400));
    const big = await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
    const pngs = SIZES.map((size) => ({ size, data: big.resize({ width: size, height: size, quality: 'best' }).toPNG() }));
    fs.writeFileSync(path.join(assets, 'icon.png'), pngs.find((p) => p.size === 256).data);
    fs.writeFileSync(path.join(assets, 'icon.ico'), buildIco(pngs));
    console.log('wrote assets/icon.ico with sizes', SIZES.join(','));
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  }
  app.quit();
});
