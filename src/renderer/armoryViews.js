'use strict';
/* global Armory, escapeHtml, S, toast */
// Ammo chart and Gunsmith screens.

const AV = {
  armory: null,
  dataMode: null,
  loading: null,
  ammo: { caliber: null, search: '', sort: 'pen', dir: -1, onlyMine: false, weaponId: '' },
  // active: id of the saved build being shown (null = computed); tree: the build being shown/edited
  // (null = computed); dirty: edited since it was computed/loaded; naming: inline name box state.
  guns: { weaponId: null, search: '', goal: 'meta', scope: 'mine', active: null, tree: null, dirty: false, naming: null, showEmpty: false },
};

const CUR = { RUB: '₽', USD: '$', EUR: '€' };
const RIFLE = new Set(['Assault rifle', 'Assault carbine', 'Marksman rifle', 'Sniper rifle', 'Machinegun']);
const PISTOL = new Set(['Handgun', 'SMG', 'Revolver']);
const SKIP_CATEGORIES = new Set(['Grenade launcher', 'Rocket Launcher']);

async function ensureArmory(force) {
  const mode = S.state.dataMode;
  if (AV.armory && AV.dataMode === mode && !force) return AV.armory;
  if (!AV.loading || force) {
    AV.loading = window.tqm.getArmory({ mode: S.state.mode, force }).then((a) => {
      AV.armory = a;
      AV.dataMode = mode;
      AV.loading = null;
      AV.traderById = Object.fromEntries(a.traders.map((t) => [t.id, t]));
      AV.ammoById = Object.fromEntries(a.ammo.map((x) => [x.id, x]));
      return a;
    });
  }
  return AV.loading;
}

// ------------------------------------------------------------------ your progress (availability)
function inferredLevel() {
  let lvl = 1;
  for (const t of S.data?.tasks || []) {
    const st = S.state.taskStates[t.id]?.status;
    if (st === 'started' || st === 'completed') lvl = Math.max(lvl, t.minPlayerLevel || 1);
  }
  return lvl;
}

function availabilityCtx(unlimited = false) {
  if (unlimited) return { unlimited: true };
  const p = S.state.profile;
  const playerLevel = p.level || inferredLevel();
  const traderLevels = {};
  for (const t of AV.armory.traders) traderLevels[t.id] = p.traderLevels?.[t.id] ?? Armory.traderLevelForPlayer(t, playerLevel);
  const completedTasks = new Set(Object.entries(S.state.taskStates).filter(([, s]) => s.status === 'completed').map(([id]) => id));
  return { playerLevel, traderLevels, completedTasks, useFlea: p.useFlea, useBarters: p.useBarters };
}

function progressPanel() {
  const p = S.state.profile;
  const ctx = availabilityCtx();
  const traders = AV.armory.traders.filter((t) => t.normalizedName !== 'fence');
  return `<div class="progress-panel">
    <span class="pp-title">${escapeHtml(S.state.modeLabel)} · what you can get</span>
    <label>Level <input type="number" min="1" max="79" data-prog="level" value="${p.level || ''}" placeholder="${inferredLevel()}" title="Your player level. Empty = estimated from your quests (${inferredLevel()})"></label>
    ${traders
      .map(
        (t) => `<label title="${escapeHtml(t.name)} loyalty level${p.traderLevels?.[t.id] ? ' (set by you)' : ' (estimated from your level)'}">${escapeHtml(t.name)}
        <select data-trader="${t.id}" class="${p.traderLevels?.[t.id] ? 'set' : ''}">${t.levels.map((_, i) => `<option value="${i + 1}" ${ctx.traderLevels[t.id] === i + 1 ? 'selected' : ''}>LL${i + 1}</option>`).join('')}</select></label>`
      )
      .join('')}
    <label class="chk"><input type="checkbox" data-prog="useFlea" ${p.useFlea ? 'checked' : ''}> Flea (lvl ${Armory.FLEA_LEVEL}+)</label>
    <label class="chk"><input type="checkbox" data-prog="useBarters" ${p.useBarters ? 'checked' : ''}> Barters</label>
    ${Object.keys(p.traderLevels || {}).length ? '<button class="small-btn" data-prog="resetTraders">Reset LLs</button>' : ''}
  </div>`;
}

function wireProgressPanel(root) {
  root.addEventListener('change', (e) => {
    const t = e.target;
    const p = S.state.profile;
    if (t.dataset.trader) window.tqm.setProfile({ traderLevels: { ...(p.traderLevels || {}), [t.dataset.trader]: Number(t.value) } });
    if (t.dataset.prog === 'level') window.tqm.setProfile({ level: t.value ? Number(t.value) : null });
    if (t.dataset.prog === 'useFlea') window.tqm.setProfile({ useFlea: t.checked });
    if (t.dataset.prog === 'useBarters') window.tqm.setProfile({ useBarters: t.checked });
  });
  root.addEventListener('click', (e) => {
    if (e.target.dataset?.prog === 'resetTraders') window.tqm.setProfile({ traderLevels: {} });
  });
}

function money(price, cur = 'RUB') {
  if (!price) return '';
  return `${CUR[cur] || ''}${Math.round(price).toLocaleString()}`;
}

function sourceLabel(a) {
  const s = a.source;
  if (!s) return `<span class="src no">${escapeHtml(a.why)}</span>`;
  const trader = AV.traderById[s.trader]?.name || 'Trader';
  let txt;
  if (s.kind === 'flea') txt = `Flea ${money(s.price)}`;
  else if (s.kind === 'barter') txt = `${trader} LL${s.level} barter`;
  else txt = `${trader} LL${s.level} ${money(s.price, s.currency)}`;
  let quest = '';
  if (s.taskUnlock) quest = ` · quest: ${escapeHtml(S.taskById.get(s.taskUnlock)?.name || 'quest')}`;
  const title = s.kind === 'barter' ? `Barter for: ${s.cost.map((c) => `${c.count}× ${c.name}`).join(', ')}` : '';
  if (!a.ok) return `<span class="src no" title="${escapeHtml(title)}">${escapeHtml(a.why)}<br><span class="muted">${escapeHtml(txt)}${quest}</span></span>`;
  return `<span class="src ok src-${s.kind}" title="${escapeHtml(title)}">${escapeHtml(txt)}${quest}</span>`;
}

// ------------------------------------------------------------------ ammo chart
function caliberGroups() {
  const usedBy = {};
  for (const w of AV.armory.weapons) (usedBy[w.caliber] ||= []).push(w.category);
  const groups = { Rifle: [], 'Pistol & SMG': [], Shotgun: [], Other: [] };
  const counts = {};
  for (const a of AV.armory.ammo) counts[a.caliber] = (counts[a.caliber] || 0) + 1;
  for (const cal of Object.keys(counts)) {
    const cats = usedBy[cal] || [];
    const g = cats.some((c) => c === 'Shotgun') ? 'Shotgun' : cats.some((c) => RIFLE.has(c)) ? 'Rifle' : cats.some((c) => PISTOL.has(c)) ? 'Pistol & SMG' : 'Other';
    groups[g].push(cal);
  }
  for (const g of Object.values(groups)) g.sort((a, b) => AV.armory.calibers[a].localeCompare(AV.armory.calibers[b], undefined, { numeric: true }));
  return { groups, counts };
}

const AMMO_COLS = [
  ['name', 'Ammo', 'Name of the round'],
  ['damage', 'Dmg', 'Flesh damage per projectile. Higher = fewer hits to kill unarmored targets'],
  ['pen', 'Pen', 'Penetration power: the most important stat against armor'],
  ['armorDamage', 'Armor dmg', 'How much armor durability each hit removes (% of damage)'],
  ['frag', 'Frag', 'Chance to fragment for extra flesh damage'],
  ['speed', 'Speed', 'Muzzle velocity (m/s): flatter trajectory and less lead at range'],
  ['recoil', 'Recoil', 'Recoil modifier (negative is better)'],
  ['accuracy', 'Acc', 'Accuracy modifier (positive is better)'],
  ['c1', '1', 'Armor class 1'],
  ['c2', '2', 'Armor class 2'],
  ['c3', '3', 'Armor class 3'],
  ['c4', '4', 'Armor class 4'],
  ['c5', '5', 'Armor class 5'],
  ['c6', '6', 'Armor class 6'],
  ['get', 'Get it', 'Cheapest way to get it with your trader levels, quests and flea access'],
];

function renderAmmo() {
  const el = $('#view-ammo');
  if (!AV.armory) {
    el.innerHTML = '<p class="muted pad">Loading ammo data…</p>';
    return;
  }
  const st = AV.ammo;
  const ctx = availabilityCtx();
  const { groups, counts } = caliberGroups();
  const weapon = st.weaponId ? AV.armory.weapons.find((w) => w.id === st.weaponId) : null;
  const q = st.search.trim().toLowerCase();
  let rows = AV.armory.ammo.filter((a) => {
    if (weapon) return weapon.allowedAmmo.includes(a.id);
    if (st.caliber && a.caliber !== st.caliber) return false;
    if (q && !a.name.toLowerCase().includes(q)) return false;
    return true;
  });
  rows = rows.map((a) => ({ a, avail: Armory.bestSource(a.sources, ctx) }));
  if (st.onlyMine) rows = rows.filter((r) => r.avail.ok);
  const key = st.sort;
  const val = (r) => (key === 'name' ? r.a.name : key === 'get' ? (r.avail.ok ? 0 : 1) : /^c\d$/.test(key) ? r.a.pen : r.a[key] * (key === 'damage' ? r.a.projectiles : 1));
  rows.sort((x, y) => {
    const a = val(x);
    const b = val(y);
    return (typeof a === 'string' ? a.localeCompare(b) : a - b) * st.dir || y.a.pen - x.a.pen;
  });
  const mine = rows.filter((r) => r.avail.ok);
  const bestPen = mine.length ? Math.max(...mine.map((r) => r.a.pen)) : null;
  const bestDmg = mine.length ? Math.max(...mine.map((r) => r.a.damage * r.a.projectiles)) : null;
  const pct = (v) => (v ? `${Math.round(v * 100)}%` : '–');
  const signed = (v) => (v ? `${v > 0 ? '+' : ''}${Math.round(v * 100)}%` : '–');

  const calList = Object.entries(groups)
    .filter(([, cals]) => cals.length)
    .map(
      ([g, cals]) =>
        `<h4>${g}</h4>${cals
          .map((c) => `<button class="cal ${st.caliber === c && !weapon ? 'active' : ''}" data-cal="${c}">${escapeHtml(AV.armory.calibers[c])}<span>${counts[c]}</span></button>`)
          .join('')}`
    )
    .join('');
  const weaponsSorted = AV.armory.weapons.filter((w) => !SKIP_CATEGORIES.has(w.category)).sort((a, b) => a.name.localeCompare(b.name));

  el.innerHTML = `${progressPanel()}
  <div class="split">
    <nav class="side-list">
      <button class="cal ${!st.caliber && !weapon ? 'active' : ''}" data-cal="">All calibers<span>${AV.armory.ammo.length}</span></button>
      ${calList}
    </nav>
    <section class="main-pane">
      <div class="toolbar">
        <h2>${weapon ? `Ammo for ${escapeHtml(weapon.shortName)}` : st.caliber ? escapeHtml(AV.armory.calibers[st.caliber]) : 'All ammo'}</h2>
        <input type="search" id="ammo-search" placeholder="Search ammo…" value="${escapeHtml(st.search)}">
        <select id="ammo-weapon"><option value="">Pick a weapon…</option>${weaponsSorted.map((w) => `<option value="${w.id}" ${w.id === st.weaponId ? 'selected' : ''}>${escapeHtml(w.name)}</option>`).join('')}</select>
        <label class="chk"><input type="checkbox" id="ammo-mine" ${st.onlyMine ? 'checked' : ''}> Only what I can get</label>
      </div>
      <table class="ammo-table">
        <thead><tr>${AMMO_COLS.map(([k, label, tip]) => `<th data-sort="${k}" title="${escapeHtml(tip)}" class="${k === st.sort ? (st.dir < 0 ? 'desc' : 'asc') : ''} ${/^c\d$/.test(k) ? 'cls' : ''}">${label}</th>`).join('')}</tr></thead>
        <tbody>${rows
          .map(({ a, avail }) => {
            const dmg = a.projectiles > 1 ? `${a.damage}×${a.projectiles}` : a.damage;
            const badges = [];
            if (avail.ok && a.pen === bestPen && rows.length > 1) badges.push('<span class="badge-best">best pen you can get</span>');
            if (avail.ok && a.damage * a.projectiles === bestDmg && rows.length > 1 && a.pen !== bestPen) badges.push('<span class="badge-flesh">most flesh dmg</span>');
            const bleed = [a.lightBleed ? `light bleed +${Math.round(a.lightBleed * 100)}%` : '', a.heavyBleed ? `heavy bleed +${Math.round(a.heavyBleed * 100)}%` : '', a.tracer ? 'tracer' : '', `ricochet ${pct(a.ricochet)}`].filter(Boolean).join(' · ');
            return `<tr class="${avail.ok ? '' : 'unavail'}">
              <td class="name"><img src="${escapeHtml(a.icon)}" alt="" loading="lazy"><div><b>${escapeHtml(a.shortName)}</b> ${badges.join(' ')}<div class="muted small">${escapeHtml(AV.armory.calibers[a.caliber])}${bleed ? ` · ${escapeHtml(bleed)}` : ''}</div></div></td>
              <td>${dmg}</td><td class="pen">${a.pen}</td><td>${pct(a.armorDamage / 100)}</td><td>${pct(a.frag)}</td><td>${a.speed}</td>
              <td class="${a.recoil < 0 ? 'good' : a.recoil > 0 ? 'bad' : ''}">${signed(a.recoil)}</td>
              <td class="${a.accuracy > 0 ? 'good' : a.accuracy < 0 ? 'bad' : ''}">${signed(a.accuracy)}</td>
              ${[1, 2, 3, 4, 5, 6].map((c) => `<td class="cls r${Armory.armorRating(a.pen, c)}">${Armory.armorRating(a.pen, c)}</td>`).join('')}
              <td>${sourceLabel(avail)}</td>
            </tr>`;
          })
          .join('')}</tbody>
      </table>
      ${rows.length ? '' : '<p class="muted pad">No ammo matches. Try turning off "Only what I can get".</p>'}
      <p class="muted small pad">Armor columns rate how well a round goes through fresh armor of that class, from 0 (bounces) to 6 (goes straight through). Rule of thumb: penetration needs to beat the class × 10, and every extra 5 points helps a lot. Damaged armor is easier to get through. Data: tarkov.dev (${escapeHtml(AV.dataMode)}).</p>
    </section>
  </div>`;
}

function wireAmmo() {
  const el = $('#view-ammo');
  wireProgressPanel(el);
  el.addEventListener('click', (e) => {
    const cal = e.target.closest('[data-cal]');
    if (cal) {
      AV.ammo.caliber = cal.dataset.cal || null;
      AV.ammo.weaponId = '';
      return renderAmmo();
    }
    const th = e.target.closest('th[data-sort]');
    if (th) {
      const k = th.dataset.sort;
      AV.ammo.dir = AV.ammo.sort === k ? -AV.ammo.dir : k === 'name' || k === 'get' ? 1 : -1;
      AV.ammo.sort = k;
      renderAmmo();
    }
  });
  el.addEventListener('change', (e) => {
    if (e.target.id === 'ammo-mine') {
      AV.ammo.onlyMine = e.target.checked;
      renderAmmo();
    }
    if (e.target.id === 'ammo-weapon') {
      AV.ammo.weaponId = e.target.value;
      renderAmmo();
    }
  });
  el.addEventListener('input', (e) => {
    if (e.target.id !== 'ammo-search') return;
    AV.ammo.search = e.target.value;
    clearTimeout(AV.ammoTimer);
    AV.ammoTimer = setTimeout(() => {
      renderAmmo();
      const s = $('#ammo-search');
      s.focus();
      s.setSelectionRange(s.value.length, s.value.length);
    }, 200);
  });
}

// ------------------------------------------------------------------ gunsmith
// Computed builds are cached: the screen redraws on every app update and solving can take ~0.5 s.
const buildCache = new Map();
function cachedOptimize(weaponId, ctx, goal) {
  const sig = ctx.unlimited
    ? 'all'
    : JSON.stringify([ctx.playerLevel, ctx.traderLevels, ctx.useFlea, ctx.useBarters, [...ctx.completedTasks].sort().join(',')]);
  const key = `${AV.dataMode}|${weaponId}|${goal}|${sig}`;
  if (!buildCache.has(key)) {
    if (buildCache.size > 60) buildCache.clear();
    buildCache.set(key, Armory.optimizeBuild(AV.armory, weaponId, ctx, goal));
  }
  return buildCache.get(key);
}
function statCell(label, value, compare, lowerBetter) {
  let delta = '';
  if (compare != null && compare !== value) {
    const better = lowerBetter ? value < compare : value > compare;
    delta = `<span class="${better ? 'good' : 'bad'}">${value > compare ? '+' : ''}${Math.round((value - compare) * 10) / 10} vs stock</span>`;
  }
  return `<div class="stat"><div class="label">${label}</div><div class="value">${value}</div>${delta}</div>`;
}

function renderGuns() {
  const el = $('#view-guns');
  if (!AV.armory) {
    el.innerHTML = '<p class="muted pad">Loading weapon data…</p>';
    return;
  }
  const st = AV.guns;
  const q = st.search.trim().toLowerCase();
  const weapons = AV.armory.weapons.filter((w) => !SKIP_CATEGORIES.has(w.category));
  if (!st.weaponId) st.weaponId = (weapons.find((w) => /M4A1/.test(w.name)) || weapons[0]).id;
  const byCat = {};
  for (const w of weapons) {
    if (q && !w.name.toLowerCase().includes(q) && !(AV.armory.calibers[w.caliber] || '').toLowerCase().includes(q)) continue;
    (byCat[w.category] ||= []).push(w);
  }
  const ctx = availabilityCtx();
  const w = AV.armory.weapons.find((x) => x.id === st.weaponId);
  const evalCtx = st.scope === 'all' ? { unlimited: true } : ctx;
  const saved = S.state.builds?.[w.id] || [];
  const activeSaved = saved.find((b) => b.id === st.active) || null;
  if (st.active && !activeSaved) Object.assign(st, { active: null, tree: null, dirty: false });
  const computed = st.tree ? null : cachedOptimize(w.id, evalCtx, st.goal);
  const build = st.tree ? { ...Armory.evaluateTree(AV.armory, w.id, st.tree, evalCtx), missing: [] } : computed;
  AV.guns.shownTree = build.tree; // what the part pickers edit
  const endgame = st.scope === 'mine' ? cachedOptimize(w.id, { unlimited: true }, st.goal) : null;
  const empty = Armory.emptySlots(AV.armory, w.id, build.tree);
  const itemName = (id) => AV.armory.mods[id]?.shortName || AV.armory.weapons.find((x) => x.id === id)?.shortName || '';
  const pct = (r) => (r ? `${r > 0 ? '+' : ''}${Math.round(r * 1000) / 10}%` : '0%');
  const optionList = (parentId, slotId, selected, allowEmpty) =>
    (allowEmpty ? `<option value="">${selected ? '— Remove part —' : '— Empty —'}</option>` : '') +
    Armory.slotOptions(AV.armory, parentId, slotId, evalCtx)
      .map((o) => `<option value="${o.mod.id}" ${o.mod.id === selected ? 'selected' : ''}>${escapeHtml(o.mod.shortName)} · recoil ${pct(o.mod.recoil)} · ergo ${o.mod.ergo > 0 ? '+' : ''}${o.mod.ergo}${o.avail.ok ? '' : ' · 🔒 ' + escapeHtml(o.avail.why)}</option>`)
      .join('');
  const savedStats = (b) => Armory.evaluateTree(AV.armory, w.id, b.tree, evalCtx).stats;
  const naming = st.naming;
  const buildsBar = `<div class="builds-bar">
    <span class="bb-title">Builds</span>
    <button class="build-chip ${!st.tree ? 'active' : ''}" data-build="computed" title="Worked out for you from the goal above">⚙ ${escapeHtml(Armory.GOALS[st.goal].label)}</button>
    ${saved
      .map((b) => {
        const s = savedStats(b);
        return `<button class="build-chip ${st.active === b.id ? 'active' : ''}" data-build="${b.id}" title="Saved ${escapeHtml(new Date(b.updatedAt).toLocaleString())}">💾 ${escapeHtml(b.name)}${st.active === b.id && st.dirty ? ' •' : ''}<span>${s.recoilV}/${s.recoilH} · ergo ${s.ergo}</span></button>`;
      })
      .join('')}
    ${st.tree && !st.active ? '<span class="build-chip active edited">✎ Edited, not saved</span>' : ''}
    <span class="spacer"></span>
    ${
      naming
        ? `<input id="build-name" maxlength="60" value="${escapeHtml(naming.value)}" placeholder="Build name"><button class="primary small-btn" data-bact="name-ok">${naming.kind === 'rename' ? 'Rename' : 'Save'}</button><button class="small-btn" data-bact="name-cancel">Cancel</button>`
        : `${activeSaved && st.dirty ? '<button class="primary small-btn" data-bact="update">💾 Save changes</button>' : ''}
           <button class="small-btn" data-bact="save-new">💾 Save as new</button>
           ${activeSaved ? '<button class="small-btn" data-bact="rename">Rename</button><button class="small-btn danger" data-bact="delete">Delete</button>' : ''}
           ${st.tree ? '<button class="small-btn" data-bact="reset" title="Throw away edits and show the computed build">↺ Computed build</button>' : ''}`
    }
  </div>`;
  const gunAvail = Armory.bestSource(w.sources, ctx);
  const ammo = w.allowedAmmo
    .map((id) => AV.ammoById[id])
    .filter(Boolean)
    .map((a) => ({ a, avail: Armory.bestSource(a.sources, ctx) }))
    .filter((r) => r.avail.ok)
    .sort((x, y) => y.a.pen - x.a.pen)
    .slice(0, 3);
  const stock = w.preset;
  const costs = Object.entries(build.stats.cost)
    .map(([cur, v]) => money(v, cur))
    .join(' + ');

  el.innerHTML = `${progressPanel()}
  <div class="split">
    <nav class="side-list">
      <input type="search" id="gun-search" placeholder="Search weapons…" value="${escapeHtml(st.search)}">
      ${Object.entries(byCat)
        .sort()
        .map(([cat, list]) => `<h4>${escapeHtml(cat)}</h4>${list.sort((a, b) => a.name.localeCompare(b.name)).map((x) => `<button class="cal ${x.id === w.id ? 'active' : ''}" data-gun="${x.id}" title="${escapeHtml(x.name)}">${escapeHtml(x.shortName)}<span>${escapeHtml(AV.armory.calibers[x.caliber] || '')}</span></button>`).join('')}`)
        .join('')}
    </nav>
    <section class="main-pane gunsmith">
      <div class="gun-head">
        <img src="${escapeHtml(w.image)}" alt="">
        <div>
          <h2>${escapeHtml(w.name)}</h2>
          <div class="muted">${escapeHtml(w.category)} · ${escapeHtml(AV.armory.calibers[w.caliber] || w.caliber)} · ${w.fireRate} RPM</div>
          <div class="small">Get the gun: ${sourceLabel(gunAvail)}</div>
          ${w.wikiLink ? `<button class="small-btn" data-link="${escapeHtml(w.wikiLink)}">Wiki</button>` : ''}
        </div>
      </div>
      <div class="toolbar">
        <div class="seg">${Object.entries(Armory.GOALS).map(([k, g]) => `<button data-goal="${k}" class="${st.goal === k ? 'active' : ''}">${g.label}</button>`).join('')}</div>
        <div class="seg">
          <button data-scope="mine" class="${st.scope === 'mine' ? 'active' : ''}" title="Only parts your trader levels, finished quests and flea access unlock">What I can get now</button>
          <button data-scope="all" class="${st.scope === 'all' ? 'active' : ''}" title="Every part, as if all traders are LL4 and every quest is done">Endgame meta</button>
        </div>
      </div>
      ${buildsBar}
      <div class="stats">
        ${statCell('Vertical recoil', build.stats.recoilV, stock?.recoilV, true)}
        ${statCell('Horizontal recoil', build.stats.recoilH, stock?.recoilH, true)}
        ${statCell('Ergonomics', build.stats.ergo, stock?.ergo, false)}
        <div class="stat"><div class="label">Parts cost</div><div class="value small-value">${costs || '–'}</div>${build.parts.some((p) => p.avail.source?.kind === 'barter') ? '<span class="muted">+ barters</span>' : ''}</div>
        ${endgame ? `<div class="stat endgame"><div class="label">Endgame meta</div><div class="value small-value">${endgame.stats.recoilV} / ${endgame.stats.recoilH} · ergo ${endgame.stats.ergo}</div><span class="muted">vertical / horizontal</span></div>` : ''}
      </div>
      ${build.conflicts ? '<p class="warn-box">Some parts in this build can\'t be fitted together (marked ⚠). Change one of them.</p>' : ''}
      ${build.missing.length ? `<p class="warn-box">You can't get a required part yet (${escapeHtml(build.missing.join(', '))}). The best one is shown anyway, marked in red.</p>` : ''}
      <table class="parts">
        <thead><tr><th>Slot</th><th>Part</th><th title="Ergonomics">Ergo</th><th title="Recoil modifier">Recoil</th><th>Get it</th></tr></thead>
        <tbody>${build.parts
          .map(
            (p) => `<tr class="${p.avail.ok ? '' : 'unavail'}">
            <td class="slot" style="padding-left:${8 + p.depth * 16}px">${p.depth ? '└ ' : ''}${escapeHtml(p.slot)}</td>
            <td class="name"><img src="${escapeHtml(p.mod.icon)}" alt="" loading="lazy"><div class="part-cell"><select class="part-pick" data-path="${escapeHtml(p.path)}" title="${escapeHtml(p.mod.name)}: change or remove this part">${optionList(p.parentId, p.slotId, p.mod.id, !p.required)}</select>${p.conflictsWith.length ? `<div class="conf">⚠ Can't be fitted with ${escapeHtml(p.conflictsWith.join(', '))}</div>` : ''}</div></td>
            <td class="${p.mod.ergo > 0 ? 'good' : p.mod.ergo < 0 ? 'bad' : ''}">${p.mod.ergo ? (p.mod.ergo > 0 ? '+' : '') + p.mod.ergo : '–'}</td>
            <td class="${p.mod.recoil < 0 ? 'good' : p.mod.recoil > 0 ? 'bad' : ''}">${p.mod.recoil ? `${p.mod.recoil > 0 ? '+' : ''}${Math.round(p.mod.recoil * 1000) / 10}%` : '–'}</td>
            <td>${sourceLabel(p.avail)}</td></tr>`
          )
          .join('')}</tbody>
      </table>
      ${
        empty.length
          ? `<button class="small-btn" data-bact="toggle-empty">${st.showEmpty ? '▾ Hide' : '▸ Show'} ${empty.length} empty slot${empty.length > 1 ? 's' : ''} you could add parts to</button>
      ${
        st.showEmpty
          ? `<table class="parts empty-slots"><tbody>${empty
              .map(
                (s) => `<tr><td class="slot" style="padding-left:${8 + s.depth * 16}px">${s.depth ? '└ ' : ''}${escapeHtml(s.name)} <span class="muted small">on ${escapeHtml(itemName(s.parentId))}</span></td>
                <td class="name"><select class="part-pick" data-path="${escapeHtml(s.path)}">${optionList(s.parentId, s.slotId, null, true).replace('— Empty —', '— Add a part —')}</select></td></tr>`
              )
              .join('')}</tbody></table>`
          : ''
      }`
          : ''
      }
      <p class="muted small">Pick a different part in any slot and its own attachments are filled in for the goal above. Then save it as one of your builds. 🔒 = you can't get it yet.</p>
      <p class="muted small">Optics, lights and lasers are up to you, so they're left off. Recoil and ergonomics use the game's own formula (checked against all 164 default presets). "Meta" means the lowest recoil the parts allow, not a list copied from streamers.</p>
      <h3>Best ammo you can get for it</h3>
      ${
        ammo.length
          ? `<div class="ammo-picks">${ammo.map(({ a, avail }) => `<div class="need"><img src="${escapeHtml(a.icon)}" alt=""><b>${escapeHtml(a.shortName)}</b><span>Pen ${a.pen} · Dmg ${a.projectiles > 1 ? `${a.damage}×${a.projectiles}` : a.damage}</span>${sourceLabel(avail)}</div>`).join('')}</div>`
          : '<p class="muted small">None of its ammo is available to you yet.</p>'
      }
      <button class="small-btn" id="gun-ammo-chart">See all ammo for this gun</button>
    </section>
  </div>`;
}

function discardEditsOk() {
  return !AV.guns.dirty || confirm('You have unsaved changes to this build. Throw them away?');
}

function defaultBuildName(w) {
  const n = (S.state.builds?.[w.id] || []).length + 1;
  return `${w.shortName} ${Armory.GOALS[AV.guns.goal].label.replace(/ \(meta\)/, '')} #${n}`;
}

async function buildAction(act) {
  const st = AV.guns;
  const w = AV.armory.weapons.find((x) => x.id === st.weaponId);
  const saved = S.state.builds?.[w.id] || [];
  const activeSaved = saved.find((b) => b.id === st.active);
  if (act === 'save-new') st.naming = { kind: 'new', value: activeSaved ? `${activeSaved.name} (copy)` : defaultBuildName(w) };
  else if (act === 'rename') st.naming = { kind: 'rename', value: activeSaved.name };
  else if (act === 'name-cancel') st.naming = null;
  else if (act === 'name-ok') {
    const name = (document.getElementById('build-name')?.value || st.naming.value || '').trim() || defaultBuildName(w);
    if (st.naming.kind === 'rename') await window.tqm.saveBuild(w.id, { id: st.active, name });
    else {
      const tree = st.shownTree;
      st.active = await window.tqm.saveBuild(w.id, { name, goal: st.goal, tree });
      st.tree = tree;
      st.dirty = false;
    }
    st.naming = null;
    toast(`Saved "${name}"`, 'ok');
  } else if (act === 'update') {
    await window.tqm.saveBuild(w.id, { id: st.active, name: activeSaved.name, tree: st.tree });
    st.dirty = false;
    toast(`Saved changes to "${activeSaved.name}"`, 'ok');
  } else if (act === 'delete') {
    if (!confirm(`Delete the build "${activeSaved.name}"?`)) return;
    await window.tqm.deleteBuild(w.id, st.active);
    Object.assign(st, { active: null, tree: null, dirty: false });
    toast(`Deleted "${activeSaved.name}"`);
  } else if (act === 'reset') {
    if (!discardEditsOk()) return;
    Object.assign(st, { active: null, tree: null, dirty: false });
  } else if (act === 'toggle-empty') st.showEmpty = !st.showEmpty;
  renderGuns();
  if (st.naming) {
    const input = document.getElementById('build-name');
    input?.focus();
    input?.select();
  }
}

function wireGuns() {
  const el = $('#view-guns');
  wireProgressPanel(el);
  el.addEventListener('change', (e) => {
    const sel = e.target.closest('.part-pick');
    if (!sel) return;
    const st = AV.guns;
    const ctx = st.scope === 'all' ? { unlimited: true } : availabilityCtx();
    st.tree = Armory.setPart(AV.armory, st.weaponId, st.shownTree, sel.dataset.path, sel.value || null, ctx, st.goal);
    st.dirty = true;
    renderGuns();
  });
  el.addEventListener('keydown', (e) => {
    if (e.target.id !== 'build-name') return;
    if (e.key === 'Enter') buildAction('name-ok');
    if (e.key === 'Escape') buildAction('name-cancel');
  });
  el.addEventListener('input', (e) => {
    if (e.target.id === 'build-name' && AV.guns.naming) AV.guns.naming.value = e.target.value;
  });
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.bact) return buildAction(b.dataset.bact);
    if (b.dataset.build) {
      const st = AV.guns;
      if (b.dataset.build === (st.active || (st.tree ? '' : 'computed'))) return;
      if (!discardEditsOk()) return;
      if (b.dataset.build === 'computed') Object.assign(st, { active: null, tree: null, dirty: false });
      else {
        const sb = (S.state.builds?.[st.weaponId] || []).find((x) => x.id === b.dataset.build);
        Object.assign(st, { active: sb.id, tree: JSON.parse(JSON.stringify(sb.tree)), dirty: false });
      }
      st.naming = null;
      return renderGuns();
    }
    if (b.dataset.gun) {
      if (b.dataset.gun === AV.guns.weaponId || !discardEditsOk()) return;
      Object.assign(AV.guns, { weaponId: b.dataset.gun, active: null, tree: null, dirty: false, naming: null });
    }
    else if (b.dataset.goal) AV.guns.goal = b.dataset.goal;
    else if (b.dataset.scope) AV.guns.scope = b.dataset.scope;
    else if (b.dataset.link) return window.tqm.openLink(b.dataset.link);
    else if (b.id === 'gun-ammo-chart') {
      AV.ammo.weaponId = AV.guns.weaponId;
      return window.showView('ammo');
    } else return;
    renderGuns();
  });
  el.addEventListener('input', (e) => {
    if (e.target.id !== 'gun-search') return;
    AV.guns.search = e.target.value;
    clearTimeout(AV.gunTimer);
    AV.gunTimer = setTimeout(() => {
      renderGuns();
      const s = $('#gun-search');
      s.focus();
      s.setSelectionRange(s.value.length, s.value.length);
    }, 200);
  });
}

window.ArmoryViews = { ensureArmory, renderAmmo, renderGuns, wireAmmo, wireGuns };
