'use strict';
/* global MapView, escapeHtml, Planner, ArmoryViews, AV, QuestDetails */

const $ = (sel) => document.querySelector(sel);
const STATUS_LABEL = { started: 'Active', available: 'Available', completed: 'Completed', failed: 'Failed', locked: 'Locked' };
const SOURCE_LABEL = { log: 'from game logs', manual: 'set by you', inferred: 'inferred from later quests', computed: 'from prerequisites' };
const RAID_LABEL = { inRaid: 'In raid', loading: 'Loading into', menu: 'In menu · last map', unknown: 'Waiting for logs' };

const S = {
  state: null,
  data: null,
  dataMode: null,
  mapId: null,
  lastRaidMap: undefined,
  taskById: new Map(),
  mapById: new Map(),
};

const mapView = new MapView($('#map'), {
  popup: buildPopup,
  error: (msg) => toast(msg, 'error'),
  spawnClick: (sp) => {
    savePlan({ start: { ...sp.position, label: 'Chosen PMC spawn' } });
    toast('Route now starts at that spawn');
  },
  floorChange: (floor) => {
    $('#floor-select').value = floor || '';
    mapView.setFloor(floor);
  },
});

// ------------------------------------------------------------------ data + state
async function loadData(force) {
  try {
    S.data = await window.tqm.getData({ mode: S.state.mode, force });
    S.dataMode = S.data.dataMode;
    S.taskById = new Map(S.data.tasks.map((t) => [t.id, t]));
    S.mapById = new Map(S.data.maps.map((m) => [m.id, m]));
  } catch (err) {
    toast(`Could not load quest data from tarkov.dev: ${err.message || err}`, 'error');
  }
}

function displayFor(mapId) {
  const m = S.mapById.get(mapId);
  return m ? S.data.display[m.normalizedName] : null;
}

function selectableMaps() {
  return S.data.maps.filter((m) => S.data.display[m.normalizedName]).sort((a, b) => a.name.localeCompare(b.name));
}

async function selectMap(mapId) {
  if (!S.data) return;
  if (!displayFor(mapId)) mapId = selectableMaps()[0]?.id;
  S.mapId = mapId;
  $('#map-select').value = mapId;
  const apiMap = S.mapById.get(mapId);
  await mapView.show(apiMap, displayFor(mapId));
  renderFloors();
  renderMarkers();
  renderPosition();
  renderHere();
  renderPlan();
}

function taskState(id) {
  return S.state.taskStates[id] || { status: 'locked', source: 'computed' };
}

// ------------------------------------------------------------------ raid plan
function getPlan(mapId = S.mapId) {
  const p = S.state?.plans?.[mapId];
  return { tasks: p?.tasks || [], start: p?.start || null, extract: p?.extract || null };
}

function savePlan(patch) {
  const plan = { ...getPlan(), ...patch };
  S.state.plans = { ...(S.state.plans || {}), [S.mapId]: plan }; // optimistic
  return window.tqm.setPlan(S.mapId, plan);
}

function togglePlanned(taskId) {
  const plan = getPlan();
  const tasks = plan.tasks.includes(taskId) ? plan.tasks.filter((t) => t !== taskId) : [...plan.tasks, taskId];
  if (tasks.length && !plan.tasks.length && S.state.settings.markerFilter !== 'plan') window.tqm.setSettings({ markerFilter: 'plan' });
  return savePlan({ tasks });
}

function plannedTasks() {
  return getPlan()
    .tasks.map((id) => S.taskById.get(id))
    .filter(Boolean);
}

function routeStart() {
  const plan = getPlan();
  if (plan.start) return { position: plan.start, label: plan.start.label || 'Start' };
  const p = S.state.position;
  if (p && p.map === S.mapId) return { position: p, label: 'Your position' };
  return null;
}

function currentRoute() {
  if (!S.data || !S.mapId) return null;
  const plan = getPlan();
  const map = S.mapById.get(S.mapId);
  const ex = plan.extract ? map.extracts.find((e) => e.name === plan.extract) : null;
  const start = routeStart();
  const r = Planner.planRoute(plannedTasks(), S.mapId, { start: start?.position || null, end: ex?.position || null, objectivesDone: S.state.objectivesDone || {} });
  return { ...r, start: start?.position || null, startLabel: start?.label || null, end: ex?.position || null, extract: ex };
}

function filterAllows(status) {
  const f = S.state.settings.markerFilter;
  if (status === 'started') return true;
  if (f === 'available') return status === 'available';
  if (f === 'all') return status !== 'completed';
  return false;
}

function objectiveOnMap(o, mapId) {
  return o.maps.includes(mapId) || o.zones.some((z) => z.map === mapId) || o.possibleLocations.some((l) => l.map === mapId);
}

function taskOnMap(t, mapId) {
  return t.mapId === mapId || t.objectives.some((o) => objectiveOnMap(o, mapId));
}

function markerEntries(mapId) {
  const out = [];
  const done = S.state.objectivesDone || {};
  const planOnly = S.state.settings.markerFilter === 'plan';
  const planned = new Set(getPlan(mapId).tasks);
  for (const task of S.data.tasks) {
    const state = taskState(task.id);
    if (planOnly ? !planned.has(task.id) : !filterAllows(state.status)) continue;
    for (const objective of task.objectives) {
      if (done[objective.id]) continue;
      for (const z of objective.zones) {
        if (z.map === mapId && z.position) out.push({ task, state, objective, kind: 'zone', item: z });
      }
      for (const loc of objective.possibleLocations) {
        if (loc.map !== mapId) continue;
        for (const p of loc.positions) out.push({ task, state, objective, kind: 'item', item: { position: p }, questItem: objective.questItem });
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ rendering
function renderTopbar() {
  const st = S.state;
  const raidEl = $('#raid-status');
  const map = S.mapById.get(st.raid.map);
  raidEl.className = `status-pill map-only raid-${st.raid.status}`;
  if (st.logError) {
    raidEl.className = 'status-pill map-only error';
    raidEl.textContent = 'Logs not found';
    raidEl.title = st.logError;
  } else {
    raidEl.textContent = map ? `${RAID_LABEL[st.raid.status] || ''} ${map.name}` : RAID_LABEL[st.raid.status] || 'Waiting for logs';
    raidEl.title = `Reading ${st.logsDir}`;
  }
  const gameLabel = st.modes.find((m) => m.id === st.gameMode)?.label;
  $('#mode-select').innerHTML =
    st.modes.map((m) => `<option value="${m.id}">${escapeHtml(m.label)}${m.prestigeLevel ? ` · P${m.prestigeLevel}` : ''}</option>`).join('') +
    `<option value="">Follow the game${gameLabel ? ` (${escapeHtml(gameLabel)})` : ''}</option>`;
  $('#mode-select').value = st.settings.viewMode || '';
  $('#prestige-pill').textContent = `Prestige ${st.profile.prestigeLevel}`;
  const warn = $('#mode-warn');
  warn.hidden = !st.gameMode || st.gameMode === st.mode || !st.settings.viewMode;
  warn.textContent = `Game is in ${gameLabel || st.gameMode}: switch?`;
  warn.dataset.mode = st.gameMode || '';

  for (const b of document.querySelectorAll('#filter-seg button')) b.classList.toggle('active', b.dataset.filter === st.settings.markerFilter);
  $('#extracts-toggle').classList.toggle('active', !!st.settings.showExtracts);
  $('#spawns-toggle').classList.toggle('active', !!st.settings.showSpawns);
  $('#pin-toggle').classList.toggle('active', !!st.settings.alwaysOnTop);
  applySidebar();

  const sel = $('#map-select');
  const maps = selectableMaps();
  const sig = maps.map((m) => m.id).join();
  if (sel.dataset.sig !== sig) {
    sel.innerHTML = maps.map((m) => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join('');
    sel.dataset.sig = sig;
  }
  if (S.mapId) sel.value = S.mapId;
}

function applySidebar() {
  const collapsed = !!S.state.settings.sidebarCollapsed;
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  const b = $('#sidebar-toggle');
  b.textContent = collapsed ? '‹' : '›';
  b.title = collapsed ? 'Show the sidebar' : 'Hide the sidebar';
}

function renderFloors() {
  const floors = mapView.floors;
  $('#floor-ctl').hidden = floors.length === 0;
  $('#floor-select').innerHTML = ['<option value="">Ground</option>', ...floors.map((f) => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`)].join('');
}

function renderMarkers() {
  if (!S.mapId) return;
  mapView.setQuestMarkers(markerEntries(S.mapId));
  mapView.setExtracts(S.mapById.get(S.mapId)?.extracts || [], S.state.settings.showExtracts);
  mapView.setSpawns(S.mapById.get(S.mapId)?.pmcSpawns || [], !!S.state.settings.showSpawns);
  mapView.setRoute(S.state.settings.markerFilter === 'plan' ? currentRoute() : null);
}

function renderPosition() {
  const p = S.state.position;
  const chip = $('#position-chip');
  if (p && p.map === S.mapId) {
    mapView.setPosition(p);
    chip.hidden = false;
    chip.textContent = `You · ${p.source === 'log' ? 'from game log' : 'screenshot'} ${new Date(p.time).toLocaleTimeString()}`;
  } else {
    mapView.setPosition(null);
    chip.hidden = true;
  }
}

function statusChip(state) {
  return `<span class="chip status-${state.status}" title="${escapeHtml(SOURCE_LABEL[state.source] || '')}">${STATUS_LABEL[state.status]}${state.source === 'manual' ? ' ✎' : ''}</span>`;
}

function renderHere() {
  const el = $('#tab-here');
  if (!S.data || !S.mapId) {
    el.innerHTML = '<p class="muted">Loading…</p>';
    return;
  }
  const map = S.mapById.get(S.mapId);
  const done = S.state.objectivesDone || {};
  const groups = { started: [], available: [] };
  for (const t of S.data.tasks) {
    const st = taskState(t.id);
    if (groups[st.status] && taskOnMap(t, S.mapId)) groups[st.status].push(t);
  }
  const markerCount = markerEntries(S.mapId).length;
  let html = `<div class="here-head"><h2>${escapeHtml(map.name)}</h2><span class="muted small">${markerCount} marker${markerCount === 1 ? '' : 's'} shown</span></div>`;
  for (const [status, tasks] of Object.entries(groups)) {
    tasks.sort((a, b) => a.trader.name.localeCompare(b.trader.name) || a.name.localeCompare(b.name));
    html += `<h3 class="group-title status-${status}">${STATUS_LABEL[status]} <span class="count">${tasks.length}</span></h3>`;
    if (!tasks.length) html += `<p class="muted small">No ${STATUS_LABEL[status].toLowerCase()} quests on this map.</p>`;
    for (const t of tasks) {
      const objs = t.objectives.filter((o) => objectiveOnMap(o, S.mapId));
      const hasMarkers = objs.some((o) => o.zones.some((z) => z.map === S.mapId) || o.possibleLocations.some((l) => l.map === S.mapId));
      html += `<div class="quest-card status-${status}" data-task="${t.id}">
        <div class="qc-head">
          <button class="link qc-name" data-act="focus" ${hasMarkers ? '' : 'disabled title="No map markers for this quest"'}>${escapeHtml(t.name)}</button>
          <span class="trader">${escapeHtml(t.trader.name)}</span>
        </div>
        <ul class="objectives">${objs
          .map((o) => {
            const located = o.zones.some((z) => z.map === S.mapId) || o.possibleLocations.some((l) => l.map === S.mapId);
            return `<li class="${done[o.id] ? 'done' : ''}"><label><input type="checkbox" data-obj="${o.id}" ${done[o.id] ? 'checked' : ''}/> <span>${escapeHtml(o.description)}${o.optional ? ' <em>(optional)</em>' : ''}</span>${located ? '<span class="has-marker" title="Has map marker">◆</span>' : ''}</label></li>`;
          })
          .join('')}</ul>
        <div class="qc-actions">
          <button data-act="plan" class="${getPlan().tasks.includes(t.id) ? 'planned' : ''}">${getPlan().tasks.includes(t.id) ? '✓ In raid plan' : '+ Plan'}</button>
          <button data-act="details" title="Pictures of the quest, its items, keys and rewards">🖼 Details</button>
          ${status === 'available' ? '<button data-act="start">Mark started</button>' : ''}
          ${t.wikiLink ? '<button data-act="wiki">Wiki</button>' : ''}
          <span class="spacer"></span>
          <button data-act="complete" class="mark-complete" title="Mark this whole quest as completed. You can undo it.">☐ Mark Complete</button>
        </div>
      </div>`;
    }
  }
  el.innerHTML = html;
}

const STATUS_ORDER = { started: 0, available: 1, failed: 2, locked: 3 };

function completedWhen(st) {
  if (st.status !== 'completed') return '';
  if (!st.time) return ' · <span class="when">completed (inferred, no date)</span>';
  const d = new Date(st.time);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
  return ` · <span class="when">completed ${date} ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>`;
}

function renderQuestList() {
  if (!S.data) return;
  const q = $('#quest-search').value.trim().toLowerCase();
  const sf = $('#quest-status-filter').value;
  const counts = {};
  const rows = [];
  for (const t of S.data.tasks) {
    const st = taskState(t.id);
    counts[st.status] = (counts[st.status] || 0) + 1;
    if (sf && st.status !== sf) continue;
    if (q && !t.name.toLowerCase().includes(q) && !t.trader.name.toLowerCase().includes(q)) continue;
    rows.push([t, st]);
  }
  const sort = S.state.settings.questSort || 'recent';
  $('#quest-sort').value = sort;
  const byTrader = (a, b) => a[0].trader.name.localeCompare(b[0].trader.name) || a[0].minPlayerLevel - b[0].minPlayerLevel || a[0].name.localeCompare(b[0].name);
  // Completed quests with a date first (newest or oldest), then completed ones with no date
  // (inferred), then everything else: active, available, failed, locked.
  const group = (st) => (st.status === 'completed' ? (st.time ? 0 : 1) : 2 + (STATUS_ORDER[st.status] ?? 9));
  if (sort === 'name') rows.sort((a, b) => a[0].name.localeCompare(b[0].name));
  else if (sort === 'trader') rows.sort(byTrader);
  else {
    const dir = sort === 'oldest' ? 1 : -1;
    rows.sort((a, b) => group(a[1]) - group(b[1]) || (group(a[1]) === 0 ? dir * (a[1].time - b[1].time) : 0) || byTrader(a, b));
  }
  $('#quest-counts').textContent = Object.entries(STATUS_LABEL)
    .map(([k, label]) => `${label}: ${counts[k] || 0}`)
    .join(' · ');
  const manual = (st) => (st.source === 'manual' ? st.status : 'auto');
  $('#quest-list').innerHTML = rows
    .map(([t, st]) => {
      const mapName = t.mapId ? S.mapById.get(t.mapId)?.name : '';
      return `<div class="quest-row" data-task="${t.id}">
        <div class="qr-main">
          <div class="qr-name"><a href="#" data-details title="Show pictures, items and rewards">${escapeHtml(t.name)}</a>${t.kappaRequired ? ' <span class="tag" title="Required for Kappa">K</span>' : ''}</div>
          <div class="qr-sub muted small">${escapeHtml(t.trader.name)} · lvl ${t.minPlayerLevel}${mapName ? ` · ${escapeHtml(mapName)}` : ''}${completedWhen(st)}</div>
        </div>
        ${statusChip(st)}
        <select data-act="set" title="Override the detected status">
          <option value="auto" ${manual(st) === 'auto' ? 'selected' : ''}>Auto</option>
          <option value="completed" ${manual(st) === 'completed' ? 'selected' : ''}>Completed</option>
          <option value="started" ${manual(st) === 'started' ? 'selected' : ''}>Active</option>
          <option value="failed" ${manual(st) === 'failed' ? 'selected' : ''}>Failed</option>
          <option value="none" ${manual(st) === 'none' ? 'selected' : ''}>Not started</option>
        </select>
      </div>`;
    })
    .join('');
}

function renderSettings() {
  const st = S.state;
  const p = st.profile;
  const latestPrestige = p.prestiges.length && !p.ignorePrestige ? p.prestiges[p.prestiges.length - 1] : 0;
  const sinceWhy = !p.effectiveSince ? 'No wipe or prestige set' : latestPrestige >= (p.since || 0) ? 'Your latest prestige' : p.sinceReason === 'wipe' ? 'The wipe you set' : 'The date you set';
  const byMode = Object.entries(st.sessions.byMode)
    .map(([m, n]) => `${escapeHtml(st.modes.find((x) => x.id === m)?.label || m)}: ${n}`)
    .join(' · ');
  $('#tab-settings').innerHTML = `
    <h3>${escapeHtml(st.modeLabel)} profile</h3>
    <p class="muted small">PvE, PvP and PvP Season each keep their own quest progress and prestige. Switch modes from <b>Mode</b> in the top bar.</p>
    <div class="callout">
      <div><b>Counting quest progress from:</b> ${p.effectiveSince ? escapeHtml(new Date(p.effectiveSince).toLocaleString()) : 'the beginning of your logs'}</div>
      <div class="muted small">${sinceWhy}. ${p.countedEventCount} of ${p.logEventCount} quest events from the logs count.</div>
    </div>

    <h4>Prestige</h4>
    <label class="row">Prestige level (0–6)
      <select id="set-prestige">
        ${[0, 1, 2, 3, 4, 5, 6].map((n) => `<option value="${n}" ${p.prestigeLevel === n ? 'selected' : ''}>${n}</option>`).join('')}
      </select>
    </label>
    <p class="muted small">${
      p.prestiges.length
        ? `Prestige${p.prestiges.length > 1 ? 's' : ''} found in your logs: ${p.prestiges.map((t) => escapeHtml(new Date(t).toLocaleString())).join(', ')}.`
        : 'No prestige found in your logs for this mode.'
    } ${p.prestigeManual ? `You set level ${p.prestigeManual.level} on ${escapeHtml(new Date(p.prestigeManual.time).toLocaleDateString())}. Prestiges detected after that add to it.` : 'The level counts prestiges seen in your logs. Set it here if you prestiged before your logs start.'} Each prestige resets quest progress, so only quests after your latest prestige count.</p>
    ${p.prestiges.length ? `<label class="row check"><input type="checkbox" id="set-ignore-prestige" ${p.ignorePrestige ? 'checked' : ''}/> Don't reset progress at the detected prestige</label>` : ''}

    <h4>Wipe</h4>
    <p class="muted small">When Battlestate wipes the game, start fresh here. Quest progress before the wipe date stops counting, and your manual marks and raid plans are cleared. Game files and logs are never touched.</p>
    <div class="wipe-box">
      <div class="wipe-modes">${st.modes
        .map((m) => `<label class="row check"><input type="checkbox" data-wipe-mode="${m.id}" ${m.id === st.mode ? 'checked' : ''}/> ${escapeHtml(m.label)}</label>`)
        .join('')}</div>
      <label class="row">Wipe date
        <input type="date" id="wipe-date" value="${new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10)}" />
      </label>
      <label class="row check"><input type="checkbox" id="wipe-prestige" checked /> Also reset prestige to 0</label>
      <button id="wipe-btn" class="danger">Wipe progress…</button>
    </div>
    ${p.since ? `<button id="unwipe-btn" class="small-btn">Undo wipe/date for ${escapeHtml(st.modeLabel)} (count all logs again)</button>` : ''}

    <h4>Quest filters</h4>
    <label class="row">Your level (hides quests you can't take yet)
      <input type="number" id="set-level" min="1" max="79" value="${p.level || ''}" placeholder="any" />
    </label>
    <label class="row">Faction
      <select id="set-faction">
        <option value="">Any</option>
        <option value="USEC" ${p.faction === 'USEC' ? 'selected' : ''}>USEC</option>
        <option value="BEAR" ${p.faction === 'BEAR' ? 'selected' : ''}>BEAR</option>
      </select>
    </label>
    <label class="row check"><input type="checkbox" id="set-follow" ${st.settings.followRaidMap ? 'checked' : ''}/> Switch the map automatically when you load into a raid</label>

    <h3>Game files</h3>
    <div class="kv"><span>Logs folder</span><code>${escapeHtml(st.logsDir || 'not found')}</code></div>
    <button id="pick-logs">Change…</button>
    <div class="kv"><span>Screenshots folder</span><code>${escapeHtml(st.screenshotsDir || 'not found')}</code></div>
    <button id="pick-shots">Change…</button>
    <p class="muted small">Sessions read: ${st.sessions.total}${byMode ? ` (${byMode})` : ''}${st.sessions.first ? ` since ${new Date(st.sessions.first).toLocaleDateString()}` : ''}. Quest events remembered for this profile: ${p.logEventCount}. Manual overrides: ${p.manualCount}.</p>
    <p class="muted small">Tip: press your in-game screenshot key during a raid and your position and facing show up on the map.</p>

    <h3>Data</h3>
    <p class="muted small">Quests, maps and positions come from <a href="#" data-link="https://tarkov.dev">tarkov.dev</a> (${escapeHtml(S.dataMode || '')} data)${st.dataError ? ` — <span class="err">${escapeHtml(st.dataError)}</span>` : ''}.</p>
    <button id="refresh-data">Refresh quest data</button>
    <button id="reset-manual" class="danger">Clear my manual changes</button>
  `;
}

// ------------------------------------------------------------------ views (Map / Ammo / Gunsmith)
let currentView = 'map';
async function showView(name) {
  currentView = name;
  for (const b of document.querySelectorAll('#view-seg button')) b.classList.toggle('active', b.dataset.view === name);
  document.body.dataset.view = name;
  $('#body').hidden = name !== 'map';
  $('#view-ammo').hidden = name !== 'ammo';
  $('#view-guns').hidden = name !== 'guns';
  if (name === 'map') {
    mapView.map?.invalidateSize();
    return;
  }
  renderArmoryView();
  if (!AV.armory || AV.dataMode !== S.state.dataMode) {
    try {
      await ArmoryViews.ensureArmory();
    } catch (err) {
      toast(`Could not load weapon data: ${err.message || err}`, 'error');
    }
    renderArmoryView();
  }
}
window.showView = showView;

function renderArmoryView() {
  if (currentView === 'map') return;
  if (AV.armory && AV.dataMode !== S.state.dataMode && !AV.loading) {
    // switched between PvE and PvP data: reload, then draw again
    ArmoryViews.ensureArmory().then(renderArmoryView, (err) => toast(`Could not load weapon data: ${err.message || err}`, 'error'));
  }
  if (currentView === 'ammo') ArmoryViews.renderAmmo();
  if (currentView === 'guns') ArmoryViews.renderGuns();
}

function renderAll() {
  renderArmoryView();
  renderTopbar();
  renderMarkers();
  renderPosition();
  renderHere();
  renderPlan();
  renderQuestList();
  renderSettings();
}

// ------------------------------------------------------------------ raid plan tab
function itemHtml(id) {
  const it = S.data.items?.[id] || { name: id };
  const img = it.iconLink ? `<img src="${escapeHtml(it.iconLink)}" alt="" loading="lazy">` : '';
  return `<span class="item" title="${escapeHtml(it.name)}">${img}<span>${escapeHtml(it.shortName && it.name.length > 38 ? it.shortName : it.name)}</span></span>`;
}

function altsHtml(alts, max = 4) {
  const shown = alts.slice(0, max).map(itemHtml).join('<span class="or">or</span>');
  const more = alts.length > max ? `<span class="more" title="${escapeHtml(alts.slice(max).map((id) => S.data.items?.[id]?.name || id).join('\n'))}">+${alts.length - max} more</span>` : '';
  return shown + more;
}

function renderPlan() {
  const el = $('#tab-plan');
  if (!S.data || !S.mapId) return;
  const map = S.mapById.get(S.mapId);
  const plan = getPlan();
  const route = currentRoute();
  const tasks = plannedTasks();
  const loadout = Planner.buildLoadout(tasks, S.mapId, S.state.objectivesDone || {});
  const options = { started: [], available: [] };
  for (const t of S.data.tasks) {
    const st = taskState(t.id).status;
    if (options[st] && taskOnMap(t, S.mapId)) options[st].push(t);
  }
  const pick = (list) =>
    list
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => `<label class="pick"><input type="checkbox" data-plan-task="${t.id}" ${plan.tasks.includes(t.id) ? 'checked' : ''}/> <span>${escapeHtml(t.name)}</span><button class="icon-btn" data-details-task="${t.id}" title="Details and pictures">🖼</button><span class="trader">${escapeHtml(t.trader.name)}</span></label>`)
      .join('') || '<p class="muted small">None on this map.</p>';
  const extracts = map.extracts.filter((e) => e.faction !== 'scav');
  const pos = S.state.position && S.state.position.map === S.mapId ? S.state.position : null;
  const near = pos ? Planner.nearestSpawn(map.pmcSpawns, pos) : null;

  let html = `<div class="here-head"><h2>Raid plan · ${escapeHtml(map.name)}</h2>${plan.tasks.length ? '<button id="plan-clear" class="small-btn">Clear</button>' : ''}</div>
  <details class="plan-pick" ${plan.tasks.length ? '' : 'open'}>
    <summary>Quests for this raid <span class="count">${plan.tasks.length} selected</span></summary>
    <h4 class="status-started">Active</h4>${pick(options.started)}
    <h4 class="status-available">Available</h4>${pick(options.available)}
  </details>`;

  if (!plan.tasks.length) {
    el.innerHTML = html + '<p class="muted">Tick the quests you want to do this raid. The map then shows only those quests, the route between them, and what to bring.</p>';
    return;
  }

  html += `<h3>Route</h3>
  <div class="route-ends">
    <div><span class="badge start">S</span> ${route.startLabel ? escapeHtml(route.startLabel) : '<span class="muted">No start set: starts at stop 1</span>'}
      <div class="btns">
        <button id="plan-pick-spawn" class="small-btn">Pick spawn on map</button>
        ${pos && near ? '<button id="plan-snap-spawn" class="small-btn">Use spawn nearest me</button>' : ''}
        ${plan.start ? '<button id="plan-clear-start" class="small-btn">Clear</button>' : ''}
      </div>
    </div>
    <div><span class="badge end">E</span>
      <select id="plan-extract"><option value="">No extract chosen</option>${extracts
        .map((e) => `<option value="${escapeHtml(e.name)}" ${plan.extract === e.name ? 'selected' : ''}>${escapeHtml(e.name)}${e.faction === 'shared' ? ' (shared)' : ''}</option>`)
        .join('')}</select>
    </div>
  </div>
  <ol class="route">${route.stops
    .map((s, i) => `<li data-stop="${i}"><span class="num">${i + 1}</span><div><b>${escapeHtml(s.task.name)}</b><div class="small">${escapeHtml(s.objective.description)}</div></div></li>`)
    .join('')}</ol>
  ${route.stops.length ? `<p class="muted small">About ${route.length} m in straight lines. Real paths around walls and buildings will be longer.</p>` : ''}
  ${route.anywhere.length ? `<h4>Anywhere on this map</h4><ul class="anywhere">${route.anywhere.map((a) => `<li><b>${escapeHtml(a.task.name)}</b>: ${escapeHtml(a.objective.description)}</li>`).join('')}</ul>` : ''}
  <button id="plan-fit" class="small-btn">Show whole route</button>`;

  html += '<h3>Bring into the raid</h3>';
  const none = !loadout.keys.length && !loadout.bring.length && !loadout.gear.length && !loadout.questItems.length;
  if (none) html += '<p class="muted small">Nothing special: no keys, plant items or gear requirements for these quests.</p>';
  if (loadout.keys.length) {
    html += `<h4>Keys</h4>${loadout.keys.map((k) => `<div class="need">${altsHtml(k.alts)}<div class="why">${escapeHtml(k.reasons.join(', '))}</div></div>`).join('')}`;
  }
  if (loadout.bring.length) {
    html += `<h4>Items to use or plant</h4>${loadout.bring.map((b) => `<div class="need"><span class="qty">×${b.count}</span>${altsHtml(b.alts)}<div class="why">${escapeHtml(b.reasons.join(', '))}</div></div>`).join('')}`;
  }
  if (loadout.gear.length) {
    html += `<h4>Weapon / gear requirements</h4>${loadout.gear
      .map((g) => `<div class="need"><span class="lbl">${escapeHtml(g.label)}</span>${g.alts.map((a) => altsHtml(a, 3)).join('<span class="or">or</span>')}<div class="why">${escapeHtml(g.task.name)}: ${escapeHtml(g.objective.description)}</div></div>`)
      .join('')}`;
  }
  if (loadout.questItems.length) {
    html += `<h4>Quest items you should be carrying</h4>${loadout.questItems.map((q) => `<div class="need"><span class="item">${q.item.iconLink ? `<img src="${escapeHtml(q.item.iconLink)}" alt="">` : ''}<span>${escapeHtml(q.item.name)}</span></span><div class="why">${escapeHtml(q.task.name)}</div></div>`).join('')}`;
  }
  if (loadout.findInRaid.length) {
    html += `<h4>Look out for (found in raid)</h4>${loadout.findInRaid.map((f) => `<div class="need"><span class="qty">×${f.count}</span>${altsHtml(f.alts, 3)}<div class="why">${escapeHtml(f.task.name)}</div></div>`).join('')}`;
  }
  html += '<p class="muted small">Requirements come from tarkov.dev, which is built from the same game data as the wiki. Use each quest\'s Wiki link to double-check.</p>';
  el.innerHTML = html;
}

function wirePlan() {
  const el = $('#tab-plan');
  el.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.dataset.planTask) await togglePlanned(t.dataset.planTask);
    if (t.id === 'plan-extract') await savePlan({ extract: t.value || null });
  });
  el.addEventListener('click', async (e) => {
    const t = e.target.closest('button, li[data-stop]');
    if (!t) return;
    if (t.dataset.detailsTask) {
      e.preventDefault();
      return QuestDetails.open(t.dataset.detailsTask);
    }
    if (t.id === 'plan-clear') await window.tqm.setPlan(S.mapId, null);
    if (t.id === 'plan-clear-start') await savePlan({ start: null });
    if (t.id === 'plan-fit') mapView.fitRoute(currentRoute());
    if (t.id === 'plan-pick-spawn') {
      if (!S.state.settings.showSpawns) await window.tqm.setSettings({ showSpawns: true });
      toast('Click a PMC spawn (small white dot) on the map');
    }
    if (t.id === 'plan-snap-spawn') {
      const near = Planner.nearestSpawn(S.mapById.get(S.mapId).pmcSpawns, S.state.position);
      if (near) await savePlan({ start: { ...near.spawn.position, label: `PMC spawn nearest you (${Math.round(near.distance)} m away)` } });
    }
    if (t.dataset.stop !== undefined) {
      const stop = currentRoute().stops[Number(t.dataset.stop)];
      if (stop) mapView.flyTo(stop.point.position);
    }
  });
}

// ------------------------------------------------------------------ popup
function buildPopup(e) {
  const el = document.createElement('div');
  const st = taskState(e.task.id);
  el.innerHTML = `
    <div class="pp-head"><strong>${escapeHtml(e.task.name)}</strong> ${statusChip(st)}</div>
    <div class="muted small">${escapeHtml(e.task.trader.name)} · lvl ${e.task.minPlayerLevel}${e.floor ? ` · <b>${escapeHtml(e.floor)}</b>` : ''}</div>
    <p class="pp-obj">${escapeHtml(e.objective.description)}</p>
    ${e.questItem ? `<div class="pp-item">${e.questItem.iconLink ? `<img src="${escapeHtml(e.questItem.iconLink)}" alt="">` : ''}<span>${escapeHtml(e.questItem.name)}</span></div>` : ''}
    <div class="pp-actions">
      <button data-act="obj">Objective done</button>
      <button data-act="details">🖼 Details</button>
      ${e.task.wikiLink ? '<button data-act="wiki">Wiki</button>' : ''}
      <span class="spacer"></span>
      <button data-act="complete" class="mark-complete" title="Mark this whole quest as completed. You can undo it.">☐ Mark Complete</button>
    </div>`;
  el.addEventListener('click', async (ev) => {
    const act = ev.target.closest('button')?.dataset.act;
    if (act === 'obj') await window.tqm.setObjective(e.objective.id, true);
    else if (act === 'details') QuestDetails.open(e.task.id);
    else if (act === 'complete') await markComplete(e.task.id);
    else if (act === 'wiki') window.tqm.openLink(e.task.wikiLink);
  });
  return el;
}

/** Mark a quest complete by hand, with an Undo that puts back whatever was there before. */
async function markComplete(taskId) {
  const before = taskState(taskId);
  const previous = before.source === 'manual' ? before.status : null;
  const name = S.taskById.get(taskId)?.name || 'Quest';
  await window.tqm.setTask(taskId, 'completed');
  toast(`Marked "${name}" complete`, 'ok', {
    label: 'Undo',
    onClick: async () => {
      await window.tqm.setTask(taskId, previous);
      toast(`"${name}" is back to ${STATUS_LABEL[previous || before.status] || 'its detected status'}`);
    },
    ms: 10000,
  });
}

// ------------------------------------------------------------------ toasts
function toast(text, kind = 'info', action = null) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  const span = document.createElement('span');
  span.textContent = text;
  el.appendChild(span);
  if (action) {
    const b = document.createElement('button');
    b.className = 'toast-action';
    b.textContent = action.label;
    b.addEventListener('click', () => {
      el.remove();
      action.onClick();
    });
    el.appendChild(b);
  }
  $('#toasts').appendChild(el);
  const ms = action?.ms || 5000;
  setTimeout(() => el.classList.add('out'), ms);
  setTimeout(() => el.remove(), ms + 600);
}

// ------------------------------------------------------------------ events
function wire() {
  $('#map-select').addEventListener('change', (e) => selectMap(e.target.value));
  $('#view-seg').addEventListener('click', (e) => {
    const v = e.target.closest('button')?.dataset.view;
    if (v) showView(v);
  });
  ArmoryViews.wireAmmo();
  ArmoryViews.wireGuns();
  $('#floor-select').addEventListener('change', (e) => mapView.setFloor(e.target.value || null));
  $('#filter-seg').addEventListener('click', (e) => {
    const f = e.target.closest('button')?.dataset.filter;
    if (f) window.tqm.setSettings({ markerFilter: f });
  });
  $('#extracts-toggle').addEventListener('click', () => window.tqm.setSettings({ showExtracts: !S.state.settings.showExtracts }));
  $('#spawns-toggle').addEventListener('click', () => window.tqm.setSettings({ showSpawns: !S.state.settings.showSpawns }));
  wirePlan();
  $('#sidebar-toggle').addEventListener('click', () => {
    S.state.settings.sidebarCollapsed = !S.state.settings.sidebarCollapsed;
    applySidebar(); // instant; the setting is saved in the background
    window.tqm.setSettings({ sidebarCollapsed: S.state.settings.sidebarCollapsed });
  });
  // keep the map sized right when the top bar wraps or the sidebar opens/closes
  new ResizeObserver(() => mapView.map?.invalidateSize({ pan: false })).observe($('#map'));
  $('#pin-toggle').addEventListener('click', () => window.tqm.setSettings({ alwaysOnTop: !S.state.settings.alwaysOnTop }));
  $('#mode-select').addEventListener('change', (e) => window.tqm.setSettings({ viewMode: e.target.value || null }));
  $('#mode-warn').addEventListener('click', (e) => window.tqm.setSettings({ viewMode: e.currentTarget.dataset.mode }));
  $('#prestige-pill').addEventListener('click', () => showTab('settings'));
  $('#position-chip').addEventListener('click', () => mapView.focusPosition(S.state.position));

  for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => showTab(b.dataset.tab));

  $('#tab-here').addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    const card = e.target.closest('.quest-card');
    if (!btn || !card) return;
    const id = card.dataset.task;
    const act = btn.dataset.act;
    if (act === 'focus') mapView.focusTask(id);
    else if (act === 'details') QuestDetails.open(id);
    else if (act === 'plan') await togglePlanned(id);
    else if (act === 'complete') await markComplete(id);
    else if (act === 'start') await window.tqm.setTask(id, 'started');
    else if (act === 'wiki') window.tqm.openLink(S.taskById.get(id).wikiLink);
  });
  $('#tab-here').addEventListener('change', (e) => {
    if (e.target.dataset.obj) window.tqm.setObjective(e.target.dataset.obj, e.target.checked);
  });

  $('#quest-search').addEventListener('input', renderQuestList);
  $('#quest-status-filter').addEventListener('change', renderQuestList);
  $('#quest-sort').addEventListener('change', (e) => {
    S.state.settings.questSort = e.target.value;
    renderQuestList();
    window.tqm.setSettings({ questSort: e.target.value });
  });
  $('#quest-list').addEventListener('click', (e) => {
    if (!e.target.closest('[data-details]')) return;
    e.preventDefault();
    QuestDetails.open(e.target.closest('.quest-row').dataset.task);
  });
  QuestDetails.wire();
  $('#quest-list').addEventListener('change', (e) => {
    if (e.target.dataset.act !== 'set') return;
    const id = e.target.closest('.quest-row').dataset.task;
    window.tqm.setTask(id, e.target.value === 'auto' ? null : e.target.value);
  });

  const settings = $('#tab-settings');
  settings.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'set-prestige') window.tqm.setProfile({ prestigeLevel: Number(t.value) });
    if (t.id === 'set-ignore-prestige') window.tqm.setProfile({ ignorePrestige: t.checked });
    if (t.id === 'set-level') window.tqm.setProfile({ level: t.value ? Number(t.value) : null });
    if (t.id === 'set-faction') window.tqm.setProfile({ faction: t.value || null });
    if (t.id === 'set-follow') window.tqm.setSettings({ followRaidMap: t.checked });
  });
  settings.addEventListener('click', async (e) => {
    const t = e.target;
    if (t.dataset.link) {
      e.preventDefault();
      window.tqm.openLink(t.dataset.link);
    }
    if (t.id === 'pick-logs') window.tqm.pickFolder('logs');
    if (t.id === 'pick-shots') window.tqm.pickFolder('screenshots');
    if (t.id === 'refresh-data') {
      t.disabled = true;
      t.textContent = 'Refreshing…';
      await loadData(true);
      await selectMap(S.mapId);
      toast('Quest data refreshed from tarkov.dev');
    }
    if (t.id === 'wipe-btn') {
      const modes = [...settings.querySelectorAll('[data-wipe-mode]:checked')].map((c) => c.dataset.wipeMode);
      const date = settings.querySelector('#wipe-date').value;
      const resetPrestige = settings.querySelector('#wipe-prestige').checked;
      if (!modes.length) return toast('Pick at least one mode to wipe', 'error');
      const time = date ? new Date(`${date}T00:00:00`).getTime() : Date.now();
      const labels = modes.map((m) => S.state.modes.find((x) => x.id === m)?.label).join(', ');
      const msg = `Wipe ${labels} as of ${new Date(time).toLocaleDateString()}?\n\nQuest progress before that date will stop counting, and your manual quest marks and raid plans for ${modes.length > 1 ? 'these modes' : 'this mode'} are cleared.${resetPrestige ? ' Prestige goes back to 0.' : ''}\n\nGame files and logs are not touched. You can undo it later with "Undo wipe".`;
      if (confirm(msg)) {
        await window.tqm.wipe(modes, time, resetPrestige);
        toast(`Wiped ${labels}`, 'ok');
      }
    }
    if (t.id === 'unwipe-btn') await window.tqm.setProfile({ since: null });
    if (t.id === 'reset-manual' && confirm('Clear every quest status and objective you set by hand for this profile? Log-detected progress stays.')) {
      window.tqm.resetManual();
    }
  });
}

function showTab(name) {
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.tab === name);
  for (const s of document.querySelectorAll('.tab')) s.hidden = s.id !== `tab-${name}`;
}

async function onState(st) {
  const prevDataMode = S.dataMode;
  S.state = st;
  if (st.dataMode !== prevDataMode) {
    await loadData();
    if (S.mapId) await selectMap(S.mapId);
  }
  renderTopbar();
  if (S.state.raid.map !== S.lastRaidMap) {
    const first = S.lastRaidMap == null;
    S.lastRaidMap = S.state.raid.map;
    if (S.state.raid.map && (first || S.state.settings.followRaidMap) && S.state.raid.map !== S.mapId) {
      await selectMap(S.state.raid.map);
      if (!first) toast(`Map switched to ${S.mapById.get(S.state.raid.map)?.name}`);
    }
  }
  if (!S.mapId && S.data) await selectMap(selectableMaps()[0]?.id);
  renderAll();
}

(async function init() {
  wire();
  window.tqm.on('state', onState);
  window.tqm.on('position', (p) => {
    S.state.position = p;
    if (p.map !== S.mapId && S.state.settings.followRaidMap) selectMap(p.map);
    else {
      renderPosition();
      if (!getPlan().start && S.state.settings.markerFilter === 'plan') {
        mapView.setRoute(currentRoute());
        renderPlan();
      }
    }
  });
  window.tqm.on('toast', (t) => {
    if (t.kind === 'save-error') return toast(`Couldn't save your progress: ${t.error}. Close any other copy of the app and try again.`, 'error');
    if (t.kind === 'prestige') return toast(`Prestige detected in ${t.modeLabel}. Quest progress for that mode starts fresh.`, 'ok');
    if (t.kind !== 'task') return;
    const name = S.taskById.get(t.taskId)?.name || 'Unknown quest';
    const verb = { started: 'Quest started', finished: 'Quest completed', failed: 'Quest failed' }[t.status];
    toast(`${verb}: ${name}`, t.status === 'failed' ? 'error' : 'ok');
  });
  await onState(await window.tqm.getState());
})();
