import { createServer } from 'node:https';
import { createHostedProvisioner } from './hosted-allocator.mjs';
import { createHostedEnrollmentHandler } from './hosted-server.mjs';
import { createSharedHostedAllocator } from './shared-hosted-allocator.mjs';
import { createInviteStore } from './invite-store.mjs';
import { createHash } from 'node:crypto';

const fail = code => Object.assign(Error(code), { code });
const material = value => typeof value === 'string' && value.length > 0 || Buffer.isBuffer(value) && value.length > 0;

export async function createSharedHostedRuntime({ databasePath, inviteDatabasePath, shared, activate, inspect, tls, limits, maxAllocations } = {}) {
  if (typeof activate !== 'function' || typeof inspect !== 'function' || !tls || typeof tls !== 'object'
    || Object.keys(tls).some(key => !['key', 'cert', 'pfx', 'passphrase'].includes(key))
    || !(material(tls.pfx) && tls.key === undefined && tls.cert === undefined || material(tls.key) && material(tls.cert) && tls.pfx === undefined)
    || tls.passphrase !== undefined && typeof tls.passphrase !== 'string') throw fail('HOSTED_RUNTIME_INVALID');
  let handler, server;
  try { server = createServer({ ...tls, minVersion: 'TLSv1.3' }, (req, res) => {
    handler(req, res).catch(() => {
      if (res.destroyed) return;
      if (!res.headersSent) { res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end('{"error":"temporarily_unavailable"}'); }
      else res.destroy();
    });
  }); } catch { throw fail('HOSTED_RUNTIME_INVALID'); }
  const allocator = await createSharedHostedAllocator({ databasePath, shared, activate, maxAllocations });
  let invites;
  try {
    if (inviteDatabasePath !== undefined) invites = await createInviteStore({ path: inviteDatabasePath });
    const authorize = invites ? (request, code) => {
      const canonical = { ...request, requestedBackends: [...request.requestedBackends].sort() };
      const binding = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
      return invites.claim(code, binding);
    } : undefined;
    handler = createHostedEnrollmentHandler({ ...limits, authorize, provision: createHostedProvisioner({ allocator, inspect }) });
  } catch (error) { invites?.close(); allocator.close(); throw error; }
  server.headersTimeout = 10000; server.requestTimeout = 15000; server.keepAliveTimeout = 5000; server.maxConnections = 128;
  return {
    server,
    async close() {
      if (server.listening) {
        const stopped = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        server.closeIdleConnections?.(); await stopped;
      }
      invites?.close(); allocator.close();
    },
  };
}
