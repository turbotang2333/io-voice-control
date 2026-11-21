import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, existsSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

const api = await import('../relay/unix-provision.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {}; throw error;
});
const installer = await import('../relay/install.mjs');
const key = 'ssh-ed25519 ' + Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 1)]).toString('base64');

for (const accountState of ['present', 'unknown', 'absent']) test(`account creation failure handles ${accountState} account state safely`, async () => {
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/relay-account-failure'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'fixture-')), source = join(root, 'relay-server.mjs');
  for (const path of ['etc/ssh', 'etc/systemd/system', 'var/lib']) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, 'etc/ssh/ssh_host_ed25519_key.pub'), key + '\n'); writeFileSync(source, 'fixture-server');
  const value = api.createUnixRelayBundle({ enrollment: { version: 1, installationId: randomUUID(), requestedBackends: ['paseo'], sshPublicKey: key },
    hosting: 'self-hosted', publicBaseUrl: 'https://relay.example.test:24443', relay: { host: 'relay.example.test', port: 2222, user: 'rayneo_test', hostKey: key } });
  const plan = installer.createInstallPlan(value, '/usr/bin/node'); let attempted = false, deleted = false;
  const run = (command, args) => {
    if (command === 'getent') {
      if (attempted && accountState === 'present') return 'rayneo_test:x:1001:1001::/nonexistent:/usr/sbin/nologin\n';
      throw Object.assign(Error(), { status: attempted && accountState === 'unknown' ? 1 : 2 });
    }
    if (command === 'useradd') { attempted = true; throw Object.assign(Error(), { status: 1 }); }
    if (command === 'userdel') { deleted = true; return ''; }
    if (command === 'systemctl' && args[0] === 'show') return 'not-found\n';
    return '';
  };
  const driver = installer.createLinuxInstallDriver({ root, serverSource: source, run, platform: 'linux', uid: 0, strictOwners: false, probePort: async () => true });
  await assert.rejects(installer.installRelay(plan, driver), { code: accountState === 'absent' ? 'RELAY_INSTALL_FAILED' : 'RELAY_INSTALL_ROLLBACK_FAILED' });
  assert.equal(deleted, false);
  assert.equal(existsSync(join(root, plan.directory, 'relay.json')), accountState !== 'absent');
  assert.equal(existsSync(join(root, plan.unitPath)), accountState !== 'absent');
});

test('new install files remain readable by their dedicated service under a restrictive umask', { skip: process.platform === 'win32' }, async () => {
  const root = mkdtempSync('/tmp/rayneo-modes-'), source = join(root, 'relay-server.mjs');
  for (const path of ['etc/ssh', 'etc/systemd/system', 'var/lib']) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(source, 'fixture-server');
  const value = api.createUnixRelayBundle({ enrollment: { version: 1, installationId: randomUUID(), requestedBackends: ['paseo'], sshPublicKey: key },
    hosting: 'self-hosted', publicBaseUrl: 'https://relay.example.test:24443', relay: { host: 'relay.example.test', port: 2222, user: 'rayneo_test', hostKey: key } });
  const plan = installer.createInstallPlan(value, '/usr/bin/node');
  const driver = installer.createLinuxInstallDriver({ root, serverSource: source, platform: 'linux', uid: 0, strictOwners: false });
  const previous = process.umask(0o077);
  try { await driver.createFiles(plan); } finally { process.umask(previous); }
  assert.equal(statSync(join(root, plan.directory)).mode & 0o777, 0o755);
  assert.equal(statSync(join(root, plan.directory, 'relay-server.mjs')).mode & 0o777, 0o644);
});

for (const stopFails of [false, true]) test(`rollback ${stopFails ? 'preserves files when a service cannot be stopped' : 'removes its socket after services stop'}`, { skip: process.platform === 'win32' }, async () => {
  const root = mkdtempSync('/tmp/rayneo-rollback-'), source = join(root, 'relay-server.mjs'), temporarySocket = join(root, 'initial.sock');
  for (const path of ['etc/ssh', 'etc/systemd/system', 'var/lib']) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, 'etc/ssh/ssh_host_ed25519_key.pub'), key + '\n'); writeFileSync(source, 'fixture-server');
  const value = api.createUnixRelayBundle({ enrollment: { version: 1, installationId: randomUUID(), requestedBackends: ['paseo'], sshPublicKey: key },
    hosting: 'self-hosted', publicBaseUrl: 'https://relay.example.test:24443', relay: { host: 'relay.example.test', port: 2222, user: 'rayneo_test', hostKey: key } });
  const plan = installer.createInstallPlan(value, '/usr/bin/node'), socket = join(root, plan.directory, 'tunnel/relay.sock');
  const server = createServer(); await new Promise((resolve, reject) => server.once('error', reject).listen(temporarySocket, resolve));
  const run = (command, args) => {
    if (command === 'getent') throw Object.assign(Error(), { status: 2 });
    if (command === 'id') return '1001\n';
    if (command === 'sshd' && args[0] === '-T') return `allowtcpforwarding remote\npermitlisten none\nallowstreamlocalforwarding remote\nstreamlocalbindunlink yes\nstreamlocalbindmask 0177\nchrootdirectory ${plan.directory}\npermittty no\nmaxsessions 0\nauthorizedkeysfile ${plan.directory}/authorized_keys\nauthenticationmethods publickey\npubkeyauthentication yes\npasswordauthentication no\nkbdinteractiveauthentication no\npermituserrc no\npermittunnel no\n`;
    if (command === 'systemctl' && args[0] === 'show') return args.includes('--property=ActiveState') ? 'inactive\n' : 'not-found\n';
    if (command === 'systemctl' && args[0] === 'enable' && args.includes(plan.sshUnitName)) renameSync(temporarySocket, socket);
    if (command === 'systemctl' && args[0] === 'enable' && args.includes(plan.unitName)) throw Error('relay start failed');
    if (stopFails && command === 'systemctl' && args[0] === 'disable') throw Error('service still running');
    if (stopFails && command === 'userdel') throw Error('must preserve account');
    return '';
  };
  const driver = installer.createLinuxInstallDriver({ root, serverSource: source, run, platform: 'linux', uid: 0, strictOwners: false, probePort: async () => true, chownPath: () => {} });
  try {
    await assert.rejects(installer.installRelay(plan, driver), { code: stopFails ? 'RELAY_INSTALL_ROLLBACK_FAILED' : 'RELAY_INSTALL_FAILED' });
    assert.equal(existsSync(join(root, plan.directory)), stopFails);
    if (stopFails) { assert.ok(existsSync(socket)); assert.ok(existsSync(join(root, plan.sshUnitPath))); }
  }
  finally { await new Promise(resolve => server.close(resolve)); }
});

test('isolated installation uses its own SSH service and gives the socket directory to its dedicated account', async () => {
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/relay-unix-install'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'fixture-')), source = join(root, 'relay-server.mjs');
  for (const path of ['etc/ssh', 'etc/systemd/system', 'var/lib']) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, 'etc/ssh/ssh_host_ed25519_key.pub'), key + '\n'); writeFileSync(source, 'fixture-server');
  const installationId = randomUUID();
  const value = api.createUnixRelayBundle({ enrollment: { version: 1, installationId, requestedBackends: ['paseo'], sshPublicKey: key },
    hosting: 'self-hosted', publicBaseUrl: 'https://relay.example.test:24443',
    relay: { host: 'relay.example.test', port: 2222, user: 'rayneo_test', hostKey: key } });
  const plan = installer.createInstallPlan(value, '/usr/bin/node'), events = [], checks = [], owners = []; let loadedUnitChanged = false, needsReload = false, portOccupied = false, ssUnavailable = false, boundCheckUnavailable = false;
  const run = (command, args) => {
    events.push([command, ...args]);
    if (command === 'getent') throw Object.assign(Error(), { status: 2 });
    if (command === 'id') return '1001\n';
    if (command === 'ss') { if (ssUnavailable || boundCheckUnavailable && args.includes('-tBn')) throw Error('unsupported ss'); return portOccupied ? 'occupied\n' : ''; }
    if (command === 'sshd' && args[0] === '-T') return `allowtcpforwarding remote\npermitlisten none\nallowstreamlocalforwarding remote\nstreamlocalbindunlink yes\nstreamlocalbindmask 0177\nchrootdirectory ${plan.directory}\npermittty no\nmaxsessions 0\nauthorizedkeysfile ${plan.directory}/authorized_keys\nauthenticationmethods publickey\npubkeyauthentication yes\npasswordauthentication no\nkbdinteractiveauthentication no\npermituserrc no\npermittunnel no\n`;
    if (command === 'systemctl' && args[0] === 'show') {
      if (args.includes('--property=FragmentPath')) return loadedUnitChanged ? '/unexpected/service\n' : (args.includes(plan.sshUnitName) ? plan.sshUnitPath : plan.unitPath) + '\n';
      if (args.includes('--property=NeedDaemonReload')) return needsReload ? 'yes\n' : 'no\n';
      return 'not-found\n';
    }
    return '';
  };
  const driver = installer.createLinuxInstallDriver({ root, serverSource: source, run, platform: 'linux', uid: 0, strictOwners: false,
    probePort: async port => { checks.push(port); return true; }, chownPath: (path, uid, gid) => owners.push({ path, uid, gid }) });
  const dry = await installer.checkRelayPrerequisites(plan, driver);
  assert.equal(dry.networkReachability, 'unverified'); assert.deepEqual(checks, []);
  assert.equal(events.filter(event => event[0] === 'ss').length, 4);
  assert.equal(existsSync(join(root, plan.directory)), false);
  portOccupied = true; await assert.rejects(installer.checkRelayPrerequisites(plan, driver), { code: 'RELAY_PORT_IN_USE' }); portOccupied = false;
  ssUnavailable = true; await assert.rejects(installer.checkRelayPrerequisites(plan, driver), { code: 'RELAY_PORT_CHECK_UNAVAILABLE' }); ssUnavailable = false;
  boundCheckUnavailable = true; const partial = await installer.checkRelayPrerequisites(plan, driver); boundCheckUnavailable = false;
  assert.equal(partial.ready, false); assert.equal(partial.portBinding, 'unverified');
  assert.deepEqual(checks, []); assert.equal(existsSync(join(root, plan.directory)), false);
  if (process.platform !== 'win32') {
    const unit = join(root, plan.unitPath); symlinkSync('missing.service', unit);
    await assert.rejects(installer.checkRelayPrerequisites(plan, driver), { code: 'RELAY_ALREADY_EXISTS' });
    unlinkSync(unit);
  }
  const result = await installer.installRelay(plan, driver);
  assert.equal(result.installed, true); assert.deepEqual(checks.sort((a, b) => a - b), [2222, 24443]);
  assert.deepEqual(owners, [{ path: join(root, plan.directory, 'tunnel'), uid: 1001, gid: 1001 }]);
  assert.equal(readFileSync(join(root, plan.sshdPath), 'utf8'), plan.sshdConfig);
  assert.ok(events.some(event => event[0] === 'systemctl' && event.includes(plan.sshUnitName) && event.includes('enable')));
  assert.ok(!events.some(event => event[0] === 'systemctl' && event.includes('reload')));
  assert.deepEqual(await installer.checkInstalledRelay(plan, driver),
    { installed: true, serviceActive: true, sshConfigured: true, encryption: 'unverified', modelMessagesSent: 0 });
  loadedUnitChanged = true;
  assert.equal((await installer.checkInstalledRelay(plan, driver)).serviceActive, false);
  loadedUnitChanged = false;
  needsReload = true;
  assert.equal((await installer.checkInstalledRelay(plan, driver)).serviceActive, false);
  needsReload = false;
  if (process.platform !== 'win32') {
    const config = join(root, plan.directory, 'relay.json');
    renameSync(config, config + '.other'); symlinkSync('relay.json.other', config);
    assert.equal((await installer.checkInstalledRelay(plan, driver)).installed, false);
    unlinkSync(config); renameSync(config + '.other', config);
  }
  writeFileSync(join(root, plan.directory, 'relay.json'), '{"tampered":true}');
  assert.equal((await installer.checkInstalledRelay(plan, driver)).installed, false);
});
test('isolated relay material creates a per-computer socket and a separate restricted SSH configuration', () => {
  assert.equal(typeof api.createUnixRelayBundle, 'function');
  const installationId = randomUUID();
  const value = api.createUnixRelayBundle({ enrollment: { version: 1, installationId, requestedBackends: ['paseo'], sshPublicKey: key },
    hosting: 'self-hosted', publicBaseUrl: 'https://relay.example.test:24443',
    relay: { host: 'relay.example.test', port: 2222, user: 'rayneo_test', hostKey: key } });
  const socket = `/var/lib/rayneo-relay/${installationId}/tunnel/relay.sock`;
  assert.equal(value.invitation.version, 3); assert.equal(value.invitation.remoteSocket, '/tunnel/relay.sock');
  assert.equal(value.relayConfig.targetSocket, socket); assert.equal(value.relayConfig.targetPort, undefined);
  assert.match(value.sshdConfig, /^Port 2222$/m);
  assert.match(value.sshdConfig, /^AllowTcpForwarding remote$/m);
  assert.match(value.sshdConfig, /^PermitListen none$/m);
  assert.match(value.sshdConfig, /^AllowStreamLocalForwarding remote$/m);
  assert.match(value.sshdConfig, /^MaxSessions 0$/m);
  assert.match(value.sshdConfig, /^StreamLocalBindUnlink yes$/m);
  assert.ok(value.sshdConfig.includes(`ChrootDirectory /var/lib/rayneo-relay/${installationId}\n`));
  assert.match(value.authorizedKey, /^restrict,port-forwarding ssh-ed25519 /);
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE KEY|apiToken|passphrase/);
  const plan = installer.createInstallPlan(value, '/usr/bin/node');
  assert.equal(plan.isolation, 'unix');
  assert.match(plan.serviceUnit, /^User=rayneo_test$/m);
  assert.match(plan.serviceUnit, /^Group=rayneo_test$/m);
  assert.doesNotMatch(plan.serviceUnit, /DynamicUser=yes/);
  assert.ok(plan.sshUnitPath.endsWith(`rayneo-ssh-${installationId}.service`));
  assert.ok(plan.sshUnit.includes(`${plan.directory}/sshd_config`));
});
