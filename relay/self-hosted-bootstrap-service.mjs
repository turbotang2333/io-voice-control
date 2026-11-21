import { randomBytes } from 'node:crypto';
import { createBootstrapServer, createPairingInformation } from './self-hosted-bootstrap.mjs';
import { createUnixRelayBundle } from './unix-provision.mjs';

/** The install callback must run the existing isolated installer, never a shell command supplied by a client. */
export async function startSelfHostedBootstrap({ host, publicPort = 443, sshPort = 2222, bootstrapPort = sshPort,
  bindHost = '0.0.0.0', hostKey, cert, pfx, passphrase, install, stopListeningBeforeInstall = false, ttlMs = 300000, secret = randomBytes(32).toString('base64url') } = {}) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 300000) throw Error('BOOTSTRAP_INPUT_INVALID');
  let server;
  server = createBootstrapServer({ pfx, passphrase, secret, expiresAt: Date.now() + ttlMs, install: async enrollment => {
    const bundle = createUnixRelayBundle({ enrollment, hosting: 'self-hosted',
      publicBaseUrl: `https://${host}${publicPort === 443 ? '' : ':' + publicPort}`,
      relay: { host, port: sshPort, user: 'rnp_' + enrollment.installationId.replaceAll('-', '').slice(0, 20), hostKey } });
    if (stopListeningBeforeInstall) server.close();
    await install(bundle);
    return bundle.invitation;
  } });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(bootstrapPort, bindHost, resolve); });
  try {
    const info = createPairingInformation({ host, port: server.address().port, cert, secret });
    const timer = setTimeout(() => { server.emit('bootstrapExpired'); server.closeAllConnections(); server.close(); }, ttlMs);
    timer.unref();
    server.once('bootstrapClaimed', () => clearTimeout(timer));
    server.once('close', () => clearTimeout(timer));
    return { server, info };
  } catch (error) { server.closeAllConnections(); server.close(); throw error; }
}
