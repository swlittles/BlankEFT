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

// ------------------------------------------------------------------ builds as editable trees
// A build is a tree: [{ slot: slotId, mod: modId, children: [...] }], rooted at the weapon.
// "path" addresses a slot in it, e.g. "mod_handguard/mod_foregrip".

const ERGO_CAP = 100;

function findItem(armory, id) {
  return armory.mods[id] || armory.weapons.find((w) => w.id === id) || null;
}

/**
 * Best attachments under `rootId` (the weapon, or a part when auto-filling after a swap).
 * @returns { tree, missing: [slot names] }
 */
function optimizeTree(armory, weaponId, ctx, goalId = 'meta', rootId = weaponId) {
  const weapon = armory.weapons.find((w) => w.id === weaponId);
  const root = findItem(armory, rootId);
  if (!weapon || !root) return { tree: [], missing: [] };
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
  let ergoWeight = goal.e;
  const own = (m) => goal.r * m.recoil * 100 - ergoWeight * m.ergo;
  const flat = (tree) => {
    const out = [];
    const walk = (nodes) => {
      for (const n of nodes) {
        out.push(mods[n.mod]);
        walk(n.children);
      }
    };
    walk(tree);
    return out;
  };
  const totals = (tree) => {
    const parts = flat(tree);
    return { recoil: parts.reduce((x, m) => x + m.recoil, 0), ergo: weapon.ergo + parts.reduce((x, m) => x + m.ergo, 0) };
  };
  const value = (tree) => {
    const t = totals(tree);
    return goal.r * t.recoil * 100 - goal.e * Math.min(ERGO_CAP, t.ergo);
  };

  // Score of a part including everything mounted on it (what you lose by banning it).
  const subtreeScore = (node) => own(mods[node.mod]) + node.children.reduce((x, c) => x + subtreeScore(c), 0);
  const findNode = (nodes, id) => {
    for (const n of nodes) {
      if (n.mod === id) return n;
      const hit = findNode(n.children, id);
      if (hit) return hit;
    }
    return null;
  };

  let best = null;
  for (let pass = 0; pass < 8; pass++) {
    // Solve once with some parts banned. Returns the build and, if two of its parts
    // conflict, both of them (the less useful sub-build first).
    const attempt = (banned) => {
      const memo = new Map();
      const missing = [];
      const solve = (item, depth) => {
        if (memo.has(item.id)) return memo.get(item.id);
        let score = item === weapon || item === root ? 0 : own(item);
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
            let pick = null;
            for (const id of cands) {
              const sub = solve(mods[id], depth + 1);
              if (!pick || sub.score < pick.score) pick = { id, ...sub };
            }
            if (!pick) continue;
            if (slot.required || isMag || pick.score < -0.001) {
              score += pick.score;
              children.push({ slot: slot.id, mod: pick.id, children: pick.children });
            }
          }
        }
        const r = { score, children };
        memo.set(item.id, r);
        return r;
      };
      // copy so memoised subtrees shared between branches don't alias each other
      const tree = structuredCloneTree(solve(root, 0).children);
      const parts = flat(tree);
      const chosen = new Set(parts.map((m) => m.id));
      let pair = null;
      for (const m of parts) {
        const other = m.conflicts.find((id) => chosen.has(id));
        if (other) {
          const a = subtreeScore(findNode(tree, m.id));
          const b = subtreeScore(findNode(tree, other));
          pair = a > b ? [m.id, other] : [other, m.id];
          break;
        }
      }
      return { tree, missing: [...new Set(missing)], conflicted: !!pair, pair };
    };
    const better = (x, y) => !y || (y.conflicted && !x.conflicted) || (y.conflicted === x.conflicted && value(x.tree) < value(y.tree) - 1e-9);
    // On a conflict, try banning either part for the first few conflicts (small search tree),
    // then fall back to banning the less useful one. Keeps the best conflict-free build.
    let solves = 0;
    const search = (banned, branches) => {
      const r = attempt(banned);
      solves++;
      if (!r.pair || solves > 600) return r;
      const [worse, other] = r.pair;
      let res = search(new Set([...banned, worse]), Math.max(0, branches - 1));
      if (branches > 0) {
        const alt = search(new Set([...banned, other]), branches - 1);
        if (better(alt, res)) res = alt;
      }
      return res;
    };
    const result = search(new Set(), 3);
    // never prefer a build with conflicting parts over a valid one
    if (better(result, best)) best = result;
    if (totals(result.tree).ergo <= ERGO_CAP || ergoWeight < 0.01) break;
    ergoWeight *= 0.5;
  }
  return best;
}

function structuredCloneTree(nodes) {
  return nodes.map((n) => ({ slot: n.slot, mod: n.mod, children: structuredCloneTree(n.children || []) }));
}

/** Parts list, stats and availability for any build tree (computed, edited or saved). */
function evaluateTree(armory, weaponId, tree, ctx) {
  const weapon = armory.weapons.find((w) => w.id === weaponId);
  const mods = armory.mods;
  const parts = [];
  const walk = (parentItem, nodes, depth, prefix) => {
    for (const n of nodes) {
      const mod = mods[n.mod];
      if (!mod) continue;
      const slot = parentItem?.slots.find((s) => s.id === n.slot);
      const path = prefix ? `${prefix}/${n.slot}` : n.slot;
      parts.push({
        slot: slot?.name || n.slot,
        slotId: n.slot,
        required: !!slot?.required,
        path,
        parentId: parentItem?.id,
        mod,
        depth,
        avail: bestSource(mod.sources, ctx),
      });
      walk(mod, n.children || [], depth + 1, path);
    }
  };
  walk(weapon, tree, 0, '');
  const ids = new Set(parts.map((p) => p.mod.id));
  // a conflict listed on either part counts for both
  for (const p of parts) p.conflictsWith = [];
  for (const p of parts) {
    for (const id of p.mod.conflicts) {
      if (!ids.has(id) || id === p.mod.id) continue;
      const other = parts.find((q) => q.mod.id === id);
      if (!p.conflictsWith.includes(other.mod.shortName)) p.conflictsWith.push(other.mod.shortName);
      if (!other.conflictsWith.includes(p.mod.shortName)) other.conflictsWith.push(p.mod.shortName);
    }
  }
  const sumRecoil = parts.reduce((s, p) => s + p.mod.recoil, 0);
  const sumErgo = parts.reduce((s, p) => s + p.mod.ergo, 0);
  const cost = {};
  for (const p of parts) {
    const s = p.avail.source;
    if (s && s.price && s.kind !== 'barter') {
      const cur = s.kind === 'flea' ? 'RUB' : s.currency || 'RUB';
      cost[cur] = (cost[cur] || 0) + s.price;
    }
  }
  return {
    weapon,
    tree,
    parts,
    unavailable: parts.filter((p) => !p.avail.ok).length,
    conflicts: parts.filter((p) => p.conflictsWith.length).length,
    stats: {
      ergo: Math.round(Math.min(ERGO_CAP, weapon.ergo + sumErgo) * 10) / 10,
      ergoRaw: Math.round((weapon.ergo + sumErgo) * 10) / 10,
      recoilV: Math.round(weapon.recoilV * (1 + sumRecoil)),
      recoilH: Math.round(weapon.recoilH * (1 + sumRecoil)),
      weight: Math.round(parts.reduce((s, p) => s + p.mod.weight, 0) * 100) / 100,
      cost,
    },
  };
}

/**
 * Pick attachments for a weapon.
 * @returns { tree, parts: [{slot, mod, depth, avail, path}], stats, missing: [slot names], unavailable: n }
 */
function optimizeBuild(armory, weaponId, ctx, goalId = 'meta') {
  if (!armory.weapons.find((w) => w.id === weaponId)) return null;
  const { tree, missing } = optimizeTree(armory, weaponId, ctx, goalId);
  return { ...evaluateTree(armory, weaponId, tree, ctx), goal: goalId, missing };
}

/** Every slot in the build that has nothing in it: [{ path, slotId, name, required, depth, parentId }]. */
function emptySlots(armory, weaponId, tree) {
  const weapon = armory.weapons.find((w) => w.id === weaponId);
  const out = [];
  const walk = (item, nodes, depth, prefix) => {
    const filled = new Map(nodes.map((n) => [n.slot, n]));
    for (const slot of item.slots) {
      const path = prefix ? `${prefix}/${slot.id}` : slot.id;
      const n = filled.get(slot.id);
      if (n && armory.mods[n.mod]) walk(armory.mods[n.mod], n.children || [], depth + 1, path);
      else if (slot.allowed.some((id) => armory.mods[id]))
        out.push({ path, slotId: slot.id, name: slot.name, required: slot.required, depth, parentId: item.id });
    }
  };
  walk(weapon, tree, 0, '');
  return out;
}

/** Parts that fit a slot, best recoil first, with availability. */
function slotOptions(armory, parentId, slotId, ctx) {
  const parent = findItem(armory, parentId);
  const slot = parent?.slots.find((s) => s.id === slotId);
  if (!slot) return [];
  return slot.allowed
    .map((id) => armory.mods[id])
    .filter(Boolean)
    .map((mod) => ({ mod, avail: bestSource(mod.sources, ctx) }))
    .sort((a, b) => a.mod.recoil - b.mod.recoil || b.mod.ergo - a.mod.ergo || a.mod.name.localeCompare(b.mod.name));
}

/**
 * Put `modId` in the slot at `path` (null empties it). The new part's own attachments are
 * filled in with the best options for `goal`. Returns a new tree; the old one is untouched.
 */
function setPart(armory, weaponId, tree, path, modId, ctx, goalId = 'meta') {
  const next = structuredCloneTree(tree);
  const segs = path.split('/');
  let nodes = next;
  for (const seg of segs.slice(0, -1)) {
    const n = nodes.find((x) => x.slot === seg);
    if (!n) return next; // parent slot is empty: nothing to attach to
    nodes = n.children;
  }
  const last = segs[segs.length - 1];
  const i = nodes.findIndex((x) => x.slot === last);
  if (!modId) {
    if (i >= 0) nodes.splice(i, 1);
    return next;
  }
  const node = { slot: last, mod: modId, children: optimizeTree(armory, weaponId, ctx, goalId, modId).tree };
  if (i >= 0) nodes[i] = node;
  else nodes.push(node);
  return next;
}

const Armory = {
  traderLevelForPlayer,
  bestSource,
  armorRating,
  optimizeBuild,
  optimizeTree,
  evaluateTree,
  emptySlots,
  slotOptions,
  setPart,
  GOALS,
  FLEA_LEVEL,
};
if (typeof module !== 'undefined' && module.exports) module.exports = Armory;
if (typeof window !== 'undefined') window.Armory = Armory;
