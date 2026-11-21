import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createSecureLinkActions } from '../secure-link/actions.mjs';
import { configureSecureLink } from '../secure-link/setup.mjs';
import { tlsFixture } from './helpers/tls-fixture.mjs';

test('an unconfigured secure entry reports no encryption and refuses to pair or launch a tunnel', async () => {
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/secure-entry'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'fixture-')), privateDirectory = join(root, 'private'); mkdirSync(privateDirectory);
  const actions = createSecureLinkActions({ codeRoot: resolve('.'), privateDirectory, stateDirectory: join(root, 'state') });
  const status = await actions.status();
  assert.equal(status.encryption, 'unverified'); assert.equal(status.pairingReady, false); assert.equal(status.phase, 'unconfigured');
  await assert.rejects(actions.pair());
  assert.throws(() => actions.connect());
  assert.throws(() => execFileSync(process.execPath, ['secure-link/run.mjs', 'check', '--private-directory', privateDirectory,
    '--state-directory', join(root, 'state')], { stdio: 'pipe' }), error => error.status === 1 && /SECURE_CONFIGURATION_MISSING/.test(error.stderr.toString()));
});

test('a damaged secure directory is a configuration error, never an unconfigured fallback', async () => {
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/secure-entry'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'damaged-')), privateDirectory = join(root, 'private');
  mkdirSync(join(privateDirectory, 'secure-link'), { recursive: true });
  const actions = createSecureLinkActions({ codeRoot: resolve('.'), privateDirectory, stateDirectory: join(root, 'state') });
  const result = await actions.status();
  assert.equal(result.phase, 'configuration_error'); assert.equal(result.encryption, 'unverified');
  assert.equal(result.pairingReady, false);
});

test('a broken secure configuration link cannot trigger a legacy fallback', async () => {
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/secure-entry'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'link-')), privateDirectory = join(root, 'private'); mkdirSync(privateDirectory);
  symlinkSync(join(root, 'missing-target'), join(privateDirectory, 'secure-link'), process.platform === 'win32' ? 'junction' : 'dir');
  const actions = createSecureLinkActions({ codeRoot: resolve('.'), privateDirectory, stateDirectory: join(root, 'state') });
  assert.equal((await actions.status()).phase, 'configuration_error');
});

test('a missing previously configured secure directory is reported as damage, not an invitation to use legacy transport', async () => {
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/secure-entry'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'missing-secure-')), privateDirectory = join(root, 'private'); mkdirSync(privateDirectory);
  writeFileSync(join(privateDirectory, 'secure-link-enabled.json'), '{"version":1}');
  const actions = createSecureLinkActions({ codeRoot: resolve('.'), privateDirectory, stateDirectory: join(root, 'state') });
  const status = await actions.status();
  assert.equal(status.phase, 'configuration_error'); assert.equal(status.encryption, 'unverified');
});

test('secure connect starts local connectors before its encrypted transport and returns only public launch results', async () => {
  const identity = tlsFixture('secure-entry-connect'), privateDirectory = join(identity.directory, 'private'); mkdirSync(privateDirectory);
  const installationId = randomUUID();
  writeFileSync(join(privateDirectory, 'installation.json'), JSON.stringify({ version: 1, installationId, backends: ['paseo'], phase: 'awaiting-invitation' }));
  writeFileSync(join(privateDirectory, 'daily.json'), JSON.stringify({ version: 1, port: 7468, apiToken: 'a'.repeat(64) }));
  writeFileSync(join(privateDirectory, 'local-test.json'), JSON.stringify({ password: 'b'.repeat(64) }));
  writeFileSync(join(privateDirectory, 'local.cer'), identity.cert);
  const hostKey = 'ssh-ed25519 ' + Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 1)]).toString('base64');
  await configureSecureLink({ privateDirectory,
    invitation: { version: 2, transport: 'tls-passthrough-v1', hosting: 'self-hosted', installationId,
      publicBaseUrl: 'https://relay.example.test:24443', remotePort: 28001, backends: ['paseo'],
      relay: { host: 'relay.example.test', port: 22, user: 'rayneo_test', hostKey } },
    generateCertificate({ directory, password }) {
      execFileSync('keytool', ['-importkeystore', '-srckeystore', join(identity.directory, 'server.p12'), '-srcstoretype', 'PKCS12',
        '-srcstorepass', identity.passphrase, '-destkeystore', join(directory, 'server.p12'), '-deststoretype', 'PKCS12', '-deststorepass', password, '-noprompt'], { stdio: 'pipe' });
      writeFileSync(join(directory, 'local.cer'), identity.cert);
    } });
  const order = [], children = [];
  const actions = createSecureLinkActions({ codeRoot: resolve('.'), privateDirectory, stateDirectory: join(identity.directory, 'state'),
    desktop: () => ({ installed: true, native: join(identity.directory, 'codex.exe') }),
    prepareDesktopAdapter: async output => writeFileSync(output, 'test-adapter'),
    async startLocalConnections(config) {
      assert.equal(config.backends.paseo.upstreamToken, 'a'.repeat(64));
      if (order.includes('migration')) assert.equal(config.backends.codex.mode, 'independent');
      order.push('local'); await new Promise(accept => setImmediate(accept));
      return { started: ['paseo'], blocked: [], existingDesktopStopped: false, modelMessagesSent: 0 };
    },
    spawnChild(command, args, options) {
      order.push('transport'); assert.ok(args.includes('start')); assert.ok(args.includes(privateDirectory));
      assert.equal(options.windowsHide, true); assert.deepEqual(options.stdio, ['ignore', 'ignore', 'ignore', 'ipc']);
      const child = new EventEmitter(); child.unref = () => {}; child.kill = () => queueMicrotask(() => child.emit('exit', 0));
      child.send = (message, callback) => { assert.equal(message, 'stop-secure-link'); callback(); queueMicrotask(() => child.emit('exit', 0)); }; children.push(child);
      queueMicrotask(() => child.emit('spawn')); return child;
    } });
  const [first, simultaneous] = await Promise.all([actions.connect(), actions.connect()]);
  assert.deepEqual(order, ['local', 'transport']); assert.deepEqual(first, simultaneous);
  assert.deepEqual(first.localConnectionsStarted, ['paseo']); assert.deepEqual(first.blocked, []);
  assert.equal(first.modelMessagesSent, 0); assert.equal(first.existingDesktopStopped, false);
  assert.ok(!JSON.stringify(first).includes('a'.repeat(64)));
  assert.ok(!JSON.stringify(first).includes(identity.passphrase));
  await actions.connect(); assert.equal(children.length, 1);
  children[0].emit('exit', 1);
  await actions.connect(); assert.equal(children.length, 2);
  order.push('migration');
  const migrated = await actions.connect({ enableCodex: true });
  assert.ok(migrated.backends.includes('codex'));
  assert.equal(migrated.restartRequired, undefined);
  assert.equal(children.length, 2);
  await assert.rejects(actions.changeIp({ ip: '203.0.113.11' }), { code: 'SECURE_IP_UPDATE_INVALID' });
});
