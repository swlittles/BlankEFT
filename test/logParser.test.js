'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { splitEntries, interpretEntry, parseScreenshotName, normalizeMode } = require('../src/main/logParser');
const { computeTaskStates } = require('../src/main/questState');

const APP_LOG = [
  '2026-11-04 23:30:47.384|1.3.0.1.48558|Info|application|Session mode: Pve',
  '2026-11-04 23:42:40.204|1.3.0.1.48558|Info|application|scene preset path:maps/sandbox_preset.bundle rcid:sandbox.scenespreset.asset',
  "2026-11-04 23:43:06.092|1.3.0.1.48558|Debug|application|TRACE-NetworkGameCreate profileStatus: 'Profileid: abc, Status: Busy, RaidMode: Online, Ip: 1.2.3.4, Port: 17014, Location: Sandbox, Sid: x, GameMode: deathmatch, shortId: ABC123'",
  '2026-11-04 23:43:55.423|1.3.0.1.48558|Info|application|GameStarted:65.25(11.25) real:77.66(12.04) diff:12.41',
  '',
].join('\r\n');

const PUSH_LOG = [
  '2026-11-05 00:08:14.806|1.3.0.1.48558|Info|push-notifications|Got notification | ChatMessageReceived',
  '{',
  '  "type": "new_message",',
  '  "eventId": "e1",',
  '  "message": {',
  '    "type": 12,',
  '    "dt": 1792101117,',
  '    "text": "quest started",',
  '    "templateId": "61604635c725987e815b1a46 successMessageText 5a7c2eca46aef81a7ca2145d 0"',
  '  }',
  '}',
  '2026-11-05 00:09:14.806|1.3.0.1.48558|Info|push-notifications|Got notification | UserMatchOver',
  '{',
  '  "type": "userMatchOver",',
  '  "location": "Sandbox"',
  '}',
  '',
].join('\n');

test('application log → mode, map, raid events', () => {
  const events = splitEntries(APP_LOG, { final: true }).entries.map(interpretEntry).filter(Boolean);
  assert.deepStrictEqual(
    events.map((e) => e.type),
    ['mode', 'mapLoading', 'raidLocation', 'raidStarted']
  );
  assert.strictEqual(events[0].mode, 'pve');
  assert.strictEqual(events[1].scenePath, 'maps/sandbox_preset.bundle');
  assert.strictEqual(events[2].nameId, 'Sandbox');
  assert.strictEqual(events[2].raidId, 'ABC123');
});

test('push notifications → task finished + raid ended', () => {
  const events = splitEntries(PUSH_LOG, { final: true }).entries.map(interpretEntry).filter(Boolean);
  assert.strictEqual(events.length, 2);
  assert.deepStrictEqual(
    { type: events[0].type, status: events[0].status, taskId: events[0].taskId, time: events[0].time },
    { type: 'task', status: 'finished', taskId: '61604635c725987e815b1a46', time: 1792101117000 }
  );
  assert.strictEqual(events[1].type, 'raidEnded');
  assert.strictEqual(events[1].nameId, 'Sandbox');
});

test('trailing entry is held back until complete', () => {
  const partial = PUSH_LOG.split('\n').slice(0, 6).join('\n') + '\n';
  const r1 = splitEntries(partial);
  assert.strictEqual(r1.entries.length, 0);
  const r2 = splitEntries(r1.rest + PUSH_LOG.split('\n').slice(6).join('\n'));
  // first entry now complete, UserMatchOver is the held-back trailing entry
  assert.strictEqual(r2.entries.length, 1);
  assert.strictEqual(interpretEntry(r2.entries[0]).type, 'task');
  assert.match(r2.rest, /UserMatchOver/);
});

test('prestige obtained (backend log)', () => {
  const text = [
    '2026-10-08 22:13:10.457|1.2.0.0.47888|Info|backend|---> Request HTTPS, id [71]: URL: https://gw-pve.escapefromtarkov.com/client/prestige/obtain. ',
    '2026-10-08 22:13:10.960|1.2.0.0.47888|Info|backend|<--- Response HTTPS, id [71]: URL: https://gw-pve.escapefromtarkov.com/client/prestige/obtain, DownloadSeconds: 0.486',
    '2026-10-08 22:13:11.000|1.2.0.0.47888|Info|backend|<--- Response HTTPS, id [72]: URL: https://gw-pve.escapefromtarkov.com/client/prestige/list, DownloadSeconds: 0.1',
    '',
  ].join('\n');
  const events = splitEntries(text, { final: true }).entries.map(interpretEntry).filter(Boolean);
  assert.strictEqual(events.length, 1); // only the successful obtain response, not the request or /list
  assert.strictEqual(events[0].type, 'prestige');
  assert.strictEqual(events[0].host, 'gw-pve.escapefromtarkov.com');
});

test('logged player position', () => {
  const text = '2026-10-15 01:12:43.809|1.2.0.0.47965|Info|application|Reason:Lift, Position:(50.222, 23.439, -156.873), SpeedLimit:0.53, CurrentState:Idle\n';
  const ev = interpretEntry(splitEntries(text, { final: true }).entries[0]);
  assert.deepStrictEqual([ev.type, ev.x, ev.y, ev.z, ev.reason], ['logPosition', 50.222, 23.439, -156.873, 'Lift']);
});

test('screenshot filename → position and yaw', () => {
  const p = parseScreenshotName('2026-08-14[00-49]_125.18, 25.93, 137.28_0.04829, -0.64264, -0.03765, 0.76372_12.75 (0).png');
  assert.deepStrictEqual([p.x, p.y, p.z], [125.18, 25.93, 137.28]);
  assert.ok(Number.isFinite(p.yaw));
  assert.strictEqual(parseScreenshotName('2026-10-10[15-36]_19.25 (0).png'), null);
});

test('complete trailing entries are recognised so they can be used right away', () => {
  const { isCompleteEntry } = require('../src/main/logParser');
  const header = '2026-11-17 10:05:00.000|1|Info|application|scene preset path:maps/woods_preset.bundle\n';
  assert.strictEqual(isCompleteEntry(header), true);
  assert.strictEqual(isCompleteEntry(header.trimEnd()), false, 'last line not finished');
  const note = '2026-11-17 10:06:00.000|1|Info|push-notifications|Got notification | ChatMessageReceived\n';
  assert.strictEqual(isCompleteEntry(note), false, 'JSON body still to come');
  assert.strictEqual(isCompleteEntry(note + '{\n  "message": {\n'), false, 'half-written JSON');
  assert.strictEqual(isCompleteEntry(note + '{\n  "message": { "type": 12 }\n}\n'), true);
});

test('session modes', () => {
  assert.strictEqual(normalizeMode('Pve'), 'pve');
  assert.strictEqual(normalizeMode('PvpSeason'), 'pvpseason');
  assert.strictEqual(normalizeMode('Regular'), 'regular');
});

test('quest state: logs, inference, manual overrides, availability', () => {
  const tasks = [
    { id: 'a', minPlayerLevel: 1, factionName: 'Any', taskRequirements: [] },
    { id: 'b', minPlayerLevel: 1, factionName: 'Any', taskRequirements: [{ task: 'a', status: ['complete'] }] },
    { id: 'c', minPlayerLevel: 1, factionName: 'Any', taskRequirements: [{ task: 'b', status: ['complete'] }] },
    { id: 'd', minPlayerLevel: 30, factionName: 'Any', taskRequirements: [] },
    { id: 'e', minPlayerLevel: 1, factionName: 'BEAR', taskRequirements: [] },
  ];
  const events = [
    { taskId: 'a', status: 'started', time: 1 },
    { taskId: 'c', status: 'started', time: 5 },
  ];
  let s = computeTaskStates(tasks, events, {}, { level: 10, faction: 'USEC' });
  assert.strictEqual(s.a.status, 'completed'); // upgraded: c needed b needed a
  assert.strictEqual(s.b.status, 'completed');
  assert.strictEqual(s.b.source, 'inferred');
  assert.strictEqual(s.c.status, 'started');
  assert.strictEqual(s.d.status, 'locked'); // level too low
  assert.strictEqual(s.e.status, 'locked'); // wrong faction

  s = computeTaskStates(tasks, events, { c: 'completed' }, {});
  assert.strictEqual(s.c.status, 'completed');
  assert.strictEqual(s.c.source, 'manual');

  s = computeTaskStates(tasks, events, {}, { since: 3 });
  assert.strictEqual(s.a.status, 'completed'); // still inferred from c
});
