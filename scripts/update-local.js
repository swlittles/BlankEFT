'use strict';
// Rebuilds the app and swaps it into release/TarkovQuestMap-win32-x64, which the desktop and
// Start menu shortcuts point at. Builds into a staging folder first, so a running copy of the
// app is never left half-replaced. Run with: npm run update-local
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const staging = path.join(root, 'release-staging');
const target = path.join(root, 'release', 'TarkovQuestMap-win32-x64');
const built = path.join(staging, 'TarkovQuestMap-win32-x64');

function appRunning() {
  try {
    return execSync('tasklist /FI "IMAGENAME eq TarkovQuestMap.exe" /NH', { encoding: 'utf8' }).includes('TarkovQuestMap.exe');
  } catch {
    return false;
  }
}

fs.rmSync(staging, { recursive: true, force: true });
execSync(
  'npx electron-packager . TarkovQuestMap --icon=assets/icon.ico --platform=win32 --arch=x64 --out=release-staging --overwrite --prune=true ' +
    '--ignore=^/test --ignore=^/release --ignore=^/scripts',
  { cwd: root, stdio: 'inherit' }
);

if (appRunning()) {
  console.error('\nTarkov Quest Map is open. Close it, then run "npm run update-local" again to install this build.');
  process.exit(2);
}
const old = `${target}.old`;
fs.rmSync(old, { recursive: true, force: true });
if (fs.existsSync(target)) fs.renameSync(target, old);
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.renameSync(built, target);
fs.rmSync(old, { recursive: true, force: true });
fs.rmSync(staging, { recursive: true, force: true });
console.log(`\nUpdated ${target}. Your desktop and Start menu shortcuts now open the new version.`);
