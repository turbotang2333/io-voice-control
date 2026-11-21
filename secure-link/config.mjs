import { isIP } from 'node:net';

const fail = () => Object.assign(Error('SECURE_INVITATION_INVALID'), { code: 'SECURE_INVITATION_INVALID' });
export const validPort = value => Number.isInteger(value) && value >= 1024 && value <= 65535;
export const validInstallationId = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
export const validHostname = value => typeof value === 'string' && value.length <= 253 && !isIP(value)
  && value.includes('.') && value.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
const validRelayAddress = (value, hosting) => validHostname(value) || hosting === 'self-hosted' && isIP(value) === 4 && !value.startsWith('127.') && value !== '0.0.0.0';

export function validateSshPublicKey(value, hostKey = false) {
  if (typeof value !== 'string' || value.length > 4096 || /[\r\n\0]/.test(value)) throw fail();
  const match = /^(ssh-ed25519|ssh-rsa) ([A-Za-z0-9+/]+={0,2})(?: [A-Za-z0-9 _.@-]{1,120})?$/.exec(value);
  if (!match || hostKey && match[1] !== 'ssh-ed25519') throw fail();
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.toString('base64') !== match[2]) throw fail();
  let offset = 0;
  const field = () => {
    if (offset + 4 > bytes.length) throw fail();
    const length = bytes.readUInt32BE(offset); offset += 4;
    if (!length || offset + length > bytes.length) throw fail();
    const result = bytes.subarray(offset, offset + length); offset += length; return result;
  };
  if (field().toString() !== match[1]) throw fail();
  if (match[1] === 'ssh-ed25519') { if (field().length !== 32) throw fail(); }
  else { const exponent = field(), modulus = field(); if (exponent.length > 8 || modulus.length < 256 || modulus.length > 1025) throw fail(); }
  if (offset !== bytes.length) throw fail();
  return match[1] + ' ' + match[2];
}

export function validateSecureInvitation(value, installationId) {
  if (!value || ![2, 3].includes(value.version) || value.transport !== 'tls-passthrough-v1' || !validInstallationId(value.installationId)
    || installationId !== undefined && value.installationId !== installationId || !['self-hosted', 'project-hosted'].includes(value.hosting)
    || !Array.isArray(value.backends) || !value.backends.length || value.backends.length > 2
    || new Set(value.backends).size !== value.backends.length || value.backends.some(key => !['paseo', 'codex'].includes(key))
    || (value.version === 2 && (!Number.isInteger(value.remotePort) || value.remotePort < 20000 || value.remotePort > 60000 || value.remoteSocket !== undefined))
    || (value.version === 3 && (value.remotePort !== undefined || value.remoteSocket !== '/tunnel/relay.sock'))) throw fail();
  let endpoint;
  try { endpoint = new URL(value.publicBaseUrl); } catch { throw fail(); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || endpoint.pathname !== '/' || !validRelayAddress(endpoint.hostname, value.hosting) || Number(endpoint.port || 443) < 1
    || value.version === 2 && Number(endpoint.port || 443) === value.remotePort) throw fail();
  const relay = value.relay;
  if (!relay || !validRelayAddress(relay.host, value.hosting) || !Number.isInteger(relay.port) || relay.port < 1 || relay.port > 65535
    || !/^[a-z_][a-z0-9_-]{0,31}$/.test(relay.user ?? '') || Number(endpoint.port || 443) === relay.port) throw fail();
  const hostKey = validateSshPublicKey(relay.hostKey, true);
  return { version: value.version, transport: 'tls-passthrough-v1', hosting: value.hosting, installationId: value.installationId,
    publicBaseUrl: endpoint.origin, ...(value.version === 2 ? { remotePort: value.remotePort } : { remoteSocket: value.remoteSocket }), backends: [...value.backends],
    relay: { host: relay.host, port: relay.port, user: relay.user, hostKey } };
}
