import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const fail = code => Object.assign(new Error(code), { code });
const allowed = new Set(['list_projects', 'list_threads', 'read_thread', 'wait_threads', 'send_message_to_thread', 'create_thread']);

export function readDesktopResult(result) {
  if (result?.isError) throw fail('DESKTOP_TOOL_REJECTED');
  const texts = result?.content?.filter(item => item.type === 'text') ?? [];
  if (texts.length !== 1) throw fail('DESKTOP_RESULT_INVALID');
  try { return JSON.parse(texts[0].text); }
  catch { throw fail('DESKTOP_RESULT_INVALID'); }
}

// Use the desktop app's bundled MCP client and existing pipe, never another Codex writer.
export class DesktopClient {
  constructor({ callerThreadId = process.env.CODEX_THREAD_ID, authorizedThreadId, creationProjectId, serverPath, pipePath, spawnProcess = spawn } = {}) {
    this.callerThreadId = callerThreadId;
    this.authorizedThreadId = authorizedThreadId;
    this.creationProjectId = creationProjectId;
    this.serverPath = serverPath;
    this.pipePath = pipePath;
    this.pending = new Map();
    this.nextId = 0;
    this.closed = true;
    this.ready = false; this.status = 'disconnected'; this.generation = 0;
    this.listeners = new Set(); this.spawnProcess = spawnProcess;
  }
  // No immediate callback. Initial state is disconnected; readiness means both handshakes succeeded.
  subscribeConnectionStatus(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  getConnectionState() { return { status: this.status, generation: this.generation }; }
  setStatus(status) {
    if (status === this.status) return;
    this.status = status; this.ready = status === 'connected';
    if (this.ready) this.generation++;
    const state = Object.freeze(this.getConnectionState());
    for (const listener of this.listeners) try { listener(state); } catch { /* An observer cannot break transport cleanup. */ }
  }
  async connect() {
    if (!this.callerThreadId) throw fail('DESKTOP_CALLER_CONTEXT_MISSING');
    if (this.child) throw fail('DESKTOP_ALREADY_CONNECTED');
    try {
    this.setStatus('connecting');
    if (!this.serverPath) {
      const install = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "Get-AppxPackage OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1 -ExpandProperty InstallLocation"],
      { encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim();
      if (!install) throw fail('DESKTOP_NOT_INSTALLED');
      this.serverPath = join(install, 'app', 'resources', 'plugins', 'openai-bundled', 'plugins', 'codex-app-tools', 'server.mjs');
    }
    if (!existsSync(this.serverPath)) throw fail('DESKTOP_MCP_NOT_FOUND');
    if (!this.pipePath) {
      const prefix = '\\\\.\\pipe\\';
      const pipes = readdirSync(prefix).filter(name => name.startsWith('codex-app-tools-'));
      if (pipes.length !== 1) throw fail('DESKTOP_PIPE_NOT_UNIQUE');
      this.pipePath = prefix + pipes[0];
    }
    const env = { ...process.env, CODEX_APP_TOOLS_PIPE_PATH: this.pipePath };
    for (const key of Object.keys(env)) if (key.startsWith('PASEO_')) delete env[key];
    this.child = this.spawnProcess(process.execPath, [this.serverPath], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.closed = false;
    this.child.stderr.resume();
    this.child.stdin.on('error', () => this.disconnect());
    this.child.once('error', () => this.disconnect());
    this.child.once('exit', () => this.disconnect());
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.once('close', () => this.disconnect());
    this.lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { this.disconnect(); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)
          || (message.jsonrpc !== undefined && message.jsonrpc !== '2.0')) { this.disconnect(); return; }
      if (message.id === undefined && typeof message.method === 'string' && message.method) return;
      if (!Number.isSafeInteger(message.id) || message.id < 1
          || (Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error'))
          || (message.error !== undefined && (!message.error || typeof message.error !== 'object' || Array.isArray(message.error)))) {
        this.disconnect(); return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) {
        const error = fail('DESKTOP_MCP_REJECTED');
        Object.defineProperty(error, 'mcpError', { value: message.error });
        pending.reject(error);
      } else pending.resolve(message.result);
    });
    await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'rayneo-desktop-experiment', version: '0.0.1' } });
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const catalog = await this.request('tools/list', {});
    this.tools = new Set(catalog.tools.map(tool => tool.name));
    if (this.closed) throw fail('DESKTOP_DISCONNECTED');
    this.setStatus('connected');
    } catch (error) { this.disconnect(); throw error; }
  }
  request(method, params, timeoutMs = 15000) {
    if (this.closed) return Promise.reject(fail('DESKTOP_DISCONNECTED'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(fail('DESKTOP_RESULT_UNKNOWN')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async call(name, args, { timeoutMs = 20000 } = {}) {
    if (!allowed.has(name)) throw fail('DESKTOP_TOOL_NOT_ALLOWED');
    if (name === 'create_thread') {
      if (!this.creationProjectId || args.target?.type !== 'project' || args.target.projectId !== this.creationProjectId
          || args.target.environment?.type !== 'local') throw fail('DESKTOP_TARGET_NOT_AUTHORIZED');
    } else if (name !== 'list_threads' && name !== 'list_projects') {
      const targets = name === 'wait_threads' ? args.targets.map(t => t.threadId) : [args.threadId];
      if (!this.authorizedThreadId || targets.some(id => id !== this.authorizedThreadId)) throw fail('DESKTOP_TARGET_NOT_AUTHORIZED');
    }
    if (!this.ready || this.closed) throw fail('DESKTOP_DISCONNECTED');
    if (!this.tools?.has(name)) throw fail('DESKTOP_TOOL_UNAVAILABLE');
    return readDesktopResult(await this.request('tools/call', { name, arguments: args,
      _meta: { 'openai/threadId': this.callerThreadId } }, timeoutMs));
  }
  disconnect() {
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(fail('DESKTOP_DISCONNECTED')); }
    this.pending.clear();
    this.setStatus('disconnected');
  }
  async close() {
    this.disconnect();
    this.child?.stdin.end();
    if (this.child && this.child.exitCode === null) await new Promise(resolve => {
      const timer = setTimeout(() => { this.child.kill(); resolve(); }, 1000);
      this.child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    this.lines?.close(); this.disconnect();
  }
}
