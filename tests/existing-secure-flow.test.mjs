import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tlsFixture } from './helpers/tls-fixture.mjs';
import { prepareExistingSecureHome } from '../distribution/existing-secure-home.mjs';
import { createRoutedSecureActions } from '../distribution/secure-action-routing.mjs';
import { createSecureDashboardActions } from '../distribution/secure-actions.mjs';
import { configureSecureLink, loadSecureLink } from '../secure-link/setup.mjs';

test('an existing installation enrolls and configures its own protected secure identity without replacing old files', async () => {
  const identity = tlsFixture('existing-secure-flow'), root = mkdtempSync(join(identity.directory, 'home-'));
  mkdirSync(join(root, 'shared-runtime'));
  const daily = JSON.stringify({ port: 7468, apiToken: 'a'.repeat(64), oldSetting: 'preserved' });
  const codex = JSON.stringify({ port: 19469, token: 'b'.repeat(64), oldSetting: 'preserved' });
  writeFileSync(join(root, 'daily.json'), daily); writeFileSync(join(root, 'shared-runtime/connector.json'), codex);
  writeFileSync(join(root, 'local.cer'), identity.cert);
  const key = 'ssh-ed25519 ' + Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 1)]).toString('base64');
  const prepareKey = path => { writeFileSync(path, 'synthetic-key'); writeFileSync(path + '.pub', key); };
  let connectCount = 0;
  const secure = createRoutedSecureActions({ privateDirectory: root, create: privateDirectory => ({
    status() { try { loadSecureLink(privateDirectory); return { phase: 'configured' }; } catch { return { phase: 'unconfigured' }; } },
    configure(invitation) { return configureSecureLink({ privateDirectory, invitation, async generateCertificate({ directory, password }) {
      execFileSync('keytool', ['-importkeystore', '-srckeystore', join(identity.directory, 'server.p12'), '-srcstoretype', 'PKCS12',
        '-srcstorepass', identity.passphrase, '-destkeystore', join(directory, 'server.p12'), '-deststoretype', 'PKCS12', '-deststorepass', password, '-noprompt'], { stdio: 'pipe' });
      writeFileSync(join(directory, 'local.cer'), identity.cert);
    } }); },
    connect() { connectCount++; return { starting: true }; },
  }) });
  const legacy = { status: async () => ({ phase: 'existing' }), connect: () => assert.fail('legacy must remain running untouched') };
  const actions = createSecureDashboardActions({ legacy, secure,
    prepareExisting: async () => (await prepareExistingSecureHome({ privateDirectory: root, prepareKey, protectDirectory: () => {} })).enrollment,
    hostedRequest: async enrollment => {
      assert.ok(!JSON.stringify(enrollment).includes('a'.repeat(64)));
      return { version: 3, transport: 'tls-passthrough-v1', hosting: 'project-hosted', installationId: enrollment.installationId,
        publicBaseUrl: 'https://relay.example.test:24443', remoteSocket: '/tunnel/relay.sock', backends: enrollment.requestedBackends,
        relay: { host: 'relay.example.test', port: 2222, user: 'rayneo_test', hostKey: key } };
    } });
  assert.equal((await actions.connect({ hosting: 'project-hosted' })).starting, true);
  assert.equal(connectCount, 1);
  assert.equal(readFileSync(join(root, 'daily.json'), 'utf8'), daily);
  assert.equal(readFileSync(join(root, 'shared-runtime/connector.json'), 'utf8'), codex);
  assert.deepEqual(Object.keys(loadSecureLink(join(root, 'secure-existing')).backends), ['paseo', 'codex']);
});
