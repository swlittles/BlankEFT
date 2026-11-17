'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LogWatcher } = require('../src/main/logWatcher');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function line(time, type, msg) {
  return `2026-11-17 ${time}|1.3.0.2.48779|Info|${type}|${msg}\n`;
}

test('reads history, then tails live writes and follows a restarted game', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tqm-logs-'));
  const old = path.join(dir, 'log_2026.11.16_10-00-00_1.3.0.2.48779');
  fs.mkdirSync(old);
  fs.writeFileSync(path.join(old, '2026.11.16_10-00-00_1.3.0.2.48779 application_000.log'), line('10:00:01.000', 'application', 'Session mode: Pve') + line('10:05:00.000', 'application', 'scene preset path:maps/woods_preset.bundle rcid:x'));

  const w = new LogWatcher(dir, { pollMs: 50 });
  let history = null;
  const live = [];
  w.on('history', (h) => (history = h));
  w.on('event', (e) => live.push(e));
  w.start();
  try {
    assert.strictEqual(history.sessions.length, 1);
    assert.strictEqual(history.sessions[0].mode, 'pve');
    assert.deepStrictEqual(history.events.map((e) => e.type), ['mode', 'mapLoading']);

    // live append to the current session
    const app = path.join(old, '2026.11.16_10-00-00_1.3.0.2.48779 application_000.log');
    fs.appendFileSync(app, line('10:06:00.000', 'application', 'GameStarted:65.25(11.25) real:77.66(12.04) diff:12.41'));
    const push = path.join(old, '2026.11.16_10-00-00_1.3.0.2.48779 push-notifications_000.log');
    fs.writeFileSync(push, line('10:20:00.000', 'push-notifications', 'Got notification | ChatMessageReceived') + '{\n  "message": {\n    "type": 10,\n');
    await sleep(80);
    fs.appendFileSync(push, '    "templateId": "5967733e86f774602332fc84 description 0"\n  }\n}\n');
    await sleep(400);
    assert.deepStrictEqual(live.map((e) => e.type), ['raidStarted', 'task']);
    assert.strictEqual(live[1].taskId, '5967733e86f774602332fc84');
    assert.strictEqual(live[1].status, 'started');
    assert.strictEqual(live[1].mode, 'pve');

    // game restarts in PvP: new folder appears
    const neu = path.join(dir, 'log_2026.11.17_12-00-00_1.3.0.2.48779');
    fs.mkdirSync(neu);
    fs.writeFileSync(path.join(neu, '2026.11.17_12-00-00_1.3.0.2.48779 application_000.log'), line('12:00:01.000', 'application', 'Session mode: Regular') + line('12:05:00.000', 'application', 'scene preset path:maps/customs_preset.bundle rcid:x'));
    await sleep(400);
    const tail = live.slice(2);
    assert.deepStrictEqual(tail.map((e) => e.type), ['mode', 'mapLoading']);
    assert.strictEqual(tail[1].mode, 'regular');
  } finally {
    w.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
