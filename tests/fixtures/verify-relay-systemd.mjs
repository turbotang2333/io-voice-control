// Run only inside the dedicated disposable WSL test distribution, as root.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import tls from 'node:tls';
import https from 'node:https';
import { join } from 'node:path';
import { randomUUID, X509Certificate } from 'node:crypto';
import { createUnixRelayBundle } from '../../relay/unix-provision.mjs';
import { createLinuxInstallDriver, createInstallPlan, checkInstalledRelay } from '../../relay/install.mjs';
import { createHostedService } from '../../relay/hosted-service.mjs';
import { requestHostedEnrollment } from '../../distribution/hosted-enrollment.mjs';

assert.equal(process.env.RAYNEO_ISOLATED_SYSTEMD_TEST, '1');
assert.equal(process.getuid(), 0);
assert.equal(existsSync('/etc/rayneo-isolated-systemd-test-only'), true, 'Dedicated test environment required');
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
const freePort = () => new Promise((resolve, reject) => {
  const server = createServer(); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});
const tmp = mkdtempSync('/run/rayneo-systemd-test-');
mkdirSync('/run/sshd', { recursive: true, mode: 0o755 });
const keyPath = join(tmp, 'client');
run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath]);
run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-keyout', join(tmp, 'tls.key'), '-out', join(tmp, 'tls.crt')]);
const tlsKey = readFileSync(join(tmp, 'tls.key')), tlsCert = readFileSync(join(tmp, 'tls.crt'));
const expectedFingerprint = new X509Certificate(tlsCert).fingerprint256;
const hostKey = readFileSync('/etc/ssh/ssh_host_ed25519_key.pub', 'utf8').trim().split(/\s+/).slice(0, 2).join(' ');
const clientKey = readFileSync(keyPath + '.pub', 'utf8').trim();
const relayPort = await freePort(), sshPort = await freePort();
assert.notEqual(relayPort, sshPort);
const enrollment = { version: 1, installationId: randomUUID(), requestedBackends: ['paseo'], sshPublicKey: clientKey };
const bundle = createUnixRelayBundle({ enrollment,
  hosting: 'project-hosted', publicBaseUrl: `https://relay.example.test:${relayPort}`,
  relay: { host: 'relay.example.test', port: sshPort, user: 'rayneosystest', hostKey } });
const plan = createInstallPlan(bundle, '/usr/local/bin/node');
// WSL networking is shared: test listeners are explicitly loopback-only.
plan.sshdConfig = plan.sshdConfig.replace('ListenAddress 0.0.0.0', 'ListenAddress 127.0.0.1');
plan.relayConfig = { ...plan.relayConfig, listenHost: '127.0.0.1' };
const original = readFileSync(new URL('../../relay/server.mjs', import.meta.url), 'utf8');
const serverSource = join(tmp, 'relay-server.mjs');
writeFileSync(serverSource, original);
const driver = createLinuxInstallDriver({ serverSource, run: (command, args) => {
  try { return run(command, args); }
  catch (error) { if (!(command === 'getent' && error.status === 2) && !(command === 'ss' && args.includes('-tBn'))) console.error('Test command failed:', command, args.join(' '), String(error.stderr ?? '')); throw error; }
} });
// Keep the test listeners loopback-only while exercising the production adapter.
const safeDriver = Object.fromEntries(['preflight', 'createFiles', 'createAccount', 'verifySsh', 'startService', 'reloadSsh', 'rollback', 'check']
  .map(name => [name, async (value, ...args) => {
    const result = await driver[name]({ ...value, relayConfig: { ...value.relayConfig, listenHost: '127.0.0.1' },
      sshdConfig: value.sshdConfig.replace('ListenAddress 0.0.0.0', 'ListenAddress 127.0.0.1') }, ...args);
    if (name === 'startService') installed = true;
    if (name === 'rollback') installed = false;
    return result;
  }]));
let tunnel, runtime, installed = false;
try {
  runtime = await createHostedService({ databasePath: join(tmp, 'registry.sqlite'), tls: { key: tlsKey, cert: tlsCert },
    nodePath: '/usr/local/bin/node', driverFactory: () => safeDriver,
    slots: [{ id: 'test', publicBaseUrl: bundle.invitation.publicBaseUrl, relay: bundle.invitation.relay }] });
  await new Promise((resolve, reject) => { runtime.server.once('error', reject); runtime.server.listen(0, '127.0.0.1', resolve); });
  const fetchImpl = (_url, options) => new Promise((resolve, reject) => {
    const request = https.request({ host: '127.0.0.1', servername: 'localhost', port: runtime.server.address().port,
      path: '/v1/enroll', method: options.method, headers: options.headers, ca: tlsCert, signal: options.signal }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })));
    });
    request.on('error', reject); request.end(options.body);
  });
  const invitation = await requestHostedEnrollment({ enrollment, serviceUrl: 'https://enrollment.example.test/v1/enroll', fetchImpl });
  assert.equal(invitation.installationId, enrollment.installationId);
  assert.equal((await requestHostedEnrollment({ enrollment, serviceUrl: 'https://enrollment.example.test/v1/enroll', fetchImpl })).installationId, enrollment.installationId);
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.deepEqual(await checkInstalledRelay(plan, driver), { installed: true, serviceActive: true, sshConfigured: true, encryption: 'unverified', modelMessagesSent: 0 });
  const backend = tls.createServer({ key: tlsKey, cert: tlsCert, minVersion: 'TLSv1.3' }, socket => socket.end('isolated-test-ok'));
  await new Promise((resolve, reject) => { backend.once('error', reject); backend.listen(0, '127.0.0.1', resolve); });
  try {
    tunnel = spawn('ssh', ['-N', '-i', keyPath, '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${tmp}/known_hosts`, '-p', String(sshPort), '-R', `/tunnel/relay.sock:127.0.0.1:${backend.address().port}`, 'rayneosystest@127.0.0.1'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; tunnel.stderr.on('data', chunk => { stderr += chunk; });
    await new Promise((resolve, reject) => {
      const started = Date.now();
      const poll = () => {
        if (tunnel.exitCode !== null) return reject(Error('SSH failed: ' + stderr));
        const socket = tls.connect({ host: '127.0.0.1', port: relayPort, servername: 'localhost', rejectUnauthorized: false }, () => {
          if (socket.getPeerCertificate().fingerprint256 !== expectedFingerprint || tls.checkServerIdentity('localhost', socket.getPeerCertificate())) socket.destroy();
        });
        let data = ''; socket.on('data', chunk => { data += chunk; });
        socket.on('error', () => {});
        socket.on('close', () => { if (data === 'isolated-test-ok') resolve(); else if (Date.now() - started > 8000) reject(Error('Tunnel did not become ready: ' + stderr)); else setTimeout(poll, 200); });
      }; poll();
    });
  } finally { tunnel?.kill(); await new Promise(resolve => backend.close(resolve)); }
  run('systemctl', ['restart', plan.unitName, plan.sshUnitName]);
  await new Promise(resolve => setTimeout(resolve, 1200));
  const restarted = await checkInstalledRelay(plan, driver);
  assert.equal(restarted.installed && restarted.serviceActive && restarted.sshConfigured, true);
  const launchPort = await freePort(), launchConfig = join(tmp, 'hosted.json');
  writeFileSync(launchConfig, JSON.stringify({ version: 1, listenHost: '127.0.0.1', listenPort: launchPort,
    databasePath: join(tmp, 'launcher.sqlite'), tlsKeyPath: join(tmp, 'tls.key'), tlsCertPath: join(tmp, 'tls.crt'),
    slots: [{ id: 'test', publicBaseUrl: bundle.invitation.publicBaseUrl, relay: bundle.invitation.relay }] }), { mode: 0o600 });
  const launcher = spawn(process.execPath, ['relay/hosted-launch.mjs', '--config', launchConfig], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Hosted service did not start')), 10000);
      launcher.stdout.on('data', chunk => { if (chunk.toString().includes('HOSTED_READY')) { clearTimeout(timer); resolve(); } });
      launcher.once('exit', code => { clearTimeout(timer); reject(Error('Hosted service exited: ' + code)); });
    });
    const status = await new Promise((resolve, reject) => {
      const request = https.get({ host: '127.0.0.1', servername: 'localhost', port: launchPort, path: '/', ca: tlsCert }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
      request.on('error', reject);
    });
    assert.equal(status, 404);
  } finally {
    if (launcher.exitCode === null && launcher.signalCode === null) { const stopped = new Promise(resolve => launcher.once('exit', resolve)); launcher.kill('SIGTERM'); await stopped; }
  }
  console.log('REAL_SYSTEMD_SSH_UNIX_RELAY_OK');
} finally {
  tunnel?.kill();
  try { if (runtime) await runtime.close(); }
  finally {
    try { if (installed) await driver.rollback(plan); }
    finally { rmSync(tmp, { recursive: true, force: true }); }
  }
}
