'use strict';
/* global S, escapeHtml, taskState, statusChip, markComplete, unlockInfo, unlockBadges, keyIcon */
// "Details" panel for a quest: pictures from its wiki page, quest items, items to hand over, keys and rewards.

const OBJ_ITEM_LABEL = {
  giveItem: 'Hand over',
  findItem: 'Find',
  plantItem: 'Plant / stash',
  sellItem: 'Sell',
  useItem: 'Use',
  mark: 'Mark with',
};

function itemTile(id, count) {
  const it = S.data.items?.[id] || { name: id };
  const img = it.iconLink ? `<img src="${escapeHtml(it.iconLink)}" alt="" loading="lazy" data-zoom="${escapeHtml(it.image || it.iconLink)}" data-caption="${escapeHtml(it.name)}">` : '';
  const qty = count > 1 ? `<span class="qty">${count >= 1000 ? count.toLocaleString() : `×${count}`}</span>` : '';
  return `<div class="tile" title="${escapeHtml(it.name)}">${img}<span class="tile-name">${escapeHtml(it.shortName && it.name.length > 30 ? it.shortName : it.name)}</span>${qty}</div>`;
}

function tiles(ids, max = 8, count) {
  const shown = ids.slice(0, max).map((id) => itemTile(id, count)).join('');
  const more = ids.length > max ? `<div class="tile more" title="${escapeHtml(ids.slice(max).map((id) => S.data.items?.[id]?.name || id).join('\n'))}">+${ids.length - max} more<br><span class="muted">(any one)</span></div>` : '';
  return `<div class="tiles">${shown}${more}</div>`;
}

function objectiveHtml(o) {
  const parts = [];
  if (o.questItem) {
    const q = o.questItem;
    parts.push(`<div class="quest-item">
      <img src="${escapeHtml(q.image || q.iconLink)}" alt="" data-zoom="${escapeHtml(q.image || q.iconLink)}" data-caption="${escapeHtml(q.name)}">
      <div><b>${escapeHtml(q.name)}</b>${q.description ? `<p class="muted small">${escapeHtml(q.description)}</p>` : ''}</div>
    </div>`);
  }
  if (o.items?.length) {
    const any = o.items.length > 1 ? ' (any of these)' : '';
    parts.push(`<div class="obj-label">${OBJ_ITEM_LABEL[o.type] || 'Items'}${o.count > 1 ? ` ×${o.count}` : ''}${o.foundInRaid ? ' · <span class="fir">found in raid</span>' : ''}${any}</div>${tiles(o.items)}`);
  }
  if (o.markerItem) parts.push(`<div class="obj-label">Mark with</div>${tiles([o.markerItem])}`);
  if (o.useAny?.length) parts.push(`<div class="obj-label">Use${o.count > 1 ? ` ×${o.count}` : ''}</div>${tiles(o.useAny)}`);
  for (const alts of o.requiredKeys || []) parts.push(`<div class="obj-label">Key needed${alts.length > 1 ? ' (any one)' : ''}</div>${tiles(alts)}`);
  if (o.usingWeapon?.length) parts.push(`<div class="obj-label">Using weapon (any one)</div>${tiles(o.usingWeapon, 6)}`);
  for (const alts of o.usingWeaponMods || []) parts.push(`<div class="obj-label">With attachment</div>${tiles(alts, 6)}`);
  if (o.wearing?.length) parts.push(`<div class="obj-label">Wearing (any one set)</div>${tiles(o.wearing.flat(), 6)}`);
  return `<li class="${S.state.objectivesDone?.[o.id] ? 'done' : ''}">
    <div class="obj-text">${escapeHtml(o.description)}${o.optional ? ' <em>(optional)</em>' : ''}${o.maps.length ? ` <span class="muted small">· ${escapeHtml(o.maps.map((id) => S.mapById.get(id)?.name).filter(Boolean).join(', '))}</span>` : ''}</div>
    ${parts.join('')}
  </li>`;
}

function unlockTile(u) {
  return itemTile(u.id).replace('</span>', `</span><span class="tile-sub">${escapeHtml(u.trader)} LL${u.level}${u.kind === 'barter' ? ' · barter' : ''}</span>`);
}

function unlocksHtml(t) {
  const u = unlockInfo(t.id);
  let html = '';
  if (u.direct.length) html += `<h3>🔓 Unlocks at traders</h3><div class="tiles">${u.direct.map(unlockTile).join('')}</div>`;
  if (u.later.length) {
    const items = u.later
      .slice(0, 15)
      .map(
        (l) => `<li><a href="#" data-task="${l.task.id}">${escapeHtml(l.task.name)}</a> <span class="muted small">${escapeHtml(l.task.trader.name)} · ${l.steps} quest${l.steps > 1 ? 's' : ''} later</span>
          <div class="tiles small-tiles">${l.task.unlocks.slice(0, 6).map(unlockTile).join('')}${l.task.unlocks.length > 6 ? `<div class="tile more">+${l.task.unlocks.length - 6} more</div>` : ''}</div></li>`
      )
      .join('');
    html += `<h3>⤳ Leads to quests that unlock items</h3><ul class="later-unlocks">${items}</ul>`;
    if (u.later.length > 15) html += `<p class="muted small">…and ${u.later.length - 15} more further down the chain.</p>`;
  }
  return html;
}

const LIGHTBOX_HTML = `<div class="lightbox" hidden>
    <button class="lb-nav lb-prev" data-lb="-1" title="Previous (←)">‹</button>
    <img alt="">
    <button class="lb-nav lb-next" data-lb="1" title="Next (→)">›</button>
    <div class="caption"></div>
  </div>`;

function openQuestDetails(taskId) {
  const t = S.taskById.get(taskId);
  if (!t) return;
  const st = taskState(t.id);
  const keys = (t.neededKeys || []).filter((k) => k.keys.length);
  const r = t.rewards || { items: [], standing: [], offerUnlock: [], startItems: [] };
  const prereqs = t.taskRequirements.map((req) => S.taskById.get(req.task)).filter(Boolean);

  const el = document.getElementById('modal');
  el.innerHTML = `<div class="modal-card" role="dialog" aria-label="${escapeHtml(t.name)}">
    <header>
      <div>
        <h2>${escapeHtml(t.name)}${keyIcon(t)} ${t.kappaRequired ? '<span class="tag" title="Required for Kappa">Kappa</span>' : ''}${t.lightkeeperRequired ? ' <span class="tag">Lightkeeper</span>' : ''} ${unlockBadges(t)}</h2>
        <div class="muted">${escapeHtml(t.trader.name)} · level ${t.minPlayerLevel}${t.mapId ? ` · ${escapeHtml(S.mapById.get(t.mapId)?.name || '')}` : ''}${t.factionName && t.factionName !== 'Any' ? ` · ${escapeHtml(t.factionName)} only` : ''} ${statusChip(st)}</div>
      </div>
      <button class="close" data-close title="Close (Esc)">✕</button>
    </header>
    <div class="modal-body">
      ${t.wikiLink ? '<div class="wiki-pics" data-wiki-pics><p class="muted small">Loading pictures from the wiki…</p></div>' : ''}
      <h3>Objectives</h3>
      <ol class="details-objectives">${t.objectives.map(objectiveHtml).join('')}</ol>
      ${keys.length ? `<h3>Keys you'll need</h3>${keys.map((k) => `<div class="obj-label">${escapeHtml(S.mapById.get(k.map)?.name || 'Any map')}${k.keys.length > 1 ? ' (any one)' : ''}</div>${tiles(k.keys)}`).join('')}` : ''}
      ${r.startItems.length ? `<h3>Given when you start it</h3>${`<div class="tiles">${r.startItems.map((x) => itemTile(x.id, x.count)).join('')}</div>`}` : ''}
      <h3>Rewards</h3>
      ${r.items.length ? `<div class="tiles">${r.items.map((x) => itemTile(x.id, x.count)).join('')}</div>` : '<p class="muted small">No item rewards.</p>'}
      <p class="small">${[
        t.experience ? `+${t.experience.toLocaleString()} XP` : '',
        ...r.standing.map((s) => `${escapeHtml(s.trader)} ${s.standing > 0 ? '+' : ''}${s.standing}`),
      ]
        .filter(Boolean)
        .join(' · ')}</p>
      ${unlocksHtml(t)}
      ${prereqs.length ? `<h3>Comes after</h3><p class="small">${prereqs.map((p) => `<a href="#" data-task="${p.id}">${escapeHtml(p.name)}</a>`).join(', ')}</p>` : ''}
    </div>
    <footer>
      ${t.wikiLink ? '<button data-wiki>Wiki</button>' : ''}
      <span class="spacer"></span>
      ${st.status !== 'completed' ? '<button class="mark-complete" data-complete title="Mark this whole quest as completed. You can undo it.">☐ Mark Complete</button>' : ''}
    </footer>
  </div>
  ${LIGHTBOX_HTML}`;
  el.hidden = false;
  el.dataset.task = t.id;
  el.querySelector('[data-close]').focus();
  if (t.wikiLink) loadWikiPictures(t);
}

// Carousel of the pictures on the quest's wiki page (location shots, where items are...).
let wikiPics = [];
async function loadWikiPictures(t) {
  const el = document.getElementById('modal');
  const r = await window.tqm.wikiImages(t.wikiLink).catch((err) => ({ images: [], error: String(err) }));
  const box = el.querySelector('[data-wiki-pics]');
  if (!box || el.dataset.task !== t.id) return; // closed, or another quest opened meanwhile
  wikiPics = r.images || [];
  if (!wikiPics.length) {
    box.innerHTML = r.error ? '<p class="muted small">Couldn’t load pictures from the wiki.</p>' : '<p class="muted small">No pictures on this quest’s wiki page.</p>';
    return;
  }
  box.innerHTML = `<h3>Pictures <span class="count">${wikiPics.length}</span><span class="muted small"> · from the wiki, click to enlarge</span></h3>
    <div class="carousel">
      <button class="car-nav" data-car="-1" title="Scroll left">‹</button>
      <div class="car-track">${wikiPics
        .map(
          (p, i) => `<figure class="car-item" data-pic="${i}" title="${escapeHtml(p.caption || 'Enlarge')}"><img src="${escapeHtml(p.thumb)}" alt="">${p.caption ? `<figcaption>${escapeHtml(p.caption)}</figcaption>` : ''}</figure>`,
        )
        .join('')}</div>
      <button class="car-nav" data-car="1" title="Scroll right">›</button>
    </div>`;
}

// Lightbox: one picture, or a set you can step through with the arrows / ← →.
let lbList = [];
let lbIndex = 0;
function showLightbox(list, index) {
  const lb = document.querySelector('#modal .lightbox');
  if (!lb || !list.length) return;
  lbList = list;
  lbIndex = (index + list.length) % list.length;
  const p = lbList[lbIndex];
  lb.querySelector('img').src = p.full;
  lb.querySelector('.caption').textContent = `${p.caption || ''}${lbList.length > 1 ? `  (${lbIndex + 1} / ${lbList.length})` : ''}`.trim();
  for (const b of lb.querySelectorAll('.lb-nav')) b.hidden = lbList.length < 2;
  lb.hidden = false;
}

/** Just the enlarged-picture viewer, without a quest panel behind it (used by the Bosses tab). */
function showPictures(list, index = 0) {
  if (!list?.length) return;
  const el = document.getElementById('modal');
  el.innerHTML = LIGHTBOX_HTML;
  el.dataset.task = '';
  el.hidden = false;
  showLightbox(list, index);
}

// Closing the enlarged picture also closes the modal when there's no quest panel behind it
function hideLightbox(el, lb) {
  lb.hidden = true;
  if (!el.querySelector('.modal-card')) closeQuestDetails();
}

function closeQuestDetails() {
  const el = document.getElementById('modal');
  el.hidden = true;
  el.innerHTML = '';
  wikiPics = [];
}

function wireQuestDetails() {
  const el = document.getElementById('modal');
  el.addEventListener('click', async (e) => {
    const lb = el.querySelector('.lightbox');
    if (lb && !lb.hidden) {
      const nav = e.target.closest('[data-lb]');
      if (nav) return showLightbox(lbList, lbIndex + Number(nav.dataset.lb));
      hideLightbox(el, lb); // any other click closes the enlarged picture
      return;
    }
    const pic = e.target.closest('[data-pic]');
    if (pic) return showLightbox(wikiPics, Number(pic.dataset.pic));
    const car = e.target.closest('[data-car]');
    if (car) {
      const track = car.parentElement.querySelector('.car-track');
      track.scrollBy({ left: Number(car.dataset.car) * track.clientWidth * 0.8, behavior: 'smooth' });
      return;
    }
    const zoom = e.target.closest('[data-zoom]');
    if (zoom) return showLightbox([{ full: zoom.dataset.zoom, caption: zoom.dataset.caption || '' }], 0);
    if (e.target === el || e.target.closest('[data-close]')) return closeQuestDetails();
    const link = e.target.closest('a[data-task]'); // not the panel itself, which carries data-task too
    if (link) {
      e.preventDefault();
      return openQuestDetails(link.dataset.task);
    }
    const t = S.taskById.get(el.dataset.task);
    if (e.target.closest('[data-wiki]')) window.tqm.openLink(t.wikiLink);
    if (e.target.closest('[data-complete]')) {
      await markComplete(t.id);
      closeQuestDetails();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (el.hidden) return;
    const lb = el.querySelector('.lightbox');
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && lb && !lb.hidden) {
      e.preventDefault();
      return showLightbox(lbList, lbIndex + (e.key === 'ArrowRight' ? 1 : -1));
    }
    if (e.key !== 'Escape') return;
    if (lb && !lb.hidden) hideLightbox(el, lb);
    else closeQuestDetails();
  });
}

window.QuestDetails = { open: openQuestDetails, close: closeQuestDetails, wire: wireQuestDetails, showPictures };
