import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { runStdioProxy } from './stdio-proxy.mjs';
import { validateSharedConnection } from '../codex-connector/shared-connection.mjs';

const fail = code => Object.assign(new Error(code), { code });
export function sharedHostArguments(args, endpoint, token) {
  validateSharedConnection({ endpoint, tokenFile: resolve('placeholder-token') });
  if (!Array.isArray(args) || args.filter(a => a === 'app-server').length !== 1
    || args.some(a => /^(?:--listen|--ws-auth|--ws-token-sha256)(?:=|$)/.test(a))) throw fail('INVALID_DESKTOP_ARGUMENTS');
  return [...args, '--listen', new URL(endpoint).origin, '--ws-auth', 'capability-token',
    '--ws-token-sha256', createHash('sha256').update(token).digest('hex')];
}

function connectOnce(endpoint, token) {
  return new Promise((accept, reject) => {
    const socket = new WebSocket(endpoint, { headers: { authorization: `Bearer ${token}` }, handshakeTimeout: 500 });
    socket.on('error', () => {});
    socket.once('open', () => { socket.close(); accept(); });
    socket.once('error', () => { socket.terminate(); reject(fail('SHARED_HOST_NOT_READY')); });
  });
}

// Desktop owns the host lifetime. This adapter never initializes RPC, creates a thread,
// submits input, or answers approvals; the existing desktop remains the primary client.
export async function runDesktopHost({ input, output, executable, args, connection, token,
  env = process.env, cwd, startupTimeoutMs = 10000, spawnProcess = spawn, stopSignal } = {}) {
  validateSharedConnection(connection);
  if (!isAbsolute(executable ?? '') || !/^[A-Za-z0-9._~-]{32,256}$/.test(token ?? '')) throw fail('INVALID_SHARED_HOST');
  input.pause();
  // Do not attach a second host to an already occupied port.
  const { createServer } = await import('node:net');
  const reservation = createServer();
  try {
    await new Promise((accept, reject) => { reservation.once('error', reject);
      reservation.listen(Number(new URL(connection.endpoint).port), new URL(connection.endpoint).hostname.replace(/^\[|\]$/g, ''), accept); });
  } catch { throw fail('SHARED_PORT_IN_USE'); }
  await new Promise(accept => reservation.close(accept));
  const child = spawnProcess(executable, sharedHostArguments(args, connection.endpoint, token),
    { env, cwd, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
  let exited = false, spawnFailed = false;
  child.stdin.on('error', () => {});
  child.once('error', () => { spawnFailed = true; });
  child.once('exit', () => { exited = true; });
  const stop = () => { if (child.exitCode === null && !spawnFailed) child.kill(); };
  stopSignal?.addEventListener('abort', stop, { once: true });
  try {
    const deadline = Date.now() + startupTimeoutMs;
    for (;;) {
      if (stopSignal?.aborted || exited || spawnFailed) throw fail('SHARED_HOST_EXITED');
      try { await connectOnce(connection.endpoint, token); break; }
      catch { if (Date.now() >= deadline) throw fail('SHARED_HOST_NOT_READY'); await delay(100); }
    }
    // Only initial socket readiness was retried. Protocol input is forwarded once.
    await runStdioProxy({ input, output, endpoint: connection.endpoint, token });
  } finally {
    stopSignal?.removeEventListener('abort', stop);
    child.stdin.end(); stop();
    if (child.exitCode === null && !exited && !spawnFailed) await new Promise(accept => {
      const timer = setTimeout(accept, 3000); child.once('exit', () => { clearTimeout(timer); accept(); });
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const path = process.env.RAYNEO_SHARED_DESKTOP_CONFIG;
    if (!path || !isAbsolute(path)) throw fail('SHARED_CONFIG_REQUIRED');
    const config = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
    const args = process.argv.slice(2);
    // Desktop reads startup requirements before it launches its long-lived server.
    // Preserve those native CLI commands, including their exact JSON-only stdout.
    if (!args.includes('app-server') || args.includes('--print-startup-config') || args.includes('--help') || args.includes('-h')) {
      const child = spawn(config.executable, args, { windowsHide: true, stdio: 'inherit' });
      process.exitCode = await new Promise(accept => { child.once('error', () => accept(1)); child.once('exit', code => accept(code ?? 1)); });
    } else {
      const token = readFileSync(config.connection.tokenFile, 'utf8').trim();
      await runDesktopHost({ input: process.stdin, output: process.stdout, executable: config.executable,
        args, connection: config.connection, token });
    }
  } catch {
    console.error('共享桌面连接未就绪；未重发请求。请恢复原启动方式。'); process.exitCode = 1;
  }
}
