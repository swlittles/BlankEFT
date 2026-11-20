'use strict';
// Works out each quest's status from log events + manual overrides + the quest prerequisite graph.
//
// Statuses: 'completed' | 'started' | 'failed' | 'available' | 'locked'
// Sources:  'log' (seen in game logs), 'manual' (set by you), 'inferred' (a later quest needed it), 'computed'

const LOG_STATUS = { started: 'started', finished: 'completed', failed: 'failed' };

/**
 * @param {Array} tasks         model.tasks
 * @param {Array} logEvents     [{ taskId, status: 'started'|'finished'|'failed', time }]
 * @param {Object} manual       { [taskId]: 'completed'|'started'|'failed'|'none' }
 * @param {Object} opts         { since: ms|null, level: number|null, faction: 'USEC'|'BEAR'|null }
 */
function computeTaskStates(tasks, logEvents, manual = {}, opts = {}) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const state = {};

  const sorted = [...logEvents].filter((e) => !opts.since || (e.time || 0) >= opts.since).sort((a, b) => (a.time || 0) - (b.time || 0));
  for (const e of sorted) {
    if (!byId.has(e.taskId)) continue;
    state[e.taskId] = { status: LOG_STATUS[e.status], source: 'log', time: e.time };
  }

  // A status you set by hand wins, unless the game logged something for that quest after you set
  // it (e.g. you marked it "started" and then finished it in game). Old marks with no time always win.
  const lastLog = {};
  for (const e of sorted) if (byId.has(e.taskId)) lastLog[e.taskId] = e.time || 0;
  const overridden = new Set();
  for (const [taskId, status] of Object.entries(manual)) {
    if (!byId.has(taskId)) continue;
    const at = opts.manualAt?.[taskId];
    if (at && lastLog[taskId] > at) {
      overridden.add(taskId);
      continue;
    }
    if (status === 'none') delete state[taskId];
    else state[taskId] = { status, source: 'manual', time: opts.manualAt?.[taskId] || null };
  }
  const manualNone = new Set(Object.entries(manual).filter(([id, s]) => s === 'none' && !overridden.has(id)).map(([id]) => id));

  // Anything you've started/finished/failed means its prerequisites were done.
  const promote = (taskId, status) => {
    if (manualNone.has(taskId)) return;
    const cur = state[taskId];
    // Manual choices always win. Log states can be upgraded: the game doesn't always log the
    // hand-in, so a quest logged as "started" that a later quest required must be complete.
    if (cur && cur.source === 'manual') return;
    if (cur && rank(cur.status) >= rank(status)) return;
    state[taskId] = { status, source: 'inferred' };
    visit(taskId);
  };
  const visit = (taskId) => {
    const t = byId.get(taskId);
    if (!t) return;
    for (const req of t.taskRequirements) {
      if (req.status.includes('complete') && !req.status.includes('active')) promote(req.task, 'completed');
      else if (req.status.includes('active') && !req.status.includes('failed')) promote(req.task, 'started');
    }
  };
  for (const taskId of Object.keys(state)) visit(taskId);

  const meets = (req) => {
    const s = state[req.task]?.status;
    return (
      (req.status.includes('complete') && s === 'completed') ||
      (req.status.includes('active') && s === 'started') ||
      (req.status.includes('failed') && s === 'failed')
    );
  };

  for (const t of tasks) {
    if (state[t.id]) continue;
    let ok = t.taskRequirements.every(meets);
    if (ok && opts.level && t.minPlayerLevel > opts.level) ok = false;
    if (ok && opts.faction && t.factionName && t.factionName !== 'Any' && t.factionName !== opts.faction) ok = false;
    state[t.id] = { status: ok ? 'available' : 'locked', source: 'computed' };
  }
  return state;
}

function rank(status) {
  return { locked: 0, available: 1, started: 2, failed: 2, completed: 3 }[status] ?? 0;
}

module.exports = { computeTaskStates };
