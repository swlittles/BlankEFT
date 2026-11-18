'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Bosses = require('../src/renderer/bosses');

const P = (x, z) => ({ x, y: 1, z });
const mobs = {
  bossBully: { name: 'bossBully', imagePortraitLink: 'https://assets.tarkov.dev/reshala-portrait.webp' },
  followerBully: { name: 'followerBully' },
  bossKnight: { name: 'bossKnight' },
  followerBigPipe: { name: 'followerBigPipe' },
  exUsec: { name: 'exUsec' },
  pmcUSEC: { name: 'pmcUSEC' },
};
const en = { bossBully: 'Reshala', followerBully: 'Reshala Guard', bossKnight: 'Knight', followerBigPipe: 'Big Pipe', exUsec: 'Rogue', pmcUSEC: 'USEC', ZoneDormitory: 'Dorms', ZoneScavBase: 'Stronghold' };
const t = (k) => en[k] ?? k;

function map() {
  return {
    bosses: [
      {
        mob: 'bossBully',
        spawnChance: 0.75,
        spawnLocations: [
          { spawnKey: 'ZoneDormitory', chance: 0.5, positions: [] },
          { spawnKey: 'ZoneScavBase', chance: 0.5, positions: [P(0, 0), P(10, 4), P(20, 10), P(400, 0)] },
        ],
        escorts: [{ mob: 'followerBully', amount: [{ chance: 0.5, count: 2 }, { chance: 0.5, count: 4 }] }],
      },
      { mob: 'bossKnight', spawnChance: 0.25, spawnLocations: [{ spawnKey: 'ZoneScavBase', chance: 1, positions: [] }], escorts: [{ mob: 'followerBigPipe', amount: [{ chance: 1, count: 1 }] }] },
      // two Rogue groups on the same spot fold into one row
      { mob: 'exUsec', spawnChance: 0.5, spawnLocations: [{ spawnKey: 'ZoneChalet', chance: 1, positions: [P(900, 900)] }], escorts: [] },
      { mob: 'exUsec', spawnChance: 0.5, spawnLocations: [{ spawnKey: 'ZoneChalet', chance: 1, positions: [] }], escorts: [] },
      // PvE PMC bots are not bosses
      { mob: 'pmcUSEC', spawnChance: 1, spawnLocations: [{ spawnKey: 'ZoneScavBase', chance: 1, positions: [] }], escorts: [] },
    ],
    spawns: [],
  };
}

test('boss spots: one marker per group of nearby spawn points, with every boss that can spawn there', () => {
  const spots = Bosses.bossSpots(map(), mobs, t);
  const base = spots.filter((s) => s.zone === 'ZoneScavBase');
  assert.strictEqual(base.length, 2, 'three points close together + one far away');
  assert.deepStrictEqual(base[0].position, { x: 10, y: 1, z: 4 }, 'marker sits on the real spawn point nearest the middle');
  assert.strictEqual(base[0].label, 'Stronghold');
  const names = base[0].bosses.map((b) => b.name);
  assert.deepStrictEqual(names, ['Reshala', 'Knight'], 'sorted by chance; USEC bots left out');
  const reshala = base[0].bosses[0];
  assert.strictEqual(reshala.chance, 0.38); // 0.75 x 0.5
  assert.strictEqual(reshala.mapChance, 0.75);
  assert.strictEqual(reshala.escorts, '2–4 Reshala Guards');
  assert.ok(reshala.portrait.includes('reshala'));
  assert.strictEqual(base[0].bosses[1].escorts, 'Big Pipe');
});

test('boss spots: zones without coordinates keep their name; repeated groups fold together', () => {
  const spots = Bosses.bossSpots(map(), mobs, t);
  const dorms = spots.find((s) => s.zone === 'ZoneDormitory');
  assert.strictEqual(dorms.position, null);
  assert.strictEqual(dorms.label, 'Dorms');
  const chalet = spots.filter((s) => s.zone === 'ZoneChalet');
  assert.strictEqual(chalet.length, 1);
  assert.strictEqual(chalet[0].label, 'Chalet', 'untranslated zone names are humanized');
  assert.strictEqual(chalet[0].bosses[0].groups, 2);
  assert.strictEqual(chalet[0].bosses[0].chance, 0.75); // 1 - 0.5 x 0.5
  assert.strictEqual(Bosses.pct(0.004), '1%');
});
