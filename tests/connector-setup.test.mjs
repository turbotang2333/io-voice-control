import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, rmdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { prepareConnectorHome, importTrialInvitation } from '../distribution/setup.mjs';
import { validateRuntimeConfig } from '../bridge/runtime-config.mjs';
import { validateProfile } from '../experiments/codex-connector/service.mjs';

function fixture() {
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/connector-setup'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'fixture-'));
  // Public self-signed fixture only; its disposable private key is never included in source.
  const certificate = readFileSync(new URL('./fixtures/connector-public-test.cer', import.meta.url));
  return { root, privateDirectory: join(root, 'private'), stateDirectory: join(root, 'state'),
    async generateCertificate({ pfxPath, certificatePath }) { writeFileSync(pfxPath, 'synthetic pfx'); writeFileSync(certificatePath, certificate); },
    async prepareDesktopAdapter(path) { writeFileSync(path, 'synthetic adapter'); },
    executable: join(root, 'codex.exe'), backends: ['paseo', 'codex'] };
}

test('new Windows setup works under an inherited Restricted script policy without changing it', { skip: process.platform !== 'win32' }, async () => {
  const previous = process.env.PSExecutionPolicyPreference;
  process.env.PSExecutionPolicyPreference = 'Restricted';
  try {
    const result = await prepareConnectorHome(fixture());
    assert.equal(result.modelMessagesSent, 0);
    assert.equal(process.env.PSExecutionPolicyPreference, 'Restricted');
  } finally {
    if (previous === undefined) delete process.env.PSExecutionPolicyPreference;
    else process.env.PSExecutionPolicyPreference = previous;
  }
});

for (const step of ['certificate', 'adapter']) {
  test(`failed ${step} preparation leaves no published configuration and can be retried`, async () => {
    const f = fixture();
    const broken = { ...f, ...(step === 'certificate'
      ? { generateCertificate: async () => { throw Error('injected platform failure'); } }
      : { prepareDesktopAdapter: async () => { throw Error('injected platform failure'); } }) };
    await assert.rejects(prepareConnectorHome(broken), /injected platform failure/);
    assert.deepEqual(readdirSync(f.privateDirectory), []);
    const prepared = await prepareConnectorHome(f);
    assert.equal(prepared.modelMessagesSent, 0);
    assert.equal(JSON.parse(readFileSync(join(f.privateDirectory, 'installation.json'))).phase, 'awaiting-invitation');
  });
}

test('an enrollment publication failure can be repaired without replacing prepared credentials', async () => {
  const f = fixture(), certificate = f.generateCertificate;
  f.generateCertificate = async options => {
    await certificate(options);
    mkdirSync(join(f.stateDirectory, 'enrollment-request.json'));
  };
  await assert.rejects(prepareConnectorHome(f), { code: 'EEXIST' });
  const before = readFileSync(join(f.privateDirectory, 'daily.json'), 'utf8');
  rmdirSync(join(f.stateDirectory, 'enrollment-request.json'));
  const result = await prepareConnectorHome({ ...f, generateCertificate: async () => assert.fail('must preserve existing certificate') });
  assert.equal(result.modelMessagesSent, 0);
  assert.equal(readFileSync(join(f.privateDirectory, 'daily.json'), 'utf8'), before);
  assert.equal(result.enrollment.installationId, JSON.parse(readFileSync(join(f.privateDirectory, 'installation.json'))).installationId);
});

test('new user setup creates independent credentials and exports only public enrollment material', async () => {
  const f = fixture();
  const prepared = await prepareConnectorHome(f);
  const publicText = JSON.stringify(prepared.enrollment);
  const daily = JSON.parse(readFileSync(join(f.privateDirectory, 'daily.json')));
  const connector = JSON.parse(readFileSync(join(f.privateDirectory, 'shared-runtime/connector.json')));
  validateRuntimeConfig(daily, { daily: true }); validateProfile(connector);
  assert.notEqual(daily.apiToken, connector.token);
  assert.ok(!publicText.includes(daily.apiToken)); assert.ok(!publicText.includes(connector.token));
  assert.ok(!publicText.includes(connector.password)); assert.ok(!publicText.includes('PRIVATE KEY'));
  assert.match(prepared.enrollment.sshPublicKey, /^ssh-rsa [A-Za-z0-9+/]+=* rayneo-trial$/);
  assert.equal(prepared.configuredForWireless, false); assert.equal(prepared.modelMessagesSent, 0);
  await assert.rejects(prepareConnectorHome(f), { code: 'CONNECTOR_ALREADY_PREPARED' });
  assert.equal(JSON.parse(readFileSync(join(f.privateDirectory, 'daily.json'))).apiToken, daily.apiToken);
});

test('fresh independent Codex setup does not require or configure the desktop launch adapter', async () => {
  const f = fixture();
  await prepareConnectorHome({ ...f, independentCodex: true, prepareDesktopAdapter: () => assert.fail('desktop adapter is unnecessary') });
  const profile = JSON.parse(readFileSync(join(f.privateDirectory, 'shared-runtime/connector.json')));
  validateProfile(profile);
  assert.equal(Object.hasOwn(profile, 'sharedConnection'), false);
  assert.equal(profile.navigation, true);
});

test('setup preserves unrecognized existing personal configuration without generating or replacing anything', async () => {
  const f = fixture(); mkdirSync(f.privateDirectory); writeFileSync(join(f.privateDirectory, 'daily.json'), 'existing personal settings');
  f.generateCertificate = async () => assert.fail('must not generate or replace credentials');
  await assert.rejects(prepareConnectorHome(f), { code: 'CONNECTOR_EXISTING_CONFIGURATION' });
  assert.equal(readFileSync(join(f.privateDirectory, 'daily.json'), 'utf8'), 'existing personal settings');
});

test('an invitation must match this installation and allocate separate trial ports before connection is enabled', async () => {
  const f = fixture(); const prepared = await prepareConnectorHome(f);
  const invitation = { version: 1, installationId: prepared.enrollment.installationId,
    relay: { host: 'relay.example.test', port: 22, user: 'trial-user', hostKey: 'ssh-ed25519 ' + Buffer.concat([Buffer.from([0,0,0,11]),Buffer.from('ssh-ed25519'),Buffer.from([0,0,0,32]),Buffer.alloc(32,1)]).toString('base64') },
    backends: { paseo: { endpoint: 'https://example.test/trial/paseo', remotePort: 28001 }, codex: { endpoint: 'https://example.test/trial/codex', remotePort: 28002 } } };
  assert.throws(() => importTrialInvitation({ privateDirectory: f.privateDirectory, invitation: { ...invitation, installationId: 'another-installation' } }), { code: 'CONNECTOR_INVITATION_INVALID' });
  assert.throws(() => importTrialInvitation({ privateDirectory: f.privateDirectory, invitation: { ...invitation, backends: { ...invitation.backends, codex: { ...invitation.backends.codex, remotePort: 28001 } } } }), { code: 'CONNECTOR_INVITATION_INVALID' });
  const result = importTrialInvitation({ privateDirectory: f.privateDirectory, invitation });
  assert.equal(result.wirelessConfigured, true); assert.equal(result.serverChanged, false); assert.equal(result.modelMessagesSent, 0);
  const relay = JSON.parse(readFileSync(join(f.privateDirectory, 'relay.json')));
  assert.equal(relay.remotePort, 28001); assert.equal(relay.enabled, true);
  const wireless = JSON.parse(readFileSync(join(f.privateDirectory, 'shared-runtime/connector-wireless.json')));
  assert.equal(wireless.remoteLoopbackPort, 28002);
  assert.ok(!readFileSync(join(f.privateDirectory, 'ssh-config'), 'utf8').includes('StrictHostKeyChecking no'));
});
