import { spawn, execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID, X509Certificate } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRuntimeConfig } from './runtime-config.mjs';
import { createRelayHealthMonitor, probeBridgeHealth } from './relay-health.mjs';
import { classifySshFailure, recordRelayEvent, pruneRelayEvents } from './relay-diagnostics.mjs';

export function relayArguments(config, localPort) {
  const socket = config?.remoteSocket;
  const validSocket = socket === '/tunnel/relay.sock';
  const validRemote = socket === undefined ? Number.isInteger(config?.remotePort) && config.remotePort >= 1024 && config.remotePort <= 65535
    : validSocket && config?.remotePort === undefined;
  if (!config || typeof config.sshHost !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(config.sshHost)
    || !validRemote || !Number.isInteger(localPort) || localPort < 1024 || localPort > 65535
    || (config.sshConfigPath !== undefined && (!isAbsolute(config.sshConfigPath) || /[\r\n\0]/.test(config.sshConfigPath)))) throw new Error('Invalid private relay configuration');
  return [...(config.sshConfigPath ? ['-F', config.sshConfigPath] : []), '-NT', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=20', '-o', 'ServerAliveCountMax=3',
    '-R', `${validSocket ? socket : '127.0.0.1:' + config.remotePort}:127.0.0.1:${localPort}`, config.sshHost];
}

/** Explicit local-only mode never reads or starts a previously configured relay. */
export function dailyMaintenancePlan(profile, relay, { localOnly = false } = {}) {
  const config = resolveRuntimeConfig(profile, { daily: true });
  if (localOnly) return { config, relayArgs: null, relayEnabled: false };
  relay ??= { enabled: false };
  if (typeof relay.enabled !== 'boolean') throw new Error('Invalid relay mode');
  return { config, relayArgs: relay.enabled ? relayArguments(relay, config.port) : null, relayEnabled: relay.enabled };
}

/** Restart a connection process, never a message. Only allowlisted exit metadata reaches diagnostics. */
export function superviseCommand({ command, args = [], cwd, minDelayMs = 1000, maxDelayMs = 30000, restartOnExit = true,
  diagnoseSsh = false, onEvent = () => {} }) {
  let child, timer, stopped = false, attempt = 0, stopping, restarting, lastExitReason;
  const emit = event => { try { onEvent(event); } catch { /* Diagnostics must not break process ownership. */ } };
  function start() {
    if (stopped) return;
    const started = Date.now();
    let ended = false, stderr = '';
    const current = spawn(command, args, { cwd, windowsHide: true, stdio: diagnoseSsh ? ['ignore', 'ignore', 'pipe'] : 'ignore' });
    child = current;
    if (diagnoseSsh) {
      current.stderr.setEncoding('utf8');
      current.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
      current.stderr.on('error', () => {});
    }
    current.once('spawn', () => emit({ type: 'started', pid: current.pid }));
    const end = (exitCode, signal, error) => {
      if (ended) return;
      ended = true;
      if (child === current) child = undefined;
      const intentional = stopped || Boolean(restarting);
      lastExitReason = intentional ? 'stopped' : classifySshFailure(stderr, error?.code);
      stderr = '';
      emit({ type: 'exited', ...(current.pid ? { pid: current.pid } : {}),
        ...(Number.isInteger(exitCode) ? { exitCode } : {}),
        ...(typeof signal === 'string' && /^SIG[A-Z0-9]{1,12}$/.test(signal) ? { signal } : {}),
        reason: lastExitReason, intentional, durationMs: Math.max(0, Date.now() - started) });
      if (stopped || restarting) return;
      if (!restartOnExit) return;
      if (Date.now() - started >= 60000) attempt = 0;
      const delay = Math.min(minDelayMs * 2 ** Math.min(attempt++, 10), maxDelayMs);
      emit({ type: 'restarting', delayMs: delay });
      timer = setTimeout(start, delay);
    };
    current.once('error', error => end(undefined, undefined, error));
    current.once('close', end);
  }
  start();
  return {
    getState() { return { running: Boolean(child), lastExitReason }; },
    restart() {
      if (stopped) return Promise.resolve(false);
      if (restarting) return restarting;
      clearTimeout(timer);
      const current = child;
      restarting = (async () => {
        if (current) await new Promise(resolveClose => {
          current.once('close', resolveClose); current.kill();
        });
        if (stopped) return false;
        start(); return true;
      })().finally(() => { restarting = undefined; });
      return restarting;
    },
    stop() {
      if (stopping) return stopping;
      stopped = true; clearTimeout(timer);
      const current = child;
      stopping = !current ? (restarting ?? Promise.resolve()) : new Promise(resolveStop => {
        current.once('close', resolveStop);
        current.kill();
      });
      return stopping;
    },
  };
}

export function acquireSupervisorLock(path) {
  mkdirSync(dirname(path), { recursive: true });
  const identity = randomUUID();
  let fd;
  try { fd = openSync(path, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = JSON.parse(readFileSync(path, 'utf8'));
    if (previous.version !== 1 || !Number.isInteger(previous.pid) || previous.pid <= 0) throw new Error('Unrecognized supervisor lock');
    let alive = true;
    try { process.kill(previous.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
    if (alive) throw new Error('Daily supervisor is already running');
    unlinkSync(path);
    fd = openSync(path, 'wx', 0o600);
  }
  try { writeFileSync(fd, JSON.stringify({ version: 1, pid: process.pid, identity })); } finally { closeSync(fd); }
  return () => {
    if (JSON.parse(readFileSync(path, 'utf8')).identity === identity) unlinkSync(path);
  };
}

async function main() {
  const root = join(homedir(), '.local-secrets', 'rayneo-paseo');
  const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const profile = JSON.parse(readFileSync(join(root, 'daily.json'), 'utf8'));
  const localOnly = process.argv.includes('--local-only');
  const relayPath = join(root, 'relay.json');
  const relay = !localOnly && existsSync(relayPath) ? JSON.parse(readFileSync(relayPath, 'utf8')) : undefined;
  const { config, relayArgs: args, relayEnabled } = dailyMaintenancePlan(profile, relay, { localOnly });
  let healthOptions;
  if (args && profile.publicBaseUrl) {
    const endpoint = new URL(profile.publicBaseUrl);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || !/^[A-Za-z0-9/_-]*$/.test(endpoint.pathname)) throw new Error('Invalid health endpoint');
    healthOptions = { ca: new X509Certificate(readFileSync(join(root, 'local.cer'))).toString(),
      publicHealth: profile.publicBaseUrl.replace(/\/+$/, '') + '/healthz' };
  }
  execFileSync(process.execPath, [join(project, 'bridge', 'server.mjs'), '--daily', '--check'], { stdio: 'pipe', windowsHide: true });
  if (process.argv.includes('--check')) {
    console.log(`日常版运行配置检查通过；转发${relayEnabled ? '已配置但未启动' : '未启用'}。未启动服务或注册自启动。`);
    return;
  }
  const release = acquireSupervisorLock(join(homedir(), '.local', 'state', 'rayneo-paseo', 'daily-supervisor.lock'));
  const relayLog = join(homedir(), '.local', 'state', 'rayneo-paseo', 'daily-relay-events.json');
  const pruneDiagnostics = () => { try { pruneRelayEvents(relayLog); } catch { /* Diagnostics cannot stop the service. */ } };
  pruneDiagnostics();
  const retentionTimer = setInterval(pruneDiagnostics, 60 * 60 * 1000);
  retentionTimer.unref();
  const event = name => value => console.log(JSON.stringify({ component: name, ...value }));
  const jobs = [superviseCommand({ command: process.execPath, args: [join(project, 'bridge', 'server.mjs'), '--daily'], cwd: project, onEvent: event('bridge') })];
  let monitor;
  if (args) {
    const relayJob = superviseCommand({ command: 'ssh.exe', args, cwd: project, restartOnExit: !healthOptions, diagnoseSsh: true,
      onEvent(value) {
        event('relay')(value);
        try { recordRelayEvent(relayLog, value); } catch { /* Diagnostics cannot stop connection recovery. */ }
      } });
    jobs.push(relayJob);
    if (healthOptions) {
      const { ca, publicHealth } = healthOptions;
      const statePath = join(homedir(), '.local', 'state', 'rayneo-paseo', 'daily-connection-health.json');
      monitor = createRelayHealthMonitor({
        probeLocal: signal => probeBridgeHealth({ url: `https://127.0.0.1:${config.port}/healthz`, token: config.token, ca, signal }),
        probePublic: signal => probeBridgeHealth({ url: publicHealth, token: config.token, signal }),
        getRelayState: () => relayJob.getState(),
        restartRelay: () => relayJob.restart(),
        onChange(value) {
          console.log(JSON.stringify({ component: 'connection-health', ...value }));
        },
        onCheck(value) {
          const status = { version: 1, updatedAt: new Date().toISOString(), ...value };
          const temp = statePath + '.tmp';
          writeFileSync(temp, JSON.stringify(status) + '\n', { mode: 0o600 }); renameSync(temp, statePath);
        },
      });
      monitor.start();
    }
  }
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(retentionTimer);
    await monitor?.stop();
    await Promise.all(jobs.map(job => job.stop()));
    release();
  };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('日常版守护未启动，请检查私有配置、端口及运行锁；不会输出连接秘密。'); process.exitCode = 1; });
}
