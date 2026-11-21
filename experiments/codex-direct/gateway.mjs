import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { directoryKey } from './catalog.mjs';

const fail = code => Object.assign(new Error(code), { code });
const label = 'Codex 直连实验';

export function openExperimentState(path) {
  const state = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { version: 1, requests: [] };
  if (state.version !== 1 || !Array.isArray(state.requests) || (state.threadId !== undefined && typeof state.threadId !== 'string')) throw fail('INVALID_STATE');
  return {
    data: state,
    save() {
      mkdirSync(dirname(path), { recursive: true });
      const temporary = path + '.' + randomUUID() + '.tmp';
      writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
      renameSync(temporary, path);
    },
  };
}

export async function createCodexGateway(rpc, { state, cwd, timeoutMs = 180000, preserveConfig = false, assertCurrent }) {
  const settings = preserveConfig ? {} : { cwd, approvalPolicy: 'never', sandbox: 'read-only' };
  if (preserveConfig && !state.data.threadId) throw fail('WRONG_THREAD');
  assertCurrent?.();
  const result = state.data.threadId
    ? await rpc.request('thread/resume', { ...settings, threadId: state.data.threadId, excludeTurns: true })
    : await rpc.request('thread/start', { ...settings,
      developerInstructions: '本会话是眼镜直连 Codex 的独立对话实验。只进行简短中文对话，不调用工具，不读取或修改文件，不访问网络，不创建子 Agent。',
    });
  assertCurrent?.();
  const thread = result.thread;
  if (!thread?.id || (state.data.threadId && thread.id !== state.data.threadId)) throw fail('WRONG_THREAD');
  if (preserveConfig && (!directoryKey(cwd) || directoryKey(thread.cwd) !== directoryKey(cwd))) throw fail('WRONG_THREAD');
  if (thread.status?.type === 'active') throw fail('CODEX_BUSY');
  state.data.threadId = thread.id;
  state.save();
  let active = false;
  let uncertain = false;
  const cache = new Map();
  return {
    threadId: thread.id,
    model: result.model,
    async submit({ requestId, text, onUpdate = () => {}, assertCurrent }) {
      if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(requestId)
          || typeof text !== 'string' || !text.trim() || [...text].length > 4096) throw fail('INVALID_INPUT');
      text = text.trim();
      const hash = createHash('sha256').update(text).digest('hex');
      const previous = state.data.requests.find(item => item.id === requestId);
      if (previous) {
        if (previous.hash !== hash) throw fail('REQUEST_CONFLICT');
        return cache.get(requestId) ?? { requestId, status: 'unknown', text: '该请求已接收过，不会重复提交。请查看 Codex 实验会话。' };
      }
      const localReply = /^(当前项目|当前\s*Agent)$/iu.test(text) ? `当前是${label}，使用专用 Codex 会话。`
        : /^(列出项目|列出\s*Agent|选择\s*[1一])$/iu.test(text) ? `本次只有一个${label}会话，已选中，可以直接对话。` : null;
      if (localReply) return { requestId, status: 'idle', text: localReply };
      if (uncertain) throw fail('OUTCOME_UNKNOWN');
      if (active) throw fail('CODEX_BUSY');
      if (rpc.closed) throw fail('CODEX_DISCONNECTED');
      // A bounded spike: never discard old request IDs and risk resending after restart.
      if (state.data.requests.length >= 256) throw fail('EXPERIMENT_FULL');
      // Progress callbacks can synchronously trigger a switch. Check AFTER them,
      // before the durable pre-send record; no await occurs before turn/start.
      active = true;
      const record = { id: requestId, hash, status: 'unknown' };
      try {
        try { onUpdate({ type: 'state', state: 'working' }); } catch {}
        assertCurrent?.();
      } catch (error) { active = false; throw error; }
      try { state.data.requests.push(record); state.save(); }
      catch { active = false; throw fail('STATE_WRITE_FAILED'); }
      const operation = new Promise(resolve => {
        let turnId, finished = false, permitted = false;
        const messages = new Map();
        const early = [];
        const notify = update => { try { onUpdate(update); } catch { /* A disconnected display must not cause resubmission. */ } };
        const finish = (status, answer) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          rpc.off('notification', receive);
          rpc.off('permission', permission);
          rpc.off('disconnect', disconnected);
          active = false;
          if (['unknown', 'timeout'].includes(status)) uncertain = true;
          record.status = status;
          try { state.save(); } catch { /* The durable pre-send record already blocks replay. */ }
          resolve({ requestId, status, text: answer ?? null });
        };
        const disconnected = () => finish('unknown');
        const permission = params => {
          if (params?.threadId === thread.id) { permitted = true; notify({ type: 'state', state: 'permission' }); }
        };
        const receive = message => {
          const { method, params: p } = message;
          if (p?.threadId !== thread.id) return;
          if (!turnId) { early.push(message); return; }
          if ((p.turnId ?? p.turn?.id) !== turnId) return;
          if (method === 'item/agentMessage/delta' && typeof p.delta === 'string') {
            messages.set(p.itemId, (messages.get(p.itemId) ?? '') + p.delta);
            notify({ type: 'text', text: [...messages.values()].join('\n') });
          }
          if (method === 'item/completed' && p.item?.type === 'agentMessage' && typeof p.item.text === 'string') messages.set(p.item.id, p.item.text);
          if (method === 'turn/completed') {
            const status = permitted ? 'permission' : p.turn.status === 'completed' ? 'idle' : p.turn.status === 'interrupted' ? 'unknown' : 'error';
            finish(status, status === 'idle' ? [...messages.values()].join('\n') || null : null);
          }
        };
        const timer = setTimeout(() => finish('timeout'), timeoutMs);
        rpc.on('notification', receive);
        rpc.on('permission', permission);
        rpc.on('disconnect', disconnected);
        rpc.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text }] })
          .then(result => {
            if (finished) return;
            if (!result.turn?.id) { finish('unknown'); return; }
            turnId = result.turn.id;
            for (const message of early) receive(message);
          }, () => finish('unknown'));
      });
      cache.set(requestId, operation);
      return operation;
    },
  };
}
