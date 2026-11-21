import { validateSecureInvitation, validateSshPublicKey } from '../secure-link/config.mjs';

/** Dedicated SSH configuration avoids inheriting a host's unrelated Match rules. */
export function createUnixRelayBundle({ enrollment, hosting, publicBaseUrl, relay } = {}) {
  const fail = () => Object.assign(Error('SECURE_INVITATION_INVALID'), { code: 'SECURE_INVITATION_INVALID' });
  if (!enrollment || enrollment.version !== 1) throw fail();
  const publicKey = validateSshPublicKey(enrollment.sshPublicKey);
  const remoteSocket = '/tunnel/relay.sock';
  const invitation = validateSecureInvitation({ version: 3, transport: 'tls-passthrough-v1', hosting, publicBaseUrl, remoteSocket, relay,
    installationId: enrollment.installationId, backends: enrollment.requestedBackends });
  const directory = `/var/lib/rayneo-relay/${invitation.installationId}`;
  const relayConfig = { version: 2, listenPort: Number(new URL(invitation.publicBaseUrl).port || 443), targetSocket: directory + remoteSocket,
    maxConnections: 128, maxPerIp: 16, idleTimeoutMs: 300000, connectTimeoutMs: 10000 };
  const authorizedKey = `restrict,port-forwarding ${publicKey}\n`;
  const sshdConfig = `Port ${invitation.relay.port}\nListenAddress 0.0.0.0\nHostKey /etc/ssh/ssh_host_ed25519_key\nPidFile /run/rayneo-ssh-${invitation.installationId}.pid\nAuthorizedKeysFile ${directory}/authorized_keys\nAllowUsers ${invitation.relay.user}\nAuthenticationMethods publickey\nPubkeyAuthentication yes\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nHostbasedAuthentication no\nGSSAPIAuthentication no\nPermitEmptyPasswords no\nPermitRootLogin no\nPermitTTY no\nPermitUserRC no\nPermitUserEnvironment no\nChrootDirectory ${directory}\nAllowTcpForwarding remote\nPermitListen none\nAllowStreamLocalForwarding remote\nStreamLocalBindUnlink yes\nStreamLocalBindMask 0177\nAllowAgentForwarding no\nX11Forwarding no\nPermitTunnel no\nGatewayPorts no\nMaxSessions 0\nStrictModes yes\nUsePAM yes\n`;
  return { invitation, relayConfig, authorizedKey, sshdConfig };
}
