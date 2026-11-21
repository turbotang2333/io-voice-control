// Opt-in, credential-free transport experiment. Does not launch the desktop app,
// read personal conversations, create threads, start turns, or enable remote control.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { runStdioProxy } from './stdio-proxy.mjs';

const failure = code => Object.assign(new Error(code), { code });

function client(send, subscribe) {
  let sequence = 0;
  const pending = new Map();
  subscribe(bytes => {
    let message;
    try { message = JSON.parse(bytes.toString()); } catch { return; }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id); clearTimeout(waiter.timer);
    message.error ? waiter.reject(failure('RPC_REJECTED')) : waiter.resolve(message.result);
  });
  return {
    request(method, params = {}) {
      // Keep this experiment incapable of sending model tasks or reading chat bodies.
      if (!['initialize', 'thread/loaded/list'].includes(method)) return Promise.reject(failure('PROBE_METHOD_NOT_ALLOWED'));
      return new Promise((resolveRequest, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(failure('RPC_TIMEOUT')); }, 15000);
        pending.set(id, { resolve: resolveRequest, reject, timer });
        try { send(JSON.stringify({ id, method, params })); }
        catch { pending.delete(id); clearTimeout(timer); reject(failure('TRANSPORT_CLOSED')); }
      });
    },
    async initialize(name) {
      await this.request('initialize', { clientInfo: { name, version: '0.0.1' }, capabilities: {} });
      send(JSON.stringify({ method: 'initialized' }));
    },
    dispose() { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(failure('PROBE_STOPPED')); } pending.clear(); },
  };
}

async function connect(endpoint, token) {
  return new Promise((resolveSocket, reject) => {
    const socket = new WebSocket(endpoint, { headers: { authorization: `Bearer ${token}` }, handshakeTimeout: 2000 });
    socket.on('error', () => {});
    socket.once('open', () => resolveSocket(socket));
    socket.once('error', () => { socket.terminate(); reject(failure('CONNECT_REJECTED')); });
  });
}

export async function checkSharedTransport() {
  const parent = join(homedir(), '.local', 'state', 'rayneo-paseo');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'shared-transport-'));
  const executable = join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@openai', 'codex',
    'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
  const report = { isolatedHome: true, loopbackOnly: true, personalCredentialsCopied: false,
    personalConversationsRead: false, modelMessagesSent: 0, conversationsCreated: 0,
    existingDesktopModified: false };
  let host, otherSocket, proxyRun, lines, first, second, input, output;
  try {
    if (!existsSync(executable)) throw failure('PROBE_BINARY_NOT_FOUND');
    const reservation = createServer();
    await new Promise((accept, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', accept); });
    const port = reservation.address().port;
    await new Promise(accept => reservation.close(accept));
    const endpoint = `ws://127.0.0.1:${port}/rpc`, token = randomBytes(32).toString('hex');
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^(CODEX_|PASEO_|OPENAI_)/.test(key)) delete env[key];
    env.CODEX_HOME = root;
    host = spawn(executable, ['app-server', '--listen', `ws://127.0.0.1:${port}`,
      '--ws-auth', 'capability-token', '--ws-token-sha256', createHash('sha256').update(token).digest('hex')],
    { env, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    host.stderr.resume(); host.stdin.on('error', () => {}); host.on('error', () => {});
    // Retry only initial transport discovery; no JSON-RPC request has been sent yet.
    for (let attempt = 0; attempt < 20; attempt++) {
      try { otherSocket = await connect(endpoint, token); break; }
      catch { if (host.exitCode !== null) throw failure('SHARED_HOST_EXITED'); await delay(250); }
    }
    if (!otherSocket) throw failure('SHARED_HOST_NOT_READY');
    second = client(text => otherSocket.send(text), listen => otherSocket.on('message', listen));
    await second.initialize('rayneo_connector_transport_check'); report.directClientInitialized = true;

    input = new PassThrough(); output = new PassThrough();
    lines = createInterface({ input: output });
    first = client(text => input.write(text + '\n'), listen => lines.on('line', listen));
    proxyRun = runStdioProxy({ input, output, endpoint, token });
    // Attach a rejection observer immediately, before awaiting any RPC promise.
    proxyRun.catch(() => {});
    await first.initialize('rayneo_desktop_stdio_transport_check'); report.stdioClientInitialized = true;
    const [a, b] = await Promise.all([first.request('thread/loaded/list'), second.request('thread/loaded/list')]);
    report.sameEmptyCatalog = Array.isArray(a.data) && Array.isArray(b.data) && a.data.length === 0 && b.data.length === 0;
    let unauthorized;
    try { unauthorized = await connect(endpoint, randomBytes(32).toString('hex')); report.wrongTokenRejected = false; }
    catch { report.wrongTokenRejected = true; }
    finally { unauthorized?.terminate(); }
    input.end(); await proxyRun; report.proxyStoppedOnOwnerEOF = true;
  } catch (error) { report.failureCode = error.code ?? 'SHARED_CHECK_FAILED'; }
  finally {
    first?.dispose(); second?.dispose(); input?.destroy(); output?.destroy(); lines?.close(); otherSocket?.terminate();
    await proxyRun?.catch(() => {});
    if (host?.exitCode === null) {
      host.stdin.end(); host.kill();
      await new Promise(accept => { const timer = setTimeout(accept, 3000); host.once('exit', () => { clearTimeout(timer); accept(); }); });
    }
    report.hostStopped = Boolean(host && (host.exitCode !== null || host.signalCode !== null));
    writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2));
  }
  return { ...report, reportPath: join(root, 'report.json') };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3 || process.argv[2] !== '--run-isolated') {
    console.error('仅限显式运行隔离检查：--run-isolated。未启动任何服务。'); process.exitCode = 1;
  } else {
    const result = await checkSharedTransport(); console.log(JSON.stringify(result));
    if (result.failureCode || !result.hostStopped || !result.sameEmptyCatalog || !result.wrongTokenRejected) process.exitCode = 1;
  }
}
