'use strict';
/* global S, escapeHtml, Bosses, QuestDetails, selectMap, showView */
// Bosses tab: every boss, guard and dangerous AI, what they look like (tarkov.dev renders and
// in-game shots from the wiki), what gear they can wear, and which maps they spawn on.

const BV = { data: null, sig: '', query: '', map: '', pics: new Map(), observer: null };
const WIKI_BASE = 'https://escapefromtarkov.fandom.com/wiki/';
const BV_SECTIONS = { bosses: 'Bosses', guards: 'Guards', others: 'Other dangerous AI' };
const BV_KIND = { bosses: 'Boss', guards: 'Guard', others: 'AI' };
const WEAR_LABEL = { Headwear: 'Headwear', FaceCover: 'Face cover', Eyewear: 'Eyewear', ArmorVest: 'Armor', TacticalVest: 'Rig / carrier', Backpack: 'Backpack' };
const pctText = (c) => `${Math.max(1, Math.round(c * 100))}%`;
const cardId = (key) => `boss-${key.replace(/[^a-z0-9]+/gi, '-')}`;

function bvItemIcons(ids, max = 10, cls = '') {
  const shown = ids.slice(0, max);
  const icons = shown
    .map((id) => {
      const it = S.data.items[id];
      if (!it) return '';
      const src = it.iconLink || it.image;
      return `<span class="bv-item${cls}" title="${escapeHtml(it.name)}">${src ? `<img src="${escapeHtml(src)}" alt="" loading="lazy">` : escapeHtml(it.shortName || it.name)}</span>`;
    })
    .join('');
  return icons + (ids.length > max ? `<span class="muted small bv-more" title="${escapeHtml(ids.slice(max).map((id) => S.data.items[id]?.name || '').join(', '))}">+${ids.length - max}</span>` : '');
}

function bossCardHtml(c) {
  const img = c.poster || c.portrait;
  const wears = Object.keys(WEAR_LABEL).filter((slot) => c.wears[slot]?.length);
  return `<article class="boss-card section-${c.section}" id="${cardId(c.key)}" data-boss="${escapeHtml(c.key)}">
    <div class="bc-pic">${img ? `<img src="${escapeHtml(img)}" alt="${escapeHtml(c.name)}" data-bv-pic="0" title="Enlarge">` : '<div class="bc-noimg">No picture</div>'}</div>
    <div class="bc-body">
      <header><h3>${escapeHtml(c.name)}</h3><span class="bc-kind">${BV_KIND[c.section]}</span>${c.health ? `<span class="muted small" title="Total health over all body parts">${c.health.toLocaleString()} HP</span>` : ''}</header>
      ${c.note ? `<p class="bc-note">${escapeHtml(c.note)}</p>` : ''}
      <div class="bc-row"><span class="bc-label">Spawns on</span><div class="bc-maps">${c.maps
        .map(
          (m) =>
            `<button class="map-chip" data-bv-map="${m.map}" title="${escapeHtml(`${m.name}: ${pctText(m.chance)} per raid${m.zones.length ? `\n${m.zones.join(', ')}` : ''}\nClick to open this map with boss spawns shown`)}">${escapeHtml(m.name)} <b>${pctText(m.chance)}</b></button>`,
        )
        .join('')}</div></div>
      ${(() => {
        const zones = c.maps.filter((m) => m.zones.length);
        return zones.length ? `<div class="bc-zones muted small">${zones.map((m) => `<span><b>${escapeHtml(m.name)}:</b> ${escapeHtml(m.zones.join(', '))}</span>`).join('')}</div>` : '';
      })()}
      ${c.guards.length ? `<div class="bc-row"><span class="bc-label">Guards</span><div>${c.guards.map((g) => `<a href="#" class="bv-goto" data-bv-goto="${escapeHtml(g.key)}">${escapeHtml(g.name)}</a> ×${g.count}`).join(', ')}</div></div>` : ''}
      ${c.guardOf.length ? `<div class="bc-row"><span class="bc-label">Guards for</span><div>${c.guardOf.map((g) => `<a href="#" class="bv-goto" data-bv-goto="${escapeHtml(g.key)}">${escapeHtml(g.name)}</a>`).join(', ')}</div></div>` : ''}
      ${wears.length ? `<div class="bc-gear"><div class="bc-label">Can wear</div><div class="bc-slots">${wears.map((slot) => `<div class="bc-slot"><span class="muted small">${WEAR_LABEL[slot]}</span><div class="bv-items">${bvItemIcons(c.wears[slot], 8)}</div></div>`).join('')}</div></div>` : ''}
      ${c.weapons.length ? `<div class="bc-gear"><div class="bc-label">Weapons</div><div class="bv-items">${bvItemIcons(c.weapons, 10, ' wide')}</div></div>` : ''}
      ${c.wiki ? `<div class="bc-pics" data-bv-pics="${escapeHtml(c.key)}"><span class="muted small">In-game pictures load from the wiki…</span></div>` : ''}
    </div>
  </article>`;
}

function bvMatches(c) {
  if (BV.map && !c.maps.some((m) => m.map === BV.map)) return false;
  const q = BV.query.trim().toLowerCase();
  if (!q) return true;
  return [c.name, ...c.maps.map((m) => m.name), ...c.maps.flatMap((m) => m.zones), ...c.guards.map((g) => g.name), ...c.guardOf.map((g) => g.name)].some((s) => s.toLowerCase().includes(q));
}

function renderBosses() {
  const el = document.getElementById('view-bosses');
  if (!S.data?.bossCatalog) {
    el.innerHTML = '<p class="muted pad">Loading…</p>';
    return;
  }
  const catalog = S.data.bossCatalog;
  if (BV.data !== S.data) {
    // new data (or PvE ↔ PvP): rebuild the toolbar too
    BV.data = S.data;
    BV.sig = '';
    const maps = [...new Map(catalog.flatMap((c) => c.maps.map((m) => [m.map, m.name]))).entries()].sort((a, b) => a[1].localeCompare(b[1]));
    if (BV.map && !maps.some(([id]) => id === BV.map)) BV.map = '';
    el.innerHTML = `<div class="bv-tools">
        <input id="bv-search" type="search" placeholder="Search bosses, guards, maps or spots…" value="${escapeHtml(BV.query)}">
        <select id="bv-map" title="Only show who can spawn on this map"><option value="">All maps</option>${maps.map(([id, name]) => `<option value="${id}" ${id === BV.map ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('')}</select>
        <span class="muted small">Spawn chances per raid from tarkov.dev (${S.data.dataMode === 'pve' ? 'PvE' : 'PvP'} data). Pictures: tarkov.dev and the EFT wiki, click to enlarge.</span>
      </div>
      <div class="bv-list" id="bv-list"></div>`;
  }
  const sig = `${BV.query}|${BV.map}`;
  if (BV.sig === sig) return;
  BV.sig = sig;
  const list = document.getElementById('bv-list');
  const shown = catalog.filter(bvMatches);
  let html = '';
  for (const [section, label] of Object.entries(BV_SECTIONS)) {
    const cards = shown.filter((c) => c.section === section);
    if (!cards.length) continue;
    html += `<h2 class="bv-section">${label} <span class="count">${cards.length}</span></h2><div class="bv-grid">${cards.map(bossCardHtml).join('')}</div>`;
  }
  list.innerHTML = html || '<p class="muted pad">Nobody matches. Try another search or map.</p>';
  list.scrollTop = 0;
  watchPictures(list);
}

// ------------------------------------------------------------------ wiki pictures, loaded as cards scroll into view
function wikiPage(page) {
  if (!BV.pics.has(page)) {
    BV.pics.set(
      page,
      window.tqm.wikiImages(WIKI_BASE + page).catch((err) => ({ images: [], error: String(err) })),
    );
  }
  return BV.pics.get(page);
}

function cardPictures(c, images) {
  const list = [];
  const img = c.poster || c.portrait;
  if (img) list.push({ full: img, caption: `${c.name} (tarkov.dev)` });
  for (const p of Bosses.lookPictures(images, c.picWords, c.picAvoid)) list.push({ thumb: p.thumb, full: p.full, caption: p.caption || c.name });
  return list;
}

async function loadCardPictures(box) {
  const c = S.data.bossCatalog.find((x) => x.key === box.dataset.bvPics);
  if (!c?.wiki) return;
  const r = await wikiPage(c.wiki);
  if (!box.isConnected) return;
  const pics = cardPictures(c, r.images || []).slice(1); // the first one is the poster shown on the left
  if (!pics.length) {
    box.innerHTML = r.error ? '<span class="muted small">Couldn’t reach the wiki for more pictures.</span>' : '';
    return;
  }
  box.innerHTML = `<div class="bc-label wide">In game · from the wiki</div><div class="bc-thumbs">${pics
    .map((p, i) => `<img src="${escapeHtml(p.thumb)}" alt="" data-bv-pic="${i + 1}" title="${escapeHtml(p.caption || 'Enlarge')}">`)
    .join('')}</div>`;
}

function watchPictures(list) {
  BV.observer?.disconnect();
  BV.observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        BV.observer.unobserve(e.target);
        loadCardPictures(e.target);
      }
    },
    { root: list, rootMargin: '300px' },
  );
  for (const box of list.querySelectorAll('[data-bv-pics]')) BV.observer.observe(box);
}

// ------------------------------------------------------------------ events
function wireBosses() {
  const el = document.getElementById('view-bosses');
  el.addEventListener('input', (e) => {
    if (e.target.id !== 'bv-search') return;
    BV.query = e.target.value;
    renderBosses();
  });
  el.addEventListener('keydown', (e) => {
    if (e.target.id === 'bv-search' && e.key === 'Escape' && e.target.value) {
      e.target.value = '';
      BV.query = '';
      renderBosses();
    }
  });
  el.addEventListener('change', (e) => {
    if (e.target.id !== 'bv-map') return;
    BV.map = e.target.value;
    renderBosses();
  });
  el.addEventListener('click', async (e) => {
    const pic = e.target.closest('[data-bv-pic]');
    if (pic) {
      const c = S.data.bossCatalog.find((x) => x.key === pic.closest('[data-boss]').dataset.boss);
      const page = c.wiki ? await wikiPage(c.wiki) : { images: [] };
      return QuestDetails.showPictures(cardPictures(c, page.images || []), Number(pic.dataset.bvPic));
    }
    const go = e.target.closest('[data-bv-goto]');
    if (go) {
      e.preventDefault();
      let card = document.getElementById(cardId(go.dataset.bvGoto));
      if (!card) {
        // filtered out: clear the filters so it shows
        BV.query = '';
        BV.map = '';
        BV.data = null;
        renderBosses();
        card = document.getElementById(cardId(go.dataset.bvGoto));
      }
      card?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      card?.classList.add('flash');
      setTimeout(() => card?.classList.remove('flash'), 1200);
      return;
    }
    const chip = e.target.closest('[data-bv-map]');
    if (chip) {
      if (!S.state.settings.showBosses) await window.tqm.setSettings({ showBosses: true });
      await showView('map');
      await selectMap(chip.dataset.bvMap);
    }
  });
  // a picture that fails to load (missing render) is hidden instead of showing a broken icon
  el.addEventListener(
    'error',
    (e) => {
      if (e.target.tagName !== 'IMG') return;
      if (e.target.closest('.bc-pic')) e.target.closest('.bc-pic').innerHTML = '<div class="bc-noimg">No picture</div>';
      else e.target.remove();
    },
    true,
  );
}

window.BossesView = { render: renderBosses, wire: wireBosses };
