'use strict';
// Ammo ratings, "can I get this?" checks and the weapon build optimizer.
// Pure functions. Loaded in the renderer and by the Node tests.

const FLEA_LEVEL = 15;

/** Highest loyalty level your player level allows (rep/spend also matter, so you can lower it). */
function traderLevelForPlayer(trader, playerLevel) {
  let ll = 1;
  trader.levels.forEach((req, i) => {
    if (playerLevel >= req) ll = Math.max(ll, i + 1);
  });
  return ll;
}

/**
 * ctx: { unlimited, playerLevel, traderLevels: {traderId: LL}, completedTasks: Set, useFlea, useBarters }
 * Returns { ok, source, why } where source is the best way to get it (trader > barter > flea).
 */
function bestSource(sources, ctx) {
  if (!sources || !sources.length) return { ok: false, source: null, why: 'Not sold anywhere (loot only)' };
  const rank = { trader: 0, barter: 1, flea: 2 };
  const sorted = [...sources].sort((a, b) => rank[a.kind] - rank[b.kind] || (a.level || 0) - (b.level || 0) || (a.price || 0) - (b.price || 0));
  if (ctx.unlimited) return { ok: true, source: sorted[0], why: '' };
  let lastWhy = '';
  for (const s of sorted) {
    if (s.kind === 'flea') {
      if (!ctx.useFlea) {
        lastWhy = lastWhy || 'Flea market turned off';
        continue;
      }
      const need = Math.max(FLEA_LEVEL, s.minLevel || 0);
      if ((ctx.playerLevel || 0) < need) {
        lastWhy = lastWhy || `Flea needs level ${need}`;
        continue;
      }
      return { ok: true, source: s, why: '' };
    }
    if (s.kind === 'barter' && !ctx.useBarters) {
      lastWhy = lastWhy || 'Barters turned off';
      continue;
    }
    const ll = ctx.traderLevels?.[s.trader] ?? 1;
    if (ll < s.level) {
      lastWhy = lastWhy || `Needs trader LL${s.level}`;
      continue;
    }
    if (s.taskUnlock && !ctx.completedTasks?.has(s.taskUnlock)) {
      lastWhy = lastWhy || 'Locked behind a quest';
      continue;
    }
    return { ok: true, source: s, why: '' };
  }
  return { ok: false, source: sorted[0], why: lastWhy || 'Not available yet' };
}

/**
 * Rough effectiveness against armor class 1–6 at full durability, as 0–6.
 * Armor class N has armor value N×10; penetration beyond that goes through reliably.
 */
function armorRating(pen, cls) {
  const diff = pen - cls * 10;
  if (diff >= 15) return 6;
  if (diff >= 10) return 5;
  if (diff >= 5) return 4;
  if (diff >= 0) return 3;
  if (diff >= -5) return 2;
  if (diff >= -10) return 1;
  return 0;
}

const GOALS = {
  // r = weight per 1% recoil reduction, e = weight per point of ergonomics
  meta: { label: 'Lowest recoil (meta)', r: 1, e: 0.25 },
  balanced: { label: 'Balanced', r: 1, e: 0.75 },
  ergo: { label: 'Ergonomics', r: 0.25, e: 1 },
};

/**
 * Pick attachments for a weapon.
 * @returns { parts: [{slot, mod, depth, avail}], stats, missing: [slot names], unavailable: n }
 */
function optimizeBuild(armory, weaponId, ctx, goalId = 'meta') {
  const weapon = armory.weapons.find((w) => w.id === weaponId);
  if (!weapon) return null;
  const goal = GOALS[goalId] || GOALS.meta;
  const mods = armory.mods;
  const availCache = new Map();
  const avail = (id) => {
    if (!availCache.has(id)) availCache.set(id, bestSource(mods[id]?.sources, ctx));
    return availCache.get(id);
  };
  const presetMag = weapon.preset?.parts.map((id) => mods[id]).find((m) => m?.capacity);
  const targetCap = presetMag?.capacity || 0;
  // The game caps ergonomics at 100, so points past it are worth nothing. If a build overshoots,
  // value ergonomics less and solve again, keeping whichever build scores best with the cap applied.
  const ERGO_CAP = 100;
  let ergoWeight = goal.e;
  const own = (m) => goal.r * m.recoil * 100 - ergoWeight * m.ergo;
  const totals = (parts) => ({
    recoil: parts.reduce((x, p) => x + p.mod.recoil, 0),
    ergo: weapon.ergo + parts.reduce((x, p) => x + p.mod.ergo, 0),
  });
  const value = (parts) => {
    const t = totals(parts);
    return goal.r * t.recoil * 100 - goal.e * Math.min(ERGO_CAP, t.ergo);
  };

  let result = null;
  let bestResult = null;
  for (let pass = 0; pass < 8; pass++) {
    const banned = new Set();
    for (let attempt = 0; attempt < 20; attempt++) {
      const memo = new Map();
      const missing = [];
      const solve = (item, depth) => {
        if (memo.has(item.id)) return memo.get(item.id);
        let score = item === weapon ? 0 : own(item);
        const children = [];
        if (depth < 10) {
          for (const slot of item.slots) {
            const all = slot.allowed.filter((id) => mods[id] && !banned.has(id));
            let cands = all.filter((id) => avail(id).ok);
            if (!cands.length && slot.required && all.length) {
              missing.push(slot.name);
              cands = all; // show the best one even though you can't get it yet
            }
            const isMag = slot.id.startsWith('mod_magazine');
            if (isMag && targetCap) {
              const big = cands.filter((id) => (mods[id].capacity || 0) >= targetCap);
              if (big.length) cands = big;
            }
            let best = null;
            for (const id of cands) {
              const sub = solve(mods[id], depth + 1);
              if (!best || sub.score < best.score) best = { id, ...sub };
            }
            if (!best) continue;
            if (slot.required || isMag || best.score < -0.001) {
              score += best.score;
              children.push({ slot, id: best.id, sub: best });
            }
          }
        }
        const r = { score, children };
        memo.set(item.id, r);
        return r;
      };
      const root = solve(weapon, 0);
      const parts = [];
      const walk = (node, depth) => {
        for (const c of node.children) {
          parts.push({ slot: c.slot.name, mod: mods[c.id], depth, avail: avail(c.id) });
          walk(c.sub, depth + 1);
        }
      };
      walk(root, 0);
      // Resolve conflicting attachments by banning the less useful one and solving again.
      const chosen = new Set(parts.map((p) => p.mod.id));
      let conflict = null;
      for (const p of parts) {
        const other = p.mod.conflicts.find((id) => chosen.has(id));
        if (other) {
          conflict = own(p.mod) > own(mods[other]) ? p.mod.id : other;
          break;
        }
      }
      result = { parts, missing: [...new Set(missing)] };
      if (!conflict) break;
      banned.add(conflict);
    }
    if (!bestResult || value(result.parts) < value(bestResult.parts) - 1e-9) bestResult = result;
    if (totals(result.parts).ergo <= ERGO_CAP || ergoWeight < 0.01) break;
    ergoWeight *= 0.5;
  }
  result = bestResult;

  const sumRecoil = result.parts.reduce((s, p) => s + p.mod.recoil, 0);
  const sumErgo = result.parts.reduce((s, p) => s + p.mod.ergo, 0);
  const cost = {};
  for (const p of result.parts) {
    const s = p.avail.source;
    if (s && s.price && s.kind !== 'barter') {
      const cur = s.kind === 'flea' ? 'RUB' : s.currency || 'RUB';
      cost[cur] = (cost[cur] || 0) + s.price;
    }
  }
  return {
    weapon,
    goal: goalId,
    parts: result.parts,
    missing: result.missing,
    unavailable: result.parts.filter((p) => !p.avail.ok).length,
    stats: {
      ergo: Math.round(Math.min(ERGO_CAP, weapon.ergo + sumErgo) * 10) / 10,
      ergoRaw: Math.round((weapon.ergo + sumErgo) * 10) / 10,
      recoilV: Math.round(weapon.recoilV * (1 + sumRecoil)),
      recoilH: Math.round(weapon.recoilH * (1 + sumRecoil)),
      weight: Math.round(result.parts.reduce((s, p) => s + p.mod.weight, 0) * 100) / 100,
      cost,
    },
  };
}

const Armory = { traderLevelForPlayer, bestSource, armorRating, optimizeBuild, GOALS, FLEA_LEVEL };
if (typeof module !== 'undefined' && module.exports) module.exports = Armory;
if (typeof window !== 'undefined') window.Armory = Armory;
