// Only the dedicated, explicitly marked disposable WSL distribution may run this fixture.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, connect } from 'node:net';
import { createServerInstallCommand } from '../../distribution/self-hosted-command.mjs';
import { createPairingInformation, requestBootstrap } from '../../relay/self-hosted-bootstrap.mjs';
import { createUnixRelayBundle } from '../../relay/unix-provision.mjs';
import { createInstallPlan, createLinuxInstallDriver, checkInstalledRelay } from '../../relay/install.mjs';
import { fileURLToPath } from 'node:url';

assert.equal(process.env.RAYNEO_ISOLATED_SYSTEMD_TEST, '1');
assert.equal(process.getuid(), 0);
assert.ok(existsSync('/etc/rayneo-isolated-systemd-test-only'));
mkdirSync('/run/sshd', { recursive: true, mode: 0o755 });
const run = (program, args) => execFileSync(program, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
const dir = mkdtempSync('/run/rayneo-auto-acceptance-'), host = process.env.RAYNEO_TEST_DOMAIN === '1' ? 'relay.example.com' : '192.0.2.10', passphrase = randomBytes(32).toString('hex');
const client = join(dir, 'client');
run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', client]);
run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=auto-test',
  '-addext', `subjectAltName=${process.env.RAYNEO_TEST_DOMAIN === '1' ? 'DNS' : 'IP'}:${host}`, '-keyout', join(dir, 'key'), '-out', join(dir, 'cert')]);
run('openssl', ['pkcs12', '-export', '-inkey', join(dir, 'key'), '-in', join(dir, 'cert'), '-out', join(dir, 'pfx'), '-passout', `pass:${passphrase}`]);
const cert = readFileSync(join(dir, 'cert')), pfx = readFileSync(join(dir, 'pfx')), secret = randomBytes(32).toString('base64url');
const expiresAt = Date.now() + 300000;
const cmd = createServerInstallCommand({ host, cert: new X509Certificate(cert).raw.toString('base64'), pfx: pfx.toString('base64'), passphrase, secret, expiresAt });
const usePty = process.env.RAYNEO_TEST_PTY === '1';
const child = usePty ? spawn('script', ['-qefc', 'bash --noprofile --norc', '/dev/null'], { stdio: ['pipe', 'pipe', 'pipe'] })
  : spawn('bash', ['-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
if (usePty) child.stdin.write(cmd + '\n');
let stdout = '', stderr = '', plan, tunnel, upstream;
child.stderr.on('data', chunk => { stderr += chunk; });
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('AUTO_BOOTSTRAP_TIMEOUT')), 120000);
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.includes('正在等待电脑自动连接')) { clearTimeout(timer); resolve(); } });
    child.once('exit', code => { clearTimeout(timer); reject(Error('AUTO_BOOTSTRAP_EXIT_' + code)); });
  });
  assert.doesNotMatch(stdout, /RNP1-|请输入服务器公网/);
  const enrollment = { version: 1, installationId: randomUUID(), requestedBackends: ['paseo'], sshPublicKey: readFileSync(client + '.pub', 'utf8').trim() };
  const info = createPairingInformation({ host, port: 2222, cert, secret });
  const invitation = await requestBootstrap({ info, enrollment, allowLoopback: true, connectHost: '127.0.0.1' });
  const bundle = createUnixRelayBundle({ enrollment, ...invitation });
  plan = createInstallPlan(bundle, '/usr/local/bin/node');
  const driver = createLinuxInstallDriver({ serverSource: fileURLToPath(new URL('../../relay/server.mjs', import.meta.url)) });
  const status = await checkInstalledRelay(plan, driver);
  assert.equal(status.installed, true); assert.equal(status.serviceActive, true); assert.equal(status.sshConfigured, true);
  const known = join(dir, 'known_hosts'); writeFileSync(known, 'auto-test ' + invitation.relay.hostKey + '\n');
  upstream = createServer(socket => socket.end('auto-relay-ok'));
  await new Promise((resolve, reject) => { upstream.once('error', reject); upstream.listen(0, '127.0.0.1', resolve); });
  tunnel = spawn('ssh', ['-N', '-i', client, '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'HostKeyAlias=auto-test', '-o', 'UserKnownHostsFile=' + known, '-p', '2222', '-R', '/tunnel/relay.sock:127.0.0.1:' + upstream.address().port,
    invitation.relay.user + '@127.0.0.1'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let tunnelError = ''; tunnel.stderr.on('data', chunk => tunnelError += chunk);
  await new Promise((resolve, reject) => { const timer = setTimeout(resolve, 1500); tunnel.once('exit', () => { clearTimeout(timer); reject(Error('SSH_TUNNEL_FAILED ' + tunnelError)); }); });
  const result = await new Promise((resolve, reject) => { const socket = connect(443, '127.0.0.1'); let body = '';
    socket.on('data', chunk => body += chunk); socket.on('end', () => resolve(body)); socket.on('error', reject); });
  assert.equal(result, 'auto-relay-ok');
  console.log('ISOLATED_AUTO_INSTALL_AND_AUTHENTICATED_RELAY_OK');
} catch (error) { console.error('ISOLATED_AUTO_INSTALL_FAILED ' + stderr.slice(-500)); throw error; }
finally {
  if (tunnel?.exitCode === null) tunnel.kill('SIGTERM');
  upstream?.close(); if (child.exitCode === null) child.kill('SIGTERM');
  if (plan) { try { run('systemctl', ['disable', '--now', plan.unitName, plan.sshUnitName]); } catch { console.error('ISOLATED_SERVICES_STOP_FAILED'); } }
}
