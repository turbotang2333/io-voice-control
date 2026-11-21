import { readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { validId } from './journal.mjs';
const fail = code => Object.assign(new Error(code), { code });
const valid = r => r && validId(r.projectId) && /^[a-f0-9]{64}$/.test(r.nameHash)
  && ['reserved', 'created', 'listed'].includes(r.status)
  && (r.status === 'reserved' ? r.threadId === undefined || validId(r.threadId) : validId(r.threadId))
  && Object.keys(r).every(k => ['projectId', 'nameHash', 'status', 'threadId'].includes(k));

/** Call only while holding the enclosing navigation journal lock. No names, prompts or paths. */
export function openCreationStore(path) {
  let data = { version: 1, requests: {} };
  try {
    const bytes = readFileSync(path);
    if (bytes.length > 1024 * 1024) throw fail('CREATION_STORE_INVALID');
    data = JSON.parse(bytes.toString('utf8'));
    if (data?.version !== 1 || !data.requests || typeof data.requests !== 'object' || Array.isArray(data.requests)
      || Object.keys(data).some(k => !['version', 'requests'].includes(k))
      || Object.entries(data.requests).some(([id, r]) => !validId(id) || !valid(r))) throw fail('CREATION_STORE_INVALID');
  } catch (e) { if (e.code !== 'ENOENT') throw fail('CREATION_STORE_INVALID'); }
  function commit(next) {
    const bytes = JSON.stringify(next);
    if (Buffer.byteLength(bytes) > 1024 * 1024) throw fail('CREATION_STORE_FULL');
    const temp = path + '.' + randomUUID() + '.tmp'; let fd;
    try {
      fd = openSync(temp, 'wx', 0o600); writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temp, path); data = next;
    } catch { throw fail('STATE_WRITE_FAILED'); }
    finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temp); } catch {} }
  }
  function update(id, patch) {
    const old = Object.hasOwn(data.requests, id) ? data.requests[id] : null;
    if (!old) throw fail('CREATION_STORE_INVALID');
    const record = { ...old, ...patch };
    if (!valid(record) || (old.threadId && old.threadId !== record.threadId)) throw fail('CREATION_STORE_INVALID');
    commit({ ...data, requests: { ...data.requests, [id]: record } });
  }
  return {
    get: id => Object.hasOwn(data.requests, id) ? { ...data.requests[id] } : null,
    records: () => Object.entries(data.requests).map(([id, r]) => ({ requestId: id, ...r })),
    reserve(id, projectId, nameHash) {
      const record = { projectId, nameHash, status: 'reserved' };
      if (!validId(id) || !valid(record)) throw fail('INVALID_INPUT');
      if (Object.hasOwn(data.requests, id)) throw fail('CREATION_REPLAY');
      if (Object.keys(data.requests).length >= 4096) throw fail('CREATION_STORE_FULL');
      commit({ ...data, requests: { ...data.requests, [id]: record } });
    },
    assign: (id, threadId) => update(id, { threadId }),
    finish: id => update(id, { status: 'created' }),
    listed: id => update(id, { status: 'listed' }),
  };
}
