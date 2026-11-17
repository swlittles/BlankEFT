'use strict';
/* global S, escapeHtml, taskState, statusChip, markComplete */
// "Details" panel for a quest: the in-game task picture, quest items, items to hand over, keys and rewards.

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
        <h2>${escapeHtml(t.name)} ${t.kappaRequired ? '<span class="tag" title="Required for Kappa">Kappa</span>' : ''}${t.lightkeeperRequired ? ' <span class="tag">Lightkeeper</span>' : ''}</h2>
        <div class="muted">${escapeHtml(t.trader.name)} · level ${t.minPlayerLevel}${t.mapId ? ` · ${escapeHtml(S.mapById.get(t.mapId)?.name || '')}` : ''}${t.factionName && t.factionName !== 'Any' ? ` · ${escapeHtml(t.factionName)} only` : ''} ${statusChip(st)}</div>
      </div>
      <button class="close" data-close title="Close (Esc)">✕</button>
    </header>
    <div class="modal-body">
      ${t.image ? `<img class="banner" src="${escapeHtml(t.image)}" alt="" data-zoom="${escapeHtml(t.image)}" data-caption="${escapeHtml(t.name)}">` : ''}
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
      ${r.offerUnlock.length ? `<div class="obj-label">Unlocks for purchase</div><div class="tiles">${r.offerUnlock.map((u) => itemTile(u.id)).join('')}</div><p class="muted small">${r.offerUnlock.map((u) => `${escapeHtml(u.trader)} LL${u.level}`).join(', ')}</p>` : ''}
      ${prereqs.length ? `<h3>Comes after</h3><p class="small">${prereqs.map((p) => `<a href="#" data-task="${p.id}">${escapeHtml(p.name)}</a>`).join(', ')}</p>` : ''}
    </div>
    <footer>
      ${t.wikiLink ? '<button data-wiki>Wiki</button>' : ''}
      <span class="spacer"></span>
      ${st.status !== 'completed' ? '<button class="mark-complete" data-complete title="Mark this whole quest as completed. You can undo it.">☐ Mark Complete</button>' : ''}
    </footer>
  </div>
  <div class="lightbox" hidden><img alt=""><div class="caption"></div></div>`;
  el.hidden = false;
  el.dataset.task = t.id;
  el.querySelector('[data-close]').focus();
}

function closeQuestDetails() {
  const el = document.getElementById('modal');
  el.hidden = true;
  el.innerHTML = '';
}

function wireQuestDetails() {
  const el = document.getElementById('modal');
  el.addEventListener('click', async (e) => {
    const lb = el.querySelector('.lightbox');
    if (lb && !lb.hidden) {
      lb.hidden = true; // any click closes the enlarged picture
      return;
    }
    const zoom = e.target.closest('[data-zoom]');
    if (zoom) {
      lb.querySelector('img').src = zoom.dataset.zoom;
      lb.querySelector('.caption').textContent = zoom.dataset.caption || '';
      lb.hidden = false;
      return;
    }
    if (e.target === el || e.target.closest('[data-close]')) return closeQuestDetails();
    const link = e.target.closest('[data-task]');
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
    if (e.key !== 'Escape' || el.hidden) return;
    const lb = el.querySelector('.lightbox');
    if (lb && !lb.hidden) lb.hidden = true;
    else closeQuestDetails();
  });
}

window.QuestDetails = { open: openQuestDetails, close: closeQuestDetails, wire: wireQuestDetails };
