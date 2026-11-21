import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const failed = () => Object.assign(new Error('当前对话正文暂时无法读取。'), { code: 'SEARCH_HISTORY_FAILED' });
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string'
  && (process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));
function executable() {
  if (process.platform !== 'win32') return 'codex';
  const arch = process.arch === 'arm64' ? ['arm64', 'aarch64'] : ['x64', 'x86_64'];
  const native = join(process.env.APPDATA ?? '', 'npm/node_modules/@openai/codex/node_modules',
    `@openai/codex-win32-${arch[0]}/vendor/${arch[1]}-pc-windows-msvc/bin/codex.exe`);
  if (existsSync(native)) return native;
  const found = (process.env.PATH ?? '').split(';').map(dir => join(dir, 'codex.exe')).find(p => existsSync(p));
  if (!found) throw failed();
  return found;
}

/** Separate local reader process. The whitelist deliberately cannot resume or send. */
export function createCodexReadClient({ launch = spawn, command, timeoutMs = 30000 } = {}) {
  let child, lines, starting, closed = false, id = 0;
  const pending = new Map();
  const rejectAll = () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(failed()); } pending.clear(); };
  function send(method, params) {
    return new Promise((resolveResult, reject) => {
      const key = ++id;
      const timer = setTimeout(() => { pending.delete(key); reject(failed()); child?.kill(); }, timeoutMs);
      pending.set(key, { resolve: resolveResult, reject, timer });
      child.stdin.write(JSON.stringify({ id: key, method, params }) + '\n', error => {
        if (error) { const p = pending.get(key); if (p) { pending.delete(key); clearTimeout(p.timer); p.reject(failed()); } }
      });
    });
  }
  async function start() {
    if (closed) throw failed();
    if (!starting) starting = (async () => {
      child = launch(command ?? executable(), ['app-server'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
      child.on('error', rejectAll);
      child.on('exit', () => { rejectAll(); lines?.close(); child = undefined; starting = undefined; });
      child.stdin.on('error', rejectAll);
      lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      lines.on('line', line => {
        let value; try { value = JSON.parse(line); } catch { rejectAll(); child?.kill(); return; }
        const p = pending.get(value.id);
        if (!p) return; // Notifications and server requests carry no search text to logs.
        pending.delete(value.id); clearTimeout(p.timer);
        if (value.error) p.reject(Object.assign(failed(), { rpcCode: value.error.code }));
        else p.resolve(value.result);
      });
      await send('initialize', { clientInfo: { name: 'rayneo-history-reader', version: '0.1.0' },
        capabilities: { experimentalApi: true } });
      child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    })();
    await starting;
  }
  return {
    async request(method, params) {
      if (!['thread/read', 'thread/turns/list'].includes(method)) throw failed();
      await start(); return send(method, params);
    },
    async close() {
      closed = true; rejectAll(); lines?.close();
      const current = child;
      if (current && current.exitCode === null) await new Promise(done => { current.once('close', done); current.kill(); });
    },
  };
}

export function createCodexHistoryReader({ request, close, maxCharacters = 16 * 1024 * 1024 } = {}) {
  const rpc = request ? { request, close } : createCodexReadClient();
  let closed = false;
  const call = async (method, params) => {
    if (closed) throw failed();
    const result = await rpc.request(method, params);
    if (closed) throw failed();
    return result;
  };
  return {
    async read(agent) {
      try {
        const nativeId = typeof agent?.persistence?.nativeHandle === 'string'
          ? agent.persistence.nativeHandle : agent?.persistence?.sessionId;
        if (agent?.provider !== 'codex' || agent.persistence?.provider !== 'codex'
          || typeof nativeId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(nativeId)) throw failed();
        const verify = response => {
          if (response?.thread?.id !== nativeId || !samePath(response.thread.cwd, agent.cwd)) throw failed();
          return response.thread;
        };
        const thread = verify(await call('thread/read', { threadId: nativeId }));
        const messages = []; let chars = 0, complete = true;
        const add = turns => {
          if (!Array.isArray(turns)) throw failed();
          for (const turn of turns) {
            if (!Array.isArray(turn.items)) throw failed();
            for (const item of turn.items) {
              const text = item.type === 'agentMessage' ? item.text : item.type === 'userMessage' && Array.isArray(item.content)
                ? item.content.filter(c => ['text', 'inputText'].includes(c.type) && typeof c.text === 'string').map(c => c.text).join('\n') : null;
              if (typeof text !== 'string' || !text.trim()) continue;
              const remaining = maxCharacters - chars;
              if (text.length > remaining) { if (remaining > 0) messages.push(text.slice(0, remaining)); complete = false; return; }
              chars += text.length; messages.push(text);
            }
          }
        };
        let cursor; const seen = new Set();
        for (let page = 0; page < 2000; page++) {
          let result;
          try { result = await call('thread/turns/list', { threadId: nativeId, limit: 50,
            sortDirection: 'asc', itemsView: 'full', ...(cursor ? { cursor } : {}) }); }
          catch (error) {
            if (page !== 0 || error.rpcCode !== -32601) throw error;
            add(verify(await call('thread/read', { threadId: nativeId, includeTurns: true })).turns);
            break;
          }
          add(result?.data);
          if (!complete || !result.nextCursor) break;
          cursor = result.nextCursor;
          if (typeof cursor !== 'string' || seen.has(cursor)) throw failed();
          seen.add(cursor);
          if (page === 1999) complete = false;
        }
        return { messages, complete, revision: thread.updatedAt ?? null };
      } catch { throw failed(); }
    },
    async close() { closed = true; await rpc.close?.(); },
  };
}
