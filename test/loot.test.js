'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Loot = require('../src/renderer/loot');

const box = (x, z, c = 'weapons', n = 'Weapon box', w = 3) => ({ c, n, w, p: { x, y: 0, z } });

function fixture() {
  return [
    // a building with 4 weapon boxes and an ammo box near (0,0)
    box(0, 0), box(5, 3), box(-4, 6), box(8, -5), box(2, 2, 'ammo', 'Wooden ammo box'),
    // a smaller spot at (200,0)
    box(200, 0), box(205, 4),
    // lone weapon box far away at (0, 600)
    box(0, 600),
    // misc containers that shouldn't count unless asked for
    box(100, 100, 'misc', 'Drawer', 0.5), box(101, 102, 'misc', 'Drawer', 0.5),
  ];
}

test('hotspots: groups nearby containers, best first, only the chosen kinds', () => {
  const hs = Loot.lootHotspots(fixture(), ['weapons', 'ammo'], { areas: [{ name: 'Dorms', x: 0, z: 0 }] });
  assert.strictEqual(hs[0].count, 5);
  // 4 weapon boxes (3 each) + 1 ammo box (3, boosted because ammo is 7x rarer here, capped at 3x... sqrt(7))
  assert.strictEqual(hs[0].score, Math.round((12 + 3 * Math.sqrt(7)) * 10) / 10);
  assert.strictEqual(hs[0].label, 'Dorms');
  assert.strictEqual(Loot.hotspotSummary(hs[0]), '4 Weapon boxes, 1 Wooden ammo box');
  assert.strictEqual(hs[1].count, 2);
  assert.strictEqual(hs[1].label, null, 'too far from any named area');
  assert.ok(!hs.some((h) => h.byType.some((t) => t.cat === 'misc')));
  assert.ok(hs.every((h) => h.score >= 3));
  // ids are stable for the same input
  assert.deepStrictEqual(Loot.lootHotspots(fixture(), ['weapons', 'ammo']).map((h) => h.id), hs.map((h) => h.id));
});

test('route: auto-pick stays within the length budget and ends at the extract', () => {
  const hs = Loot.lootHotspots(fixture(), ['weapons', 'ammo'], { minScore: 1 });
  const start = { x: -50, z: 0 };
  const end = { x: 250, z: 0 };
  const r = Loot.planLootRoute(hs, { start, end, size: 'short' });
  const names = r.stops.map((s) => s.hotspot.count);
  assert.deepStrictEqual(names, [5, 2], 'the two spots on the way, not the far lone box');
  assert.ok(r.length <= Loot.ROUTE_SIZES.short.budget);
  // the far box only fits a longer route
  const long = Loot.planLootRoute(hs, { start, end, size: 'long' });
  assert.strictEqual(long.stops.length, 3);
});

test('route: manual picks, looted spots drop out, auto-pick ignores live position', () => {
  const hs = Loot.lootHotspots(fixture(), ['weapons', 'ammo'], { minScore: 1 });
  const far = hs.find((h) => h.count === 1);
  const r = Loot.planLootRoute(hs, { picks: [far.id, hs[0].id], looted: [hs[0].id] });
  assert.deepStrictEqual(r.picked, [far.id, hs[0].id]);
  assert.deepStrictEqual(r.stops.map((s) => s.hotspot.id), [far.id]);
  assert.strictEqual(r.looted.length, 1);
  // with pickFrom given, the chosen stops don't move when the live start does
  const a = Loot.planLootRoute(hs, { start: { x: 0, z: 590 }, pickFrom: { x: -50, z: 0 }, end: { x: 250, z: 0 }, size: 'short' });
  const b = Loot.planLootRoute(hs, { start: { x: 210, z: 0 }, pickFrom: { x: -50, z: 0 }, end: { x: 250, z: 0 }, size: 'short' });
  assert.deepStrictEqual([...a.picked].sort(), [...b.picked].sort());
});

test('every container type tarkov.dev lists has a known category', () => {
  for (const [name, k] of Object.entries(Loot.CONTAINERS)) {
    assert.ok(Loot.CAT_BY_ID[k.cat], `${name} -> ${k.cat}`);
    assert.ok(k.w > 0);
  }
});
