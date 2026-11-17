'use strict';
// Pure parsing of Escape from Tarkov log files. No I/O here so it can be unit tested.
//
// EFT log lines look like:
//   2026-11-04 23:42:40.204|1.3.0.1.48558|Info|application|scene preset path:maps/sandbox_preset.bundle rcid:...
// Some entries (push notifications) are followed by a multi-line JSON body:
//   2026-11-05 00:08:14.806|1.3.0.1.48558|Info|push-notifications|Got notification | UserMatchOver
//   {
//     "type": "userMatchOver", ...
//   }

const HEADER_RE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}\.\d{3})(?: ([+-]\d{2}:\d{2}))?\|([^|]*)\|([^|]*)\|([^|]*)\|(.*)$/;

// Task chat message types (from the game's MessageType enum).
const TASK_MESSAGE_TYPES = { 10: 'started', 11: 'failed', 12: 'finished' };

// "Session mode:" values seen in logs → tarkov.dev data set + progress bucket.
function normalizeMode(raw) {
  const m = String(raw || '').toLowerCase();
  if (m === 'pve') return 'pve';
  if (m === 'pvpseason') return 'pvpseason';
  return 'regular';
}

function dataModeFor(mode) {
  return mode === 'pve' ? 'pve' : 'regular';
}

function toTimestamp(date, time, tz) {
  // Logs are written in local time; some versions append an explicit offset.
  const iso = `${date}T${time}${tz || ''}`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Split log text into entries. Returns { entries, rest } where `rest` is the text of the
 * trailing entry, which may still be incomplete while the game is writing it.
 * Pass `final: true` to treat the trailing entry as complete.
 */
function splitEntries(text, { final = false } = {}) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split(/\r?\n/);
  // If the text does not end in a newline, the last line is partial.
  const endsWithNewline = /\n$/.test(text);
  const entries = [];
  let current = null;
  let currentStartLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === lines.length - 1 && line === '') break;
    const m = HEADER_RE.exec(line);
    if (m) {
      if (current) entries.push(current);
      current = {
        timestamp: toTimestamp(m[1], m[2], m[3]),
        version: m[4],
        level: m[5],
        logType: m[6],
        message: m[7],
        body: [],
      };
      currentStartLine = i;
    } else if (current) {
      current.body.push(line);
    }
  }

  let rest = '';
  if (current) {
    if (final) {
      entries.push(current);
    } else {
      rest = lines.slice(currentStartLine).join('\n');
      if (!endsWithNewline) {
        // keep as-is; partial last line stays in rest
      } else if (!rest.endsWith('\n')) {
        rest += '\n';
      }
    }
  }
  return { entries: entries.map(finishEntry), rest };
}

function finishEntry(e) {
  const bodyText = e.body.join('\n').trim();
  let json = null;
  if (bodyText.startsWith('{')) {
    try {
      json = JSON.parse(bodyText);
    } catch {
      json = null;
    }
  }
  return { timestamp: e.timestamp, version: e.version, level: e.level, logType: e.logType, message: e.message, json };
}

/** Turn a parsed entry into a high-level event, or null if it's not interesting. */
function interpretEntry(entry) {
  const msg = entry.message || '';
  const t = entry.timestamp;

  if (msg.startsWith('Session mode: ')) {
    const raw = msg.slice('Session mode: '.length).split(/[\s|]/)[0];
    return { type: 'mode', mode: normalizeMode(raw), rawMode: raw, time: t };
  }

  let m = /scene preset path:(maps\/[A-Za-z0-9_]+\.bundle)/.exec(msg);
  if (m) return { type: 'mapLoading', scenePath: m[1], time: t };

  if (msg.startsWith('TRACE-NetworkGameCreate profileStatus')) {
    m = /Location: ([^,]+)/.exec(msg);
    if (m) {
      const raid = /shortId: ([A-Z0-9]{6})/.exec(msg);
      return { type: 'raidLocation', nameId: m[1].trim(), online: /RaidMode: Online/.test(msg), raidId: raid ? raid[1] : null, time: t };
    }
  }

  if (/^GameStarted:/.test(msg)) return { type: 'raidStarted', time: t };

  // Prestiging resets all quest progress for that game mode. The backend log records the call.
  m = /^<--- Response HTTPS, id \[\d+\]: URL: https:\/\/([^/]+)\/client\/prestige\/obtain\b/.exec(msg);
  if (m) return { type: 'prestige', host: m[1], time: t };

  // The game occasionally logs your own position (movement speed checks: Lift, Speed, Stuck…).
  m = /^Reason:(\w+), Position:\((-?[\d.]+), (-?[\d.]+), (-?[\d.]+)\)/.exec(msg);
  if (m) return { type: 'logPosition', reason: m[1], x: +m[2], y: +m[3], z: +m[4], time: t };

  if (/Network game matching (aborted|cancelled)/.test(msg)) return { type: 'matchCancelled', time: t };

  if (msg.includes('Got notification | UserMatchOver')) {
    return { type: 'raidEnded', nameId: entry.json?.location || null, time: t };
  }

  if (msg.includes('Got notification | ChatMessageReceived')) {
    const message = entry.json?.message;
    const status = message && TASK_MESSAGE_TYPES[message.type];
    if (status && typeof message.templateId === 'string') {
      const taskId = message.templateId.split(' ')[0];
      if (/^[0-9a-f]{24}$/i.test(taskId)) {
        const dt = typeof message.dt === 'number' ? message.dt * 1000 : null;
        return { type: 'task', status, taskId, time: dt || t, eventId: entry.json?.eventId || null };
      }
    }
  }

  return null;
}

/**
 * Parse an EFT screenshot filename that contains a position, e.g.
 *   2026-08-14[00-49]_125.18, 25.93, 137.28_0.04829, -0.64264, -0.03765, 0.76372_12.75 (0).png
 * Returns { x, y, z, yaw } or null. Screenshots taken outside a raid have no position.
 */
function parseScreenshotName(name) {
  const m = /_(-?\d+\.\d+), (-?\d+\.\d+), (-?\d+\.\d+)_(-?\d+\.\d+), (-?\d+\.\d+), (-?\d+\.\d+), (-?\d+\.\d+)/.exec(name);
  if (!m) return null;
  const [x, y, z, qx, qy, qz, qw] = m.slice(1).map(Number);
  return { x, y, z, yaw: quaternionToYaw(qx, qy, qz, qw) };
}

// Same yaw extraction tarkov.dev's position sharing uses (Unity quaternion, y-up).
function quaternionToYaw(qx, qy, qz, qw) {
  const sinyCosp = 2 * (qw * qy + qx * qz);
  const cosyCosp = 1 - 2 * (qz * qz + qy * qy);
  return (Math.atan2(sinyCosp, cosyCosp) * 180) / Math.PI;
}

module.exports = { splitEntries, interpretEntry, parseScreenshotName, normalizeMode, dataModeFor, quaternionToYaw };
