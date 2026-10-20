'use strict';

const fs = require('node:fs');

const OWNER_KEY = 'GATHA_JOB_OWNER';
const gone = (error) => ['ENOENT', 'ESRCH'].includes(error.code);
const executing = (record) => record && !['Z', 'X', 'x'].includes(record.state);

function parseStat(text) {
  const end = text.lastIndexOf(') ');
  const fields = text.slice(end + 2).trim().split(/\s+/);
  const pid = Number(text.slice(0, text.indexOf(' (')));
  if (end < 0 || !Number.isSafeInteger(pid) || pid < 1 || fields.length < 20 || !/^\d+$/.test(fields[19])) {
    throw new Error('Process metadata is unavailable');
  }
  return { pid, state: fields[0], parent: Number(fields[1]), group: Number(fields[2]),
    session: Number(fields[3]), started: fields[19] };
}

function readStat(pid) {
  try { return parseStat(fs.readFileSync('/proc/' + pid + '/stat', 'utf8')); }
  catch (error) { if (gone(error)) return null; throw error; }
}

// The pinned Linux renderer inherits its environment for Chromium, ffmpeg and
// the compositor. A random marker follows even double-forked/reparented children.
// Environment bytes are compared in memory, cleared, and never logged/retained.
// PID/start-time ancestry also tracks children that subsequently change groups.
class ProcessLedger {
  constructor(marker, rootPid) {
    if (process.platform !== 'linux' || !/^[a-f0-9]{48}$/.test(marker) || !Number.isSafeInteger(rootPid) || rootPid < 2) {
      throw new Error('Linux process ownership is unavailable');
    }
    this.marker = Buffer.from(OWNER_KEY + '=' + marker + '\0');
    this.rootPid = rootPid;
    this.records = new Map();
  }
  hasMarker(pid, buffer) {
    let descriptor;
    try {
      descriptor = fs.openSync('/proc/' + pid + '/environ', 'r');
      let length = 0;
      while (length < buffer.length) {
        const count = fs.readSync(descriptor, buffer, length, buffer.length - length, null);
        if (!count) break;
        length += count;
      }
      if (length === buffer.length) throw new Error('Process environment exceeds the inspection bound');
      const position = buffer.subarray(0, length).indexOf(this.marker);
      return position >= 0 && (position === 0 || buffer[position - 1] === 0);
    } catch (error) { if (gone(error)) return false; throw error; }
    finally { if (descriptor !== undefined) fs.closeSync(descriptor); buffer.fill(0); }
  }
  sample() {
    const names = fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name));
    if (names.length > 8192) throw new Error('Process inventory exceeds the inspection bound');
    const current = new Map();
    const owned = new Map();
    const buffer = Buffer.alloc(256 * 1024);
    for (const name of names) {
      const record = readStat(Number(name));
      if (!record) continue;
      current.set(record.pid, record);
      const prior = this.records.get(record.pid);
      if ((prior && prior.started === record.started) ||
          (executing(record) && this.hasMarker(record.pid, buffer))) owned.set(record.pid, record);
    }
    let changed;
    do {
      changed = false;
      for (const record of current.values()) {
        if (!owned.has(record.pid) && owned.has(record.parent)) { owned.set(record.pid, record); changed = true; }
      }
    } while (changed);
    for (const record of owned.values()) {
      if (record.pid < 2 || record.pid === process.pid) throw new Error('Invalid process ownership boundary');
      this.records.set(record.pid, record);
    }
    if (this.records.size > 8192) throw new Error('Owned process inventory exceeds the inspection bound');
    return { live: [...owned.values()].filter(executing),
      exited: [...owned.values()].filter((record) => !executing(record)),
      observed: [...this.records.values()] };
  }
  signal(records, signal) {
    for (const record of records) {
      const current = readStat(record.pid);
      if (!executing(current) || current.started !== record.started) continue;
      try { process.kill(record.pid, signal); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
}

module.exports = { ProcessLedger, OWNER_KEY, parseStat, readStat, executing };
