import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPairingStore } from '../bridge/pairing.mjs';
import { relayArguments, superviseCommand } from '../bridge/supervisor.mjs';
import { probeBridgeHealth } from '../bridge/relay-health.mjs';
import { createDesktopGateway } from './gateway.mjs';
import { probeSecureEndpoint } from './probe.mjs';

const fail = code => Object.assign(Error(code), { code });
const codeRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

export async function inspectSecureLink(configuration, { timeoutMs = 5000 } = {}) {
  const { identity, invitation, backends } = configuration;
  const transport = await probeSecureEndpoint({ publicBaseUrl: invitation.publicBaseUrl, identity, timeoutMs });
  const connections = await Promise.all(Object.entries(backends).map(async ([backend, local]) => {
    const [localState, wireless] = await Promise.all([
      probeBridgeHealth({ url: `https://127.0.0.1:${local.port}/healthz`, token: local.upstreamToken, ca: local.ca, timeoutMs }),
      transport.state === 'verified'
        ? probeBridgeHealth({ url: invitation.publicBaseUrl + '/' + backend + '/healthz', token: local.token, ca: identity.cert, timeoutMs })
        : Promise.resolve(transport.state),
    ]);
    return { backend, local: localState, wireless, ready: localState === 'ready' && wireless === 'ready' };
  }));
  return { version: 1, phase: 'configured', hosting: invitation.hosting, transport: 'tls-passthrough-v1',
    encryption: transport.encryption, state: transport.state, connections,
    pairingReady: transport.state === 'verified' && connections.some(value => value.ready), modelMessagesSent: 0 };
}

export async function issueSecurePairing(configuration, pairing, computerLabel = '我的电脑') {
  const status = await inspectSecureLink(configuration);
  if (status.state !== 'verified') throw fail(status.state === 'identity_rejected' ? 'SECURE_IDENTITY_REJECTED' : 'SECURE_LINK_UNVERIFIED');
  const profiles = Object.fromEntries(status.connections.filter(value => value.ready).map(value => [value.backend, configuration.profiles[value.backend]]));
  if (!Object.keys(profiles).length) throw fail('SECURE_BACKEND_OFFLINE');
  const publicBaseUrl = Object.values(profiles)[0].endpoint;
  return pairing.issue({ computerLabel, profiles, publicBaseUrl, certificateSha256: configuration.identity.certificateSha256 });
}

/** Own only this TLS gateway and its dedicated SSH transport. Never starts/stops an assistant or submits a task. */
export async function startSecureLinkService({ configuration, startTunnel = superviseCommand, getBackends } = {}) {
  const pairing = createPairingStore({ directory: join(configuration.directory, 'pairing') });
  const gateway = createDesktopGateway({ identity: configuration.identity,
    hostname: new URL(configuration.invitation.publicBaseUrl).hostname, backends: configuration.backends, pairing, getBackends });
  let tunnel, stopping;
  const stop = () => stopping ??= (async () => {
    try { await tunnel?.stop(); }
    finally {
      gateway.closeAllConnections();
      await new Promise(resolveClose => gateway.close(resolveClose));
    }
  })();
  try {
    await new Promise((accept, reject) => { gateway.once('error', reject); gateway.listen(0, '127.0.0.1', accept); });
    const args = relayArguments({ sshHost: configuration.sshHost, sshConfigPath: join(configuration.directory, 'ssh-config'),
      ...(configuration.invitation.remoteSocket ? { remoteSocket: configuration.invitation.remoteSocket }
        : { remotePort: configuration.invitation.remotePort }) }, gateway.address().port);
    tunnel = await startTunnel({ command: process.platform === 'win32' ? 'ssh.exe' : 'ssh', args, cwd: codeRoot, diagnoseSsh: true });
    return { pairing, stop };
  } catch (error) { await stop(); throw error; }
}
