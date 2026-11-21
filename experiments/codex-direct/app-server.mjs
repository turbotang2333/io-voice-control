import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';

const failure = code => Object.assign(new Error(code), { code });

export function protocolError(detail) {
  const error = failure(/already has an active writer/i.test(detail?.message ?? '') ? 'THREAD_IN_USE' : 'CODEX_RPC_FAILED');
  Object.defineProperty(error, 'rpcError', { value: detail });
  return error;
}

// A private stdio process, not Paseo's process or the desktop app's live session.
export class CodexRpc extends EventEmitter {
  constructor(executable, { timeoutMs = 30000 } = {}) {
    super();
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.nextId = 0;
    this.closed = false;
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('PASEO_')) delete env[key];
    this.child = spawn(executable, ['app-server', '--listen', 'stdio://'], {
      env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    this.child.stderr.resume(); // Never forward tool logs, credentials or conversation bodies.
    this.child.stdin.on('error', () => this.fail('CODEX_DISCONNECTED'));
    this.child.once('error', () => this.fail('CODEX_START_FAILED'));
    this.child.once('exit', () => this.fail('CODEX_DISCONNECTED'));
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { this.fail('INVALID_RPC'); return; }
      if (message.method && message.id !== undefined) {
        this.emit('permission', message.params);
        let result;
        if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(message.method)) result = { decision: 'decline' };
        else if (message.method === 'item/permissions/requestApproval') result = { permissions: {}, scope: 'turn' };
        else if (message.method === 'item/tool/requestUserInput') result = { answers: {} };
        else if (message.method === 'mcpServer/elicitation/request') result = { action: 'cancel', content: null };
        this.write(result ? { id: message.id, result } : { id: message.id, error: { code: -32601, message: 'Unsupported by conversation experiment' } });
      } else if (message.method) {
        this.emit('notification', message);
      } else {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) {
          pending.reject(protocolError(message.error));
        }
        else pending.resolve(message.result);
      }
    });
  }
  write(message) {
    if (this.closed || this.child.stdin.destroyed) throw failure('CODEX_DISCONNECTED');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  request(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(failure('CODEX_RPC_TIMEOUT'));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  fail(code) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(failure(code)); }
    this.pending.clear();
    this.emit('disconnect');
  }
  async initialize() {
    await this.request('initialize', { clientInfo: { name: 'rayneo_codex_direct_experiment', title: 'RayNeo Codex experiment', version: '0.0.1' } });
    this.write({ method: 'initialized' });
    const { account } = await this.request('account/read');
    if (account?.type !== 'chatgpt') throw failure('CHATGPT_LOGIN_REQUIRED');
  }
  async close() {
    if (!this.closed) this.child.stdin.end();
    if (this.child.exitCode === null) {
      await new Promise(resolve => {
        const timer = setTimeout(() => { this.child.kill(); resolve(); }, 3000);
        this.child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    this.fail('CODEX_DISCONNECTED');
    this.lines.close();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
  }
}
