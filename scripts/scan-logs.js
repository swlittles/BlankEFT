'use strict';
// Dev helper: read all EFT logs on this PC and print what the app would detect.
const path = require('path');
const os = require('os');
const { findLogsDir } = require('../src/main/eftPaths');
const { LogWatcher } = require('../src/main/logWatcher');
const { TarkovData } = require('../src/main/tarkovData');
const { computeTaskStates } = require('../src/main/questState');
const { dataModeFor } = require('../src/main/logParser');

(async () => {
  const { installDir, logsDir } = await findLogsDir(process.argv[2]);
  console.log('install:', installDir, '\nlogs:', logsDir);
  if (!logsDir) process.exit(1);
  const w = new LogWatcher(logsDir);
  let hist;
  w.on('history', (h) => (hist = h));
  w.start();
  w.stop();
  const modes = {};
  for (const s of hist.sessions) modes[s.mode || 'unknown'] = (modes[s.mode || 'unknown'] || 0) + 1;
  console.log('sessions:', hist.sessions.length, modes);
  const byType = {};
  for (const e of hist.events) byType[e.type] = (byType[e.type] || 0) + 1;
  console.log('events:', byType);
  const data = new TarkovData(path.join(os.tmpdir(), 'tqm-scan-cache'));
  for (const mode of Object.keys(modes).filter((m) => m !== 'unknown')) {
    const model = await data.load(dataModeFor(mode));
    const prestiges = hist.events.filter((e) => e.type === 'prestige' && (e.mode === mode || (!e.mode && mode === 'pve')));
    const since = prestiges.length ? prestiges[prestiges.length - 1].time : null;
    if (prestiges.length) console.log(`
[${mode}] prestige(s): ${prestiges.map((p) => new Date(p.time).toLocaleString()).join(', ')}`);
    const ev = hist.events.filter((e) => e.type === 'task' && e.mode === mode);
    const st = computeTaskStates(model.tasks, ev, {}, { since });
    const count = {};
    for (const s of Object.values(st)) count[`${s.status}/${s.source}`] = (count[`${s.status}/${s.source}`] || 0) + 1;
    console.log(`\n[${mode}] task events: ${ev.length}`, count);
    const unknown = ev.filter((e) => !model.tasks.some((t) => t.id === e.taskId));
    console.log(`  events for tasks not in tarkov.dev data: ${unknown.length}`);
    const active = model.tasks.filter((t) => st[t.id].status === 'started').map((t) => `${t.name} (${t.trader.name})`);
    console.log('  active:', active.slice(0, 12).join('; '), active.length > 12 ? `… +${active.length - 12}` : '');
    const lastMap = [...hist.events].reverse().find((e) => e.mode === mode && (e.type === 'mapLoading' || e.type === 'raidLocation'));
    const m = lastMap && model.maps.find((x) => x.scenePath === lastMap.scenePath || x.nameId === lastMap.nameId);
    console.log('  last map:', m ? `${m.name} (${m.normalizedName}) display=${!!model.display[m.normalizedName]}` : lastMap);
  }
})().catch((e) => { console.error(e); process.exit(1); });
