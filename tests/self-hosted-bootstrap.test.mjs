import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createBootstrapServer, createPairingInformation, decodePairingInformation, encodePairingInformation, requestBootstrap } from '../relay/self-hosted-bootstrap.mjs';
import { startSelfHostedBootstrap } from '../relay/self-hosted-bootstrap-service.mjs';

const key = 'ssh-ed25519 ' + Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 1)]).toString('base64');
const enrollment = () => ({ version: 1, installationId: randomUUID(), requestedBackends: ['paseo'], sshPublicKey: key });

test('bootstrap verifies the server certificate and accepts one authenticated computer only', { skip: process.platform !== 'win32' }, async () => {
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/bootstrap'); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'test-')), password = randomBytes(32).toString('hex');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', 'distribution/certificate.ps1', '-Directory', directory], {
    env: { ...process.env, RAYNEO_INSTALL_PFX_PASSWORD: password }, stdio: 'pipe', windowsHide: true,
  });
  const cert = readFileSync(join(directory, 'local.cer')), pfx = readFileSync(join(directory, 'server.p12'));
  const secret = randomBytes(32).toString('base64url'), calls = [];
  const bootstrap = createBootstrapServer({ pfx, passphrase: password, secret, install: async request => { calls.push(request); return { accepted: true }; } });
  await new Promise((resolve, reject) => { bootstrap.once('error', reject); bootstrap.listen(0, '127.0.0.1', resolve); });
  try {
    const info = createPairingInformation({ host: '127.0.0.1', port: bootstrap.address().port, cert, secret, allowLoopback: true });
    assert.deepEqual(decodePairingInformation(encodePairingInformation(info, true), true), info);
    assert.throws(() => decodePairingInformation('RNP1-incorrect', true));
    await assert.rejects(requestBootstrap({ info: { ...info, secret: randomBytes(32).toString('base64url') }, enrollment: enrollment(), allowLoopback: true }));
    await assert.rejects(requestBootstrap({ info: { ...info, fingerprint: '0'.repeat(64) }, enrollment: enrollment(), allowLoopback: true }));
    const request = enrollment();
    assert.deepEqual(await requestBootstrap({ info, enrollment: request, allowLoopback: true }), { accepted: true });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], request);
    await assert.rejects(requestBootstrap({ info, enrollment: enrollment(), allowLoopback: true }));
    assert.equal(calls.length, 1);
  } finally { bootstrap.closeAllConnections(); await new Promise(resolve => bootstrap.close(resolve)); }
});

test('expired pairing cannot install even with the correct code', { skip: process.platform !== 'win32' }, async () => {
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/bootstrap'); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'test-')), password = randomBytes(32).toString('hex');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', 'distribution/certificate.ps1', '-Directory', directory], {
    env: { ...process.env, RAYNEO_INSTALL_PFX_PASSWORD: password }, stdio: 'pipe', windowsHide: true,
  });
  const cert = readFileSync(join(directory, 'local.cer')), pfx = readFileSync(join(directory, 'server.p12'));
  const secret = randomBytes(32).toString('base64url'); let calls = 0;
  const bootstrap = createBootstrapServer({ pfx, passphrase: password, secret, expiresAt: Date.now() - 1, install: async () => { calls++; } });
  await new Promise((resolve, reject) => { bootstrap.once('error', reject); bootstrap.listen(0, '127.0.0.1', resolve); });
  try {
    const info = createPairingInformation({ host: '127.0.0.1', port: bootstrap.address().port, cert, secret, allowLoopback: true });
    await assert.rejects(requestBootstrap({ info, enrollment: enrollment(), allowLoopback: true }));
    assert.equal(calls, 0);
  } finally { bootstrap.closeAllConnections(); await new Promise(resolve => bootstrap.close(resolve)); }
});

test('server installs only the enrolled computer and returns a matching invitation', { skip: process.platform !== 'win32' }, async () => {
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/bootstrap'); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'test-')), password = randomBytes(32).toString('hex');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', 'distribution/certificate.ps1', '-Directory', directory, '-Hostname', '203.0.113.10'], {
    env: { ...process.env, RAYNEO_INSTALL_PFX_PASSWORD: password }, stdio: 'pipe', windowsHide: true,
  });
  const cert = readFileSync(join(directory, 'local.cer')), pfx = readFileSync(join(directory, 'server.p12'));
  let installed;
  const instance = await startSelfHostedBootstrap({ host: '203.0.113.10', publicPort: 443, sshPort: 2222, bootstrapPort: 0,
    hostKey: key, cert, pfx, passphrase: password, bindHost: '127.0.0.1',
    install: async bundle => { installed = bundle; } });
  try {
    const request = enrollment();
    const invitation = await requestBootstrap({ info: instance.info, enrollment: request, allowLoopback: true, connectHost: '127.0.0.1' });
    assert.equal(invitation.installationId, request.installationId);
    assert.equal(invitation.relay.hostKey, key);
    assert.equal(invitation.hosting, 'self-hosted');
    assert.match(installed.authorizedKey, /^restrict,port-forwarding ssh-ed25519 /);
  } finally { instance.server.closeAllConnections(); await new Promise(resolve => instance.server.close(resolve)); }
});

test('a valid claim in progress is not cut off when the pairing window expires', { skip: process.platform !== 'win32' }, async () => {
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/bootstrap'); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'test-')), password = randomBytes(32).toString('hex');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', 'distribution/certificate.ps1', '-Directory', directory, '-Hostname', '203.0.113.10'], {
    env: { ...process.env, RAYNEO_INSTALL_PFX_PASSWORD: password }, stdio: 'pipe', windowsHide: true,
  });
  const instance = await startSelfHostedBootstrap({ host: '203.0.113.10', publicPort: 443, sshPort: 2222, bootstrapPort: 0,
    hostKey: key, cert: readFileSync(join(directory, 'local.cer')), pfx: readFileSync(join(directory, 'server.p12')),
    passphrase: password, bindHost: '127.0.0.1', ttlMs: 300,
    install: async () => { await new Promise(resolve => setTimeout(resolve, 600)); } });
  try {
    const result = await requestBootstrap({ info: instance.info, enrollment: enrollment(), allowLoopback: true, connectHost: '127.0.0.1' });
    assert.equal(result.hosting, 'self-hosted');
  } finally { instance.server.closeAllConnections(); await new Promise(resolve => instance.server.close(resolve)); }
});

test('an unclaimed pairing server closes after its limited window', { skip: process.platform !== 'win32' }, async () => {
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/bootstrap'); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'test-')), password = randomBytes(32).toString('hex');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', 'distribution/certificate.ps1', '-Directory', directory, '-Hostname', '203.0.113.10'], {
    env: { ...process.env, RAYNEO_INSTALL_PFX_PASSWORD: password }, stdio: 'pipe', windowsHide: true,
  });
  const instance = await startSelfHostedBootstrap({ host: '203.0.113.10', publicPort: 443, sshPort: 2222, bootstrapPort: 0,
    hostKey: key, cert: readFileSync(join(directory, 'local.cer')), pfx: readFileSync(join(directory, 'server.p12')),
    passphrase: password, bindHost: '127.0.0.1', ttlMs: 150, install: async () => {} });
  try { await new Promise(resolve => setTimeout(resolve, 300)); assert.equal(instance.server.listening, false); }
  finally { instance.server.closeAllConnections(); await new Promise(resolve => instance.server.close(resolve)); }
});

test('bootstrap releases its temporary port before installing the permanent service', { skip: process.platform !== 'win32' }, async () => {
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/bootstrap'); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'test-')), password = randomBytes(32).toString('hex');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', 'distribution/certificate.ps1', '-Directory', directory, '-Hostname', '203.0.113.10'], {
    env: { ...process.env, RAYNEO_INSTALL_PFX_PASSWORD: password }, stdio: 'pipe', windowsHide: true,
  });
  const cert = readFileSync(join(directory, 'local.cer')), pfx = readFileSync(join(directory, 'server.p12'));
  let permanent;
  const instance = await startSelfHostedBootstrap({ host: '203.0.113.10', publicPort: 443, sshPort: 2222, bootstrapPort: 0,
    hostKey: key, cert, pfx, passphrase: password, bindHost: '127.0.0.1', stopListeningBeforeInstall: true,
    install: async () => { permanent = createServer(); await new Promise((resolve, reject) => { permanent.once('error', reject); permanent.listen(instance.info.port, '127.0.0.1', resolve); }); } });
  try {
    const invitation = await requestBootstrap({ info: instance.info, enrollment: enrollment(), allowLoopback: true, connectHost: '127.0.0.1' });
    assert.equal(invitation.hosting, 'self-hosted');
  } finally { permanent?.close(); instance.server.closeAllConnections(); instance.server.close(); }
});

test('bootstrap server command explains prerequisites without requiring privileges', () => {
  const help = execFileSync(process.execPath, ['relay/self-hosted-bootstrap-cli.mjs', '--help'], { encoding: 'utf8' });
  assert.match(help, /Node\.js 22/);
  assert.match(help, /2222/);
});
