'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { bestSource, armorRating, optimizeBuild, traderLevelForPlayer } = require('../src/renderer/armory');

const T = 'prapor';
const trader = (level, extra = {}) => ({ kind: 'trader', trader: T, level, price: 1000, currency: 'RUB', taskUnlock: null, ...extra });

test('trader loyalty level from player level', () => {
  const t = { levels: [1, 15, 26, 36] };
  assert.strictEqual(traderLevelForPlayer(t, 10), 1);
  assert.strictEqual(traderLevelForPlayer(t, 15), 2);
  assert.strictEqual(traderLevelForPlayer(t, 40), 4);
});

test('availability: trader level, quest unlocks, flea level, toggles', () => {
  const base = { playerLevel: 20, traderLevels: { [T]: 2 }, completedTasks: new Set(['q1']), useFlea: true, useBarters: true };
  assert.strictEqual(bestSource([trader(2)], base).ok, true);
  assert.match(bestSource([trader(3)], base).why, /LL3/);
  assert.match(bestSource([trader(1, { taskUnlock: 'q2' })], base).why, /quest/);
  assert.strictEqual(bestSource([trader(1, { taskUnlock: 'q1' })], base).ok, true);
  assert.strictEqual(bestSource([{ kind: 'flea', price: 5, minLevel: 0 }], { ...base, playerLevel: 10 }).ok, false);
  assert.strictEqual(bestSource([{ kind: 'flea', price: 5, minLevel: 0 }], base).ok, true);
  assert.strictEqual(bestSource([{ kind: 'flea', price: 5, minLevel: 0 }], { ...base, useFlea: false }).ok, false);
  assert.strictEqual(bestSource([], base).ok, false);
  assert.strictEqual(bestSource([trader(4)], { unlimited: true }).ok, true);
});

test('armor rating vs class', () => {
  assert.strictEqual(armorRating(57, 4), 6);
  assert.strictEqual(armorRating(31, 3), 3);
  assert.strictEqual(armorRating(31, 4), 1);
  assert.strictEqual(armorRating(7, 3), 0);
});

function fixture() {
  const mod = (id, recoil, ergo, extra = {}) => ({ id, name: id, shortName: id, recoil, ergo, capacity: null, weight: 0.1, slots: [], conflicts: [], sources: [trader(1)], ...extra });
  const mods = {
    brake: mod('brake', -0.1, -2),
    bigBrake: mod('bigBrake', -0.15, -3, { sources: [trader(4)] }),
    stockA: mod('stockA', -0.2, 5),
    grip: mod('grip', 0, 3),
    badGrip: mod('badGrip', 0, -5),
    mag30: mod('mag30', 0, -2, { capacity: 30 }),
    mag10: mod('mag10', 0, 0, { capacity: 10 }),
    hg: mod('hg', 0, 1, { slots: [{ id: 'mod_foregrip', name: 'Foregrip', required: false, allowed: ['fg'] }] }),
    fg: mod('fg', -0.03, 1, { conflicts: ['stockA'] }),
  };
  const weapon = {
    id: 'gun',
    ergo: 50,
    recoilV: 100,
    recoilH: 200,
    preset: { parts: ['mag30'] },
    slots: [
      { id: 'mod_muzzle', name: 'Muzzle', required: false, allowed: ['brake', 'bigBrake'] },
      { id: 'mod_stock', name: 'Stock', required: false, allowed: ['stockA'] },
      { id: 'mod_pistol_grip', name: 'Pistol grip', required: true, allowed: ['badGrip', 'grip'] },
      { id: 'mod_magazine', name: 'Magazine', required: false, allowed: ['mag30', 'mag10'] },
      { id: 'mod_handguard', name: 'Handguard', required: false, allowed: ['hg'] },
    ],
  };
  return { weapons: [weapon], mods };
}

test('optimizer: best available parts, keeps magazine size, resolves conflicts', () => {
  const armory = fixture();
  const ctx = { playerLevel: 10, traderLevels: { [T]: 1 }, completedTasks: new Set(), useFlea: false, useBarters: false };
  const b = optimizeBuild(armory, 'gun', ctx, 'meta');
  const ids = b.parts.map((p) => p.mod.id);
  assert.ok(ids.includes('brake') && !ids.includes('bigBrake'), 'LL4 brake not available');
  assert.ok(ids.includes('grip'), 'required slot filled with the better grip');
  assert.ok(ids.includes('mag30'), 'magazine at least as big as stock');
  assert.ok(ids.includes('stockA') && !ids.includes('fg'), 'foregrip conflicts with the better stock');
  assert.strictEqual(b.stats.recoilV, Math.round(100 * (1 - 0.1 - 0.2)));

  const all = optimizeBuild(armory, 'gun', { unlimited: true }, 'meta');
  assert.ok(all.parts.some((p) => p.mod.id === 'bigBrake'));
});

test('editing a build: swap auto-fills the new part, remove empties the slot, original untouched', () => {
  const { setPart, evaluateTree, emptySlots, slotOptions } = require('../src/renderer/armory');
  const armory = fixture();
  const b = optimizeBuild(armory, 'gun', { unlimited: true }, 'meta');
  // swap the stock out, then put the handguard back (its foregrip gets auto-filled again)
  const noStock = setPart(armory, 'gun', b.tree, 'mod_stock', null, { unlimited: true });
  assert.ok(!evaluateTree(armory, 'gun', noStock, { unlimited: true }).parts.some((p) => p.mod.id === 'stockA'));
  assert.ok(emptySlots(armory, 'gun', noStock).some((s) => s.path === 'mod_stock'));
  const withHg = setPart(armory, 'gun', noStock, 'mod_handguard', 'hg', { unlimited: true });
  const e = evaluateTree(armory, 'gun', withHg, { unlimited: true });
  assert.ok(e.parts.some((p) => p.path === 'mod_handguard/mod_foregrip' && p.mod.id === 'fg'), 'foregrip auto-filled');
  assert.strictEqual(e.conflicts, 0);
  // the original build is unchanged
  assert.ok(evaluateTree(armory, 'gun', b.tree, { unlimited: true }).parts.some((p) => p.mod.id === 'stockA'));
  // options are sorted best recoil first
  assert.deepStrictEqual(slotOptions(armory, 'gun', 'mod_muzzle', { unlimited: true }).map((o) => o.mod.id), ['bigBrake', 'brake']);
});

test('conflicts in a hand-made build are reported', () => {
  const { setPart, evaluateTree } = require('../src/renderer/armory');
  const armory = fixture();
  let tree = setPart(armory, 'gun', [], 'mod_stock', 'stockA', { unlimited: true });
  tree = setPart(armory, 'gun', tree, 'mod_handguard', 'hg', { unlimited: true });
  // the optimizer would skip the foregrip because of the stock, so add it by hand
  tree = setPart(armory, 'gun', tree, 'mod_handguard/mod_foregrip', 'fg', { unlimited: true });
  const e = evaluateTree(armory, 'gun', tree, { unlimited: true });
  assert.strictEqual(e.conflicts, 2);
  assert.ok(e.parts.find((p) => p.mod.id === 'fg').conflictsWith.includes('stockA'));
});
