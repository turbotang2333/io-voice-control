// Explicit, offline native integration check. Uses a new home, no personal login or model task.
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { discoverCodex, connectorEnvironment } from '../codex-connector/client.mjs';

function rpc(send, listen) {
  let sequence = 0; const pending = new Map();
  listen(bytes => {
    const m = JSON.parse(bytes.toString()), waiter = pending.get(m.id);
    if (!waiter) return;
    pending.delete(m.id); clearTimeout(waiter.timer);
    m.error ? waiter.reject(Error('NATIVE_RPC_REJECTED')) : waiter.resolve(m.result);
  });
  return {
    request(method, params = {}) {
      if (!['initialize', 'thread/start', 'thread/name/set', 'thread/read'].includes(method)) throw Error('CHECK_METHOD_NOT_ALLOWED');
      return new Promise((accept, reject) => {
        const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error('NATIVE_RPC_TIMEOUT')); }, 15000);
        pending.set(id, { resolve: accept, reject, timer }); send(JSON.stringify({ id, method, params }));
      });
    },
    async initialize(name) { await this.request('initialize', { clientInfo: { name, version: '1' }, capabilities: { experimentalApi: true } }); send('{"method":"initialized"}'); },
    close() { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error('CHECK_STOPPED')); } pending.clear(); },
  };
}

export async function checkDesktopAdapter(proxyExecutable) {
  const parent = join(homedir(), '.local/state/rayneo-paseo/connector-approval-20261108'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'desktop-native-')), executable = discoverCodex();
  const reservation = createServer(); await new Promise(r => reservation.listen(0, '127.0.0.1', r));
  const port = reservation.address().port; await new Promise(r => reservation.close(r));
  const tokenFile = join(root, 'token'), token = randomBytes(32).toString('hex'), configPath = join(root, 'host.json');
  const connection = { endpoint: `ws://127.0.0.1:${port}/rpc`, tokenFile };
  writeFileSync(tokenFile, token, { mode: 0o600 }); writeFileSync(configPath, JSON.stringify({ executable, connection }), { mode: 0o600 });
  const env = connectorEnvironment(process.env, root);
  for (const key of Object.keys(env)) if (/^(OPENAI_|AZURE_)/.test(key)) delete env[key];
  Object.assign(env, { RAYNEO_SHARED_NODE: process.execPath,
    RAYNEO_SHARED_ENTRY: fileURLToPath(new URL('./desktop-host.mjs', import.meta.url)), RAYNEO_SHARED_DESKTOP_CONFIG: configPath });
  let child, lines, a, b, socket;
  const report = { isolatedHome: true, personalCredentialsCopied: false, personalHistoryRead: false,
    modelMessagesSent: 0, commandsExecuted: 0, desktopRestarted: false };
  try {
    const prefix = proxyExecutable === process.execPath ? [env.RAYNEO_SHARED_ENTRY] : [];
    report.versionPassthrough = execFileSync(proxyExecutable, [...prefix, '--version'], { env, encoding: 'utf8', windowsHide: true, timeout: 15000 }).startsWith('codex-cli ');
    report.phase = 'startup-policy';
    const startup = JSON.parse(execFileSync(proxyExecutable, [...prefix, 'app-server', '--print-startup-config', '--startup-client-info',
      JSON.stringify({ name: 'codex_desktop', title: 'Codex Desktop', version: '1' })],
    { env, encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }));
    report.startupPolicyPassthrough = startup !== null && typeof startup === 'object' && !Array.isArray(startup);
    child = spawn(proxyExecutable, [...prefix, 'app-server'], { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.resume(); child.stdin.on('error', () => {}); lines = createInterface({ input: child.stdout });
    a = rpc(s => child.stdin.write(s + '\n'), listen => lines.on('line', listen));
    report.phase = 'primary-initialize'; await a.initialize('rayneo_desktop_adapter_check');
    socket = new WebSocket(connection.endpoint, { headers: { authorization: `Bearer ${token}` }, handshakeTimeout: 2000 });
    socket.on('error', () => {});
    await new Promise((accept, reject) => { socket.once('open', accept); socket.once('error', reject); });
    b = rpc(s => socket.send(s), listen => socket.on('message', listen)); report.phase = 'observer-initialize'; await b.initialize('rayneo_observer_adapter_check');
    report.phase = 'create-empty';
    const { thread } = await a.request('thread/start', { cwd: root, ephemeral: false, historyMode: 'paginated', approvalPolicy: 'never', sandbox: 'read-only' });
    await a.request('thread/name/set', { threadId: thread.id, name: 'isolated-shared-adapter-check' });
    const first = await a.request('thread/read', { threadId: thread.id, includeTurns: false });
    const second = await b.request('thread/read', { threadId: thread.id, includeTurns: false });
    report.ownerStatus = first.thread.status.type; report.observerStatus = second.thread.status.type;
    report.sharedRuntimeConfirmed = first.thread.id === second.thread.id && first.thread.status.type === 'idle' && second.thread.status.type === 'idle';
    const denied = new WebSocket(connection.endpoint, { headers: { authorization: 'Bearer synthetic-wrong-token' }, handshakeTimeout: 1000 });
    denied.on('error', () => {});
    report.wrongTokenRejected = await new Promise(accept => { denied.once('open', () => { denied.terminate(); accept(false); }); denied.once('error', () => { denied.terminate(); accept(true); }); });
    const closed = new Promise(accept => socket.once('close', accept)); child.stdin.end(); await closed;
    report.hostStoppedWithDesktop = true;
    report.phase = 'complete';
  } catch (error) { report.failure = ['NATIVE_RPC_TIMEOUT', 'NATIVE_RPC_REJECTED'].includes(error.message) ? error.message : 'NATIVE_ADAPTER_CHECK_FAILED'; }
  finally {
    a?.close(); b?.close(); socket?.terminate(); lines?.close();
    if (child?.exitCode === null) await new Promise(accept => { const timer = setTimeout(() => { child.kill(); accept(); }, 3000); child.once('exit', () => { clearTimeout(timer); accept(); }); });
    writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2));
  }
  return { ...report, reportPath: join(root, 'report.json') };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4 || process.argv[2] !== '--run-isolated') { console.error('用法：--run-isolated 桌面适配器.exe'); process.exitCode = 1; }
  else {
    const report = await checkDesktopAdapter(resolve(process.argv[3])); console.log(JSON.stringify(report));
    if (report.failure || !report.sharedRuntimeConfirmed || !report.hostStoppedWithDesktop || !report.wrongTokenRejected) process.exitCode = 1;
  }
}
