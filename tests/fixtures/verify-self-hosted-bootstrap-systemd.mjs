// Run only inside the explicitly marked disposable WSL distribution.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect, createServer } from 'node:net';
import { createServerInstallCommand } from '../../distribution/self-hosted-command.mjs';
import { fileURLToPath } from 'node:url';
import { decodePairingInformation, requestBootstrap } from '../../relay/self-hosted-bootstrap.mjs';
import { createUnixRelayBundle } from '../../relay/unix-provision.mjs';
import { createInstallPlan, createLinuxInstallDriver, checkInstalledRelay } from '../../relay/install.mjs';

assert.equal(process.env.RAYNEO_ISOLATED_SYSTEMD_TEST, '1');
assert.equal(process.getuid(), 0);
assert.ok(existsSync('/etc/rayneo-isolated-systemd-test-only'));
mkdirSync('/run/sshd', { recursive: true, mode: 0o755 });
const command = (name, args) => execFileSync(name, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
const directory = mkdtempSync('/run/rayneo-bootstrap-acceptance-'), client = join(directory, 'client');
command('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', client]);
const sshPublicKey = readFileSync(client + '.pub', 'utf8').trim(), installationId = randomUUID();
writeFileSync(join(directory, 'installation-id'), installationId + '\n');
const enrollment = { version: 1, installationId, requestedBackends: ['paseo'], sshPublicKey };
let blockedPort;
if (process.env.RAYNEO_TEST_BLOCK_PORT === '1') {
  blockedPort = createServer();
  await new Promise((resolve, reject) => { blockedPort.once('error', reject); blockedPort.listen(443, '0.0.0.0', resolve); });
}
let installCommand = createServerInstallCommand();
// Only this isolated fixture preserves the restricted PATH to simulate a server with no Node in PATH.
if (process.env.RAYNEO_TEST_KEEP_PATH === '1') installCommand = installCommand.replace(/^sudo python3 /, 'sudo --preserve-env=PATH python3 ');
const usePty = process.env.RAYNEO_TEST_PTY === '1';
const child = usePty ? spawn('script', ['-qefc', 'bash --noprofile --norc', '/dev/null'], { stdio: ['pipe', 'pipe', 'pipe'] })
  : spawn('bash', ['-c', installCommand], { stdio: ['pipe', 'pipe', 'pipe'] });
let stderr = '', stdout = '', plan, tunnel, upstream;
child.stderr.on('data', data => { stderr += data; });
if (usePty) child.stdin.write(installCommand + '\n');
else child.stdin.end('192.0.2.10\n');
try {
  const encoded = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('BOOTSTRAP_READY_TIMEOUT')), 180000);
    let ipSent = false;
    child.stdout.on('data', data => {
      stdout += data;
      if (usePty && !ipSent && stdout.includes('请输入服务器公网 IPv4')) { ipSent = true; child.stdin.write('192.0.2.10\n'); }
      const match = /(RNP1-[A-Za-z0-9_-]+)\r?\n/.exec(stdout); if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.once('exit', code => { clearTimeout(timer); reject(Error('BOOTSTRAP_EXIT_' + code + ' ' + stderr.slice(-250))); });
  });
  const info = decodePairingInformation(encoded);
  if (blockedPort) {
    await assert.rejects(requestBootstrap({ info, enrollment, allowLoopback: true, connectHost: '127.0.0.1' }));
    assert.equal(blockedPort.listening, true);
    console.log('ISOLATED_OCCUPIED_PORT_REJECTED_WITH_EXISTING_SERVICE_UNCHANGED');
  } else {
  const invitation = await requestBootstrap({ info, enrollment, allowLoopback: true, connectHost: '127.0.0.1' });
  const bundle = createUnixRelayBundle({ enrollment, ...invitation });
  plan = createInstallPlan(bundle, process.env.RAYNEO_EXPECT_NODE ?? '/usr/local/bin/node');
  const driver = createLinuxInstallDriver({ serverSource: fileURLToPath(new URL('../../relay/server.mjs', import.meta.url)) });
  const status = await checkInstalledRelay(plan, driver);
  assert.equal(status.installed, true); assert.equal(status.serviceActive, true); assert.equal(status.sshConfigured, true);
  writeFileSync(join(directory, 'known_hosts'), 'acceptance ' + invitation.relay.hostKey + '\n');
  upstream = createServer(socket => socket.end('relay-ok'));
  await new Promise((resolve, reject) => { upstream.once('error', reject); upstream.listen(0, '127.0.0.1', resolve); });
  tunnel = spawn('ssh', ['-N', '-i', client, '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'StrictHostKeyChecking=yes', '-o', 'HostKeyAlias=acceptance', '-o', 'UserKnownHostsFile=' + join(directory, 'known_hosts'),
    '-p', '2222', '-R', '/tunnel/relay.sock:127.0.0.1:' + upstream.address().port, invitation.relay.user + '@127.0.0.1'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let tunnelError = ''; tunnel.stderr.on('data', data => tunnelError += data);
  await new Promise((resolve, reject) => { const timer = setTimeout(resolve, 1500); tunnel.once('exit', () => { clearTimeout(timer); reject(Error('SSH_TUNNEL_FAILED ' + tunnelError)); }); });
  const result = await new Promise((resolve, reject) => { const clientSocket = connect(443, '127.0.0.1'); let data = '';
    clientSocket.on('data', chunk => data += chunk); clientSocket.on('end', () => resolve(data)); clientSocket.on('error', reject); });
  assert.equal(result, 'relay-ok');
  console.log('ISOLATED_BOOTSTRAP_COMMAND_INSTALL_AND_SSH_RELAY_OK');
  }
} catch (error) {
  console.error('ISOLATED_BOOTSTRAP_FAILED ' + stderr.slice(-250));
  throw error;
} finally {
  if (tunnel?.exitCode === null) tunnel.kill('SIGTERM');
  if (upstream) upstream.close();
  if (blockedPort) blockedPort.close();
  if (child.exitCode === null) child.kill('SIGTERM');
  if (plan) {
    try { command('systemctl', ['disable', '--now', plan.unitName, plan.sshUnitName]); } catch { console.error('ISOLATED_SERVICES_STOP_FAILED'); }
  }
}
