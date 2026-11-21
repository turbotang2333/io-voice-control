import test from 'node:test';
import assert from 'node:assert/strict';
const api = await import('./wireless-check.mjs').catch(e => { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; return {}; });
const profile = { host: '127.0.0.1', port: 19469, token: 'a'.repeat(64), navigation: true,
  pfxPath: 'C:\\private\\server.p12', password: 'synthetic' };

test('connector wireless forwarding targets its configured service rather than the old direct experiment', () => {
  assert.equal(typeof api.connectorRelayArguments, 'function');
  const args = api.connectorRelayArguments(profile, { sshHost: 'synthetic-host', remotePort: 17467 });
  assert.ok(args.includes('127.0.0.1:17469:127.0.0.1:19469'));
  assert.ok(!args.includes('127.0.0.1:17469:127.0.0.1:17469'));
  assert.ok(!args.join(' ').includes('17467'));
  assert.throws(() => api.connectorRelayArguments({ ...profile, port: 7468 }, { sshHost: 'synthetic-host' }));
  assert.throws(() => api.connectorRelayArguments(profile, { sshHost: '-unsafe' }));
});
