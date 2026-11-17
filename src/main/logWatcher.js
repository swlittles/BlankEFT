'use strict';
// Reads every past EFT log session once, then tails the newest session for live events.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { splitEntries, interpretEntry, isCompleteEntry } = require('./logParser');

const WATCHED_FILE_RE = /(application|push-notifications|backend)(_\d+)?\.log$/i;
// Backend logs are large and only a few lines matter, so skip parsing unless one of them is present.
const BACKEND_RE = /backend(_\d+)?\.log$/i;
const BACKEND_NEEDLE = '/client/prestige/obtain';
const FOLDER_RE = /^log_(\d{4})\.(\d{2})\.(\d{2})_(\d{2})-(\d{2})-(\d{2})/;

function folderTime(name) {
  const m = FOLDER_RE.exec(name);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
}

function listFolders(logsDir) {
  try {
    return fs
      .readdirSync(logsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && FOLDER_RE.test(d.name))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

function listWatchedFiles(folderPath) {
  try {
    return fs
      .readdirSync(folderPath)
      .filter((f) => WATCHED_FILE_RE.test(f))
      // application before push-notifications so the session mode is known first
      .sort((a, b) => (/application/i.test(a) === /application/i.test(b) ? a.localeCompare(b) : /application/i.test(a) ? -1 : 1))
      .map((f) => path.join(folderPath, f));
  } catch {
    return [];
  }
}

function readRange(file, start, end) {
  const len = end - start;
  if (len <= 0) return '';
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, start);
    return buf.toString('utf8', 0, n);
  } finally {
    fs.closeSync(fd);
  }
}

class LogWatcher extends EventEmitter {
  /**
   * @param {string} logsDir EFT Logs folder
   * @param {object} opts { pollMs }
   */
  constructor(logsDir, opts = {}) {
    super();
    this.logsDir = logsDir;
    this.pollMs = opts.pollMs || 500;
    this.timer = null;
    this.live = null; // { name, path, mode, files: Map<file, {offset, rest, idlePolls}> }
  }

  /** Parse a whole folder (history). Returns events sorted by time. */
  readFolder(name) {
    const folderPath = path.join(this.logsDir, name);
    let mode = null;
    const events = [];
    for (const file of listWatchedFiles(folderPath)) {
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      if (BACKEND_RE.test(file) && !text.includes(BACKEND_NEEDLE)) continue;
      for (const entry of splitEntries(text, { final: true }).entries) {
        const ev = interpretEntry(entry);
        if (!ev) continue;
        if (ev.type === 'mode' && !mode) mode = ev.mode;
        events.push(ev);
      }
    }
    for (const ev of events) {
      ev.mode = mode;
      ev.folder = name;
    }
    events.sort((a, b) => (a.time || 0) - (b.time || 0));
    return { mode, events };
  }

  start() {
    const folders = listFolders(this.logsDir);
    const history = [];
    const sessions = [];
    for (const name of folders) {
      const { mode, events } = this.readFolder(name);
      sessions.push({ name, time: folderTime(name), mode });
      history.push(...events);
    }
    this.emit('history', { events: history, sessions });
    const newest = folders[folders.length - 1];
    if (newest) this.attachLive(newest, true);
    this.timer = setInterval(() => this.poll(), this.pollMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Start tailing a folder. If `atEnd`, existing content was already read as history. */
  attachLive(name, atEnd) {
    const folderPath = path.join(this.logsDir, name);
    this.live = { name, path: folderPath, mode: null, files: new Map() };
    if (atEnd) this.live.mode = this.readFolder(name).mode;
    for (const file of listWatchedFiles(folderPath)) {
      let size = 0;
      try {
        size = fs.statSync(file).size;
      } catch {
        /* ignore */
      }
      this.live.files.set(file, { offset: atEnd ? size : 0, rest: '', idlePolls: 0 });
    }
    this.emit('session', { name, mode: this.live.mode });
  }

  poll() {
    try {
      const folders = listFolders(this.logsDir);
      const newest = folders[folders.length - 1];
      if (newest && (!this.live || newest > this.live.name)) {
        // Game was restarted: drain the old session, then follow the new one from the start.
        if (this.live) this.pollFiles(true);
        this.attachLive(newest, false);
      }
      if (!this.live) return;
      for (const file of listWatchedFiles(this.live.path)) {
        if (!this.live.files.has(file)) this.live.files.set(file, { offset: 0, rest: '', idlePolls: 0 });
      }
      this.pollFiles(false);
    } catch (err) {
      this.emit('error', err);
    }
  }

  pollFiles(final) {
    for (const [file, st] of this.live.files) {
      let size;
      try {
        size = fs.statSync(file).size;
      } catch {
        continue;
      }
      if (size < st.offset) {
        st.offset = 0; // truncated/replaced
        st.rest = '';
      }
      let text = st.rest;
      if (size > st.offset) {
        text += readRange(file, st.offset, size);
        st.offset = size;
        st.idlePolls = 0;
      } else {
        st.idlePolls++;
      }
      if (!text) continue;
      // Hold back the trailing entry until the file has been quiet for a couple of polls,
      // because its JSON body may still be mid-write.
      if (BACKEND_RE.test(file) && !text.includes(BACKEND_NEEDLE)) {
        st.rest = text.slice(text.lastIndexOf('\n') + 1); // keep only a partial last line
        continue;
      }
      // The newest entry may still be mid-write, so it's held back... unless it's clearly
      // complete, or the file has been quiet for a couple of checks.
      let { entries, rest } = splitEntries(text, { final: final || st.idlePolls >= 2 });
      if (rest && isCompleteEntry(rest)) {
        entries = entries.concat(splitEntries(rest, { final: true }).entries);
        rest = '';
      }
      st.rest = rest;
      for (const entry of entries) {
        const ev = interpretEntry(entry);
        if (!ev) continue;
        if (ev.type === 'mode') this.live.mode = ev.mode;
        ev.mode = this.live.mode;
        ev.folder = this.live.name;
        ev.live = true;
        this.emit('event', ev);
      }
    }
  }
}

module.exports = { LogWatcher, listFolders, folderTime };
