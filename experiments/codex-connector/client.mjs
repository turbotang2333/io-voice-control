import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, readdirSync } from 'node:fs';
import { join, isAbsolute, win32 } from 'node:path';
import { homedir } from 'node:os';
import { validId } from './journal.mjs';
import { readToolActivity } from './tool-activity.mjs';
import { fileURLToPath } from 'node:url';
import { validateSharedConnection } from './shared-connection.mjs';

const fail = code => Object.assign(new Error(code), { code });
const methods = new Set(['initialize', 'account/read', 'thread/loaded/list', 'thread/read',
  'thread/turns/list', 'thread/queue/list', 'thread/queue/add', 'project/list', 'thread/list', 'thread/start', 'thread/name/set']);

export function connectorEnvironment(source = process.env, codexHome) {
  const env = { ...source };
  for (const key of Object.keys(env)) if (/^(CODEX_|PASEO_|RAYNEO_SHARED_)/i.test(key)) delete env[key];
  if (codexHome) {
    if (!isAbsolute(codexHome)) throw fail('INVALID_CODEX_HOME');
    env.CODEX_HOME = codexHome;
  }
  return env;
}

export function discoverCodex() {
  const candidates = [join(process.env.LOCALAPPDATA ?? '', 'OpenAI/Codex/bin/codex.exe'),
    join(process.env.APPDATA ?? '', 'npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe')];
  try {
    const location = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-AppxPackage OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1 -ExpandProperty InstallLocation'],
    { encoding: 'utf8', timeout: 10000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (location) candidates.unshift(join(location, 'app/resources/codex.exe'));
  } catch { /* The CLI installation can be used when package discovery is unavailable. */ }
  const path = candidates.find(p => isAbsolute(p) && existsSync(p));
  if (!path) throw fail('CODEX_NOT_INSTALLED');
  return path;
}

export function desktopAvailable() {
  if (process.platform !== 'win32') return false;
  try { return readdirSync('\\\\.\\pipe\\').filter(n => n.startsWith('codex-app-tools-')).length === 1; }
  catch { return false; }
}

export class QueueClient {
  constructor({ executable, threadId, codexHome, sharedConnection, catalog = false, readOnly = false, creationScope, timeoutMs = 15000, spawnProcess = spawn } = {}) {
    if (threadId !== undefined && !validId(threadId)) throw fail('INVALID_TARGET');
    this.threadId = threadId; this.executable = executable; this.codexHome = codexHome;
    this.sharedConnection = sharedConnection === undefined ? undefined : validateSharedConnection(sharedConnection);
    this.catalog = catalog === true; this.knownThreads = new Set();
    this.readOnly = readOnly === true;
    if (creationScope !== undefined && (readOnly || !validId(creationScope?.projectId) || !win32.isAbsolute(creationScope?.cwd ?? '')
      || Object.keys(creationScope).some(k => !['projectId', 'cwd'].includes(k)))) throw fail('INVALID_CREATION_SCOPE');
    this.creationScope = creationScope ? Object.freeze({ ...creationScope }) : undefined;
    this.authorizedThreads = new Set(threadId ? [threadId] : []);
    this.metadataReads = new Map();
    this.toolPaths = new Map();
    this.timeoutMs = timeoutMs; this.spawnProcess = spawnProcess;
    this.pending = new Map(); this.sequence = 0; this.closed = true; this.ready = false;
    this.whenDisconnected = new Promise(resolve => { this.resolveDisconnect = resolve; });
  }
  isDesktopAvailable() { return this.ready && desktopAvailable(); }
  async connect() {
    if (this.child) throw fail('ALREADY_CONNECTED');
    const env = connectorEnvironment(process.env, this.codexHome);
    if (this.sharedConnection) {
      env.RAYNEO_SHARED_WS_URL = this.sharedConnection.endpoint;
      env.RAYNEO_SHARED_TOKEN_FILE = this.sharedConnection.tokenFile;
      this.child = this.spawnProcess(process.execPath, [fileURLToPath(new URL('../codex-shared/stdio-proxy.mjs', import.meta.url))],
        { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } else {
      this.executable ??= discoverCodex();
      this.child = this.spawnProcess(this.executable, ['app-server', '--listen', 'stdio://'], {
        env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
    }
    this.closed = false;
    this.child.stderr.resume();
    this.child.once('error', () => this.disconnect('CODEX_START_FAILED'));
    this.child.once('exit', () => this.disconnect('CODEX_DISCONNECTED'));
    this.child.stdin.on('error', () => this.disconnect('CODEX_DISCONNECTED'));
    let buffered = 0;
    this.child.stdout.on('data', bytes => {
      const newline = bytes.lastIndexOf(10);
      buffered = newline < 0 ? buffered + bytes.length : bytes.length - newline - 1;
      if (buffered > 8 * 1024 * 1024) this.disconnect('RESPONSE_TOO_LARGE');
    });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { this.disconnect('INVALID_RPC'); return; }
      if (Buffer.byteLength(line) > 8 * 1024 * 1024 || !message || typeof message !== 'object') {
        this.disconnect('INVALID_RPC'); return;
      }
      if (message.method) {
        // This sidecar never runs tasks or answers permissions on behalf of the desktop.
        if (message.id !== undefined) this.disconnect('UNEXPECTED_SERVER_REQUEST');
        return;
      }
      if (!Number.isSafeInteger(message.id) || (Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error'))) {
        this.disconnect('INVALID_RPC'); return;
      }
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id); clearTimeout(waiter.timer);
      if (message.error) waiter.reject(fail('CODEX_RPC_REJECTED'));
      else waiter.resolve(message.result);
    });
    try {
      await this.request('initialize', { clientInfo: { name: 'rayneo_independent_connector', version: '0.0.1' },
        capabilities: { experimentalApi: true } });
      this.child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
      const { account } = await this.request('account/read');
      if (account?.type !== 'chatgpt') throw fail('CHATGPT_LOGIN_REQUIRED');
      this.ready = true;
    } catch (e) { await this.close(); throw e; }
  }
  request(method, params = {}) {
    if (!methods.has(method)) return Promise.reject(fail('METHOD_NOT_ALLOWED'));
    if ((this.readOnly || this.creationScope) && method === 'thread/queue/add') return Promise.reject(fail('METHOD_NOT_ALLOWED'));
    if (method === 'thread/start') {
      if (!this.creationScope || this.creationAttempted || params.projectId !== this.creationScope.projectId || params.cwd !== this.creationScope.cwd
        || params.ephemeral !== false || params.historyMode !== 'paginated'
        || Object.keys(params).some(k => !['projectId', 'cwd', 'ephemeral', 'historyMode'].includes(k))) return Promise.reject(fail('METHOD_NOT_ALLOWED'));
      this.creationAttempted = true;
    }
    if (method === 'thread/name/set' && (!this.creationScope || params.threadId !== this.createdThreadId
      || typeof params.name !== 'string' || !params.name.trim() || [...params.name].length > 40 || /[\p{Cc}\p{Cf}]/u.test(params.name)
      || Object.keys(params).some(k => !['threadId', 'name'].includes(k)))) return Promise.reject(fail('METHOD_NOT_ALLOWED'));
    if (['project/list', 'thread/list'].includes(method) && !this.catalog) return Promise.reject(fail('METHOD_NOT_ALLOWED'));
    const listedMetadataRead = method === 'thread/turns/list' && this.catalog && this.knownThreads.has(params.threadId)
      && params.itemsView === 'summary' && params.limit === 10 && params.sortDirection === 'desc';
    const creationMetadataRead = method === 'thread/read' && params.includeTurns === false && this.metadataReads.has(params.threadId);
    if (method.startsWith('thread/') && !['thread/loaded/list', 'thread/list', 'thread/start'].includes(method)
      && !this.authorizedThreads.has(params.threadId) && !listedMetadataRead && !creationMetadataRead) return Promise.reject(fail('INVALID_TARGET'));
    if (this.closed) return Promise.reject(fail('CODEX_DISCONNECTED'));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => this.disconnect('CODEX_RPC_TIMEOUT'), this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n'); }
      catch { this.disconnect('CODEX_DISCONNECTED'); }
    });
  }
  async projectPage(cursor) {
    const result = await this.request('project/list', { limit: 100, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(result?.data)) throw fail('INVALID_RPC');
    return { data: result.data.map(p => ({ id: p.id, name: p.name, roots: p.roots })), nextCursor: result.nextCursor };
  }
  async createEmpty(name, onCreated = () => {}) {
    if (!this.creationScope || this.creationAttempted) throw fail('METHOD_NOT_ALLOWED');
    if (typeof name !== 'string' || !name.trim() || [...name.trim()].length > 40 || /[\p{Cc}\p{Cf}]/u.test(name)) throw fail('INVALID_INPUT');
    const { thread } = await this.request('thread/start', { ...this.creationScope, ephemeral: false, historyMode: 'paginated' });
    if (!validId(thread?.id) || thread.projectId !== this.creationScope.projectId
      || win32.normalize(thread.cwd ?? '').toLowerCase() !== win32.normalize(this.creationScope.cwd).toLowerCase()) throw fail('INVALID_TARGET');
    this.createdThreadId = thread.id; this.authorizedThreads.add(thread.id);
    await onCreated(thread.id);
    // Naming materializes an otherwise empty paginated thread so it survives process exit.
    await this.request('thread/name/set', { threadId: thread.id, name: name.trim() });
    return this.readSnapshot(thread.id);
  }
  async storedCreationSnapshot(threadId) {
    if (!this.catalog || !validId(threadId)) throw fail('INVALID_TARGET');
    this.metadataReads.set(threadId, (this.metadataReads.get(threadId) ?? 0) + 1);
    try { return await this.readSnapshot(threadId); }
    finally { const count = this.metadataReads.get(threadId) - 1; if (count) this.metadataReads.set(threadId, count); else this.metadataReads.delete(threadId); }
  }
  async threadPage(cursor) {
    const result = await this.request('thread/list', { limit: 100, archived: false, useStateDbOnly: true,
      sourceKinds: ['cli', 'vscode', 'appServer'], sortKey: 'updated_at', ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(result?.data)) throw fail('INVALID_RPC');
    const data = result.data.map(t => ({ id: t.id, name: t.name, projectId: t.projectId, cwd: t.cwd,
      source: t.source, status: t.status, ephemeral: t.ephemeral, canAcceptDirectInput: t.canAcceptDirectInput,
      updatedAt: t.updatedAt, recencyAt: t.recencyAt }));
    for (const t of data) if (validId(t.id)) this.knownThreads.add(t.id);
    return { data, nextCursor: result.nextCursor };
  }
  async userTimePage(threadId, cursor) {
    if (!this.catalog || !this.knownThreads.has(threadId)) throw fail('INVALID_TARGET');
    const result = await this.request('thread/turns/list', { threadId, limit: 10,
      sortDirection: 'desc', itemsView: 'summary', ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(result?.data) || result.data.some(t => !Array.isArray(t?.items) || t.itemsView === 'notLoaded')) throw fail('INVALID_RPC');
    return { data: result.data.map(t => ({ items: t.items.filter(i => i.type === 'userMessage')
      .map(i => ({ type: i.type, startedAtMs: i.startedAtMs })) })), nextCursor: result.nextCursor };
  }
  bindThread(threadId) {
    if (!this.catalog || !this.knownThreads.has(threadId)) throw fail('INVALID_TARGET');
    this.authorizedThreads.add(threadId);
    return Object.freeze({ threadId, isDesktopAvailable: () => this.isDesktopAvailable(),
      snapshot: () => this.readSnapshot(threadId), turns: () => this.readTurns(threadId),
      toolActivity: turnId => this.readToolActivity(threadId, turnId),
      approvalActivity: turnId => this.readApprovalActivity(threadId, turnId),
      queued: () => this.readQueued(threadId), enqueue: (text, id) => this.enqueueFor(threadId, text, id) });
  }
  snapshot() { return this.readSnapshot(this.threadId); }
  turns() { return this.readTurns(this.threadId); }
  toolActivity(turnId) { return this.readToolActivity(this.threadId, turnId); }
  approvalActivity(turnId) { return this.readApprovalActivity(this.threadId, turnId); }
  queued() { return this.readQueued(this.threadId); }
  enqueue(text, id) { return this.enqueueFor(this.threadId, text, id); }
  async readSnapshot(threadId) {
    const value = await this.request('thread/read', { threadId, includeTurns: false });
    if (value?.thread?.id !== threadId) throw fail('INVALID_TARGET');
    if (this.authorizedThreads.has(threadId)) {
      if (typeof value.thread.path === 'string') this.toolPaths.set(threadId, value.thread.path);
      else this.toolPaths.delete(threadId);
    }
    return value.thread;
  }
  readToolActivity(threadId, turnId) {
    if (!this.ready || !this.authorizedThreads.has(threadId)) return false;
    return readToolActivity({ codexHome: this.codexHome ?? join(homedir(), '.codex'),
      snapshotPath: this.toolPaths.get(threadId), threadId, turnId });
  }
  async readApprovalActivity(threadId, turnId) {
    // An independent reader's notLoaded state cannot describe the desktop's runtime.
    if (!this.sharedConnection || !this.ready || !this.authorizedThreads.has(threadId) || !validId(turnId)) return false;
    const snapshot = await this.readSnapshot(threadId);
    if (snapshot.status?.type !== 'active' || !Array.isArray(snapshot.status.activeFlags)
      || !snapshot.status.activeFlags.includes('waitingOnApproval')) return false;
    const turns = await this.readTurns(threadId);
    // Reject flags for a previous/other turn or after completion. Never inspect prose or tool arguments.
    return turns[0]?.id === turnId && turns[0].status === 'inProgress';
  }
  async readTurns(threadId) {
    const value = await this.request('thread/turns/list', { threadId, limit: 10, sortDirection: 'desc', itemsView: 'full' });
    if (!Array.isArray(value?.data)) throw fail('INVALID_RPC');
    return value.data;
  }
  async readQueued(threadId) {
    const value = await this.request('thread/queue/list', { threadId, limit: 100 });
    if (!Array.isArray(value?.data) || value.nextCursor) throw fail('QUEUE_TOO_LARGE');
    return value.data;
  }
  async enqueueFor(threadId, text, clientUserMessageId) {
    if (typeof text !== 'string' || !text.trim() || [...text].length > 4096 || !validId(clientUserMessageId)) throw fail('INVALID_INPUT');
    const value = await this.request('thread/queue/add', { threadId, clientUserMessageId,
      input: [{ type: 'text', text }] });
    return value?.queuedSubmission;
  }
  disconnect(code) {
    this.closed = true; this.ready = false;
    this.resolveDisconnect(code);
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(fail(code)); }
    this.pending.clear();
    this.child?.stdin.end();
  }
  async close() {
    this.disconnect('CODEX_DISCONNECTED');
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
      await new Promise(resolve => {
        const timer = setTimeout(() => { this.child.kill(); }, 1000);
        this.child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    this.lines?.close();
  }
}
