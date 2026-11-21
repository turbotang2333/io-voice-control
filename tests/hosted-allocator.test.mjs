import test from 'node:test';
import assert from 'node:assert/strict';
import { chownSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const api = await import('../relay/hosted-allocator.mjs').catch(error => { if (error.code === 'ERR_MODULE_NOT_FOUND') return {}; throw error; });
const key = 'ssh-ed25519 ' + Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 1)]).toString('base64');
const key2 = 'ssh-ed25519 ' + Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 2)]).toString('base64');
const request = () => ({ version: 1, installationId: randomUUID(), requestedBackends: ['paseo'], sshPublicKey: key });
const slot = n => ({ id: 'slot' + n, publicBaseUrl: `https://relay.example.test:${24000 + n}`,
  relay: { host: 'relay.example.test', port: 25000 + n, user: 'rayneo_' + n, hostKey: key2 } });
function dbPath() { const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/hosted-allocator'); mkdirSync(parent, { recursive: true }); return join(mkdtempSync(join(parent, 'fixture-')), 'registry.sqlite'); }

test('a privileged allocator refuses a database directory controlled by another user', { skip: process.platform === 'win32' || process.getuid?.() !== 0 }, async () => {
  const dir = mkdtempSync('/tmp/rayneo-db-owner-');
  try {
    chownSync(dir, 65534, 65534);
    let opened;
    try { await assert.rejects(async () => { opened = await api.createHostedAllocator({ databasePath: join(dir, 'registry.sqlite'), slots: [slot(1)], activate: async () => true }); }, { code: 'HOSTED_DATABASE_INVALID' }); }
    finally { opened?.close(); }
  } finally { chownSync(dir, 0, 0); rmSync(dir, { recursive: true, force: true }); }
});

test('allocated resources remain unique and repeated requests return the same result after restart', async () => {
  const databasePath = dbPath(), slots = [slot(1), slot(2)]; let calls = 0;
  let allocator = await api.createHostedAllocator({ databasePath, slots, activate: async () => { calls++; return true; } });
  const first = request(), second = request();
  const [a, b] = await Promise.all([allocator.provision(first), allocator.provision(second)]);
  assert.notEqual(a.publicBaseUrl, b.publicBaseUrl); assert.equal(calls, 2);
  await assert.rejects(allocator.provision(request()), { code: 'HOSTED_CAPACITY_FULL' });
  allocator.close(); allocator = await api.createHostedAllocator({ databasePath, slots, activate: async () => { throw Error('must not activate again'); } });
  assert.deepEqual(await allocator.provision(first), a);
  await assert.rejects(allocator.provision({ ...first, sshPublicKey: key2 }), { code: 'HOSTED_ALLOCATION_CONFLICT' });
  allocator.close();
});

test('an interrupted or failed activation never frees its resource or silently retries it', async () => {
  const databasePath = dbPath(), slots = [slot(1), slot(2)], first = request(); let calls = 0;
  let allocator = await api.createHostedAllocator({ databasePath, slots, activate: async () => { calls++; throw Error('unknown side effects'); } });
  await assert.rejects(allocator.provision(first), { code: 'HOSTED_ACTIVATION_UNCERTAIN' }); allocator.close();
  allocator = await api.createHostedAllocator({ databasePath, slots, activate: async () => { calls++; return true; } });
  await assert.rejects(allocator.provision(first), { code: 'HOSTED_ALLOCATION_PENDING' });
  const other = await allocator.provision(request()); assert.equal(other.publicBaseUrl, slot(2).publicBaseUrl);
  await assert.rejects(allocator.provision(request()), { code: 'HOSTED_CAPACITY_FULL' });
  assert.equal(calls, 2); allocator.close();
});

test('a confirmed clean rollback frees the reservation so the same request can retry', async () => {
  const databasePath = dbPath(), input = request(); let attempts = 0;
  const allocator = await api.createHostedAllocator({ databasePath, slots: [slot(1)], activate: async () => {
    if (++attempts === 1) throw Object.assign(Error('rolled back'), { code: 'HOSTED_ACTIVATION_CLEAN_FAILED' });
    return true;
  } });
  await assert.rejects(allocator.provision(input), { code: 'HOSTED_ACTIVATION_RETRYABLE' });
  assert.equal((await allocator.provision(input)).installationId, input.installationId);
  assert.equal(attempts, 2); allocator.close();
});

test('an uncertain activation can be recovered only after inspecting the exact reserved service', async () => {
  const databasePath = dbPath(), slots = [slot(1)], input = request();
  let allocator = await api.createHostedAllocator({ databasePath, slots, activate: async () => { throw Error('connection lost'); } });
  await assert.rejects(allocator.provision(input), { code: 'HOSTED_ACTIVATION_UNCERTAIN' });
  allocator.close(); allocator = await api.createHostedAllocator({ databasePath, slots, activate: async () => { throw Error('must not activate again'); } });
  await assert.rejects(allocator.reconcile(input, async () => false), { code: 'HOSTED_RECONCILIATION_UNCONFIRMED' });
  await assert.rejects(allocator.provision(input), { code: 'HOSTED_ALLOCATION_PENDING' });
  let inspected;
  const restored = await allocator.reconcile(input, async bundle => { inspected = bundle; return true; });
  assert.equal(inspected.invitation.installationId, input.installationId);
  assert.equal(inspected.invitation.publicBaseUrl, slot(1).publicBaseUrl);
  assert.deepEqual(await allocator.provision(input), restored);
  allocator.close();
});

test('the enrollment adapter checks an existing uncertain allocation without starting it again', async () => {
  const databasePath = dbPath(), slots = [slot(1)], input = request(); let starts = 0, inspections = 0;
  const allocator = await api.createHostedAllocator({ databasePath, slots, activate: async () => { starts++; throw Error('response lost'); } });
  const provision = api.createHostedProvisioner({ allocator, inspect: async () => { inspections++; return true; } });
  await assert.rejects(provision(input), { code: 'HOSTED_ACTIVATION_UNCERTAIN' });
  assert.equal((await provision(input)).installationId, input.installationId);
  assert.equal(starts, 1); assert.equal(inspections, 1); allocator.close();
});

test('recovery refuses a reservation whose resource changes during inspection', async () => {
  const databasePath = dbPath(), slots = [slot(1), slot(2)], input = request();
  const allocator = await api.createHostedAllocator({ databasePath, slots, activate: async () => { throw Error('interrupted'); } });
  await assert.rejects(allocator.provision(input), { code: 'HOSTED_ACTIVATION_UNCERTAIN' });
  await assert.rejects(allocator.reconcile(input, async () => {
    const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync(databasePath);
    db.prepare("UPDATE allocations SET slot_id='slot2' WHERE installation_id=?").run(input.installationId); db.close(); return true;
  }), { code: 'HOSTED_RECONCILIATION_UNCONFIRMED' });
  allocator.close();
});

test('conflicting slot definitions are refused rather than reusing a live resource', async () => {
  const databasePath = dbPath(), slots = [slot(1)];
  const allocator = await api.createHostedAllocator({ databasePath, slots, activate: async () => true });
  await allocator.provision(request()); allocator.close();
  await assert.rejects(api.createHostedAllocator({ databasePath, slots: [{ ...slot(1), publicBaseUrl: 'https://relay.example.test:26000' }], activate: async () => true }), { code: 'HOSTED_SLOT_CONFLICT' });
  await assert.rejects(api.createHostedAllocator({ databasePath, slots: [slot(1), { ...slot(2), publicBaseUrl: slot(1).publicBaseUrl }], activate: async () => true }), { code: 'HOSTED_SLOT_CONFLICT' });
});

test('an altered reservation cannot be returned as successfully activated', async () => {
  const databasePath = dbPath(), input = request();
  const allocator = await api.createHostedAllocator({ databasePath, slots: [slot(1)], activate: async () => {
    const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync(databasePath);
    db.prepare("UPDATE allocations SET state='uncertain' WHERE installation_id=?").run(input.installationId); db.close(); return true;
  } });
  await assert.rejects(allocator.provision(input), { code: 'HOSTED_ACTIVATION_UNCERTAIN' });
  await assert.rejects(allocator.provision(input), { code: 'HOSTED_ALLOCATION_PENDING' });
  allocator.close();
});

test('activation refuses a reservation whose resource changes while the service starts', async () => {
  const databasePath = dbPath(), input = request();
  const allocator = await api.createHostedAllocator({ databasePath, slots: [slot(1), slot(2)], activate: async () => {
    const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync(databasePath);
    db.prepare("UPDATE allocations SET slot_id='slot2' WHERE installation_id=?").run(input.installationId); db.close(); return true;
  } });
  await assert.rejects(allocator.provision(input), { code: 'HOSTED_ACTIVATION_UNCERTAIN' });
  allocator.close();
});

test('activation cannot change the invitation returned to the computer', async () => {
  const databasePath = dbPath(), input = request();
  const allocator = await api.createHostedAllocator({ databasePath, slots: [slot(1)], activate: async bundle => {
    bundle.invitation.publicBaseUrl = 'https://other.example.test:29999'; return true;
  } });
  const first = await allocator.provision(input), again = await allocator.provision(input);
  assert.equal(first.publicBaseUrl, slot(1).publicBaseUrl); assert.deepEqual(first, again);
  allocator.close();
});

test('two independent processes cannot allocate the same slot to different computers', async () => {
  const databasePath = dbPath(), slots = [slot(1)];
  const initial = await api.createHostedAllocator({ databasePath, slots, activate: async () => true }); initial.close();
  function worker(enrollment) {
    const payload = Buffer.from(JSON.stringify({ slots, enrollment, delay: 250 })).toString('base64');
    const child = spawn(process.execPath, ['tests/helpers/hosted-allocator-worker.mjs', databasePath, payload], { stdio: ['ignore', 'pipe', 'pipe'] });
    return new Promise((resolve, reject) => { let output = '', error = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => error += b);
      child.on('error', reject); child.on('close', code => { if (code) reject(Error(error)); else resolve(JSON.parse(output)); }); });
  }
  const results = await Promise.all([worker(request()), worker(request())]);
  assert.equal(results.filter(value => value.invitation).length, 1);
  assert.equal(results.filter(value => value.error === 'HOSTED_CAPACITY_FULL').length, 1);
});

test('a process crash preserves the reservation and allows recovery only after inspection', async () => {
  const databasePath = dbPath(), slots = [slot(1)], input = request();
  const initial = await api.createHostedAllocator({ databasePath, slots, activate: async () => true }); initial.close();
  const payload = Buffer.from(JSON.stringify({ slots, enrollment: input, delay: 30000, notifyReserved: true })).toString('base64');
  const child = spawn(process.execPath, ['tests/helpers/hosted-allocator-worker.mjs', databasePath, payload], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    let output = ''; const timer = setTimeout(() => { child.kill(); reject(Error('reservation did not start')); }, 10000);
    child.stdout.on('data', data => { output += data; if (output.includes('RESERVED\n')) { clearTimeout(timer); resolve(); } });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => { clearTimeout(timer); if (!output.includes('RESERVED\n')) reject(Error(`worker exited before reserving: ${code}`)); });
  });
  const stopped = new Promise(resolve => child.once('exit', resolve)); child.kill(); await stopped;
  const allocator = await api.createHostedAllocator({ databasePath, slots, activate: async () => { throw Error('must not activate again'); } });
  await assert.rejects(allocator.provision(input), { code: 'HOSTED_ALLOCATION_PENDING' });
  await assert.rejects(allocator.provision(request()), { code: 'HOSTED_CAPACITY_FULL' });
  await assert.rejects(allocator.reconcile(input, async () => false), { code: 'HOSTED_RECONCILIATION_UNCONFIRMED' });
  assert.equal((await allocator.reconcile(input, async () => true)).installationId, input.installationId);
  assert.equal((await allocator.provision(input)).installationId, input.installationId);
  allocator.close();
});

test('recovery cannot inspect or activate a reservation while another process is still activating it', async () => {
  const databasePath = dbPath(), slots = [slot(1)], input = request();
  const initial = await api.createHostedAllocator({ databasePath, slots, activate: async () => true }); initial.close();
  const payload = Buffer.from(JSON.stringify({ slots, enrollment: input, delay: 1000, notifyReserved: true })).toString('base64');
  const child = spawn(process.execPath, ['tests/helpers/hosted-allocator-worker.mjs', databasePath, payload], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    let output = ''; const timer = setTimeout(() => { child.kill(); reject(Error('reservation did not start')); }, 10000);
    child.stdout.on('data', data => { output += data; if (output.includes('RESERVED\n')) { clearTimeout(timer); resolve(); } });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => { clearTimeout(timer); if (!output.includes('RESERVED\n')) reject(Error(`worker exited before reserving: ${code}`)); });
  });
  const allocator = await api.createHostedAllocator({ databasePath, slots, activate: async () => true }); let inspected = false;
  await assert.rejects(allocator.reconcile(input, async () => { inspected = true; return true; }), { code: 'HOSTED_ALLOCATION_PENDING' });
  assert.equal(inspected, false);
  await new Promise((resolve, reject) => { child.once('exit', code => code === 0 ? resolve() : reject(Error(`worker exit ${code}`))); });
  assert.equal((await allocator.provision(input)).installationId, input.installationId); allocator.close();
});
