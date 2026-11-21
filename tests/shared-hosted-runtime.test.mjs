import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import https from 'node:https';
import { tlsFixture, listen } from './helpers/tls-fixture.mjs';
import { createSharedHostedRuntime } from '../relay/shared-hosted-runtime.mjs';
import { createSharedHostedService } from '../relay/shared-hosted-service.mjs';
import { createInviteStore } from '../relay/invite-store.mjs';
import { createHostedProvider } from '../distribution/hosted-provider.mjs';
import { createSecureDashboardActions } from '../distribution/secure-actions.mjs';

const key = n => 'ssh-ed25519 ' + Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, n)]).toString('base64');

test('enrollment service registers two computers with shared ports over HTTPS', async t => {
  const identity = tlsFixture('shared-hosted-runtime');
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/shared-runtime'); mkdirSync(parent, { recursive: true });
  const databasePath = join(mkdtempSync(join(parent, 'fixture-')), 'registry.sqlite');
  const activated = [];
  const runtime = await createSharedHostedRuntime({ databasePath, tls: { pfx: identity.pfx, passphrase: identity.passphrase },
    shared: { publicBaseUrl: 'https://relay.example.test:24443', relay: { host: 'ssh.example.test', port: 2222, hostKey: key(2) } },
    activate: async bundle => { activated.push(bundle); return true; }, inspect: async () => false });
  t.after(() => runtime.close()); const port = await listen(runtime.server);
  const enroll = input => new Promise((resolve, reject) => {
    const body = JSON.stringify(input);
    const req = https.request({ host: '127.0.0.1', servername: 'localhost', port, ca: identity.cert, path: '/v1/enroll', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
      const data = []; res.on('data', b => data.push(b)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(data).toString()) }));
    }); req.on('error', reject); req.end(body);
  });
  const requests = Array.from({ length: 2 }, () => ({ version: 1, installationId: randomUUID(), requestedBackends: ['paseo'], sshPublicKey: key(1) }));
  const results = await Promise.all(requests.map(enroll));
  assert.deepEqual(results.map(value => value.status), [200, 200]);
  assert.equal(activated.length, 2);
  assert.deepEqual(results.map(value => value.body.relay.port), [2222, 2222]);
  assert.deepEqual(results.map(value => new URL(value.body.publicBaseUrl).port), ['24443', '24443']);
  assert.notEqual(results[0].body.relay.user, results[1].body.relay.user);
  assert.deepEqual((await enroll(requests[0])).body, results[0].body);
  assert.equal(activated.length, 2);
});

test('hosted enrollment cannot start when shared infrastructure is unverified', async () => {
  await assert.rejects(createSharedHostedService({ verifyInfrastructure: async () => false }), { code: 'SHARED_INFRASTRUCTURE_UNVERIFIED' });
});

test('shared runtime requires its invitation and binds it to the enrolling computer', async t => {
  const identity = tlsFixture('invite-runtime');
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/shared-runtime'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'invite-')), inviteDatabasePath = join(root, 'invites.sqlite');
  const invites = await createInviteStore({ path: inviteDatabasePath }); const code = invites.issue(); invites.close();
  let activations = 0;
  const runtime = await createSharedHostedRuntime({ databasePath: join(root, 'registry.sqlite'), inviteDatabasePath,
    tls: { pfx: identity.pfx, passphrase: identity.passphrase },
    shared: { publicBaseUrl: 'https://relay.example.test:24443', relay: { host: 'ssh.example.test', port: 2222, hostKey: key(2) } },
    activate: async () => { activations++; return true; }, inspect: async () => false });
  t.after(() => runtime.close()); const port = await listen(runtime.server);
  const enroll = (input, invite) => new Promise((resolve, reject) => {
    const body = JSON.stringify(input), headers = { 'content-type': 'application/json' };
    if (invite) headers['x-invite-code'] = invite;
    const req = https.request({ host: '127.0.0.1', servername: 'localhost', port, ca: identity.cert, path: '/v1/enroll', method: 'POST', headers },
      res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end(body);
  });
  const first = { version: 1, installationId: randomUUID(), requestedBackends: ['paseo'], sshPublicKey: key(1) };
  assert.equal(await enroll(first), 403);
  assert.equal(await enroll(first, code), 200);
  assert.equal(await enroll(first, code), 200);
  assert.equal(await enroll({ ...first, installationId: randomUUID() }, code), 403);
  assert.equal(activations, 1);
});

test('connector sends the invite to the real HTTPS enrollment service and connects after acceptance', async t => {
  const tls = tlsFixture('invite-connector');
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/shared-runtime'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'connector-invite-')), inviteDatabasePath = join(root, 'invites.sqlite');
  const store = await createInviteStore({ path: inviteDatabasePath }); const code = store.issue(); store.close();
  let activations = 0;
  const runtime = await createSharedHostedRuntime({ databasePath: join(root, 'registry.sqlite'), inviteDatabasePath,
    tls: { pfx: tls.pfx, passphrase: tls.passphrase },
    shared: { publicBaseUrl: 'https://relay.example.test:24443', relay: { host: 'ssh.example.test', port: 2222, hostKey: key(2) } },
    activate: async () => { activations++; return true; }, inspect: async () => false });
  t.after(() => runtime.close()); const port = await listen(runtime.server);
  const fetchImpl = (url, options) => new Promise((accept, reject) => {
    const req = https.request({ host: '127.0.0.1', servername: 'localhost', port, path: new URL(url).pathname,
      method: options.method, headers: options.headers, ca: tls.cert }, res => {
      const chunks = []; res.on('data', b => chunks.push(b)); res.on('end', () => accept(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
    }); req.on('error', reject); req.end(options.body);
  });
  const enrollment = { version: 1, installationId: randomUUID(), requestedBackends: ['paseo'], sshPublicKey: key(1) };
  let configured, state = 'unconfigured';
  const legacy = { connect: async () => ({ needsConfiguration: true }), enrollment: () => enrollment };
  const secure = { status: async () => ({ phase: state }), configure: async value => { configured = value; state = 'configured'; }, connect: async () => ({ started: true }) };
  const actions = createSecureDashboardActions({ legacy, secure, hostedRequest: createHostedProvider({ serviceUrl: 'https://enrollment.example.test/v1/enroll', fetchImpl }) });
  await assert.rejects(actions.connect({ hosting: 'project-hosted' }), { code: 'HOSTED_INVITATION_REJECTED' });
  assert.equal(activations, 0);
  assert.deepEqual(await actions.connect({ hosting: 'project-hosted', invitationCode: code }), { started: true });
  assert.equal(configured.installationId, enrollment.installationId); assert.equal(activations, 1);
});

test('upgrading an existing registry preserves its allocation and requires an invite only for re-enrollment', async t => {
  const tls = tlsFixture('invite-upgrade');
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/shared-runtime'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'upgrade-'));
  const databasePath = join(root, 'registry.sqlite'), inviteDatabasePath = join(root, 'invites.sqlite');
  const shared = { publicBaseUrl: 'https://relay.example.test:24443', relay: { host: 'ssh.example.test', port: 2222, hostKey: key(2) } };
  let activations = 0;
  const options = { databasePath, shared, tls: { pfx: tls.pfx, passphrase: tls.passphrase },
    activate: async () => { activations++; return true; }, inspect: async () => false };
  const enrollment = { version: 1, installationId: randomUUID(), requestedBackends: ['paseo'], sshPublicKey: key(1) };
  const send = (port, input, code) => new Promise((resolve, reject) => {
    const body = JSON.stringify(input), headers = { 'content-type': 'application/json' };
    if (code) headers['x-invite-code'] = code;
    const req = https.request({ host: '127.0.0.1', servername: 'localhost', port, ca: tls.cert,
      path: '/v1/enroll', method: 'POST', headers }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
    });
    req.on('error', reject); req.end(body);
  });
  const oldRuntime = await createSharedHostedRuntime(options);
  const oldPort = await listen(oldRuntime.server);
  const before = await send(oldPort, enrollment);
  assert.equal(before.status, 200); assert.equal(activations, 1);
  await oldRuntime.close();

  const store = await createInviteStore({ path: inviteDatabasePath }); const code = store.issue(); store.close();
  const upgraded = await createSharedHostedRuntime({ ...options, inviteDatabasePath });
  t.after(() => upgraded.close()); const port = await listen(upgraded.server);
  assert.equal((await send(port, enrollment)).status, 403);
  const after = await send(port, enrollment, code);
  assert.equal(after.status, 200); assert.deepEqual(after.body, before.body);
  assert.equal(activations, 1);
  assert.equal((await send(port, { ...enrollment, sshPublicKey: key(3) }, code)).status, 403);
  assert.equal((await send(port, { ...enrollment, installationId: randomUUID() })).status, 403);
});

test('a failed invitation upgrade allows the previous service to reopen existing registrations', async t => {
  const tls = tlsFixture('invite-upgrade-failure');
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/shared-runtime'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'upgrade-failure-'));
  const databasePath = join(root, 'registry.sqlite');
  const shared = { publicBaseUrl: 'https://relay.example.test:24443', relay: { host: 'ssh.example.test', port: 2222, hostKey: key(2) } };
  let activations = 0;
  const options = { databasePath, shared, tls: { pfx: tls.pfx, passphrase: tls.passphrase },
    activate: async () => { activations++; return true; }, inspect: async () => false };
  const enrollment = { version: 1, installationId: randomUUID(), requestedBackends: ['paseo'], sshPublicKey: key(1) };
  const send = (port, input) => new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', servername: 'localhost', port, ca: tls.cert,
      path: '/v1/enroll', method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
    });
    req.on('error', reject); req.end(JSON.stringify(input));
  });
  const previous = await createSharedHostedRuntime(options);
  const before = await send(await listen(previous.server), enrollment);
  assert.equal(before.status, 200); assert.equal(activations, 1);
  await previous.close();

  await assert.rejects(createSharedHostedRuntime({ ...options, inviteDatabasePath: join(root, 'missing-directory', 'invites.sqlite') }));
  const restored = await createSharedHostedRuntime(options);
  t.after(() => restored.close());
  const after = await send(await listen(restored.server), enrollment);
  assert.equal(after.status, 200); assert.deepEqual(after.body, before.body);
  assert.equal(activations, 1);
});

test('a held installation lock makes a no-invite probe safe even against an unprotected service', async t => {
  const { DatabaseSync } = await import('node:sqlite');
  const tls = tlsFixture('invite-safe-probe');
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/shared-runtime'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'safe-probe-')), databasePath = join(root, 'registry.sqlite');
  let activations = 0;
  const runtime = await createSharedHostedRuntime({ databasePath, tls: { pfx: tls.pfx, passphrase: tls.passphrase },
    shared: { publicBaseUrl: 'https://relay.example.test:24443', relay: { host: 'ssh.example.test', port: 2222, hostKey: key(2) } },
    activate: async () => { activations++; return true; }, inspect: async () => false });
  t.after(() => runtime.close()); const port = await listen(runtime.server);
  const send = input => new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', servername: 'localhost', port, ca: tls.cert,
      path: '/v1/enroll', method: 'POST', headers: { 'content-type': 'application/json' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end(JSON.stringify(input));
  });
  const original = { version: 1, installationId: randomUUID(), requestedBackends: ['paseo'], sshPublicKey: key(1) };
  assert.equal(await send(original), 200); assert.equal(activations, 1);
  const lock = new DatabaseSync(join(databasePath + '.locks', original.installationId + '.sqlite'));
  try {
    lock.exec('BEGIN IMMEDIATE');
    assert.equal(await send({ ...original, sshPublicKey: key(3) }), 503);
  } finally { lock.exec('ROLLBACK'); lock.close(); }
  assert.equal(await send(original), 200); assert.equal(activations, 1);
});
