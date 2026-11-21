import { openSync, closeSync, readFileSync, writeFileSync, fsyncSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const fail = code => Object.assign(new Error(code), { code });
export const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const statuses = new Set(['unknown', 'queued', 'working', 'idle', 'failed']);
const validRecord = r => r && /^[a-f0-9]{64}$/.test(r.hash) && validId(r.clientId)
  && statuses.has(r.status) && (r.queueId === undefined || validId(r.queueId))
  && (r.turnId === undefined || validId(r.turnId))
  && (r.targetThreadId === undefined || validId(r.targetThreadId))
  && (r.kind === undefined || ['task', 'control'].includes(r.kind))
  && Object.keys(r).every(k => ['hash', 'clientId', 'status', 'queueId', 'turnId', 'targetThreadId', 'kind'].includes(k));
const validSelection = s => s && validId(s.projectId) && (s.threadId === undefined || validId(s.threadId))
  && Object.keys(s).every(k => ['projectId', 'threadId'].includes(k));

// Only opaque identities and fingerprints. Questions and replies stay in Codex.
export function openJournal(path, threadId) {
  if (!validId(threadId)) throw fail('INVALID_TARGET');
  let data = { version: 1, threadId, requests: {} };
  function load() { try {
    const bytes = readFileSync(path);
    if (bytes.length > 1024 * 1024) throw fail('JOURNAL_INVALID');
    data = JSON.parse(bytes.toString('utf8'));
    if (data.version !== 1 || !validId(data.threadId) || !data.requests || Array.isArray(data.requests)
      || typeof data.requests !== 'object' || Object.entries(data.requests).some(([k, v]) => !validId(k) || !validRecord(v))
      || (data.selection !== undefined && !validSelection(data.selection))) {
      throw fail('JOURNAL_INVALID');
    }
    if (data.threadId !== threadId) throw fail('JOURNAL_TARGET_MISMATCH');
  } catch (e) {
    if (e.code !== 'ENOENT') throw fail(e.code === 'JOURNAL_TARGET_MISMATCH' ? e.code : 'JOURNAL_INVALID');
  } }
  load();
  mkdirSync(dirname(path), { recursive: true });
  const lockPath = path + '.lock', owner = randomUUID();
  let closed = false;
  const claim = () => writeFileSync(lockPath, JSON.stringify({ pid: process.pid, owner }), { flag: 'wx', mode: 0o600 });
  try { claim(); }
  catch (e) {
    if (e.code !== 'EEXIST') throw fail('CONNECTOR_LOCKED');
    // Serialize stale-lock recovery. A competing fresh wx claim may win; never unlink it.
    const recovery = lockPath + '.recovery';
    try { writeFileSync(recovery, owner, { flag: 'wx', mode: 0o600 }); }
    catch { throw fail('CONNECTOR_LOCKED'); }
    try {
      let old;
      try { old = JSON.parse(readFileSync(lockPath, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw fail('CONNECTOR_LOCKED'); }
      if (old) {
        if (!Number.isSafeInteger(old.pid) || old.pid <= 0 || typeof old.owner !== 'string') throw fail('CONNECTOR_LOCKED');
        let dead = false;
        try { process.kill(old.pid, 0); } catch (error) { dead = error.code === 'ESRCH'; }
        if (!dead) throw fail('CONNECTOR_LOCKED');
        unlinkSync(lockPath);
      }
      try { claim(); } catch { throw fail('CONNECTOR_LOCKED'); }
    } finally { if (readFileSync(recovery, 'utf8') === owner) unlinkSync(recovery); }
  }
  function commit(next) {
    if (closed) throw fail('JOURNAL_CLOSED');
    const bytes = JSON.stringify(next);
    if (Buffer.byteLength(bytes) > 1024 * 1024) throw fail('JOURNAL_FULL');
    const temp = path + '.' + randomUUID() + '.tmp';
    let fd;
    try {
      fd = openSync(temp, 'wx', 0o600); writeFileSync(fd, bytes);
      fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temp, path); data = next;
    } catch { throw fail('STATE_WRITE_FAILED'); }
    finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temp); } catch {} }
  }
  const close = () => {
    if (closed) return;
    closed = true;
    if (JSON.parse(readFileSync(lockPath, 'utf8')).owner === owner) unlinkSync(lockPath);
  };
  // The preflight read may be stale: reload only after exclusive ownership is held.
  try { load(); commit(data); } catch (e) { close(); throw e; }
  return {
    threadId,
    getSelection() { return data.selection ? { ...data.selection } : null; },
    saveSelection(selection) {
      if (!validSelection(selection)) throw fail('JOURNAL_INVALID');
      commit({ ...data, selection: { ...selection } });
    },
    get(id) { return Object.hasOwn(data.requests, id) ? { ...data.requests[id] } : null; },
    unresolved() { return Object.values(data.requests).some(r => !['idle', 'failed'].includes(r.status)); },
    pending() { return Object.entries(data.requests).filter(([, r]) => !['idle', 'failed'].includes(r.status))
      .map(([id, r]) => [id, { ...r }]); },
    put(id, record) {
      if (!validId(id) || !validRecord(record)) throw fail('JOURNAL_INVALID');
      const old = Object.hasOwn(data.requests, id) ? data.requests[id] : null;
      if (old && (old.hash !== record.hash || old.clientId !== record.clientId)) throw fail('REQUEST_CONFLICT');
      if (!old && Object.keys(data.requests).length >= 4096) throw fail('JOURNAL_FULL');
      commit({ ...data, requests: { ...data.requests, [id]: { ...record } } });
    },
    close,
  };
}
