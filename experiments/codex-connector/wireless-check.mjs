import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { X509Certificate } from 'node:crypto';
import { validateProfile } from './service.mjs';
import { relayArguments } from '../../bridge/supervisor.mjs';
import { probeBridgeHealth } from '../../bridge/relay-health.mjs';

export function connectorRelayArguments(profile, relay) {
  const local = validateProfile(profile);
  return relayArguments({ sshHost: relay?.sshHost, remotePort: relay?.remoteLoopbackPort ?? 17469,
    ...(relay?.sshConfigPath === undefined ? {} : { sshConfigPath: relay.sshConfigPath }) }, local.port);
}

// Read-only preparation for the connector. Never starts SSH, changes a public route,
// changes the phone, dispatches a model message, or treats a local check as wireless acceptance.
export async function checkConnectorWireless() {
  const root = join(homedir(), '.local-secrets/rayneo-paseo');
  const read = name => JSON.parse(readFileSync(join(root, name), 'utf8').replace(/^\uFEFF/, ''));
  const profile = validateProfile(read('codex-connector-phone.json')), daily = read('daily.json');
  const args = connectorRelayArguments(profile, read('relay.json'));
  const ca = new X509Certificate(readFileSync(join(root, 'local.cer'))).toString();
  const url = `https://127.0.0.1:${profile.port}/healthz`;
  const [local, invalidToken] = await Promise.all([
    probeBridgeHealth({ url, ca, token: profile.token }),
    probeBridgeHealth({ url, ca, token: 'synthetic-invalid-token' }),
  ]);
  const checks = { connectorTlsReady: local === 'ready', unauthorizedDenied: invalidToken === 'rejected',
    paseoPortSeparated: daily.port !== profile.port, paseoTokenSeparated: daily.token !== profile.token,
    forwardTargetsConnector: args.includes(`127.0.0.1:17469:127.0.0.1:${profile.port}`) };
  return { checkedAt: new Date().toISOString(), checks, localPreparationPassed: Object.values(checks).every(Boolean),
    sharedRuntimeConfigured: Boolean(profile.sharedConnection), localPort: profile.port, remoteLoopbackPort: 17469,
    relayStarted: false, publicRouteChanged: false, phoneChanged: false, modelMessagesSent: 0, wirelessAcceptance: 'pending' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== '--check') throw Error('USAGE');
    const report = await checkConnectorWireless(); console.log(JSON.stringify(report));
    if (!report.localPreparationPassed) process.exitCode = 1;
  } catch { console.error('连接器无线准备检查未通过；未启动转发或发送消息。'); process.exitCode = 1; }
}
