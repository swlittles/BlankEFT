'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { keyCatalog } = require('../src/main/keyCatalog');

test('keyCatalog: map it belongs to, spawn spots, quest rewards and needs, name fallback', () => {
  const maps = [
    {
      id: 'customs',
      normalizedName: 'customs',
      locks: [
        { lockType: 'door', key: 'dorm' },
        { lockType: 'door', key: 'dorm' },
        { lockType: 'trunk', key: 'dorm' },
      ],
      lootLoose: [{ items: ['dorm', 'dorm'] }, { items: ['car'] }],
    },
    { id: 'lab', normalizedName: 'the-lab', accessKeys: ['labcard'], lootLoose: [{ items: ['dorm'] }] },
    { id: 'shore', normalizedName: 'shoreline' },
  ];
  const tasks = [
    { id: 't1', neededKeys: [{ map: { id: 'customs' }, keys: [{ id: 'dorm' }] }], finishRewards: { items: [{ item: 'dorm', count: 1 }] } },
    { id: 't2', startRewards: { items: [{ item: { id: 'resort' } }] }, objectives: [{ requiredKeys: [[{ id: 'resort' }, { id: 'car' }]] }] },
  ];
  const names = { resort: 'Health Resort west wing room 301 key', car: 'Folding car key' };
  const byId = Object.fromEntries(keyCatalog({ keyIds: ['dorm', 'labcard', 'resort', 'car'], maps, tasks, nameOf: (id) => names[id] }).map((k) => [k.id, k]));

  assert.deepStrictEqual(byId.dorm.maps, ['customs']);
  assert.deepStrictEqual(byId.dorm.locks, { customs: { door: 2, trunk: 1, other: 0 } });
  assert.deepStrictEqual(byId.dorm.spawns, { customs: 1, lab: 1 }); // one spot listing it twice counts once
  assert.deepStrictEqual(byId.dorm.rewards, [{ task: 't1', start: false }]);
  assert.deepStrictEqual(byId.dorm.neededBy, ['t1']);
  assert.deepStrictEqual(byId.labcard.maps, ['lab']);
  assert.deepStrictEqual(byId.labcard.access, ['lab']);
  // no lock data: the name says Shoreline
  assert.deepStrictEqual(byId.resort.maps, ['shore']);
  assert.deepStrictEqual(byId.resort.rewards, [{ task: 't2', start: true }]);
  assert.deepStrictEqual(byId.resort.neededBy, ['t2']);
  // nothing known
  assert.deepStrictEqual(byId.car.maps, []);
  assert.deepStrictEqual(byId.car.spawns, { customs: 1 });
});
