import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRelayBundle } from '../relay/provision.mjs';
import { createUnixRelayBundle } from '../relay/unix-provision.mjs';

const api = await import('../relay/install.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {}; throw error;
});

test('prerequisite checks are explicitly read-only and never invoke installation steps', async () => {
  const calls = [], plan = { isolation: 'unix' };
  const driver = { async preflight(value, options) { calls.push([value, options]); return { portBinding: 'verified' }; }, async createFiles() { throw Error('must not write'); } };
  assert.deepEqual(await api.checkRelayPrerequisites(plan, driver), { ready: true, installed: false, portBinding: 'verified', networkReachability: 'unverified', encryption: 'unverified', modelMessagesSent: 0 });
  assert.deepEqual(calls, [[plan, { readOnly: true }]]);
});
const key = 'ssh-ed25519 ' + Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 1)]).toString('base64');
function bundle() {
  return createRelayBundle({ enrollment: { version: 1, installationId: randomUUID(), requestedBackends: ['paseo'], sshPublicKey: key },
    hosting: 'self-hosted', publicBaseUrl: 'https://relay.example.test:24443', remotePort: 28001,
    relay: { host: 'relay.example.test', port: 22, user: 'rayneo_test', hostKey: key } });
}

test('installation plan isolates one relay and restricts its SSH account and system service', () => {
  assert.equal(typeof api.createInstallPlan, 'function');
  const plan = api.createInstallPlan(bundle(), '/usr/bin/node');
  assert.match(plan.directory, /^\/var\/lib\/rayneo-relay\/[a-f0-9-]{36}$/);
  assert.equal(plan.sshUser, 'rayneo_test'); assert.equal(plan.listenPort, 24443);
  assert.match(plan.sshdConfig, /AuthenticationMethods publickey/);
  assert.match(plan.sshdConfig, /PasswordAuthentication no/);
  assert.match(plan.sshdConfig, /AllowStreamLocalForwarding no/);
  assert.match(plan.sshdConfig, /PermitListen 127\.0\.0\.1:28001/);
  assert.match(plan.serviceUnit, /DynamicUser=yes/);
  assert.match(plan.serviceUnit, /NoNewPrivileges=yes/);
  assert.doesNotMatch(plan.serviceUnit, /AmbientCapabilities=CAP_NET_BIND_SERVICE/);
  assert.doesNotMatch(JSON.stringify(plan), /PRIVATE KEY|apiToken|passphrase/);
  assert.throws(() => api.createInstallPlan(bundle(), '/tmp/node\nExecStart=bad'));
});

test('installation stops before any changes if checks fail', async () => {
  assert.equal(typeof api.installRelay, 'function');
  const changes = [], plan = api.createInstallPlan(bundle(), '/usr/bin/node');
  const driver = { async preflight() { throw Object.assign(Error(), { code: 'RELAY_PORT_IN_USE' }); },
    async apply() { changes.push('changed'); } };
  await assert.rejects(api.installRelay(plan, driver), { code: 'RELAY_PORT_IN_USE' });
  assert.deepEqual(changes, []);
});

test('a real Linux host refuses the unsafe TCP relay before any system inspection or changes', async () => {
  const plan = api.createInstallPlan(bundle(), '/usr/bin/node');
  const driver = api.createLinuxInstallDriver({ root: '/', serverSource: '/tmp/synthetic-relay-server.mjs', platform: 'linux', uid: 0,
    run() { assert.fail('the unsafe plan must be refused before system commands'); },
    probePort() { assert.fail('the unsafe plan must be refused before binding'); } });
  await assert.rejects(driver.preflight(plan), { code: 'RELAY_ISOLATION_REQUIRED' });
});

test('a private socket installation reaches prerequisite validation without changing the host', async () => {
  const isolated = createUnixRelayBundle({ enrollment: { version: 1, installationId: randomUUID(), requestedBackends: ['paseo'], sshPublicKey: key },
    hosting: 'self-hosted', publicBaseUrl: 'https://relay.example.test:24443',
    relay: { host: 'relay.example.test', port: 2222, user: 'rayneo_test', hostKey: key } });
  const plan = api.createInstallPlan(isolated, '/usr/bin/node');
  const driver = api.createLinuxInstallDriver({ root: '/', serverSource: '/tmp/rayneo-deliberately-missing-server.mjs', platform: 'linux', uid: 0,
    run() { assert.fail('a missing source must be rejected before system commands'); } });
  await assert.rejects(driver.preflight(plan), { code: 'ENOENT' });
});

test('installation starts only after effective SSH restrictions pass and rolls back its own partial work', async () => {
  assert.equal(typeof api.installRelay, 'function');
  const events = [], plan = api.createInstallPlan(bundle(), '/usr/bin/node');
  const driver = {
    async preflight() { events.push('check'); }, async createFiles() { events.push('files'); },
    async createAccount() { events.push('account'); }, async verifySsh() { events.push('ssh-rejected'); throw Error('fixture'); },
    async startService() { events.push('started'); }, async reloadSsh() { events.push('reloaded'); },
    async rollback() { events.push('rollback'); },
  };
  await assert.rejects(api.installRelay(plan, driver), { code: 'RELAY_INSTALL_FAILED' });
  assert.deepEqual(events, ['check', 'files', 'account', 'ssh-rejected', 'rollback']);
});

test('status distinguishes an installed service from verified end-to-end encryption', async () => {
  assert.equal(typeof api.checkInstalledRelay, 'function');
  const result = await api.checkInstalledRelay(api.createInstallPlan(bundle(), '/usr/bin/node'),
    { async check() { return { installed: true, serviceActive: true, sshConfigured: true }; } });
  assert.deepEqual(result, { installed: true, serviceActive: true, sshConfigured: true, encryption: 'unverified', modelMessagesSent: 0 });
});

test('Linux installer writes only its own files, verifies SSH, and refuses to overwrite an existing installation', async () => {
  assert.equal(typeof api.createLinuxInstallDriver, 'function');
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/relay-install'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'fixture-')), source = join(root, 'relay-server.mjs');
  for (const path of ['etc/ssh/sshd_config.d', 'etc/systemd/system', 'var/lib']) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, 'etc/ssh/ssh_host_ed25519_key.pub'), key + ' fixture\n');
  writeFileSync(source, 'fixture-server');
  const plan = api.createInstallPlan(bundle(), '/usr/bin/node'), events = [];
  const run = (command, args) => {
    events.push([command, ...args]);
    if (command === 'getent') throw Object.assign(Error(), { status: 2 });
    if (command === 'sshd' && args[0] === '-T') return `allowtcpforwarding remote\nallowstreamlocalforwarding no\ngatewayports no\npermitlisten 127.0.0.1:${plan.remotePort}\npermittty no\nmaxsessions 0\nauthorizedkeysfile ${plan.directory}/authorized_keys\nauthenticationmethods publickey\npubkeyauthentication yes\npasswordauthentication no\nkbdinteractiveauthentication no\npermituserrc no\npermittunnel no\n`;
    if (command === 'systemctl' && args[0] === 'show') return 'not-found\n';
    return '';
  };
  const driver = api.createLinuxInstallDriver({ root, serverSource: source, run, probePort: async () => true, platform: 'linux', uid: 0, strictOwners: false });
  const result = await api.installRelay(plan, driver);
  assert.equal(result.installed, true); assert.equal(result.encryption, 'unverified');
  assert.equal(readFileSync(join(root, plan.directory, 'authorized_keys'), 'utf8'), plan.authorizedKey);
  assert.equal(readFileSync(join(root, plan.sshdPath), 'utf8'), plan.sshdConfig);
  assert.ok(events.some(event => event[0] === 'systemctl' && event.includes('enable')));
  assert.ok(events.some(event => event[0] === 'systemctl' && event.includes('reload')));
  await assert.rejects(api.installRelay(plan, driver), { code: 'RELAY_ALREADY_EXISTS' });
  assert.equal(readFileSync(join(root, plan.unitPath), 'utf8'), plan.serviceUnit);
});

test('a failed SSH validation removes only this invocation’s new files and account', async () => {
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/relay-install'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'rollback-')), source = join(root, 'relay-server.mjs');
  for (const path of ['etc/ssh/sshd_config.d', 'etc/systemd/system', 'var/lib']) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, 'etc/ssh/ssh_host_ed25519_key.pub'), key + '\n'); writeFileSync(source, 'fixture-server');
  const sentinel = join(root, 'etc/ssh/sshd_config.d/existing.conf'); writeFileSync(sentinel, 'existing');
  const plan = api.createInstallPlan(bundle(), '/usr/bin/node'), events = [];
  const run = (command, args) => {
    events.push([command, ...args]);
    if (command === 'getent') throw Object.assign(Error(), { status: 2 });
    if (command === 'sshd' && args[0] === '-T') return 'allowtcpforwarding yes\n';
    if (command === 'systemctl' && args[0] === 'show') return 'not-found\n';
    return '';
  };
  const driver = api.createLinuxInstallDriver({ root, serverSource: source, run, probePort: async () => true, platform: 'linux', uid: 0, strictOwners: false });
  await assert.rejects(api.installRelay(plan, driver), { code: 'RELAY_INSTALL_FAILED' });
  assert.equal(readFileSync(sentinel, 'utf8'), 'existing');
  assert.equal(existsSync(join(root, plan.directory)), false); assert.equal(existsSync(join(root, plan.sshdPath)), false);
  assert.ok(events.some(event => event[0] === 'userdel' && event[1] === plan.sshUser));
  assert.ok(!events.some(event => event[0] === 'systemctl' && event.includes('enable')));
});

test('a partially written SSH file is removed after a disk write failure', async () => {
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/relay-install'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'write-failure-')), source = join(root, 'relay-server.mjs');
  for (const path of ['etc/ssh/sshd_config.d', 'etc/systemd/system', 'var/lib']) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, 'etc/ssh/ssh_host_ed25519_key.pub'), key + '\n'); writeFileSync(source, 'fixture-server');
  const plan = api.createInstallPlan(bundle(), '/usr/bin/node'); let writes = 0;
  const run = (command, args) => {
    if (command === 'getent') throw Object.assign(Error(), { status: 2 });
    if (command === 'systemctl' && args[0] === 'show') return 'not-found\n';
    return '';
  };
  const driver = api.createLinuxInstallDriver({ root, serverSource: source, run, probePort: async () => true,
    platform: 'linux', uid: 0, strictOwners: false, writeData(fd, value) {
      if (++writes === 4) { writeFileSync(fd, 'Match User '); throw Object.assign(Error(), { code: 'ENOSPC' }); }
      writeFileSync(fd, value);
    } });
  await assert.rejects(api.installRelay(plan, driver), { code: 'RELAY_INSTALL_FAILED' });
  assert.equal(writes, 4);
  assert.equal(existsSync(join(root, plan.sshdPath)), false);
  assert.equal(existsSync(join(root, plan.directory)), false);
});
