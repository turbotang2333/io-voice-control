import { spawn, execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { probeBridgeHealth } from '../bridge/relay-health.mjs';

const fail = code => Object.assign(Error(code), { code });
const defaultPrivate = join(homedir(), '.local-secrets/rayneo-paseo');

/** Starts only local connectors. An existing desktop and its conversations are never stopped. */
export function createLocalConnectionStarter({ codeRoot, privateDirectory = defaultPrivate,
  spawnChild = spawn, probeLocal = probeBridgeHealth, desktop } = {}) {
  if (![codeRoot, privateDirectory].every(path => isAbsolute(path ?? ''))) throw fail('SECURE_CONFIGURATION_INVALID');
  const launching = new Map();
  let pending;
  desktop ??= () => JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', join(codeRoot, 'distribution/desktop-state.ps1')], { windowsHide: true, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }));
  async function launch(backend, mode) {
    // The legacy Paseo server uses its fixed per-user home. Refuse a different root rather than silently using another configuration.
    if (backend === 'paseo' && resolve(privateDirectory) !== resolve(defaultPrivate)) throw fail('SECURE_LOCAL_PATH_UNSUPPORTED');
    const command = backend === 'paseo' || mode === 'independent' ? process.execPath : 'powershell.exe';
    const args = backend === 'paseo' ? [join(codeRoot, 'bridge/supervisor.mjs'), '--local-only']
      : mode === 'independent' ? [join(codeRoot, 'experiments/codex-connector/supervisor.mjs'), 'start', '--config',
        join(privateDirectory, 'shared-runtime/connector.json'), '--local-only']
      : ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File',
        join(codeRoot, 'scripts/run-codex-daily.ps1'), '-LocalOnly', '-Configuration', join(privateDirectory, 'shared-runtime/startup.json')];
    const child = spawnChild(command, args, { cwd: codeRoot, detached: true, windowsHide: true, stdio: 'ignore',
      env: { ...process.env, PATH: dirname(process.execPath) + ';' + (process.env.PATH ?? '') } });
    launching.set(backend, child);
    const clear = () => { if (launching.get(backend) === child) launching.delete(backend); };
    child.once('exit', clear);
    await new Promise((accept, reject) => {
      child.once('error', () => { clear(); reject(fail('SECURE_LOCAL_START_FAILED')); });
      child.once('spawn', () => { child.unref(); accept(); });
    });
  }
  async function start(configuration) {
    const started = [], blocked = [];
    const states = await Promise.all(Object.entries(configuration.backends).map(async ([backend, local]) => {
      let state;
      try { state = await probeLocal({ url: `https://127.0.0.1:${local.port}/healthz`, token: local.upstreamToken, ca: local.ca, timeoutMs: 5000 }); }
      catch { state = 'unreachable'; }
      return { backend, state, mode: local.mode };
    }));
    for (const { backend, state, mode } of states) {
      if (['ready', 'reconnecting'].includes(state) || launching.has(backend)) continue;
      if (state === 'rejected') { blocked.push({ backend, reason: 'SECURE_LOCAL_AUTH_REJECTED' }); continue; }
      try {
        if (backend === 'codex') {
          const current = await desktop();
          if (!current.installed) { blocked.push({ backend, reason: 'CODEX_NOT_INSTALLED' }); continue; }
          if (mode !== 'independent' && current.inspectionFailed) { blocked.push({ backend, reason: 'SECURE_LOCAL_START_FAILED' }); continue; }
          if (mode !== 'independent' && current.desktopRunning && !current.sharedReady) { blocked.push({ backend, reason: 'CODEX_CLOSE_REQUIRED' }); continue; }
        }
        await launch(backend, mode); started.push(backend);
      } catch (error) {
        blocked.push({ backend, reason: error?.code === 'SECURE_LOCAL_PATH_UNSUPPORTED' ? error.code : 'SECURE_LOCAL_START_FAILED' });
      }
    }
    return { started, blocked, existingDesktopStopped: false, modelMessagesSent: 0 };
  }
  return { start(configuration) { return pending ??= start(configuration).finally(() => { pending = undefined; }); } };
}
