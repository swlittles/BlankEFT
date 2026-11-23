'use strict';
// Cuts a release: bumps the version, commits, tags and pushes. GitHub Actions then builds the
// installer and publishes it (.github/workflows/release.yml), and installed copies update themselves.
// Usage: npm run release [-- patch|minor|major|x.y.z]   (default: patch)
const { execSync, execFileSync } = require('child_process');

const sh = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
const git = (...args) => execFileSync('git', args, { stdio: 'inherit' });

const bump = process.argv[2] || 'patch';
if (!['patch', 'minor', 'major'].includes(bump) && !/^\d+\.\d+\.\d+$/.test(bump)) {
  console.error('Usage: npm run release [-- patch|minor|major|x.y.z]');
  process.exit(1);
}
if (sh('git rev-parse --abbrev-ref HEAD') !== 'main') {
  console.error('Releases are cut from main.');
  process.exit(1);
}
if (sh('git status --porcelain')) {
  console.error('Commit or put aside your changes first.');
  process.exit(1);
}
sh('git fetch origin main');
if (sh('git rev-parse HEAD') !== sh('git rev-parse origin/main')) {
  console.error('main is not the same as origin/main. Pull or push first.');
  process.exit(1);
}
execSync('npm test', { stdio: 'inherit' });

const version = sh(`npm version ${bump} --no-git-tag-version`).replace(/^v/, '');
git('add', 'package.json', 'package-lock.json');
git('commit', '-m', `Release v${version}\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`);
git('tag', '-a', `v${version}`, '-m', `v${version}`);
git('push', 'origin', 'main', `v${version}`);
console.log(
  `\nPushed v${version}. GitHub is building it now:\n  https://github.com/swlittles/BlankEFT/actions\n` +
    'Then it shows up at https://github.com/swlittles/BlankEFT/releases and installed copies update themselves.',
);
