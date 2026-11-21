import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import QRCode from 'qrcode';
import { createPaseoConnection } from '../bridge/paseo-connection.mjs';
import { createPairingStore } from '../bridge/pairing.mjs';
import { probeBridgeHealth } from '../bridge/relay-health.mjs';
import { prepareConnectorHome, importTrialInvitation } from './setup.mjs';

const fail = code => Object.assign(Error(code), { code });
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
export function selectPairingProfiles(status, profiles, hostingBackend) {
  const host = status.connections.find(c => c.backend === hostingBackend);
  const selected = Object.fromEntries(Object.entries(profiles).filter(([backend]) => status.connections.some(c => c.backend === backend && c.ready)));
  if (!profiles[hostingBackend] || !host?.ready || !selected[hostingBackend]) throw fail('CONNECTOR_NOT_READY');
  return selected;
}
export function startAvailableConnections({ backends, connections, isLaunching, desktop, launch }) {
  const blocked = [];
  for (const backend of backends) {
    if (connections.some(c => c.backend === backend && ['ready', 'reconnecting'].includes(c.local)) || isLaunching(backend)) continue;
    try {
      if (backend === 'codex') {
        const state = desktop();
        if (state.inspectionFailed) { blocked.push({ backend, reason: 'CONNECTOR_PLATFORM_STEP_FAILED' }); continue; }
        if (state.desktopRunning && !state.sharedReady) { blocked.push({ backend, reason: 'CODEX_CLOSE_REQUIRED' }); continue; }
      }
      launch(backend);
    } catch { blocked.push({ backend, reason: 'CONNECTOR_PLATFORM_STEP_FAILED' }); }
  }
  return { starting: true, blocked, modelMessagesSent: 0, existingDesktopStopped: false };
}
function read(path) { const bytes = readFileSync(path); if (bytes.length > 16384) throw fail('CONNECTOR_SETUP_INVALID'); return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); }
function powerShell(entry, args = [], env = process.env) {
  try { return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', entry, ...args],
    { encoding: 'utf8', env, windowsHide: true, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { throw fail('CONNECTOR_PLATFORM_STEP_FAILED'); }
}

export function createConnectorActions({ codeRoot, privateDirectory = join(homedir(), '.local-secrets/rayneo-paseo'),
  stateDirectory = join(homedir(), '.local/state/rayneo-paseo'), now = Date.now } = {}) {
  let statusPending, lastStatus, checkedAt = 0, detectedAt = 0, detected, store;
  const launching = new Map();
  const installation = () => existsSync(join(privateDirectory, 'installation.json')) ? read(join(privateDirectory, 'installation.json')) : null;
  const getStore = () => store ??= createPairingStore({ directory: join(privateDirectory, 'pairing') });
  function desktop() { return JSON.parse(powerShell(join(codeRoot, 'distribution/desktop-state.ps1'))); }
  async function detect() {
    const client = createPaseoConnection({ url: 'ws://127.0.0.1:6767/ws', logger: quiet, connectTimeoutMs: 1500, reconnect: { enabled: false } });
    let paseo = false;
    try { await client.connect(); paseo = true; } catch {} finally { await client.close().catch(() => {}); }
    let codex = { installed: false }; try { codex = desktop(); } catch {}
    detected = { available: [...(paseo ? ['paseo'] : []), ...(codex.installed ? ['codex'] : [])], native: codex.native }; detectedAt = now();
    return detected;
  }
  function profiles() {
    const installed = installation();
    const enabled = installed?.configuredBackends ?? ['paseo', 'codex'];
    const output = {};
    if (enabled.includes('paseo') && existsSync(join(privateDirectory, 'daily.json'))) {
      const p = read(join(privateDirectory, 'daily.json'));
      if (p.publicBaseUrl) output.paseo = { endpoint: p.publicBaseUrl, port: p.port, token: p.apiToken };
    }
    if (enabled.includes('codex') && existsSync(join(privateDirectory, 'shared-runtime/connector-wireless.json'))) {
      const p = read(join(privateDirectory, 'shared-runtime/connector.json')), w = read(join(privateDirectory, 'shared-runtime/connector-wireless.json'));
      output.codex = { endpoint: w.endpoint, port: p.port, token: p.token };
    }
    return output;
  }
  async function checkStatus(force = false) {
    if (!force && lastStatus && now() - checkedAt < 10000) return lastStatus;
    if (statusPending) return statusPending;
    statusPending = (async () => {
      if (force || !detected || now() - detectedAt > 30000) await detect();
      const meta = installation();
      const legacy = !meta && (existsSync(join(privateDirectory, 'daily.json')) || existsSync(join(privateDirectory, 'shared-runtime/connector.json')));
      const enrollmentAvailable = Boolean(meta && existsSync(join(stateDirectory, 'enrollment-request.json')));
      const phase = meta?.phase === 'configured' ? 'configured' : meta ? (meta.phase === 'awaiting-invitation' && enrollmentAvailable ? 'prepared' : 'incomplete') : legacy ? 'existing' : 'new';
      const connections = [];
      const configurations = profiles();
      let ca; if (Object.keys(configurations).length) ca = new X509Certificate(readFileSync(join(privateDirectory, 'local.cer'))).toString();
      await Promise.all(Object.entries(configurations).map(async ([backend, p]) => {
        const [local, wireless] = await Promise.all([
          probeBridgeHealth({ url: `https://127.0.0.1:${p.port}/healthz`, token: p.token, ca, timeoutMs: 5000 }),
          probeBridgeHealth({ url: p.endpoint.replace(/\/+$/, '') + '/healthz', token: p.token, timeoutMs: 8000 }),
        ]);
        if (local === 'ready') launching.delete(backend);
        connections.push({ backend, ready: local === 'ready' && wireless === 'ready', local, wireless });
      }));
      const pairingEnabled = existsSync(join(privateDirectory, 'pairing-config.json'));
      let pairingReady = false;
      if (pairingEnabled) {
        try { selectPairingProfiles({ connections }, configurations, read(join(privateDirectory, 'pairing-config.json')).hostingBackend); pairingReady = true; } catch {}
      }
      lastStatus = { application: 'rayneo-connector', version: '0.2.0-trial.1', phase, available: detected.available,
        requestedBackends: meta?.backends ?? [], enrollmentAvailable,
        connections: connections.sort((a, b) => a.backend.localeCompare(b.backend)), pairingEnabled, pairingReady,
        pairingState: pairingEnabled ? getStore().status().kind : 'none' };
      checkedAt = now(); return lastStatus;
    })().finally(() => { statusPending = undefined; });
    return statusPending;
  }
  const actions = {
    status: checkStatus,
    async prepare({ backends } = {}) {
      await detect();
      backends ??= installation()?.backends ?? detected.available;
      if (!Array.isArray(backends) || !backends.length || backends.some(b => !detected.available.includes(b))) throw fail('CONNECTOR_SETUP_INVALID');
      const result = await prepareConnectorHome({ privateDirectory, stateDirectory, backends, executable: detected.native, independentCodex: true,
        generateCertificate: async ({ directory, password }) => {
          powerShell(join(codeRoot, 'distribution/certificate.ps1'), ['-Directory', directory], { ...process.env, RAYNEO_INSTALL_PFX_PASSWORD: password });
        },
        prepareDesktopAdapter: async output => {
          const compiler = join(process.env.SystemRoot ?? 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
          try { execFileSync(compiler, ['/nologo', '/optimize+', '/target:exe', '/out:' + output, join(codeRoot, 'experiments/codex-shared/DesktopProxy.cs')], { windowsHide: true, stdio: 'pipe', timeout: 30000 }); }
          catch { throw fail('CONNECTOR_PLATFORM_STEP_FAILED'); }
        },
      });
      lastStatus = null; return { prepared: true, modelMessagesSent: result.modelMessagesSent };
    },
    enrollment() { if (!installation()) throw fail('CONNECTOR_SETUP_INVALID'); return read(join(stateDirectory, 'enrollment-request.json')); },
    invitation(value) { const result = importTrialInvitation({ privateDirectory, invitation: value }); lastStatus = null; return result; },
    async connect() {
      const current = await checkStatus(true), meta = installation();
      if (['new', 'incomplete'].includes(current.phase)) {
        await actions.prepare();
        return { needsConfiguration: true, modelMessagesSent: 0 };
      }
      if (current.phase === 'prepared') return { needsConfiguration: true, modelMessagesSent: 0 };
      if (!['configured', 'existing'].includes(current.phase)) throw fail('CONNECTOR_NOT_READY');
      const enabled = meta?.configuredBackends ?? Object.keys(profiles());
      const env = { ...process.env, PATH: dirname(process.execPath) + ';' + (process.env.PATH ?? '') };
      const result = startAvailableConnections({ backends: enabled, connections: current.connections,
        isLaunching: backend => launching.has(backend), desktop, launch: backend => {
        const child = backend === 'paseo'
          ? spawn(process.execPath, [join(codeRoot, 'bridge/supervisor.mjs')], { cwd: codeRoot, env, detached: true, windowsHide: true, stdio: 'ignore' })
          : spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', join(codeRoot, 'scripts/run-codex-daily.ps1')], { cwd: codeRoot, env, detached: true, windowsHide: true, stdio: 'ignore' });
        launching.set(backend, child.pid ?? -1); child.once('error', () => launching.delete(backend)); child.once('exit', () => launching.delete(backend)); child.unref();
      } });
      lastStatus = null; return result;
    },
    async pair() {
      const status = await checkStatus(true);
      if (!status.pairingEnabled) throw fail('CONNECTOR_NOT_READY');
      const configured = profiles();
      const config = read(join(privateDirectory, 'pairing-config.json'));
      const selected = selectPairingProfiles(status, configured, config.hostingBackend);
      const ticket = getStore().issue({ computerLabel: '我的电脑', profiles: selected, publicBaseUrl: configured[config.hostingBackend].endpoint });
      const image = await QRCode.toDataURL(ticket.url, { width: 420, margin: 4, errorCorrectionLevel: 'M' });
      lastStatus = null; return { image, expiresAt: ticket.expiresAt };
    },
  };
  return actions;
}
