import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createSelfHostedActions } from '../distribution/self-hosted.mjs';
import { createPairingInformation, encodePairingInformation } from '../relay/self-hosted-bootstrap.mjs';
import { createUnixRelayBundle } from '../relay/unix-provision.mjs';
import { createServerInstallCommand } from '../distribution/self-hosted-command.mjs';
import { startSelfHostedBootstrap } from '../relay/self-hosted-bootstrap-service.mjs';
import { requestBootstrap } from '../relay/self-hosted-bootstrap.mjs';
import { createServer } from 'node:net';

const key = 'ssh-ed25519 ' + Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 1)]).toString('base64');
test('server install command packages only the dedicated installer and requires no private credentials', () => {
  const command = createServerInstallCommand();
  assert.match(command, /^sudo python3 -c '/);
  assert.match(command, /base64/);
  assert.ok(command.length < 150000);
  assert.ok(command.split('\n').every(line => line.length < 1000), 'terminal input must not exceed typical line limits');
  assert.doesNotMatch(command, /BEGIN (?:RSA |OPENSSH )?PRIVATE KEY/);
});
test('second step offers the hosted test code and self-hosted server pairing', () => {
  const html = readFileSync(new URL('../distribution/ui/index.html', import.meta.url), 'utf8');
  assert.match(html, /第二步：连接并配对/);
  assert.match(html, /使用自己的服务器/);
  assert.match(html, /id="self-bootstrap-code"/);
  assert.match(html, /id="self-bootstrap-install"/);
  assert.match(html, /测试码/);
});
function fixture() {
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/self-hosted-ui'); mkdirSync(parent, { recursive: true });
  const stateDirectory = mkdtempSync(join(parent, 'test-'));
  const enrollment = { version: 1, installationId: randomUUID(), requestedBackends: ['paseo'], sshPublicKey: key };
  const calls = [];
  const legacy = { status: async () => ({ phase: 'new' }), prepare: async () => calls.push('prepare'), enrollment: () => enrollment };
  const secure = { status: async () => ({ phase: 'unconfigured' }), configure: async invitation => calls.push(invitation), connect: async () => ({ starting: true }) };
  return { stateDirectory, enrollment, calls, actions: createSelfHostedActions({ stateDirectory, legacy, secure }) };
}
test('self-hosted setup generates a matching isolated server bundle before explicitly connecting', async () => {
  const f = fixture();
  const prepared = await f.actions.prepareSelfHosted({ ip: '203.0.113.10', hostKey: key });
  assert.deepEqual(f.calls, ['prepare']);
  const invitation = JSON.parse(readFileSync(join(prepared.directory, 'invitation.json'), 'utf8'));
  assert.equal(invitation.publicBaseUrl, 'https://203.0.113.10');
  assert.equal(invitation.hosting, 'self-hosted');
  assert.equal(invitation.installationId, f.enrollment.installationId);
  assert.equal(readFileSync(join(prepared.directory, 'sshd.conf'), 'utf8').includes('PermitTTY no'), true);
  await f.actions.finishSelfHosted({ bundleId: prepared.bundleId });
  assert.equal(f.calls[1].installationId, f.enrollment.installationId);
});
test('manual recovery accepts the same personal server domain used by automatic installation', async () => {
  const f = fixture();
  const prepared = await f.actions.prepareSelfHosted({ ip: 'relay.example.com', hostKey: key });
  const invitation = JSON.parse(readFileSync(join(prepared.directory, 'invitation.json'), 'utf8'));
  assert.equal(invitation.publicBaseUrl, 'https://relay.example.com');
  assert.equal(invitation.relay.host, 'relay.example.com');
});
test('self-hosted setup rejects invalid addresses, unconfirmed server keys and foreign bundle IDs', async () => {
  const f = fixture();
  await assert.rejects(f.actions.prepareSelfHosted({ ip: 'bad\naddress', hostKey: key }));
  await assert.rejects(f.actions.prepareSelfHosted({ ip: '203.0.113.10', hostKey: 'wrong' }));
  await assert.rejects(f.actions.finishSelfHosted({ bundleId: '../outside' }));
});
test('bootstrap configures only the server and computer named by the pairing information', { skip: process.platform !== 'win32' }, async () => {
  const f = fixture(), directory = join(f.stateDirectory, 'certificate'); mkdirSync(directory);
  const password = randomBytes(32).toString('hex');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', 'distribution/certificate.ps1', '-Directory', directory, '-Hostname', '203.0.113.10'], {
    env: { ...process.env, RAYNEO_INSTALL_PFX_PASSWORD: password }, stdio: 'pipe', windowsHide: true,
  });
  const info = createPairingInformation({ host: '203.0.113.10', port: 2222, cert: readFileSync(join(directory, 'local.cer')),
    secret: randomBytes(32).toString('base64url') });
  const invitation = createUnixRelayBundle({ enrollment: f.enrollment, hosting: 'self-hosted', publicBaseUrl: 'https://203.0.113.10',
    relay: { host: '203.0.113.10', port: 2222, user: 'rnp_' + f.enrollment.installationId.replaceAll('-', '').slice(0, 20), hostKey: key } }).invitation;
  let received;
  const secure = { status: async () => ({ phase: 'unconfigured' }), configure: async value => { received = value; }, connect: async () => ({ starting: true }) };
  const legacy = { status: async () => ({ phase: 'prepared' }), enrollment: async () => f.enrollment };
  const actions = createSelfHostedActions({ stateDirectory: f.stateDirectory, legacy, secure, bootstrapRequest: async () => invitation });
  assert.equal((await actions.pairSelfHosted({ pairingInfo: encodePairingInformation(info) })).starting, true);
  assert.deepEqual(received, invitation);
  const unsafe = createSelfHostedActions({ stateDirectory: f.stateDirectory, legacy, secure,
    bootstrapRequest: async () => ({ ...invitation, publicBaseUrl: 'https://203.0.113.11' }) });
  await assert.rejects(unsafe.pairSelfHosted({ pairingInfo: encodePairingInformation(info) }));
  const lostResponse = createSelfHostedActions({ stateDirectory: f.stateDirectory, legacy, secure,
    bootstrapRequest: async () => { throw Object.assign(Error(), { code: 'SELF_HOSTED_BOOTSTRAP_FAILED' }); } });
  await assert.rejects(lostResponse.pairSelfHosted({ pairingInfo: encodePairingInformation(info) }));
  const recovery = await lostResponse.prepareSelfHosted({ ip: info.host, hostKey: key });
  const saved = JSON.parse(readFileSync(join(recovery.directory, 'invitation.json'), 'utf8'));
  assert.deepEqual(saved, invitation);
});

test('real bootstrap enrollment configures a fresh isolated Windows connector', { skip: process.platform !== 'win32' }, async () => {
  const f = fixture(), directory = join(f.stateDirectory, 'certificate'), privateDirectory = join(f.stateDirectory, 'private'), stateDirectory = join(f.stateDirectory, 'state');
  mkdirSync(directory); const password = randomBytes(32).toString('hex');
  const certificate = (target, hostname, passphrase) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', 'distribution/certificate.ps1', '-Directory', target, ...(hostname ? ['-Hostname', hostname] : [])], {
    env: { ...process.env, RAYNEO_INSTALL_PFX_PASSWORD: passphrase }, stdio: 'pipe', windowsHide: true,
  });
  certificate(directory, '203.0.113.10', password);
  const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  let installed;
  const server = await startSelfHostedBootstrap({ host: '203.0.113.10', publicPort: 443, sshPort: port, bootstrapPort: port,
    hostKey: key, cert: readFileSync(join(directory, 'local.cer')), pfx: readFileSync(join(directory, 'server.p12')),
    passphrase: password, bindHost: '127.0.0.1', install: async value => { installed = value; } });
  try {
    const { prepareConnectorHome } = await import('../distribution/setup.mjs');
    const { configureSecureLink, loadSecureLink } = await import('../secure-link/setup.mjs');
    let phase = 'new';
    const legacy = { status: async () => ({ phase }), async prepare() {
      await prepareConnectorHome({ privateDirectory, stateDirectory, backends: ['paseo'], generateCertificate: ({ directory: target, password: passphrase }) => certificate(target, '', passphrase) });
      phase = 'prepared';
    }, enrollment: () => JSON.parse(readFileSync(join(stateDirectory, 'enrollment-request.json'), 'utf8')) };
    const secure = { status: async () => ({ phase: 'unconfigured' }),
      configure: invitation => configureSecureLink({ privateDirectory, invitation }), connect: async () => ({ starting: true }) };
    const actions = createSelfHostedActions({ stateDirectory, legacy, secure,
      bootstrapRequest: args => requestBootstrap({ ...args, allowLoopback: true, connectHost: '127.0.0.1' }) });
    assert.equal((await actions.pairSelfHosted({ pairingInfo: encodePairingInformation(server.info) })).starting, true);
    const config = loadSecureLink(privateDirectory);
    assert.equal(config.invitation.publicBaseUrl, 'https://203.0.113.10');
    assert.equal(config.invitation.relay.hostKey, key);
    assert.equal(config.invitation.installationId, installed.invitation.installationId);
  } finally { server.server.closeAllConnections(); await new Promise(resolve => server.server.close(resolve)); }
});
test('recovery only accepts a backup offered by the damaged secure configuration', async () => {
  const f = fixture(), id = 'b'.repeat(64); let restored;
  const actions = createSelfHostedActions({ stateDirectory: f.stateDirectory, legacy: {}, secure: {
    status: async () => ({ phase: 'configuration_error', ipRecoveryOptions: [{ id, modified: '2026-01-01T00:00:00.000Z' }] }),
    restoreIp: async value => { restored = value; return { restored: true }; },
  } });
  await assert.rejects(actions.restoreSelfHostedIp({ backupId: 'a'.repeat(64) }), { code: 'SECURE_IP_RECOVERY_INVALID' });
  assert.deepEqual(await actions.restoreSelfHostedIp({ backupId: id }), { restored: true });
  assert.equal(restored.backupId, id);
});
test('a changed IP is reported as saved even if restarting the connection fails', async () => {
  const f = fixture(); let changed = false;
  const actions = createSelfHostedActions({ stateDirectory: f.stateDirectory, legacy: {}, secure: {
    status: async () => ({ phase: 'configured', hosting: 'self-hosted' }),
    changeIp: async () => { changed = true; }, connect: async () => { throw Error('offline'); },
  } });
  assert.deepEqual(await actions.changeSelfHostedIp({ ip: '203.0.113.11' }), { starting: false, pairingRequired: true });
  assert.equal(changed, true);
});

test('fresh isolated computer prepares a real self-hosted bundle and imports its IPv4 identity', { skip: process.platform !== 'win32' }, async () => {
  const f = fixture(), privateDirectory = join(f.stateDirectory, 'private'), stateDirectory = join(f.stateDirectory, 'state');
  const { prepareConnectorHome } = await import('../distribution/setup.mjs');
  const { loadSecureLink } = await import('../secure-link/setup.mjs');
  const { createSecureLinkActions } = await import('../secure-link/actions.mjs');
  let phase = 'new', configured = false;
  const legacy = { status: async () => ({ phase }),
    async prepare() {
      await prepareConnectorHome({ privateDirectory, stateDirectory, backends: ['paseo'], generateCertificate({ directory, password }) {
        execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', 'distribution/certificate.ps1', '-Directory', directory],
          { env: { ...process.env, RAYNEO_INSTALL_PFX_PASSWORD: password }, stdio: 'pipe', windowsHide: true });
      } }); phase = 'prepared';
    },
    enrollment: () => JSON.parse(readFileSync(join(stateDirectory, 'enrollment-request.json'), 'utf8')),
  };
  let stops = 0;
  const secureController = createSecureLinkActions({ codeRoot: process.cwd(), privateDirectory, stateDirectory,
    startLocalConnections: async () => ({ started: [], blocked: [] }), spawnChild() {
      const child = new EventEmitter(); child.unref = () => {};
      child.send = (message, callback) => { assert.equal(message, 'stop-secure-link'); stops++; callback(); queueMicrotask(() => child.emit('exit', 0)); };
      queueMicrotask(() => child.emit('spawn')); return child;
    } });
  const secure = { status: async () => ({ phase: configured ? 'configured' : 'unconfigured', hosting: 'self-hosted' }),
    async configure(invitation) { await secureController.configure(invitation); configured = true; },
    connect: () => secureController.connect(), changeIp: value => secureController.changeIp(value) };
  const actions = createSelfHostedActions({ stateDirectory, legacy, secure });
  const prepared = await actions.prepareSelfHosted({ ip: '203.0.113.10', hostKey: key });
  assert.equal((await actions.finishSelfHosted({ bundleId: prepared.bundleId })).starting, true);
  const loaded = loadSecureLink(privateDirectory);
  assert.equal(loaded.invitation.publicBaseUrl, 'https://203.0.113.10');
  assert.equal(loaded.invitation.relay.hostKey, key);
  assert.equal((await actions.changeSelfHostedIp({ ip: '203.0.113.11' })).pairingRequired, true);
  assert.equal(stops, 1);
  assert.equal(loadSecureLink(privateDirectory).invitation.publicBaseUrl, 'https://203.0.113.11');
});
