import net from 'node:net';
import { validHostname, validInstallationId, validateSecureInvitation } from '../secure-link/config.mjs';
import { createHostedEnrollment } from '../distribution/hosted-enrollment.mjs';

const fail = () => { throw Object.assign(Error('SHARED_CONFIG_INVALID'), { code: 'SHARED_CONFIG_INVALID' }); };
const root = '/var/lib/rayneo-shared';
const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';

export function accountForInstallation(id) {
  if (!validInstallationId(id)) fail();
  let number = BigInt('0x' + id.replaceAll('-', '')), encoded = '';
  for (let i = 0; i < 26; i++) { encoded = alphabet[Number(number & 31n)] + encoded; number >>= 5n; }
  return 'rnp_' + encoded;
}

export function sharedSocket(id) { return `${root}/${accountForInstallation(id)}/tunnel/relay.sock`; }

export function sharedHostname(id, suffix) {
  if (!validInstallationId(id) || !validHostname(suffix) || suffix !== suffix.toLowerCase()) fail();
  const value = `${id}.${suffix}`;
  if (!validHostname(value)) fail();
  return value;
}

export function createSharedRouteConnector({ suffix, connectSocket = path => net.connect({ path }) } = {}) {
  sharedHostname('00000000-0000-0000-0000-000000000000', suffix);
  if (typeof connectSocket !== 'function') fail();
  return name => {
    if (typeof name !== 'string' || !name.endsWith('.' + suffix)) return null;
    const id = name.slice(0, -(suffix.length + 1));
    if (!validInstallationId(id)) return null;
    return connectSocket(sharedSocket(id));
  };
}

export function createSharedRelayBundle({ enrollment, hosting, shared } = {}) {
  let request, endpoint;
  try {
    request = createHostedEnrollment(enrollment);
    endpoint = new URL(shared.publicBaseUrl);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash
      || endpoint.hostname !== endpoint.hostname.toLowerCase() || !validHostname(endpoint.hostname)) fail();
    const hostname = sharedHostname(request.installationId, endpoint.hostname);
    const publicBaseUrl = `https://${hostname}${endpoint.port ? ':' + endpoint.port : ''}`;
    const invitation = validateSecureInvitation({ version: 3, transport: 'tls-passthrough-v1', hosting,
      publicBaseUrl, installationId: request.installationId, remoteSocket: '/tunnel/relay.sock', backends: request.requestedBackends,
      relay: { ...shared.relay, user: accountForInstallation(request.installationId) } });
    return { invitation, targetSocket: sharedSocket(request.installationId), authorizedKey: `restrict,port-forwarding ${request.sshPublicKey}\n` };
  } catch { fail(); }
}

export function createSharedSshConfig({ port, listenHost = '0.0.0.0' } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !['0.0.0.0', '127.0.0.1'].includes(listenHost)) fail();
  return `Port ${port}\nListenAddress ${listenHost}\nHostKey /etc/ssh/ssh_host_ed25519_key\nPidFile /run/rayneo-shared-ssh.pid\nAuthorizedKeysFile ${root}/%u/authorized_keys\nAllowUsers rnp_*\nAuthenticationMethods publickey\nPubkeyAuthentication yes\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nHostbasedAuthentication no\nGSSAPIAuthentication no\nPermitEmptyPasswords no\nPermitRootLogin no\nPermitTTY no\nPermitUserRC no\nPermitUserEnvironment no\nChrootDirectory ${root}/%u\nAllowTcpForwarding remote\nPermitListen none\nAllowStreamLocalForwarding remote\nStreamLocalBindUnlink yes\nStreamLocalBindMask 0117\nAllowAgentForwarding no\nX11Forwarding no\nPermitTunnel no\nGatewayPorts no\nMaxSessions 0\nStrictModes yes\nUsePAM yes\n`;
}
