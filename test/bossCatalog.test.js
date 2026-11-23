'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Bosses = require('../src/renderer/bosses');

const mobs = {
  bossBully: { name: 'bossBully', imagePosterLink: 'https://assets.tarkov.dev/reshala-poster.webp', health: [{ max: 70 }, { max: 200 }], equipment: [{ item: 'cap', attributes: { slot: 'Headwear' } }, { item: 'tt', attributes: { slot: 'Holster' } }, { item: 'ammo', attributes: { slot: 'pocket1' } }] },
  followerBully: { name: 'followerBully', equipment: [{ item: 'helmet', attributes: { slot: 'Headwear' } }] },
  ExUsec: { name: 'ExUsec', imagePortraitLink: 'https://assets.tarkov.dev/rogue-portrait.webp' },
  exUsecFree: { name: 'ExUsec' },
  pmcUSEC: { name: 'pmcUSEC' },
};
const en = { bossBully: 'Reshala', followerBully: 'Reshala Guard', ExUsec: 'Rogue', customs: 'Customs', lighthouse: 'Lighthouse', ZoneDormitory: 'Dorms' };
const t = (k) => en[k] ?? k;
const maps = [
  {
    id: 'c',
    name: 'customs',
    bosses: [
      { mob: 'bossBully', spawnChance: 0.5, spawnLocations: [{ spawnKey: 'ZoneDormitory', chance: 1 }, { spawnKey: 'ZonePort29', chance: 0 }], escorts: [{ mob: 'followerBully', amount: [{ count: 2 }, { count: 4 }] }] },
      { mob: 'bossBully', spawnChance: 0.5, spawnLocations: [] },
      { mob: 'pmcUSEC', spawnChance: 1, escorts: [{ mob: 'pmcUSEC', amount: [{ count: 1 }] }] },
    ],
  },
  { id: 'l', name: 'lighthouse', bosses: [{ mob: 'ExUsec', spawnChance: 1 }, { mob: 'exUsecFree', spawnChance: 0.5 }] },
];

test('bossCatalog: cards per enemy with maps, guards and gear; PMCs left out', () => {
  const seen = [];
  const cat = Bosses.bossCatalog(maps, mobs, t, (id) => (seen.push(id), id));
  assert.deepStrictEqual(cat.map((c) => `${c.section}:${c.name}`), ['bosses:Reshala', 'guards:Reshala Guard', 'others:Rogue']);
  const [reshala, guard, rogue] = cat;
  assert.strictEqual(reshala.maps[0].chance, 0.75); // two 50% entries → 75% per raid
  assert.deepStrictEqual(reshala.maps[0].zones, ['Dorms']); // "Port29" has a number: an internal id, dropped
  assert.deepStrictEqual(reshala.guards, [{ key: 'guards:Reshala Guard', name: 'Reshala Guard', count: '2–4' }]);
  assert.deepStrictEqual(reshala.wears, { Headwear: ['cap'] });
  assert.deepStrictEqual(reshala.weapons, ['tt']);
  assert.strictEqual(reshala.health, 270);
  assert.strictEqual(reshala.wiki, 'Reshala');
  assert.ok(reshala.note);
  assert.deepStrictEqual(guard.guardOf, [{ key: 'bosses:Reshala', name: 'Reshala' }]);
  assert.deepStrictEqual(guard.maps.map((m) => m.map), ['c']);
  // the two Rogue mobs share one card
  assert.deepStrictEqual(rogue.ids, ['ExUsec', 'exUsecFree']);
  assert.strictEqual(rogue.maps[0].chance, 1);
  assert.strictEqual(rogue.portrait, 'https://assets.tarkov.dev/rogue-portrait.webp');
  assert.ok(seen.includes('cap') && seen.includes('helmet') && !seen.includes('ammo'));
});

test('lookPictures keeps in-game looks, not health charts, maps, gun builds or guard shots', () => {
  const img = (file, caption = '') => ({ thumb: `https://x/${file}/scale-to-width-down/300`, full: `https://static.wikia.nocookie.net/eft/images/a/ab/${file}/revision/latest`, caption });
  const images = [
    img('KillaInfobox.png'),
    img('KillaHealth.png'),
    img('KillaSpawns.jpg', 'Locations marked on map'),
    img('Killa-AKMS.png'),
    img('Killa_In_Game.png', 'Killa with his TT-33'),
    img('Killa.jpg', 'Killa concept art'),
    img('FestiveKilla.png', 'Festive Killa in the 2024 Christmas event'),
    img('Killa_Guard_nr.1.png', 'One of Killa&#39;s guards'),
    img('Killa_153.png'),
  ];
  const names = (list) => list.map((p) => p.full.split('/')[7]);
  assert.deepStrictEqual(names(Bosses.lookPictures(images, ['killa'], ['guard', 'follower', 'oneof'])), ['KillaInfobox.png', 'Killa_In_Game.png', 'FestiveKilla.png']);
  assert.deepStrictEqual(names(Bosses.lookPictures(images, ['guard', 'follower', 'oneof'])), ['Killa_Guard_nr.1.png']);
  assert.deepStrictEqual(names(Bosses.lookPictures([img('Rogue_1.PNG'), img('RogueG36.png')], ['rogue'])), ['Rogue_1.PNG']);
});
