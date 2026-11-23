'use strict';
/* global S, escapeHtml, baseMap, QuestDetails, selectMap, showView */
// Keys tab: every key and keycard, the map it belongs to, and how you get it: found in raid
// (with the maps it spawns on), barter, trader, quest reward or flea.

const KV = { data: null, sig: '', query: '', map: '', how: '' };
const KV_NO_MAP = 'none';
const KV_CUR = { RUB: '₽', USD: '$', EUR: '€' };
const kvMoney = (price, currency = 'RUB') => `${KV_CUR[currency] || ''}${Math.round(price).toLocaleString()}`;
const KV_HOW = {
  fir: ['Find in raid only', 'No trader, barter or quest gives it and it can’t be bought on the flea market'],
  spawns: ['Spawns in raid', 'Has known spawn spots on a map'],
  barter: ['Barter', 'A trader barters it'],
  trader: ['Trader', 'A trader sells it for money'],
  quest: ['Quest reward', 'A quest gives it'],
  flea: ['Flea market', 'Can be bought on the flea market'],
};

/** Everything the list needs for one key, worked out once per data load. */
function keyRows() {
  return S.data.keys
    .map((k) => {
      const it = S.data.items[k.id] || { name: k.id };
      const sources = it.sources || [];
      const how = new Set();
      if (Object.keys(k.spawns).length) how.add('spawns');
      if (sources.some((s) => s.kind === 'barter')) how.add('barter');
      if (sources.some((s) => s.kind === 'trader')) how.add('trader');
      if (sources.some((s) => s.kind === 'flea')) how.add('flea');
      if (k.rewards.length) how.add('quest');
      if (!how.has('barter') && !how.has('trader') && !how.has('flea') && !how.has('quest')) how.add('fir');
      const bases = [...new Set(k.maps.map(baseMap))];
      return { k, it, sources, how, bases };
    })
    .sort((a, b) => a.it.name.localeCompare(b.it.name));
}

const kvMapName = (id) => S.mapById.get(id)?.name || 'Unknown map';
const kvBaseName = (base) => S.data.maps.find((m) => m.normalizedName === base)?.name || base;

function lockText(c) {
  const parts = [];
  if (c.door) parts.push(`${c.door} door${c.door > 1 ? 's' : ''}`);
  if (c.trunk) parts.push(`${c.trunk} car trunk${c.trunk > 1 ? 's' : ''}`);
  if (c.other) parts.push(`${c.other} lock${c.other > 1 ? 's' : ''}`);
  return parts.join(', ');
}

function keyRowHtml({ k, it, sources, how }) {
  const img = it.image || it.iconLink;
  const taskLink = (id) => {
    const t = S.taskById.get(id);
    return t ? `<a href="#" data-kv-task="${t.id}">${escapeHtml(t.name)}</a>` : '';
  };
  // where it belongs: the maps with its locks (click to see them on the map), access keys, quest maps
  const belongs = k.maps.length
    ? k.maps
        .map((id) => {
          const locks = k.locks[id];
          const what = locks ? lockText(locks) : k.access.includes(id) ? 'needed to enter the map' : '';
          return locks
            ? `<button class="map-chip" data-kv-map="${id}" title="Show its locks on the map">${escapeHtml(kvMapName(id))}${what ? ` <span class="muted">· ${what}</span>` : ''}</button>`
            : `<span class="map-chip static">${escapeHtml(kvMapName(id))}${what ? ` <span class="muted">· ${what}</span>` : ''}</span>`;
        })
        .join('')
    : '<span class="muted small">No known map</span>';
  const lines = [];
  if (how.has('fir')) lines.push(`<div><span class="kv-badge fir" title="${KV_HOW.fir[1]}">FIR only</span> Find it in raid${Object.keys(k.spawns).length ? '' : ' (no fixed spawn spot known: random loot)'}</div>`);
  if (how.has('spawns')) {
    const spots = Object.entries(k.spawns)
      .sort((a, b) => b[1] - a[1])
      .map(([id, n]) => `${escapeHtml(kvMapName(id))} <span class="muted">(${n} spot${n > 1 ? 's' : ''})</span>`)
      .join(', ');
    lines.push(`<div><span class="kv-badge spawns" title="${KV_HOW.spawns[1]}">Spawns</span> ${spots}</div>`);
  }
  for (const r of k.rewards) lines.push(`<div><span class="kv-badge quest">Quest</span> ${r.start ? 'Given when you start' : 'Reward for'} ${taskLink(r.task)}</div>`);
  for (const s of sources.filter((x) => x.kind === 'barter')) {
    const items = (s.items || [])
      .map((x) => {
        const ri = S.data.items[x.id];
        return ri ? `<span class="kv-req" title="${escapeHtml(`${x.count}× ${ri.name}`)}">${ri.iconLink ? `<img src="${escapeHtml(ri.iconLink)}" alt="" loading="lazy">` : ''}${x.count > 1 ? `<b>${Math.round(x.count * 100) / 100}×</b>` : ''} ${escapeHtml(ri.shortName || ri.name)}</span>` : '';
      })
      .join('');
    lines.push(`<div class="kv-barter"><span class="kv-badge barter">Barter</span> ${escapeHtml(s.trader)} LL${s.level}${s.taskUnlock ? ` after ${taskLink(s.taskUnlock)}` : ''}${items ? `: ${items}` : ''}</div>`);
  }
  for (const s of sources.filter((x) => x.kind === 'trader')) lines.push(`<div><span class="kv-badge trader">Trader</span> ${escapeHtml(s.trader)} LL${s.level} ${kvMoney(s.price, s.currency)}${s.taskUnlock ? ` after ${taskLink(s.taskUnlock)}` : ''}</div>`);
  const flea = sources.find((x) => x.kind === 'flea');
  if (flea) lines.push(`<div><span class="kv-badge flea">Flea</span> about ${kvMoney(flea.price)}</div>`);
  else if (!how.has('fir')) lines.push('<div class="muted small">Can’t be bought on the flea market</div>');
  const needed = k.neededBy.map(taskLink).filter(Boolean);
  return `<div class="kv-row" data-key="${k.id}">
    <div class="kv-icon">${img ? `<img src="${escapeHtml(img)}" alt="" loading="lazy">` : ''}</div>
    <div class="kv-main">
      <div class="kv-name">${it.wikiLink ? `<a href="#" data-kv-wiki="${escapeHtml(it.wikiLink)}" title="Open on the wiki">${escapeHtml(it.name)}</a>` : escapeHtml(it.name)}</div>
      <div class="kv-maps">${belongs}</div>
      ${needed.length ? `<div class="small"><span class="muted">Needed for</span> ${needed.join(', ')}</div>` : ''}
    </div>
    <div class="kv-how">${lines.join('')}</div>
  </div>`;
}

function kvMatches(r) {
  if (KV.map === KV_NO_MAP ? r.k.maps.length : KV.map && !r.bases.includes(KV.map)) return false;
  if (KV.how && !r.how.has(KV.how)) return false;
  const q = KV.query.trim().toLowerCase();
  return !q || r.it.name.toLowerCase().includes(q) || (r.it.shortName || '').toLowerCase().includes(q);
}

function renderKeys() {
  const el = document.getElementById('view-keys');
  if (!S.data?.keys) {
    el.innerHTML = '<p class="muted pad">Loading…</p>';
    return;
  }
  if (KV.data !== S.data) {
    KV.data = S.data;
    KV.sig = '';
    KV.rows = keyRows();
    const counts = new Map();
    for (const r of KV.rows) for (const b of r.bases) counts.set(b, (counts.get(b) || 0) + 1);
    const none = KV.rows.filter((r) => !r.k.maps.length).length;
    const chips = [...counts.entries()].sort((a, b) => kvBaseName(a[0]).localeCompare(kvBaseName(b[0])));
    if (KV.map && KV.map !== KV_NO_MAP && !counts.has(KV.map)) KV.map = '';
    el.innerHTML = `<div class="bv-tools">
        <input id="kv-search" type="search" placeholder="Search keys…" value="${escapeHtml(KV.query)}">
        <select id="kv-how" title="How you get it">
          <option value="">Any way to get it</option>
          ${Object.entries(KV_HOW).map(([id, [label]]) => `<option value="${id}" ${KV.how === id ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
        <span class="muted small" id="kv-count"></span>
      </div>
      <div class="map-chips" id="kv-maps">
        <button class="chip-btn ${KV.map ? '' : 'on'}" data-kv-filter="">All maps <span class="muted">${KV.rows.length}</span></button>
        ${chips.map(([b, n]) => `<button class="chip-btn ${KV.map === b ? 'on' : ''}" data-kv-filter="${b}">${escapeHtml(kvBaseName(b))} <span class="muted">${n}</span></button>`).join('')}
        ${none ? `<button class="chip-btn ${KV.map === KV_NO_MAP ? 'on' : ''}" data-kv-filter="${KV_NO_MAP}" title="Keys whose lock isn't on any map in the data">No known map <span class="muted">${none}</span></button>` : ''}
      </div>
      <div class="bv-list" id="kv-list"></div>`;
  }
  const sig = `${KV.query}|${KV.map}|${KV.how}`;
  if (KV.sig === sig) return;
  KV.sig = sig;
  for (const b of el.querySelectorAll('[data-kv-filter]')) b.classList.toggle('on', b.dataset.kvFilter === KV.map);
  const shown = KV.rows.filter(kvMatches);
  document.getElementById('kv-count').textContent = `${shown.length} of ${KV.rows.length} keys · from tarkov.dev (${S.data.dataMode === 'pve' ? 'PvE' : 'PvP'} data)`;
  const list = document.getElementById('kv-list');
  list.innerHTML = shown.length ? shown.map(keyRowHtml).join('') : '<p class="muted pad">No keys match.</p>';
  list.scrollTop = 0;
}

function wireKeys() {
  const el = document.getElementById('view-keys');
  el.addEventListener('input', (e) => {
    if (e.target.id !== 'kv-search') return;
    KV.query = e.target.value;
    renderKeys();
  });
  el.addEventListener('keydown', (e) => {
    if (e.target.id === 'kv-search' && e.key === 'Escape' && e.target.value) {
      e.target.value = '';
      KV.query = '';
      renderKeys();
    }
  });
  el.addEventListener('change', (e) => {
    if (e.target.id !== 'kv-how') return;
    KV.how = e.target.value;
    renderKeys();
  });
  el.addEventListener('click', async (e) => {
    const f = e.target.closest('[data-kv-filter]');
    if (f) {
      KV.map = f.dataset.kvFilter;
      return renderKeys();
    }
    const task = e.target.closest('[data-kv-task]');
    if (task) {
      e.preventDefault();
      return QuestDetails.open(task.dataset.kvTask);
    }
    const wiki = e.target.closest('[data-kv-wiki]');
    if (wiki) {
      e.preventDefault();
      return window.tqm.openLink(wiki.dataset.kvWiki);
    }
    const icon = e.target.closest('.kv-icon img');
    if (icon) {
      const it = S.data.items[icon.closest('[data-key]').dataset.key];
      return QuestDetails.showPictures([{ full: it.image || it.iconLink, caption: it.name }], 0);
    }
    const chip = e.target.closest('[data-kv-map]');
    if (chip) {
      if (!S.state.settings.showLocks) await window.tqm.setSettings({ showLocks: true });
      await showView('map');
      await selectMap(chip.dataset.kvMap);
    }
  });
}

window.KeysView = { render: renderKeys, wire: wireKeys };
