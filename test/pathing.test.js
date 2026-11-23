'use strict';
const test = require('node:test');
const assert = require('node:assert');
const P = require('../src/renderer/pathing');

// grid from rows of characters: . open, # blocked, = road, B building, ! danger
function grid(rows) {
  const h = rows.length;
  const w = rows[0].length;
  const g = new Uint8Array(w * h);
  const code = { '.': P.OPEN, '#': P.BLOCKED, '=': P.ROAD, B: P.BUILDING, '!': P.DANGER };
  rows.forEach((r, y) => [...r].forEach((c, x) => (g[y * w + x] = code[c])));
  return { g, w, h };
}
const blockedOn = (G, path) => path.some((c) => G.g[c.y * G.w + c.x] === P.BLOCKED);

test('goes through the gap in a wall, never through it', () => {
  const G = grid([
    '..........',
    '....#.....',
    '....#.....',
    '....#.....',
    '..........', // gap at the bottom
  ]);
  const path = P.findPath(G.g, G.w, G.h, { x: 0, y: 1 }, { x: 9, y: 1 });
  assert.ok(path);
  assert.ok(!blockedOn(G, path));
  assert.ok(path.some((c) => c.x === 4 && c.y === 0) || path.some((c) => c.x === 4 && c.y === 4), 'uses one of the gaps');
});

test("a diagonal step can't slip between two fence cells", () => {
  const G = grid([
    '.#..',
    '#...',
    '....',
  ]);
  // (0,0) is boxed in by fence cells at (1,0) and (0,1): no way out
  assert.strictEqual(P.findPath(G.g, G.w, G.h, { x: 0, y: 0 }, { x: 3, y: 2 }, { snapRadius: 0 }), null);
});

test('prefers a road when it is worth the detour, avoids danger zones', () => {
  const G = grid([
    '..........',
    '..........',
    '==========',
  ]);
  const path = P.findPath(G.g, G.w, G.h, { x: 0, y: 2 }, { x: 9, y: 2 });
  assert.ok(path.every((c) => c.y === 2), 'stays on the road');
  const D = grid([
    '..........',
    '.!!!!!!!!.',
    '..........',
  ]);
  const p2 = P.findPath(D.g, D.w, D.h, { x: 0, y: 1 }, { x: 9, y: 1 });
  assert.ok(!p2.some((c) => D.g[c.y * D.w + c.x] === P.DANGER), 'walks around the minefield');
});

test('snaps start and end off blocked cells; smoothing keeps it clear and shorter', () => {
  const G = grid([
    '#.........',
    '..........',
    '..........',
    '.........#',
  ]);
  const path = P.findPath(G.g, G.w, G.h, { x: 0, y: 0 }, { x: 9, y: 3 });
  assert.ok(path && !blockedOn(G, path));
  const s = P.smoothPath(G.g, G.w, path);
  assert.ok(s.length <= path.length && s.length >= 2);
  for (let i = 1; i < s.length; i++) assert.ok(P.lineCost(G.g, G.w, s[i - 1], s[i]) < Infinity, 'smoothed legs never cross a blocked cell');
  // smoothing doesn't cut across a building the path went around, even from a stop inside one
  const B = grid([
    '..........',
    '..BBBBBB..',
    '..BBBBBB..',
    '..........',
  ]);
  const raw = P.findPath(B.g, B.w, B.h, { x: 0, y: 1 }, { x: 9, y: 2 });
  const pb = P.smoothPath(B.g, B.w, raw);
  const cost = (p) => { let c = 0; for (let i = 1; i < p.length; i++) c += P.lineCost(B.g, B.w, p[i - 1], p[i]); return c; };
  assert.ok(cost(pb) <= cost(raw) * 1.05, 'smoothing never makes it costlier');
  assert.ok(!pb.slice(1, -1).some((c) => B.g[c.y * B.w + c.x] === P.BUILDING), 'goes around the building');
  // from a stop inside a building: leaves it, doesn't walk the length of it
  const C = grid([
    'BBBBBBBBBB',
    'B........B',
    'BBBBBBBBBB',
  ]);
  const pc = P.smoothPath(C.g, C.w, P.findPath(C.g, C.w, C.h, { x: 0, y: 0 }, { x: 9, y: 0 }));
  assert.ok(pc.some((c) => C.g[c.y * C.w + c.x] === P.OPEN), 'uses the corridor of open ground');
});

test('pixels are read back as the nearest palette colour; transparent is off the map', () => {
  const px = new Uint8ClampedArray([255, 0, 0, 255, 250, 250, 10, 255, 0, 240, 5, 255, 0, 0, 0, 0, 10, 10, 250, 255]);
  assert.deepStrictEqual([...P.classify(px, 5, 1)], [P.BLOCKED, P.ROAD, P.OPEN, P.BLOCKED, P.BUILDING]);
});
