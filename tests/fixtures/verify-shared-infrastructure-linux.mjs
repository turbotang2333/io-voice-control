// Exclusive to the dedicated disposable WSL distribution; never use a real host.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import tls from 'node:tls';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedInfrastructurePlan, inspectSharedInfrastructure, installSharedInfrastructure, isSafeSharedNode } from '../../relay/shared-infrastructure.mjs';
import { installSharedHostedService } from '../../relay/shared-hosted-launch.mjs';
import { accountForInstallation } from '../../relay/shared-configuration.mjs';
import { writeSharedInstallerBundle } from '../../relay/shared-package.mjs';
import { createInviteStore } from '../../relay/invite-store.mjs';

assert.equal(process.env.RAYNEO_ISOLATED_SYSTEMD_TEST, '1');
assert.equal(process.getuid(), 0);
assert.equal(existsSync('/etc/rayneo-isolated-systemd-test-only'), true);
for (const path of ['/etc/rayneo-paseo-shared', '/opt/rayneo-paseo-shared', '/var/lib/rayneo-shared',
  '/etc/systemd/system/rayneo-shared-ssh.service', '/etc/systemd/system/rayneo-shared-router.service',
  '/etc/systemd/system/rayneo-shared-hosted.service', '/var/lib/rayneo-paseo-shared-hosted']) assert.equal(existsSync(path), false);
const run = (name, args) => execFileSync(name, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
const freePort = () => new Promise((resolve, reject) => { const s = createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const tmp = mkdtempSync('/run/rayneo-shared-infra-test-');
let driver, hostedDriver, installed = false, hostedInstalled = false, backend, tunnel, account;
try {
  assert.equal(isSafeSharedNode('/usr/local/bin/node'), true);
  const privateBin = join(tmp, 'private-node'); writeFileSync(privateBin, 'fixture'); chmodSync(privateBin, 0o755);
  assert.equal(isSafeSharedNode(privateBin), false);
  mkdirSync('/run/sshd', { recursive: true, mode: 0o755 });
  const publicPort = await freePort(); let sshPort = await freePort();
  while (sshPort === publicPort) sshPort = await freePort();
  const options = { publicPort, sshPort, suffix: 'relay.example.test', nodePath: '/usr/local/bin/node', listenHost: '127.0.0.1' };
  const plan = createSharedInfrastructurePlan(options);
  const bundleRoot = join(tmp, 'bundle'); writeSharedInstallerBundle({ output: bundleRoot });
  const packagedInfra = await import(pathToFileURL(join(bundleRoot, 'relay/shared-infrastructure-linux.mjs')).href);
  const packagedHosted = await import(pathToFileURL(join(bundleRoot, 'relay/shared-hosted-linux.mjs')).href);
  driver = packagedInfra.createSharedLinuxInfrastructureDriver({ sourceRoot: bundleRoot, options, run: (name, args) => {
    try { return run(name, args); } catch (error) { if (!(name === 'getent' && error.status === 2)) console.error('test command failed:', name, args.join(' '), String(error.stderr ?? '')); throw error; }
  } });
  const traced = Object.fromEntries(Object.entries(driver).map(([name, method]) => [name, async (...args) => {
    try { const value = await method(...args); if (name === 'check' && value !== true) console.error('test check returned false'); return value; }
    catch (error) { console.error('test stage failed:', name, error.code ?? error.message); throw error; }
  }]));
  assert.deepEqual(await installSharedInfrastructure(options, traced), { installed: true, encryption: 'unverified' }); installed = true;
  assert.equal(await inspectSharedInfrastructure(options), true);
  run('systemctl', ['restart', 'rayneo-shared-ssh.service', 'rayneo-shared-router.service']);
  assert.equal(await inspectSharedInfrastructure(options), true);
  const certificate = (name, label) => {
    const key = join(tmp, label + '.key'), cert = join(tmp, label + '.crt');
    run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=' + name,
      '-addext', 'subjectAltName=DNS:' + name, '-keyout', key, '-out', cert]);
    return { key: readFileSync(key), cert: readFileSync(cert), keyPath: key, certPath: cert };
  };
  const enrollmentTls = certificate('localhost', 'enrollment');
  const hostKey = readFileSync('/etc/ssh/ssh_host_ed25519_key.pub', 'utf8').trim().split(/\s+/).slice(0, 2).join(' ');
  const shared = { publicBaseUrl: `https://relay.example.test:${publicPort}`, relay: { host: 'ssh.example.test', port: sshPort, hostKey } };
  let enrollmentPort = await freePort(); while ([publicPort, sshPort].includes(enrollmentPort)) enrollmentPort = await freePort();
  const hostedConfig = { version: 1, listenHost: '127.0.0.1', listenPort: enrollmentPort, databasePath: '/var/lib/rayneo-paseo-shared-hosted/registry.sqlite', inviteDatabasePath: '/var/lib/rayneo-paseo-shared-hosted/invites.sqlite',
    tlsKeyPath: enrollmentTls.keyPath, tlsCertPath: enrollmentTls.certPath, maxAllocations: 100, infrastructure: options, shared };
  hostedDriver = packagedHosted.createSharedHostedLinuxDriver({ config: hostedConfig });
  assert.deepEqual(await installSharedHostedService(hostedConfig, hostedDriver), { installed: true, encryption: 'unverified' }); hostedInstalled = true;
  const invites = await createInviteStore({ path: hostedConfig.inviteDatabasePath });
  const inviteCode = invites.issue(), secondCode = invites.issue(); invites.close();
  const id = randomUUID(), hostname = `${id}.relay.example.test`; account = accountForInstallation(id);
  const key = join(tmp, 'client'); run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
  const request = { version: 1, installationId: id, requestedBackends: ['paseo'], sshPublicKey: readFileSync(key + '.pub', 'utf8').trim() };
  const enroll = (value, code = inviteCode) => new Promise((resolve, reject) => {
    const body = JSON.stringify(value), req = https.request({ host: '127.0.0.1', port: enrollmentPort, servername: 'localhost',
      ca: enrollmentTls.cert, path: '/v1/enroll', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-invite-code': code } }, res => {
      const data = []; res.on('data', b => data.push(b)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(data)) }));
    }); req.on('error', reject); req.end(body);
  });
  const response = await enroll(request); assert.equal(response.status, 200); assert.equal(response.body.relay.user, account);
  const desktopTls = certificate(hostname, 'desktop');
  backend = tls.createServer(desktopTls, socket => socket.end('encrypted-desktop-ok'));
  await new Promise((resolve, reject) => backend.once('error', reject).listen(0, '127.0.0.1', resolve));
  tunnel = spawn('ssh', ['-N', '-i', key, '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${tmp}/known_hosts`, '-p', String(sshPort), '-R', `/tunnel/relay.sock:127.0.0.1:${backend.address().port}`,
    `${account}@127.0.0.1`], { stdio: ['ignore', 'ignore', 'pipe'] });
  let sshErrors = ''; tunnel.stderr.on('data', b => { sshErrors += b; });
  const until = Date.now() + 10000, socketPath = `/var/lib/rayneo-shared/${account}/tunnel/relay.sock`;
  while (!existsSync(socketPath)) {
    if (tunnel.exitCode !== null || Date.now() > until) throw Error('SSH failed: ' + sshErrors);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const reply = await new Promise((resolve, reject) => {
    const socket = tls.connect({ host: '127.0.0.1', port: publicPort, servername: hostname, ca: desktopTls.cert }); let data = '';
    socket.on('data', b => { data += b; }); socket.on('end', () => resolve(data)); socket.on('error', reject);
  });
  assert.equal(reply, 'encrypted-desktop-ok');
  const sshConfig = '/etc/rayneo-paseo-shared/sshd_config';
  writeFileSync(sshConfig, plan.sshdConfig + '# altered\n');
  try {
    assert.equal(await inspectSharedInfrastructure(options), false);
    assert.equal((await enroll({ ...request, installationId: randomUUID() }, secondCode)).status, 503);
  } finally { writeFileSync(sshConfig, plan.sshdConfig); }
  assert.equal(await inspectSharedInfrastructure(options), true);
  run('systemctl', ['restart', 'rayneo-shared-hosted.service']);
  for (let attempt = 0; attempt < 30; attempt++) {
    try { if ((await enroll(request)).status === 200) break; } catch {}
    if (attempt === 29) throw Error('Hosted service failed to recover after restart');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  console.log('SHARED_SYSTEMD_HOSTED_ENROLL_SSH_TLS_RESTART_OK');
} finally {
  if (tunnel && tunnel.exitCode === null && tunnel.signalCode === null) await new Promise(resolve => { tunnel.once('exit', resolve); tunnel.kill('SIGTERM'); });
  if (backend) await new Promise(resolve => backend.close(resolve));
  if (hostedInstalled) run('systemctl', ['stop', 'rayneo-shared-hosted.service']);
  if (account) {
    try { run('getent', ['passwd', account]); run('userdel', [account]); } catch (error) { if (error.status !== 2) throw error; }
    const directory = `/var/lib/rayneo-shared/${account}`;
    if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
  }
  try {
    if (hostedInstalled) {
      const database = '/var/lib/rayneo-paseo-shared-hosted/registry.sqlite';
      rmSync(database, { force: true }); rmSync(database + '.locks', { recursive: true, force: true });
      rmSync('/var/lib/rayneo-paseo-shared-hosted/invites.sqlite', { force: true });
      await hostedDriver.rollback();
    }
    if (installed) await driver.rollback();
  }
  finally { rmSync(tmp, { recursive: true, force: true }); }
}
