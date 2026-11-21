import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const fail = code => Object.assign(new Error(code), { code });
const keyValid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const idValid = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const valid = value => value && idValid(value.workspaceId) && idValid(value.agentId)
  && /^[a-f0-9]{64}$/.test(value.nameHash) && ['pending', 'created'].includes(value.status);

/** Creation effects only: stable identities and fingerprints, never titles, prompts or profile settings. */
export function openCreationStore(path) {
  let state = { version: 1, requests: {} };
  try {
    const bytes = readFileSync(path);
    if (bytes.length > 4 * 1024 * 1024) throw fail('CREATION_STORE_INVALID');
    state = JSON.parse(bytes.toString('utf8'));
    if (state?.version !== 1 || !state.requests || typeof state.requests !== 'object' || Array.isArray(state.requests)
      || Object.keys(state.requests).length > 4096
      || Object.entries(state.requests).some(([key, value]) => !keyValid(key) || !valid(value))) throw fail('CREATION_STORE_INVALID');
  } catch (error) { if (error.code !== 'ENOENT') throw fail('CREATION_STORE_INVALID'); }
  function commit(requests) {
    const next = { version: 1, requests }, temp = `${path}.${randomUUID()}.tmp`;
    let fd;
    try {
      mkdirSync(dirname(path), { recursive: true });
      fd = openSync(temp, 'wx', 0o600); writeFileSync(fd, JSON.stringify(next));
      fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temp, path); state = next;
    } catch { throw fail('CREATION_STORE_WRITE_FAILED'); }
    finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temp); } catch {} }
  }
  return {
    get(key) { return Object.hasOwn(state.requests, key) ? { ...state.requests[key] } : null; },
    pending(workspaceId, nameHash) {
      return Object.entries(state.requests).filter(([, r]) => r.status === 'pending' && r.workspaceId === workspaceId && r.nameHash === nameHash)
        .map(([requestId, record]) => ({ requestId, ...record }));
    },
    reserve(key, value) {
      if (!keyValid(key) || !valid({ ...value, status: 'pending' })) throw fail('CREATION_STORE_INVALID');
      if (Object.hasOwn(state.requests, key)) throw fail('CREATION_REPLAY');
      if (Object.values(state.requests).some(r => r.status === 'pending' && r.workspaceId === value.workspaceId && r.nameHash === value.nameHash)) throw fail('CREATION_UNCERTAIN');
      if (Object.keys(state.requests).length >= 4096) throw fail('CREATION_STORE_WRITE_FAILED');
      const record = { workspaceId: value.workspaceId, agentId: value.agentId, nameHash: value.nameHash, status: 'pending' };
      commit({ ...state.requests, [key]: record });
    },
    markCreated(key) {
      if (!Object.hasOwn(state.requests, key)) throw fail('CREATION_STORE_INVALID');
      if (state.requests[key].status !== 'created') commit({ ...state.requests, [key]: { ...state.requests[key], status: 'created' } });
    },
  };
}
