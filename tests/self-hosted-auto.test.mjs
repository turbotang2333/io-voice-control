import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPairingInformation, requestBootstrap } from '../relay/self-hosted-bootstrap.mjs';
import { startSelfHostedBootstrap } from '../relay/self-hosted-bootstrap-service.mjs';
import { createSelfHostedActions } from '../distribution/self-hosted.mjs';
import { createServerInstallCommand } from '../distribution/self-hosted-command.mjs';

test('a computer-chosen bootstrap identity authenticates the server without copying a code back', { skip: process.platform !== 'win32' }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rnp-auto-test-'));
  const passphrase = randomBytes(32).toString('hex');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', 'distribution/certificate.ps1', '-Directory', directory, '-Hostname', 'example.com'],
    { env: { ...process.env, RAYNEO_INSTALL_PFX_PASSWORD: passphrase }, stdio: 'pipe', windowsHide: true });
  const cert = readFileSync(join(directory, 'local.cer')), pfx = readFileSync(join(directory, 'server.p12'));
  const secret = randomBytes(32).toString('base64url');
  const hostKey = 'ssh-ed25519 ' + Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 1)]).toString('base64');
  const instance = await startSelfHostedBootstrap({ host: 'example.com', publicPort: 443, sshPort: 2222, bootstrapPort: 0,
    bindHost: '127.0.0.1', hostKey, cert, pfx, passphrase, secret, install: async () => {} });
  try {
    const info = createPairingInformation({ host: 'example.com', port: instance.server.address().port, cert, secret });
    const enrollment = { version: 1, installationId: '12345678-1234-4234-8234-123456789abc', requestedBackends: ['paseo'], sshPublicKey: hostKey };
    await assert.rejects(requestBootstrap({ info: { ...info, secret: randomBytes(32).toString('base64url') }, enrollment, allowLoopback: true, connectHost: '127.0.0.1' }));
    let authenticated = false;
    const result = await requestBootstrap({ info, enrollment, allowLoopback: true, connectHost: '127.0.0.1', onAuthenticated: () => { authenticated = true; } });
    assert.equal(authenticated, true);
    assert.equal(result.relay.host, 'example.com');
    assert.equal(result.relay.hostKey, hostKey);
    await assert.rejects(requestBootstrap({ info, enrollment, allowLoopback: true, connectHost: '127.0.0.1' }));
  } finally { instance.server.closeAllConnections(); await new Promise(resolve => instance.server.close(resolve)); }
});

test('automatic setup requires one server address and rejects invalid addresses before preparing', async () => {
  let prepared = false;
  const actions = createSelfHostedActions({ stateDirectory: tmpdir(), legacy: { status: async () => ({ phase: 'new' }), prepare: async () => { prepared = true; } }, secure: { status: async () => ({ phase: 'unconfigured' }) } });
  await assert.rejects(actions.selfHostedCommand({ host: 'bad address' }), { code: 'SELF_HOSTED_INVALID' });
  assert.equal(prepared, false);
});

test('automatic server command supports root without sudo and carries its address without prompting', () => {
  const command = createServerInstallCommand({ host: 'example.com', pfx: 'dGVzdA==', cert: 'dGVzdA==', passphrase: 'a'.repeat(64), secret: 'a'.repeat(43), expiresAt: Date.now() + 60000 });
  assert.ok(command.includes('id -u'));
  assert.match(command, /python3 - <<'RNP_AUTO'/);
  assert.ok(command.includes('apt-get install -y'));
  const encoded = [...command.matchAll(/"([A-Za-z0-9+/=]{50,})"/g)].map(match => match[1]).join('');
  const program = gunzipSync(Buffer.from(encoded, 'base64')).toString('utf8');
  assert.doesNotMatch(program, /input\(/);
  assert.match(program, /--automatic/);
});

test('missing Ubuntu dependencies are installed before launching the installer', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'rnp-dependency-test-'));
  const executable = (name, content) => { const path = join(dir, name); writeFileSync(path, '#!/bin/sh\n' + content + '\n'); chmodSync(path, 0o755); };
  executable('id', 'printf 0');
  executable('apt-get', `printf '%s\\n' "$*" >> '${dir}/calls'\nif [ "$1" = install ]; then printf '#!/bin/sh\\nexit 0\\n' > '${dir}/python3'; /bin/chmod 755 '${dir}/python3'; fi`);
  const command = createServerInstallCommand({ host: 'example.com', pfx: 'dGVzdA==', cert: 'dGVzdA==', passphrase: 'a'.repeat(64), secret: 'a'.repeat(43), expiresAt: Date.now() + 60000 });
  const result = spawnSync('/bin/bash', ['-c', command], { env: { ...process.env, PATH: dir }, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(join(dir, 'calls'), 'utf8'), /update\ninstall -y python3 openssl/);
});

test('the self-hosted page asks for the server address and displays automatic progress', () => {
  const html = readFileSync(new URL('../distribution/ui/index.html', import.meta.url), 'utf8');
  const js = readFileSync(new URL('../distribution/ui/app.js', import.meta.url), 'utf8');
  assert.match(html, /id="self-bootstrap-host"/);
  assert.match(html, /id="self-bootstrap-progress"/);
  assert.match(js, /self-hosted-progress/);
});

test('one generated command starts an authenticated automatic pairing without a return code', { skip: process.platform !== 'win32' }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rnp-auto-flow-'));
  const passphrase = randomBytes(32).toString('hex');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', 'distribution/certificate.ps1', '-Directory', directory, '-Hostname', 'example.com'],
    { env: { ...process.env, RAYNEO_INSTALL_PFX_PASSWORD: passphrase }, stdio: 'pipe', windowsHide: true });
  const cert = readFileSync(join(directory, 'local.cer')), pfx = readFileSync(join(directory, 'server.p12'));
  const key = 'ssh-ed25519 ' + Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 1)]).toString('base64');
  const enrollment = { version: 1, installationId: '12345678-1234-4234-8234-123456789abc', requestedBackends: ['paseo'], sshPublicKey: key };
  const probe = (await import('node:net')).createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  let args, saved, connected = false, requestedTimeout;
  const actions = createSelfHostedActions({ stateDirectory: directory, legacy: { status: async () => ({ phase: 'prepared' }), enrollment: () => enrollment },
    secure: { status: async () => ({ phase: saved ? 'configured' : 'unconfigured' }), configure: async value => { saved = value; }, connect: async () => { connected = true; } },
    createIdentity: async () => ({ cert, pfx, passphrase }), makeInstallCommand: value => { args = value; return 'test command'; }, bootstrapPort: port, pollIntervalMs: 20,
    bootstrapRequest: value => { requestedTimeout = value.timeoutMs; return requestBootstrap({ ...value, allowLoopback: true, connectHost: '127.0.0.1' }); } });
  const result = await actions.selfHostedCommand({ host: 'example.com' });
  assert.equal(result.command, 'test command');
  const instance = await startSelfHostedBootstrap({ host: 'example.com', sshPort: port, bootstrapPort: port, bindHost: '127.0.0.1', hostKey: key,
    cert, pfx, passphrase, secret: args.secret, install: async () => {} });
  try {
    for (let i = 0; i < 100 && !connected; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(connected, true);
    assert.equal(requestedTimeout, 120000);
    assert.equal(saved.relay.hostKey, key);
    assert.equal(actions.selfHostedProgress().state, 'connected');
  } finally { instance.server.closeAllConnections(); await new Promise(resolve => instance.server.close(resolve)); }
});

test('concurrent command generation shares the same pending session', { skip: process.platform !== 'win32' }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rnp-auto-race-')), passphrase = randomBytes(32).toString('hex');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', 'distribution/certificate.ps1', '-Directory', directory, '-Hostname', 'example.com'],
    { env: { ...process.env, RAYNEO_INSTALL_PFX_PASSWORD: passphrase }, stdio: 'pipe', windowsHide: true });
  const cert = readFileSync(join(directory, 'local.cer')), pfx = readFileSync(join(directory, 'server.p12'));
  let identityCount = 0, enrollmentCount = 0;
  const key = 'ssh-ed25519 ' + Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 1)]).toString('base64');
  const actions = createSelfHostedActions({ stateDirectory: directory, legacy: { status: async () => ({ phase: 'prepared' }), enrollment: async () => { enrollmentCount++; await new Promise(r => setTimeout(r, 20)); return { version: 1, installationId: '12345678-1234-4234-8234-123456789abc', requestedBackends: ['paseo'], sshPublicKey: key }; } },
    secure: { status: async () => ({ phase: 'unconfigured' }) }, createIdentity: async () => { identityCount++; return { cert, pfx, passphrase }; },
    makeInstallCommand: ({ secret }) => secret, bootstrapRequest: async () => { throw Error('offline'); } });
  const [first, second] = await Promise.all([actions.selfHostedCommand({ host: 'example.com' }), actions.selfHostedCommand({ host: 'example.com' })]);
  assert.equal(first.command, second.command);
  assert.equal(identityCount, 1); assert.equal(enrollmentCount, 1);
});

test('a received invalid installation response stops retrying and requests recovery', { skip: process.platform !== 'win32' }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rnp-auto-invalid-')), passphrase = randomBytes(32).toString('hex');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', 'distribution/certificate.ps1', '-Directory', directory, '-Hostname', 'example.com'],
    { env: { ...process.env, RAYNEO_INSTALL_PFX_PASSWORD: passphrase }, stdio: 'pipe', windowsHide: true });
  const key = 'ssh-ed25519 ' + Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 1)]).toString('base64');
  let calls = 0;
  const actions = createSelfHostedActions({ stateDirectory: directory, legacy: { status: async () => ({ phase: 'prepared' }), enrollment: () => ({ version: 1, installationId: '12345678-1234-4234-8234-123456789abc', requestedBackends: ['paseo'], sshPublicKey: key }) },
    secure: { status: async () => ({ phase: 'unconfigured' }) }, createIdentity: async () => ({ cert: readFileSync(join(directory, 'local.cer')), pfx: readFileSync(join(directory, 'server.p12')), passphrase }),
    makeInstallCommand: () => 'command', pollIntervalMs: 10, bootstrapRequest: async () => { calls++; return {}; } });
  await actions.selfHostedCommand({ host: 'example.com' });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(actions.selfHostedProgress().state, 'failed');
  assert.equal(calls, 1);
});

test('an explicit installation failure is not retried', { skip: process.platform !== 'win32' }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rnp-auto-install-fail-')), passphrase = randomBytes(32).toString('hex');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', 'distribution/certificate.ps1', '-Directory', directory, '-Hostname', 'example.com'],
    { env: { ...process.env, RAYNEO_INSTALL_PFX_PASSWORD: passphrase }, stdio: 'pipe', windowsHide: true });
  const key = 'ssh-ed25519 ' + Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 1)]).toString('base64');
  let calls = 0;
  const actions = createSelfHostedActions({ stateDirectory: directory, legacy: { status: async () => ({ phase: 'prepared' }), enrollment: () => ({ version: 1, installationId: '12345678-1234-4234-8234-123456789abc', requestedBackends: ['paseo'], sshPublicKey: key }) },
    secure: { status: async () => ({ phase: 'unconfigured' }) }, createIdentity: async () => ({ cert: readFileSync(join(directory, 'local.cer')), pfx: readFileSync(join(directory, 'server.p12')), passphrase }),
    makeInstallCommand: () => 'command', pollIntervalMs: 10, bootstrapRequest: async () => { calls++; throw Object.assign(Error(), { code: 'SELF_HOSTED_BOOTSTRAP_RESPONSE' }); } });
  await actions.selfHostedCommand({ host: 'example.com' });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(actions.selfHostedProgress().state, 'failed'); assert.equal(calls, 1);
});

test('a lost response after authenticating the server stops automatic retry', { skip: process.platform !== 'win32' }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rnp-auto-lost-')), passphrase = randomBytes(32).toString('hex');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', 'distribution/certificate.ps1', '-Directory', directory, '-Hostname', 'example.com'],
    { env: { ...process.env, RAYNEO_INSTALL_PFX_PASSWORD: passphrase }, stdio: 'pipe', windowsHide: true });
  const key = 'ssh-ed25519 ' + Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 1)]).toString('base64');
  let calls = 0;
  const actions = createSelfHostedActions({ stateDirectory: directory, legacy: { status: async () => ({ phase: 'prepared' }), enrollment: () => ({ version: 1, installationId: '12345678-1234-4234-8234-123456789abc', requestedBackends: ['paseo'], sshPublicKey: key }) },
    secure: { status: async () => ({ phase: 'unconfigured' }) }, createIdentity: async () => ({ cert: readFileSync(join(directory, 'local.cer')), pfx: readFileSync(join(directory, 'server.p12')), passphrase }),
    makeInstallCommand: () => 'command', pollIntervalMs: 10, bootstrapRequest: async ({ onAuthenticated }) => { calls++; onAuthenticated(); throw Error('connection lost'); } });
  await actions.selfHostedCommand({ host: 'example.com' });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(actions.selfHostedProgress().state, 'failed'); assert.equal(calls, 1);
});
