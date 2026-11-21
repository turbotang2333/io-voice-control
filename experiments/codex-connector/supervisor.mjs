import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { X509Certificate } from 'node:crypto';
import { createServer } from 'node:net';
import { validateProfile } from './service.mjs';
import { connectorRelayArguments } from './wireless-check.mjs';
import { acquireSupervisorLock, superviseCommand } from '../../bridge/supervisor.mjs';
import { probeBridgeHealth, createRelayHealthMonitor } from '../../bridge/relay-health.mjs';
import { recordRelayEvent } from '../../bridge/relay-diagnostics.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const invalid = () => Object.assign(new Error('CONNECTOR_MAINTENANCE_CONFIG_INVALID'), { code: 'INVALID_CONFIG' });

export function localConnectorMaintenancePlan(profile, configPath) {
  const local = validateProfile(profile);
  if (!isAbsolute(configPath ?? '')) throw invalid();
  return { localOnly: true, port: local.port, configPath: resolve(configPath),
    serviceArgs: [join(project, 'experiments/codex-connector/run.mjs'), 'serve', '--config', resolve(configPath)],
    localHealth: `https://127.0.0.1:${local.port}/healthz` };
}

export function connectorMaintenancePlan(profile, wireless, configPath) {
  const local = validateProfile(profile);
  if (!isAbsolute(configPath ?? '') || resolve(wireless?.configPath ?? '') !== resolve(configPath)
    || wireless?.localPort !== local.port || !Number.isInteger(wireless?.remoteLoopbackPort)
    || !(wireless.remoteLoopbackPort === 17469 || wireless.remoteLoopbackPort >= 20000 && wireless.remoteLoopbackPort <= 60000)) throw invalid();
  let endpoint;
  try { endpoint = new URL(wireless.endpoint); } catch { throw invalid(); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
    || !/^[A-Za-z0-9/_-]*$/.test(endpoint.pathname)) throw invalid();
  return { port: local.port, configPath: resolve(configPath),
    serviceArgs: [join(project, 'experiments/codex-connector/run.mjs'), 'serve', '--config', resolve(configPath)],
    relayArgs: connectorRelayArguments(local, wireless),
    localHealth: `https://127.0.0.1:${local.port}/healthz`,
    publicHealth: endpoint.href.replace(/\/+$/, '') + '/healthz' };
}

/** Own only the connector and its SSH tunnel. Journals and all message dispatch stay in run.mjs. */
export function startConnectorMaintenance({ plan, stateDirectory, probeLocal, probePublic,
  startJob = superviseCommand, intervalMs = 10000, failureThreshold = 3, cooldownMs = 60000 } = {}) {
  mkdirSync(stateDirectory, { recursive: true });
  const statePath = join(stateDirectory, 'health.json'), latest = {};
  const record = component => event => {
    latest[component] = event;
    try { recordRelayEvent(join(stateDirectory, component + '-events.json'), event); } catch { /* Recovery remains available. */ }
  };
  let service, relay, monitor, stopping;
  try {
    service = startJob({ command: process.execPath, args: plan.serviceArgs, cwd: project,
      onEvent: record('service') });
    if (plan.localOnly === true) return { stop() { return stopping ??= Promise.resolve().then(() => service.stop()); } };
    relay = startJob({ command: 'ssh.exe', args: plan.relayArgs, cwd: project,
      restartOnExit: false, diagnoseSsh: true, onEvent: record('relay') });
    monitor = createRelayHealthMonitor({ probeLocal, probePublic, intervalMs, failureThreshold, cooldownMs,
      getRelayState: () => relay.getState(), restartRelay: () => relay.restart(),
      onCheck(value) {
        try {
          const temp = statePath + '.tmp';
          writeFileSync(temp, JSON.stringify({ version: 1, ...value, processes: latest }) + '\n', { mode: 0o600 });
          renameSync(temp, statePath);
        } catch { /* A failed status write must not cause task replay or stop recovery. */ }
      } });
    monitor.start();
  } catch (error) { void service?.stop(); void relay?.stop(); throw error; }
  return {
    stop() {
      stopping ??= (async () => { await monitor.stop(); await Promise.all([service.stop(), relay.stop()]); })();
      return stopping;
    },
  };
}

async function requireFreeLocalPort(port) {
  const server = createServer();
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', accept); });
  await new Promise(accept => server.close(accept));
}

async function main() {
  const [mode, configFlag, configPath, ...transport] = process.argv.slice(2);
  const localOnly = transport.length === 1 && transport[0] === '--local-only';
  const wirelessPath = transport[1];
  if (!['check', 'start'].includes(mode) || configFlag !== '--config' || !isAbsolute(configPath ?? '')
    || (!localOnly && (transport.length !== 2 || transport[0] !== '--wireless' || !isAbsolute(wirelessPath ?? '')))) throw invalid();
  const read = path => {
    const bytes = readFileSync(path); if (bytes.length > 16384) throw invalid();
    return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  };
  const profile = validateProfile(read(configPath)), plan = localOnly ? localConnectorMaintenancePlan(profile, configPath)
    : connectorMaintenancePlan(profile, read(wirelessPath), configPath);
  const ca = new X509Certificate(readFileSync(join(dirname(profile.pfxPath), 'local.cer'))).toString();
  readFileSync(profile.pfxPath); // Readiness only; never print credentials or start a model task.
  if (mode === 'check') {
    console.log(JSON.stringify({ prepared: true, sharedRuntime: Boolean(profile.sharedConnection),
      serviceStarted: false, relayStarted: false, localOnly, startupRegistered: false, modelMessagesSent: 0 }));
    return;
  }
  const stateDirectory = join(homedir(), '.local/state/rayneo-paseo/codex-connector', 'maintenance-' + plan.port);
  const release = acquireSupervisorLock(join(stateDirectory, 'supervisor.lock'));
  let maintenance;
  try {
    await requireFreeLocalPort(plan.port);
    maintenance = startConnectorMaintenance({ plan, stateDirectory,
      probeLocal: signal => probeBridgeHealth({ url: plan.localHealth, token: profile.token, ca, signal, timeoutMs: 15000 }),
      probePublic: signal => probeBridgeHealth({ url: plan.publicHealth, token: profile.token, signal, timeoutMs: 15000 }) });
    console.log(JSON.stringify({ started: true, localOnly, relayStarted: !localOnly, modelMessagesSent: 0, startupRegistered: false }));
    await new Promise(accept => {
      process.once('SIGINT', accept); process.once('SIGTERM', accept);
      if (process.connected) {
        process.on('message', message => { if (message?.type === 'stop') accept(); });
        process.once('disconnect', accept);
      }
    });
  } finally { await maintenance?.stop(); release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Codex 连接维护未启动，请核对配置、端口和运行锁；未重发消息。'); process.exitCode = 1; });
}
