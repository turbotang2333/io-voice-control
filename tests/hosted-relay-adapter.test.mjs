import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createUnixRelayBundle } from '../relay/unix-provision.mjs';

const api = await import('../relay/hosted-relay-adapter.mjs').catch(error => { if (error.code === 'ERR_MODULE_NOT_FOUND') return {}; throw error; });
const key = 'ssh-ed25519 ' + Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 1)]).toString('base64');
const bundle = () => createUnixRelayBundle({ enrollment: { version: 1, installationId: randomUUID(), requestedBackends: ['paseo'], sshPublicKey: key },
  hosting: 'project-hosted', publicBaseUrl: 'https://relay.example.test:24443', relay: { host: 'relay.example.test', port: 2222, user: 'rayneo_test', hostKey: key } });
function driver({ active = true, failStart = false } = {}) {
  const calls = [];
  return { calls, async preflight() { calls.push('preflight'); }, async createFiles() { calls.push('files'); }, async createAccount() { calls.push('account'); },
    async verifySsh() { calls.push('verify'); }, async startService() { calls.push('start'); if (failStart) throw Error('failed'); },
    async reloadSsh() { calls.push('reload'); }, async rollback() { calls.push('rollback'); },
    async check() { calls.push('check'); return { installed: true, serviceActive: active, sshConfigured: true }; } };
}
test('hosted relay activation returns success only after installation and server-side checks', async () => {
  const d = driver(), adapter = api.createHostedRelayAdapter({ nodePath: '/usr/bin/node', driverFactory: () => d });
  assert.equal(await adapter.activate(bundle()), true);
  assert.deepEqual(d.calls, ['preflight', 'files', 'account', 'verify', 'start', 'reload', 'check']);
});
test('failed or unhealthy activation is never reported ready and inspection never installs', async () => {
  const broken = driver({ failStart: true }), a = api.createHostedRelayAdapter({ nodePath: '/usr/bin/node', driverFactory: () => broken });
  await assert.rejects(a.activate(bundle()), { code: 'HOSTED_ACTIVATION_CLEAN_FAILED' }); assert.ok(broken.calls.includes('rollback'));
  const stopped = driver({ active: false }), b = api.createHostedRelayAdapter({ nodePath: '/usr/bin/node', driverFactory: () => stopped });
  assert.equal(await b.activate(bundle()), false); stopped.calls.length = 0;
  assert.equal(await b.inspect(bundle()), false); assert.deepEqual(stopped.calls, ['check']);
});

test('a blocked host preflight is a clean failure and never begins installation', async () => {
  const d = driver(); d.preflight = async () => { d.calls.push('preflight'); throw Object.assign(Error(), { code: 'RELAY_ISOLATION_REQUIRED' }); };
  const adapter = api.createHostedRelayAdapter({ nodePath: '/usr/bin/node', driverFactory: () => d });
  await assert.rejects(adapter.activate(bundle()), { code: 'HOSTED_ACTIVATION_CLEAN_FAILED' });
  assert.deepEqual(d.calls, ['preflight']);
});

test('an already occupied resource remains uncertain instead of being declared free', async () => {
  const d = driver(); d.preflight = async () => { throw Object.assign(Error(), { code: 'RELAY_PORT_IN_USE' }); };
  const adapter = api.createHostedRelayAdapter({ nodePath: '/usr/bin/node', driverFactory: () => d });
  await assert.rejects(adapter.activate(bundle()), { code: 'RELAY_PORT_IN_USE' });
});
