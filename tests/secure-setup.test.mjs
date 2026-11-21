import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRelayBundle } from '../relay/provision.mjs';
import { configureSecureLink, loadSecureLink } from '../secure-link/setup.mjs';
import { tlsFixture } from './helpers/tls-fixture.mjs';

const identity = tlsFixture('secure-setup');
const hostKey = 'ssh-ed25519 ' + Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 1)]).toString('base64');
function fixture() {
  const root = mkdtempSync(join(identity.directory, 'home-')), privateDirectory = join(root, 'private');
  mkdirSync(privateDirectory);
  const installationId = randomUUID();
  writeFileSync(join(privateDirectory, 'installation.json'), JSON.stringify({ version: 1, installationId, backends: ['paseo'], phase: 'awaiting-invitation' }));
  writeFileSync(join(privateDirectory, 'daily.json'), JSON.stringify({ version: 1, port: 7468, apiToken: 'a'.repeat(64) }));
  writeFileSync(join(privateDirectory, 'local.cer'), identity.cert);
  writeFileSync(join(privateDirectory, 'relay-key.pem'), 'synthetic-private-key-not-exported');
  const enrollment = { version: 1, installationId, requestedBackends: ['paseo'], sshPublicKey: hostKey + ' disposable-test' };
  return { root, privateDirectory, enrollment,
    async generateCertificate({ directory, password }) {
      execFileSync('keytool', ['-importkeystore', '-srckeystore', join(identity.directory, 'server.p12'), '-srcstoretype', 'PKCS12',
        '-srcstorepass', identity.passphrase, '-destkeystore', join(directory, 'server.p12'), '-deststoretype', 'PKCS12', '-deststorepass', password, '-noprompt'], { stdio: 'pipe' });
      writeFileSync(join(directory, 'local.cer'), identity.cert);
    } };
}
function bundle(f, hosting = 'self-hosted') {
  return createRelayBundle({ enrollment: f.enrollment, hosting, publicBaseUrl: 'https://relay.example.test:24443', remotePort: 28001,
    relay: { host: 'relay.example.test', port: 22, user: 'rayneo_test', hostKey } });
}

for (const hosting of ['self-hosted', 'project-hosted']) {
  test(`${hosting} uses the same encrypted configuration without exporting computer credentials`, async () => {
    const f = fixture(), generated = bundle(f, hosting);
    assert.equal(generated.invitation.version, 2);
    assert.equal(generated.invitation.transport, 'tls-passthrough-v1');
    assert.equal(generated.relayConfig.listenPort, 24443);
    assert.equal(generated.relayConfig.targetPort, 28001);
    const before = readFileSync(join(f.privateDirectory, 'daily.json'));
    const result = await configureSecureLink({ ...f, invitation: generated.invitation });
    assert.equal(result.configured, true); assert.equal(result.serverChanged, false); assert.equal(result.modelMessagesSent, 0);
    assert.equal(result.encryption, 'unverified');
    assert.equal(JSON.parse(readFileSync(join(f.privateDirectory, 'secure-link-enabled.json'))).version, 1);
    assert.deepEqual(readFileSync(join(f.privateDirectory, 'daily.json')), before);
    const loaded = loadSecureLink(f.privateDirectory);
    assert.equal(loaded.hosting, hosting); assert.equal(loaded.identity.certificateSha256, identity.certificateSha256);
    assert.equal(loaded.profiles.paseo.endpoint, 'https://relay.example.test:24443/paseo');
    assert.notEqual(loaded.profiles.paseo.token, 'a'.repeat(64));
    const exported = JSON.stringify(generated);
    for (const secret of ['a'.repeat(64), loaded.profiles.paseo.token, 'synthetic-private-key-not-exported', loaded.identity.passphrase]) assert.ok(!exported.includes(secret));
    assert.ok(!JSON.stringify(result).includes(loaded.profiles.paseo.token));
    const ssh = readFileSync(join(f.privateDirectory, 'secure-link/ssh-config'), 'utf8');
    assert.match(ssh, /StrictHostKeyChecking yes/); assert.match(ssh, /IdentitiesOnly yes/);
    assert.match(generated.authorizedKey, /permitlisten="127\.0\.0\.1:28001"/);
    assert.match(generated.sshdConfig, /AllowStreamLocalForwarding no/);
    const repeated = await configureSecureLink({ ...f, invitation: generated.invitation, generateCertificate: () => assert.fail('identity must not rotate') });
    assert.equal(repeated.reused, true);
  });
}

test('fresh Codex configuration retains independent startup through secure enrollment', async () => {
  const f = fixture();
  const installation = JSON.parse(readFileSync(join(f.privateDirectory, 'installation.json'), 'utf8'));
  installation.backends.push('codex');
  writeFileSync(join(f.privateDirectory, 'installation.json'), JSON.stringify(installation));
  f.enrollment.requestedBackends.push('codex');
  mkdirSync(join(f.privateDirectory, 'shared-runtime'));
  writeFileSync(join(f.privateDirectory, 'shared-runtime/connector.json'), JSON.stringify({
    host: '127.0.0.1', port: 19469, token: 'c'.repeat(64), navigation: true, creation: true,
  }));
  await configureSecureLink({ ...f, invitation: bundle(f).invitation });
  assert.equal(loadSecureLink(f.privateDirectory).backends.codex.mode, 'independent');
});

test('invalid or mismatched invitations leave the existing connector and identity untouched', async () => {
  const f = fixture(), generated = bundle(f);
  for (const invitation of [{ ...generated.invitation, version: 1 }, { ...generated.invitation, installationId: randomUUID() },
    { ...generated.invitation, transport: 'https' }, { ...generated.invitation, publicBaseUrl: 'http://relay.example.test:24443' },
    { ...generated.invitation, remotePort: 22 }, { ...generated.invitation, relay: { ...generated.invitation.relay, user: 'bad\nuser' } }]) {
    await assert.rejects(configureSecureLink({ ...f, invitation }), { code: 'SECURE_INVITATION_INVALID' });
  }
  assert.equal(existsSync(join(f.privateDirectory, 'secure-link')), false);
});

test('private-socket invitations persist without depending on a legacy reverse port', async () => {
  const f = fixture(), old = bundle(f).invitation;
  const { remotePort, ...rest } = old;
  const remoteSocket = '/tunnel/relay.sock';
  const invitation = { ...rest, version: 3, remoteSocket };
  const result = await configureSecureLink({ ...f, invitation });
  assert.equal(result.configured, true); assert.equal(result.encryption, 'unverified');
  const loaded = loadSecureLink(f.privateDirectory);
  assert.equal(loaded.invitation.version, 3); assert.equal(loaded.invitation.remoteSocket, remoteSocket);
  assert.equal(loaded.invitation.remotePort, undefined);
});

test('an existing Paseo connection can safely add Codex without changing its identity or credentials', async () => {
  const f = fixture();
  await configureSecureLink({ ...f, invitation: bundle(f).invitation });
  const before = loadSecureLink(f.privateDirectory);
  writeFileSync(join(f.privateDirectory, 'local-test.json'), JSON.stringify({ password: 'b'.repeat(64) }));
  const { addCodexBackend } = await import('../secure-link/setup.mjs');
  await addCodexBackend({ privateDirectory: f.privateDirectory, executable: join(f.root, 'codex.exe'),
    prepareDesktopAdapter: async path => writeFileSync(path, 'test-adapter') });
  const after = loadSecureLink(f.privateDirectory);
  assert.deepEqual(after.profiles.paseo, before.profiles.paseo);
  assert.equal(after.certificateSha256, before.certificateSha256);
  assert.equal(after.profiles.codex.endpoint, before.invitation.publicBaseUrl + '/codex');
  assert.notEqual(after.profiles.codex.token, after.profiles.paseo.token);
  assert.equal(after.backends.codex.port, 19469);
  assert.deepEqual(await addCodexBackend({ privateDirectory: f.privateDirectory }), { added: false });
});

test('adds detected Codex independently to a Paseo-only connection while Codex is open', async () => {
  const f = fixture();
  await configureSecureLink({ ...f, invitation: bundle(f).invitation });
  writeFileSync(join(f.privateDirectory, 'local-test.json'), JSON.stringify({ password: 'b'.repeat(64) }));
  const { addCodexBackend } = await import('../secure-link/setup.mjs');
  const { createLocalConnectionStarter } = await import('../secure-link/local-backends.mjs');
  await addCodexBackend({ privateDirectory: f.privateDirectory, executable: join(f.root, 'codex.exe'), independentCodex: true,
    prepareDesktopAdapter: async () => assert.fail('must not prepare a desktop adapter') });
  const configuration = loadSecureLink(f.privateDirectory);
  assert.equal(configuration.backends.codex.mode, 'independent');
  const { EventEmitter } = await import('node:events');
  const starter = createLocalConnectionStarter({ codeRoot: f.root, privateDirectory: f.privateDirectory,
    probeLocal: async ({ url }) => url.includes(':7468/') ? 'ready' : 'unreachable',
    desktop: async () => ({ installed: true, desktopRunning: true, sharedReady: false }),
    spawnChild: () => { const child = new EventEmitter(); child.unref = () => {}; queueMicrotask(() => child.emit('spawn')); return child; } });
  const result = await starter.start(configuration);
  assert.deepEqual(result.started, ['codex']); assert.deepEqual(result.blocked, []);
});

test('dashboard addition starts Codex independently without requesting a computer restart', async () => {
  const f = fixture(); await configureSecureLink({ ...f, invitation: bundle(f).invitation });
  writeFileSync(join(f.privateDirectory, 'local-test.json'), JSON.stringify({ password: 'b'.repeat(64) }));
  const { createSecureLinkActions } = await import('../secure-link/actions.mjs');
  const { EventEmitter } = await import('node:events'); let started;
  const actions = createSecureLinkActions({ codeRoot: f.root, privateDirectory: f.privateDirectory, stateDirectory: f.root,
    desktop: () => ({ installed: true, desktopRunning: true, native: join(f.root, 'codex.exe') }),
    prepareDesktopAdapter: () => assert.fail('must not compile an adapter'),
    startLocalConnections: async config => { started = config; return { started: ['codex'], blocked: [] }; },
    spawnChild: () => { const child = new EventEmitter(); child.unref = () => {}; queueMicrotask(() => child.emit('spawn')); return child; },
  });
  const result = await actions.connect({ enableCodex: true });
  assert.equal(started.backends.codex.mode, 'independent'); assert.equal(result.restartRequired, undefined);
  assert.deepEqual(result.blocked, []); assert.equal(result.existingDesktopStopped, false);
});

test('failed Codex preparation preserves the original Paseo connection', async () => {
  const f = fixture();
  await configureSecureLink({ ...f, invitation: bundle(f).invitation });
  const before = loadSecureLink(f.privateDirectory);
  writeFileSync(join(f.privateDirectory, 'local-test.json'), JSON.stringify({ password: 'b'.repeat(64) }));
  const { addCodexBackend } = await import('../secure-link/setup.mjs');
  await assert.rejects(addCodexBackend({ privateDirectory: f.privateDirectory, executable: join(f.root, 'codex.exe'),
    prepareDesktopAdapter: async () => { throw Error('compiler unavailable'); } }));
  assert.deepEqual(loadSecureLink(f.privateDirectory).profiles.paseo, before.profiles.paseo);
  assert.equal(existsSync(join(f.privateDirectory, 'shared-runtime')), false);
});

test('an interrupted certificate preparation can be retried without publishing an incomplete configuration', async () => {
  const f = fixture(), generated = bundle(f);
  await assert.rejects(configureSecureLink({ ...f, invitation: generated.invitation,
    generateCertificate: () => { throw Error('synthetic failure'); } }), /synthetic failure/);
  assert.equal(existsSync(join(f.privateDirectory, 'secure-link')), false);
  assert.equal((await configureSecureLink({ ...f, invitation: generated.invitation })).configured, true);
});

test('operator input cannot turn the relay into an arbitrary TCP proxy or inject SSH configuration', () => {
  const f = fixture(), safe = { enrollment: f.enrollment, hosting: 'self-hosted', publicBaseUrl: 'https://relay.example.test:24443', remotePort: 28001,
    relay: { host: 'relay.example.test', port: 22, user: 'rayneo_test', hostKey } };
  for (const changes of [{ publicBaseUrl: 'https://relay.example.test:24443/private' }, { publicBaseUrl: 'https://relay.example.test:0' }, { hosting: 'other' }, { remotePort: 24443 },
    { relay: { ...safe.relay, host: 'relay.example.test\nProxyCommand bad' } }, { enrollment: { ...f.enrollment, sshPublicKey: hostKey + '\ncommand="bad"' } }]) {
    assert.throws(() => createRelayBundle({ ...safe, ...changes }), { code: 'SECURE_INVITATION_INVALID' });
  }
});

test('the standard HTTPS port remains usable without an explicit :443 in the invitation', () => {
  const f = fixture();
  const generated = createRelayBundle({ enrollment: f.enrollment, hosting: 'self-hosted', publicBaseUrl: 'https://relay.example.test', remotePort: 28001,
    relay: { host: 'relay.example.test', port: 22, user: 'rayneo_test', hostKey } });
  assert.equal(generated.relayConfig.listenPort, 443);
});

test('Windows prepares a new public-host desktop identity without changing certificate stores', { skip: process.platform !== 'win32' }, async () => {
  const f = fixture();
  const generated = bundle(f);
  const result = await configureSecureLink({ privateDirectory: f.privateDirectory, invitation: generated.invitation });
  const loaded = loadSecureLink(f.privateDirectory);
  assert.equal(result.certificateSha256, loaded.identity.certificateSha256);
  assert.notEqual(result.certificateSha256, identity.certificateSha256);
});

test('personal IPv4 relay config uses an IP certificate and retains strict SSH identity', { skip: process.platform !== 'win32' }, async () => {
  const f = fixture();
  const { createUnixRelayBundle } = await import('../relay/unix-provision.mjs');
  const options = { enrollment: f.enrollment, hosting: 'self-hosted', publicBaseUrl: 'https://203.0.113.10:24443',
    relay: { host: '203.0.113.10', port: 2222, user: 'rayneo_test', hostKey } };
  const generated = createUnixRelayBundle(options);
  await configureSecureLink({ privateDirectory: f.privateDirectory, invitation: generated.invitation });
  const loaded = loadSecureLink(f.privateDirectory);
  const { X509Certificate } = await import('node:crypto');
  assert.equal(new X509Certificate(loaded.identity.cert).checkIP('203.0.113.10'), '203.0.113.10');
  assert.equal(new X509Certificate(loaded.identity.cert).checkIP('203.0.113.11'), undefined);
  const ssh = readFileSync(join(f.privateDirectory, 'secure-link/ssh-config'), 'utf8');
  assert.match(ssh, /StrictHostKeyChecking yes/);
  assert.match(readFileSync(join(f.privateDirectory, 'secure-link/known-hosts'), 'utf8'), /ssh-ed25519/);
  assert.throws(() => createUnixRelayBundle({ ...options, hosting: 'project-hosted' }), { code: 'SECURE_INVITATION_INVALID' });
  await assert.rejects(configureSecureLink({ privateDirectory: f.privateDirectory, invitation: { ...generated.invitation,
    publicBaseUrl: 'https://203.0.113.11:24443' } }), { code: 'SECURE_CONFIGURATION_EXISTS' });
});

test('personal IPv4 setup rejects a certificate for a different address', async () => {
  const f = fixture();
  const { createUnixRelayBundle } = await import('../relay/unix-provision.mjs');
  const { invitation } = createUnixRelayBundle({ enrollment: f.enrollment, hosting: 'self-hosted',
    publicBaseUrl: 'https://203.0.113.10:24443', relay: { host: '203.0.113.10', port: 2222, user: 'rayneo_test', hostKey } });
  await assert.rejects(configureSecureLink({ ...f, invitation }), { code: 'SECURE_IDENTITY_INVALID' });
  assert.equal(existsSync(join(f.privateDirectory, 'secure-link')), false);
});

test('changing a personal IPv4 identity preserves old configuration and requires a fresh pairing', { skip: process.platform !== 'win32' }, async () => {
  const f = fixture(), stateDirectory = join(f.root, 'state');
  const { createUnixRelayBundle } = await import('../relay/unix-provision.mjs');
  const { changeSelfHostedIp } = await import('../secure-link/setup.mjs');
  const build = ip => createUnixRelayBundle({ enrollment: f.enrollment, hosting: 'self-hosted', publicBaseUrl: `https://${ip}:24443`,
    relay: { host: ip, port: 2222, user: 'rayneo_test', hostKey } }).invitation;
  await configureSecureLink({ privateDirectory: f.privateDirectory, invitation: build('203.0.113.10') });
  const before = loadSecureLink(f.privateDirectory);
  const result = await changeSelfHostedIp({ privateDirectory: f.privateDirectory, stateDirectory, invitation: build('203.0.113.11') });
  const after = loadSecureLink(f.privateDirectory);
  assert.equal(result.pairingRequired, true);
  assert.equal(result.encryption, 'unverified');
  assert.notEqual(after.certificateSha256, before.certificateSha256);
  assert.notEqual(after.profiles.paseo.token, before.profiles.paseo.token);
  assert.equal(after.profiles.paseo.endpoint, 'https://203.0.113.11:24443/paseo');
  assert.equal(readFileSync(join(result.backupDirectory, 'config.json'), 'utf8').includes(before.certificateSha256), true);
  assert.equal(existsSync(join(after.directory, 'pairing', 'ticket.json')), false);
  assert.match(readFileSync(join(after.directory, 'ssh-config'), 'utf8'), /StrictHostKeyChecking yes/);
});

test('IP update refuses a live service and changed SSH identity without modifying old configuration', { skip: process.platform !== 'win32' }, async () => {
  const f = fixture(), stateDirectory = join(f.root, 'state');
  const { createUnixRelayBundle } = await import('../relay/unix-provision.mjs');
  const { changeSelfHostedIp } = await import('../secure-link/setup.mjs');
  const { acquireSupervisorLock } = await import('../bridge/supervisor.mjs');
  const build = ip => createUnixRelayBundle({ enrollment: f.enrollment, hosting: 'self-hosted', publicBaseUrl: `https://${ip}:24443`,
    relay: { host: ip, port: 2222, user: 'rayneo_test', hostKey } }).invitation;
  await configureSecureLink({ privateDirectory: f.privateDirectory, invitation: build('203.0.113.10') });
  const before = readFileSync(join(f.privateDirectory, 'secure-link/config.json'));
  const release = acquireSupervisorLock(join(stateDirectory, 'secure-link/supervisor.lock'));
  try { await assert.rejects(changeSelfHostedIp({ privateDirectory: f.privateDirectory, stateDirectory, invitation: build('203.0.113.11') }), { code: 'SECURE_SERVICE_RUNNING' }); }
  finally { release(); }
  const changed = build('203.0.113.11'); changed.relay.port = 2223;
  await assert.rejects(changeSelfHostedIp({ privateDirectory: f.privateDirectory, stateDirectory, invitation: changed }), { code: 'SECURE_IP_UPDATE_INVALID' });
  await assert.rejects(changeSelfHostedIp({ privateDirectory: f.privateDirectory, stateDirectory, invitation: build('203.0.113.11'),
    generateCertificate() { throw Error('test failure'); } }), /test failure/);
  assert.deepEqual(readFileSync(join(f.privateDirectory, 'secure-link/config.json')), before);
});

test('the IP update command changes the personal IPv4 and preserves a recovery copy', { skip: process.platform !== 'win32' }, async () => {
  const f = fixture(), stateDirectory = join(f.root, 'state');
  const { createUnixRelayBundle } = await import('../relay/unix-provision.mjs');
  const { invitation } = createUnixRelayBundle({ enrollment: f.enrollment, hosting: 'self-hosted', publicBaseUrl: 'https://203.0.113.10:24443',
    relay: { host: '203.0.113.10', port: 2222, user: 'rayneo_test', hostKey } });
  await configureSecureLink({ privateDirectory: f.privateDirectory, invitation });
  const output = execFileSync(process.execPath, ['secure-link/change-ip.mjs', '--ip', '203.0.113.11',
    '--private-directory', f.privateDirectory, '--state-directory', stateDirectory], { encoding: 'utf8' });
  const result = JSON.parse(output);
  assert.equal(result.pairingRequired, true);
  assert.equal(existsSync(join(result.backupDirectory, 'config.json')), true);
  assert.equal(loadSecureLink(f.privateDirectory).invitation.publicBaseUrl, 'https://203.0.113.11:24443');
});

test('interrupted IP update can restore its saved identity without overwriting an active configuration', { skip: process.platform !== 'win32' }, async () => {
  const f = fixture(), stateDirectory = join(f.root, 'state');
  const { createUnixRelayBundle } = await import('../relay/unix-provision.mjs');
  const { restoreInterruptedSelfHostedIp } = await import('../secure-link/setup.mjs');
  const { invitation } = createUnixRelayBundle({ enrollment: f.enrollment, hosting: 'self-hosted', publicBaseUrl: 'https://203.0.113.10:24443',
    relay: { host: '203.0.113.10', port: 2222, user: 'rayneo_test', hostKey } });
  await configureSecureLink({ privateDirectory: f.privateDirectory, invitation });
  const target = join(f.privateDirectory, 'secure-link'), backupDirectory = join(f.privateDirectory, '.secure-previous-' + 'b'.repeat(64));
  assert.throws(() => restoreInterruptedSelfHostedIp({ privateDirectory: f.privateDirectory, stateDirectory, backupDirectory }), { code: 'SECURE_IP_RECOVERY_INVALID' });
  renameSync(target, backupDirectory);
  const result = restoreInterruptedSelfHostedIp({ privateDirectory: f.privateDirectory, stateDirectory, backupDirectory });
  assert.equal(result.restored, true);
  assert.equal(loadSecureLink(f.privateDirectory).invitation.publicBaseUrl, invitation.publicBaseUrl);
});
