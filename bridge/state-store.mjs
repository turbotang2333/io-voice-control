import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const fail = (code, message) => Object.assign(new Error(message), { code });
const id = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 512;
const selectionValid = value => value && id(value.workspaceId) && (value.agentId === undefined || id(value.agentId));
const requestValid = value => value && /^[a-f0-9]{64}$/.test(value.hash)
  && (value.kind === 'control' || ((value.kind === undefined || value.kind === 'task') && id(value.workspaceId) && id(value.agentId)));
const keyValid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

/** Machine state only: identities and request fingerprints, never questions, replies or credentials. */
export function createStateStore(path) {
  let state = { version: 1, selection: null, requests: {} };
  try {
    const bytes = readFileSync(path);
    if (bytes.length > 4 * 1024 * 1024) throw new Error('oversize');
    state = JSON.parse(bytes.toString('utf8'));
    if (state?.version !== 1 || (state.selection !== null && !selectionValid(state.selection))
      || !state.requests || Array.isArray(state.requests) || typeof state.requests !== 'object'
      || Object.entries(state.requests).some(([key, value]) => !keyValid(key) || !requestValid(value))) throw new Error('invalid');
  } catch (error) {
    if (error.code !== 'ENOENT') throw fail('STATE_INVALID', '选择或请求记录无法核对，已停止接入；请保留状态文件并检查。');
  }
  function commit(next) {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = openSync(temp, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify(next));
      fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temp, path);
      state = next;
    } catch {
      throw fail('STATE_WRITE_FAILED', '未能保存选择或请求记录，本次没有重新发送；请检查电脑存储。');
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temp); } catch { /* A committed temporary file no longer exists. */ }
    }
  }
  return {
    getSelection() { return state.selection ? { ...state.selection } : null; },
    saveSelection(value) {
      if (!selectionValid(value)) throw fail('STATE_INVALID', '选择记录格式无效。');
      const selection = { workspaceId: value.workspaceId, ...(value.agentId ? { agentId: value.agentId } : {}) };
      commit({ ...state, selection });
    },
    findRequest(key) { return Object.hasOwn(state.requests, key) ? { ...state.requests[key] } : null; },
    reserveRequest(key, value) {
      if (!keyValid(key) || !requestValid(value)) throw fail('INVALID_INPUT', '请求记录格式无效。');
      if (Object.hasOwn(state.requests, key)) throw fail('REQUEST_CONFLICT', '请求编号已使用，请先核对原会话。');
      if (Object.keys(state.requests).length >= 4096) throw fail('SESSION_FULL', '请求记录已满，请先核对并归档；不会自动清除或重发。');
      const record = { hash: value.hash, ...(value.kind ? { kind: value.kind } : {}),
        ...(value.workspaceId ? { workspaceId: value.workspaceId } : {}), ...(value.agentId ? { agentId: value.agentId } : {}) };
      commit({ ...state, requests: { ...state.requests, [key]: record } });
    },
  };
}
