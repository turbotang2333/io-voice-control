import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { relayArguments, superviseCommand, acquireSupervisorLock } from '../../bridge/supervisor.mjs';

const role = 'codex-wireless-relay';
const defaultRoot = join(homedir(), '.local', 'state', 'rayneo-paseo', 'codex-direct');
const project = fileURLToPath(new URL('../../', import.meta.url));
const read = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const paths = root => ({ lock: join(root, 'wireless-relay.lock'), metadata: join(root, 'wireless-relay.json'), stop: join(root, 'wireless-relay.stop') });
function write(path, data) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  try { writeFileSync(temporary, JSON.stringify(data), { mode: 0o600, flag: 'wx' }); renameSync(temporary, path); }
  finally { try { unlinkSync(temporary); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
}

export function relayMode(args) {
  if (!args.length) return 'serve';
  if (args.length === 1 && args[0] === '--check') return 'check';
  if (args.length === 1 && args[0] === '--stop') return 'stop';
  throw new Error('INVALID_RELAY_ARGUMENTS');
}

export function codexRelayArguments(relay) {
  return relayArguments({ sshHost: relay?.sshHost, remotePort: 17469 }, 17469);
}

// Supervise only this SSH transport. Never launch a backend or resubmit a message.
export function startWirelessRelay({ root = defaultRoot, relay, supervise = superviseCommand, pollMs = 500 }) {
  const args = codexRelayArguments(relay), files = paths(root);
  const release = acquireSupervisorLock(files.lock);
  let owner, metadata, job, timer, stopping, resolveDone, rejectDone;
  const done = new Promise((resolveJob, rejectJob) => { resolveDone = resolveJob; rejectDone = rejectJob; });
  const owned = value => value?.pid === owner.pid && value?.identity === owner.identity;
  function stop() {
    if (stopping) return stopping;
    clearInterval(timer);
    stopping = (async () => {
      await job.stop();
      try { write(files.metadata, { ...metadata, status: 'stopped', updatedAt: new Date().toISOString() }); }
      finally {
        try { if (existsSync(files.stop) && owned(read(files.stop))) unlinkSync(files.stop); }
        finally { release(); }
      }
      resolveDone();
    })();
    stopping.catch(rejectDone);
    return stopping;
  }
  try {
    owner = read(files.lock);
    metadata = { version: 1, role, pid: process.pid, identity: owner.identity, status: 'starting', startedAt: new Date().toISOString() };
    write(files.metadata, metadata);
    job = supervise({ command: 'ssh.exe', args, cwd: project, onEvent(event) {
      if (stopping || !['started', 'restarting'].includes(event?.type)) return;
      metadata = { ...metadata, status: event.type, updatedAt: new Date().toISOString() };
      if (Number.isInteger(event.delayMs) && event.delayMs >= 0) metadata.delayMs = event.delayMs;
      try { write(files.metadata, metadata); } catch { /* No raw child output or private connection data is logged. */ }
    } });
    timer = setInterval(() => {
      try { if (existsSync(files.stop) && owned(read(files.stop))) void stop(); }
      catch { /* Ignore malformed or foreign requests; keep ownership. */ }
    }, pollMs);
    return { stop, done };
  } catch (error) { release(); throw error; }
}

// File-based graceful stop also works for a hidden Windows process without a console signal.
export async function stopWirelessRelay(root = defaultRoot, { timeoutMs = 10000 } = {}) {
  const files = paths(root);
  if (!existsSync(files.lock)) return false;
  const owner = read(files.lock), metadata = read(files.metadata);
  if (owner.version !== 1 || !Number.isInteger(owner.pid) || owner.pid <= 0 || typeof owner.identity !== 'string'
      || metadata.role !== role || metadata.pid !== owner.pid || metadata.identity !== owner.identity) throw new Error('UNCONFIRMED_RELAY_OWNER');
  process.kill(owner.pid, 0); // Check existence only; never send a terminating signal to a PID from disk.
  write(files.stop, { version: 1, pid: owner.pid, identity: owner.identity });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!existsSync(files.lock)) return true;
    const current = read(files.lock);
    if (current.identity !== owner.identity) return true;
    await sleep(50);
  }
  throw new Error('RELAY_STOP_NOT_CONFIRMED');
}

async function main() {
  const mode = relayMode(process.argv.slice(2));
  if (mode === 'stop') {
    await stopWirelessRelay();
    console.log('Codex 专用转发已停止或原本未运行；未触及后端及 Paseo。');
    return;
  }
  const relay = read(join(homedir(), '.local-secrets', 'rayneo-paseo', 'relay.json'));
  codexRelayArguments(relay);
  if (mode === 'check') {
    console.log('Codex 专用转发配置检查通过；未连接服务器、未加锁、未启动服务或注册任务。');
    return;
  }
  const job = startWirelessRelay({ relay });
  const stop = () => { void job.stop(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try { await job.done; }
  finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Codex 专用转发操作未完成，请检查配置、归属锁或停止状态；未输出连接秘密。'); process.exitCode = 1; });
}
