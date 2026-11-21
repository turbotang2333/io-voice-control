import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { tlsFixture, listen, close } from './helpers/tls-fixture.mjs';
import { probeSecureEndpoint } from '../secure-link/probe.mjs';

const identity = tlsFixture('secure-status');
test('encryption is verified only by a live handshake with the paired desktop and the expected protocol', async t => {
  let requests = 0;
  const server = https.createServer(identity, (req, res) => { requests++; res.end('{"ok":true,"transport":"tls-passthrough-v1"}'); });
  t.after(() => close(server)); const port = await listen(server);
  const options = { publicBaseUrl: `https://localhost:${port}`, identity, timeoutMs: 2000 };
  assert.equal((await probeSecureEndpoint(options)).state, 'verified');
  const before = requests;
  assert.equal((await probeSecureEndpoint({ ...options, identity: { ...identity, certificateSha256: 'a'.repeat(64) } })).state, 'identity_rejected');
  assert.equal(requests, before);
});

test('a reachable HTTPS server without a valid protocol response cannot advertise end-to-end encryption', async t => {
  const server = https.createServer(identity, (req, res) => res.end('{"ok":true}'));
  t.after(() => close(server)); const port = await listen(server);
  const result = await probeSecureEndpoint({ publicBaseUrl: `https://localhost:${port}`, identity, timeoutMs: 2000 });
  assert.equal(result.state, 'protocol_rejected');
});

test('a dropped network preserves the configured identity and produces a reconnectable state', async t => {
  const server = https.createServer(identity); const port = await listen(server); await close(server);
  const result = await probeSecureEndpoint({ publicBaseUrl: `https://localhost:${port}`, identity, timeoutMs: 1000 });
  assert.equal(result.state, 'network_unavailable');
  assert.equal(result.encryption, 'unverified');
});
