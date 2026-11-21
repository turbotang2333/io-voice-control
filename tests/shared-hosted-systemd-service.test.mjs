import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { tlsFixture, listen } from './helpers/tls-fixture.mjs';
import { createSharedHostedSystemdService, selectExistingEnrollment } from '../relay/shared-hosted-systemd-service.mjs';
import { createSharedHostedGuardPlan } from '../relay/shared-hosted-upgrade-guard-plan.mjs';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

test('systemd adapter checks the pinned certificate and controls only the enrollment service', async t => {
  const identity = tlsFixture('upgrade-systemd-probe'), other = tlsFixture('upgrade-systemd-wrong');
  let registrations = 0, sentKey, enforce = true;
  const server = https.createServer({ pfx: identity.pfx, passphrase: identity.passphrase }, (req, res) => {
    if (req.method === 'POST') {
      registrations++; assert.equal(req.headers['x-invite-code'], undefined); let body = '';
      req.on('data', value => { body += value; }); req.on('end', () => { sentKey = JSON.parse(body).sshPublicKey; res.writeHead(enforce ? 403 : 503); res.end(); });
    } else { res.writeHead(404); res.end(); }
  });
  t.after(() => server.close()); const port = await listen(server), calls = [];
  let active = true;
  const run = args => { calls.push(args); if (args[0] === 'show') return active ? 'active' : 'inactive';
    if (args[0] === 'stop') active = false; if (args[0] === 'start') active = true; return ''; };
  const config = { listenPort: port, shared: { relay: { host: 'localhost' } } };
  const key = n => 'ssh-ed25519 ' + Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, n)]).toString('base64');
  const enrollment = { version: 1, installationId: randomUUID(), requestedBackends: ['paseo'], sshPublicKey: key(1) };
  let releases = 0;
  const service = createSharedHostedSystemdService({ run, readCertificate: () => identity.cert,
    reserveEnrollment: () => ({ enrollment, release() { releases++; } }), attempts: 1 });
  assert.equal(await service.isActive(), true); assert.equal(await service.verifyNew(config), true);
  assert.equal(registrations, 1);
  assert.notEqual(sentKey, enrollment.sshPublicKey);
  assert.equal(releases, 1);
  await service.stop(); assert.equal(await service.isActive(), false);
  await service.start(); assert.equal(await service.verifyOld(config), true);
  const startIndex = calls.findIndex(args => args[0] === 'start');
  assert.equal(calls[startIndex - 1][0], 'reset-failed');
  assert.ok(calls.filter(args => ['stop', 'start'].includes(args[0])).every(args => args[1] === 'rayneo-shared-hosted.service'));
  enforce = false; assert.equal(await service.verifyNew(config), false);
  assert.equal(releases, 2);
  const wrong = createSharedHostedSystemdService({ run, readCertificate: () => other.cert,
    reserveEnrollment: () => ({ enrollment, release() {} }), attempts: 1 });
  assert.equal(await wrong.verifyNew(config), false);
  assert.equal(registrations, 2);
});

test('server upgrade requires the exact guard and an active systemd override', async () => {
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/upgrade-systemd'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'fixture-')), plan = createSharedHostedGuardPlan({ nodePath: '/usr/bin/node' });
  const local = path => join(root, path.replace(/^\/+/, ''));
  for (const [path, bytes] of [[plan.guardPath, plan.guardSource], [plan.dropInPath, plan.dropIn]]) {
    mkdirSync(dirname(local(path)), { recursive: true }); writeFileSync(local(path), bytes);
  }
  mkdirSync(dirname(local(plan.lockPath)), { recursive: true });
  const lock = new DatabaseSync(local(plan.lockPath)); lock.exec('CREATE TABLE guard (id INTEGER)'); lock.close();
  let loaded = true;
  const run = args => args.includes('--property=NeedDaemonReload') ? 'no'
    : args.includes('--property=ExecStartPre') && loaded ? `{ path=/usr/bin/node ; argv[]=/usr/bin/node ${plan.guardPath} --verify-live ; }` : '';
  const service = createSharedHostedSystemdService({ run, guardRoot: root });
  assert.equal(await service.guardReady('/usr/bin/node'), true);
  loaded = false; assert.equal(await service.guardReady('/usr/bin/node'), false);
  loaded = true; writeFileSync(local(plan.guardPath), 'changed');
  assert.equal(await service.guardReady('/usr/bin/node'), false);
});

test('the invitation check uses an already active registration without changing the database', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE allocations (request TEXT NOT NULL, state TEXT NOT NULL)');
    const key = 'ssh-ed25519 ' + Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 1)]).toString('base64');
    const enrollment = { version: 1, installationId: randomUUID(), requestedBackends: ['paseo'], sshPublicKey: key };
    db.prepare('INSERT INTO allocations (request, state) VALUES (?, ?)').run(JSON.stringify(enrollment), 'active');
    assert.deepEqual(selectExistingEnrollment(db), enrollment);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM allocations').get().count, 1);
    db.exec('UPDATE allocations SET state = \'uncertain\'');
    assert.throws(() => selectExistingEnrollment(db), { code: 'SHARED_HOSTED_SERVICE_UNVERIFIED' });
  } finally { db.close(); }
});
