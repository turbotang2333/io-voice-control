import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { tlsFixture, listen } from './helpers/tls-fixture.mjs';
import { createHostedRelayAdapter } from '../relay/hosted-relay-adapter.mjs';

const api = await import('../relay/hosted-runtime.mjs').catch(error => { if (error.code === 'ERR_MODULE_NOT_FOUND') return {}; throw error; });
const key = 'ssh-ed25519 ' + Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 1)]).toString('base64');
const slot = { id: 'one', publicBaseUrl: 'https://relay.example.test:24443', relay: { host: 'relay.example.test', port: 2222, user: 'rayneo_test', hostKey: key } };
const request = () => ({ version: 1, installationId: randomUUID(), requestedBackends: ['paseo'], sshPublicKey: key });
const path = () => { const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/hosted-runtime'); mkdirSync(parent, { recursive: true }); return join(mkdtempSync(join(parent, 'fixture-')), 'registry.sqlite'); };

test('hosted runtime handles an encrypted request with bounded resources and no duplicate activation', async t => {
  const identity = tlsFixture('hosted-runtime'), enrollment = request(); let starts = 0;
  const adapter = createHostedRelayAdapter({ nodePath: '/usr/bin/node', driverFactory: () => ({
    async preflight() {}, async createFiles() {}, async createAccount() {}, async verifySsh() {}, async startService() { starts++; },
    async reloadSsh() {}, async rollback() {}, async check() { return { installed: true, serviceActive: true, sshConfigured: true }; },
  }) });
  const runtime = await api.createHostedRuntime({ databasePath: path(), slots: [slot], tls: { pfx: identity.pfx, passphrase: identity.passphrase },
    activate: adapter.activate, inspect: adapter.inspect });
  t.after(() => runtime.close()); const port = await listen(runtime.server);
  async function send(value) { const body = JSON.stringify(value); return await new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', servername: 'localhost', port, path: '/v1/enroll', method: 'POST', ca: identity.cert,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
      const chunks = []; res.on('data', b => chunks.push(b)); res.on('end', () => resolve({ status: res.statusCode, value: JSON.parse(Buffer.concat(chunks).toString()) }));
    }); req.on('error', reject); req.end(body);
  }); }
  const first = await send(enrollment), retry = await send(enrollment), full = await send(request());
  assert.equal(first.status, 200); assert.deepEqual(first, retry); assert.equal(full.status, 503); assert.equal(starts, 1);
});

test('runtime cannot start without explicit activation, inspection and TLS material', async () => {
  await assert.rejects(api.createHostedRuntime({ databasePath: path(), slots: [slot] }), { code: 'HOSTED_RUNTIME_INVALID' });
});
