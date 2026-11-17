'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { planRoute, buildLoadout, nearestSpawn } = require('../src/renderer/planner');

const M = 'map1';
const obj = (id, extra = {}) => ({ id, type: 'visit', description: id, maps: [M], zones: [], possibleLocations: [], items: [], useAny: [], requiredKeys: [], usingWeapon: [], usingWeaponMods: [], wearing: [], ...extra });
const zoneAt = (x, z) => ({ map: M, position: { x, y: 0, z }, outline: [] });

test('route visits stops nearest-first from the start and ends near the extract', () => {
  const tasks = [
    { id: 't1', name: 'Far', objectives: [obj('far', { zones: [zoneAt(100, 0)] })] },
    { id: 't2', name: 'Near', objectives: [obj('near', { zones: [zoneAt(10, 0)] })] },
    { id: 't3', name: 'Mid', objectives: [obj('mid', { zones: [zoneAt(50, 0)] }), obj('kill', { type: 'shoot' })] },
  ];
  const r = planRoute(tasks, M, { start: { x: 0, z: 0 }, end: { x: 120, z: 0 } });
  assert.deepStrictEqual(r.stops.map((s) => s.objective.id), ['near', 'mid', 'far']);
  assert.strictEqual(r.length, 120);
  assert.deepStrictEqual(r.anywhere.map((a) => a.objective.id), ['kill']);
});

test('objective with several candidate spots uses the closest one; done objectives are skipped', () => {
  const tasks = [{ id: 't', name: 'T', objectives: [obj('a', { zones: [zoneAt(500, 0), zoneAt(5, 5)] }), obj('b', { zones: [zoneAt(1, 1)] })] }];
  const r = planRoute(tasks, M, { start: { x: 0, z: 0 }, objectivesDone: { b: true } });
  assert.strictEqual(r.stops.length, 1);
  assert.deepStrictEqual(r.stops[0].point.position, { x: 5, y: 0, z: 5 });
});

test('loadout collects keys, plant items, markers, gear and quest items for this map', () => {
  const tasks = [
    {
      id: 't',
      name: 'Quest',
      neededKeys: [{ map: M, keys: ['key1'] }, { map: 'other', keys: ['key9'] }],
      objectives: [
        obj('p', { type: 'plantItem', items: ['wifi'], count: 2, requiredKeys: [['key2', 'key3']] }),
        obj('m', { type: 'mark', markerItem: 'ms2000' }),
        obj('s', { type: 'shoot', maps: [], usingWeapon: ['sv98'], wearing: [['paca']] }),
        obj('q', { type: 'plantQuestItem', questItem: { id: 'qi', name: 'Folder' } }),
        obj('elsewhere', { type: 'plantItem', maps: ['other'], items: ['nope'] }),
      ],
    },
  ];
  const l = buildLoadout(tasks, M);
  assert.deepStrictEqual(l.keys.map((k) => k.alts), [['key1'], ['key2', 'key3']]);
  assert.deepStrictEqual(l.bring.map((b) => [b.alts, b.count]), [[['wifi'], 2], [['ms2000'], 1]]);
  assert.deepStrictEqual(l.gear.map((g) => g.label), ['Weapon (any one)', 'Wear']);
  assert.strictEqual(l.questItems[0].item.name, 'Folder');
});

test('nearest spawn', () => {
  const n = nearestSpawn([{ position: { x: 0, z: 0 } }, { position: { x: 30, z: 40 } }], { x: 28, z: 41 });
  assert.deepStrictEqual(n.spawn.position, { x: 30, z: 40 });
  assert.ok(n.distance < 3);
});
