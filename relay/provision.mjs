import { validateSecureInvitation, validateSshPublicKey } from '../secure-link/config.mjs';

/** Both operator-hosted and self-hosted relays consume the same public enrollment and emit the same invitation. */
export function createRelayBundle({ enrollment, hosting, publicBaseUrl, remotePort, relay } = {}) {
  const fail = () => Object.assign(Error('SECURE_INVITATION_INVALID'), { code: 'SECURE_INVITATION_INVALID' });
  if (!enrollment || enrollment.version !== 1) throw fail();
  const publicKey = validateSshPublicKey(enrollment.sshPublicKey);
  const invitation = validateSecureInvitation({ version: 2, transport: 'tls-passthrough-v1', hosting, publicBaseUrl, remotePort, relay,
    installationId: enrollment.installationId, backends: enrollment.requestedBackends });
  const relayConfig = { version: 1, listenPort: Number(new URL(invitation.publicBaseUrl).port || 443), targetPort: invitation.remotePort,
    maxConnections: 128, maxPerIp: 16, idleTimeoutMs: 300000, connectTimeoutMs: 10000 };
  const authorizedKey = `restrict,port-forwarding,permitlisten="127.0.0.1:${invitation.remotePort}" ${publicKey}\n`;
  // A dedicated SSH account must use these restrictions. No shell, local forwarding, PTY or other host access is needed.
  const sshdConfig = `Match User ${invitation.relay.user}\n    AllowTcpForwarding remote\n    AllowStreamLocalForwarding no\n    GatewayPorts no\n    PermitListen 127.0.0.1:${invitation.remotePort}\n    PermitTTY no\n    X11Forwarding no\n    AllowAgentForwarding no\n    MaxSessions 0\nMatch all\n`;
  return { invitation, relayConfig, authorizedKey, sshdConfig };
}
