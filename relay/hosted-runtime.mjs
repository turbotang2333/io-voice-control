import { createServer } from 'node:https';
import { createHostedAllocator, createHostedProvisioner } from './hosted-allocator.mjs';
import { createHostedEnrollmentHandler } from './hosted-server.mjs';

const fail = code => Object.assign(Error(code), { code });
const material = value => typeof value === 'string' && value.length > 0 || Buffer.isBuffer(value) && value.length > 0;

/** Creates an unbound server; the caller must supply trusted activation and inspection implementations. */
export async function createHostedRuntime({ databasePath, slots, activate, inspect, tls, limits } = {}) {
  if (typeof activate !== 'function' || typeof inspect !== 'function' || !tls || typeof tls !== 'object'
    || Object.keys(tls).some(key => !['key', 'cert', 'pfx', 'passphrase'].includes(key))
    || !(material(tls.pfx) && tls.key === undefined && tls.cert === undefined
      || material(tls.key) && material(tls.cert) && tls.pfx === undefined)
    || tls.passphrase !== undefined && typeof tls.passphrase !== 'string') throw fail('HOSTED_RUNTIME_INVALID');
  let handler;
  let server;
  try { server = createServer({ ...tls, minVersion: 'TLSv1.3' }, (req, res) => {
    handler(req, res).catch(() => {
      if (res.destroyed) return;
      if (!res.headersSent) { res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end('{"error":"temporarily_unavailable"}'); }
      else res.destroy();
    });
  }); }
  catch { throw fail('HOSTED_RUNTIME_INVALID'); }
  const allocator = await createHostedAllocator({ databasePath, slots, activate });
  try {
    const provision = createHostedProvisioner({ allocator, inspect });
    handler = createHostedEnrollmentHandler({ ...limits, provision });
  } catch (error) { allocator.close(); throw error; }
  server.headersTimeout = 10000; server.requestTimeout = 15000; server.keepAliveTimeout = 5000; server.maxConnections = 128;
  return {
    server,
    async close() {
      if (server.listening) {
        const stopped = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        server.closeIdleConnections?.(); await stopped;
      }
      allocator.close();
    },
  };
}
