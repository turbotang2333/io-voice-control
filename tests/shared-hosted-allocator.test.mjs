import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createSharedHostedAllocator } from '../relay/shared-hosted-allocator.mjs';

const key = n => 'ssh-ed25519 ' + Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, n)]).toString('base64');
const request = () => ({ version: 1, installationId: randomUUID(), requestedBackends: ['paseo'], sshPublicKey: key(1) });
const shared = { publicBaseUrl: 'https://relay.example.test:24443', relay: { host: 'ssh.example.test', port: 2222, hostKey: key(2) } };
function dbPath() { const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/shared-allocator'); mkdirSync(parent, { recursive: true }); return join(mkdtempSync(join(parent, 'fixture-')), 'registry.sqlite'); }

test('more than 256 users share the same ports and their registrations survive restart', async () => {
  const databasePath = dbPath(); let calls = 0;
  let allocator = await createSharedHostedAllocator({ databasePath, shared, activate: async () => { calls++; return true; } });
  const requests = Array.from({ length: 260 }, request), invitations = [];
  for (const value of requests) invitations.push(await allocator.provision(value));
  assert.equal(calls, 260);
  assert.equal(new Set(invitations.map(value => value.publicBaseUrl)).size, 260);
  assert.deepEqual(new Set(invitations.map(value => new URL(value.publicBaseUrl).port)), new Set(['24443']));
  assert.deepEqual(new Set(invitations.map(value => value.relay.port)), new Set([2222]));
  allocator.close();
  allocator = await createSharedHostedAllocator({ databasePath, shared, activate: async () => { throw Error('must not activate again'); } });
  assert.deepEqual(await allocator.provision(requests[0]), invitations[0]);
  await assert.rejects(allocator.provision({ ...requests[0], sshPublicKey: key(3) }), { code: 'HOSTED_ALLOCATION_CONFLICT' });
  allocator.close();
  await assert.rejects(createSharedHostedAllocator({ databasePath, shared: { ...shared, publicBaseUrl: 'https://other.example.test:24443' }, activate: async () => true }), { code: 'HOSTED_CONFIG_CONFLICT' });
});

test('an interrupted registration is not repeated until its exact installation is inspected', async () => {
  const databasePath = dbPath(), input = request(); let calls = 0;
  const allocator = await createSharedHostedAllocator({ databasePath, shared, activate: async () => { calls++; throw Error('lost result'); } });
  await assert.rejects(allocator.provision(input), { code: 'HOSTED_ACTIVATION_UNCERTAIN' });
  await assert.rejects(allocator.provision(input), { code: 'HOSTED_ALLOCATION_PENDING' });
  await assert.rejects(allocator.reconcile(input, async () => false), { code: 'HOSTED_RECONCILIATION_UNCONFIRMED' });
  const invitation = await allocator.reconcile(input, async bundle => bundle.invitation.installationId === input.installationId);
  assert.deepEqual(await allocator.provision(input), invitation); assert.equal(calls, 1); allocator.close();
});

test('a simultaneous registration for the same computer cannot start another activation', async () => {
  const databasePath = dbPath(), input = request(); let finish;
  const allocator = await createSharedHostedAllocator({ databasePath, shared, activate: async () => { await new Promise(resolve => { finish = resolve; }); return true; } });
  const first = allocator.provision(input);
  await assert.rejects(allocator.provision(input), { code: 'HOSTED_ALLOCATION_PENDING' });
  finish(); await first; allocator.close();
});

test('operator capacity limit prevents unbounded public registrations', async () => {
  const databasePath = dbPath(); let calls = 0;
  const allocator = await createSharedHostedAllocator({ databasePath, shared, maxAllocations: 1, activate: async () => { calls++; return true; } });
  await allocator.provision(request());
  await assert.rejects(allocator.provision(request()), { code: 'HOSTED_CAPACITY_FULL' });
  assert.equal(calls, 1); allocator.close();
  await assert.rejects(createSharedHostedAllocator({ databasePath: dbPath(), shared, maxAllocations: 0, activate: async () => true }), { code: 'HOSTED_CONFIG_INVALID' });
});

test('independent processes cannot activate the same computer at once', async () => {
  const databasePath = dbPath(), enrollment = request();
  const initial = await createSharedHostedAllocator({ databasePath, shared, activate: async () => true }); initial.close();
  const payload = Buffer.from(JSON.stringify({ shared, enrollment })).toString('base64');
  const worker = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['tests/helpers/shared-allocator-worker.mjs', databasePath, payload], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { error += b; });
    child.on('error', reject); child.on('close', code => code ? reject(Error(error)) : resolve(JSON.parse(output)));
  });
  const results = await Promise.all([worker(), worker()]);
  assert.equal(results.filter(value => value.invitation).length, 1);
  assert.equal(results.filter(value => value.error === 'HOSTED_ALLOCATION_PENDING').length, 1);
});
