// Manual integration: a disposable Linux container, real useradd/sshd and a simulated service manager.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const files = ['relay/install.mjs', 'relay/provision.mjs', 'relay/unix-provision.mjs', 'relay/server.mjs', 'secure-link/config.mjs'];
const lines = [
  'set -eu',
  'export DEBIAN_FRONTEND=noninteractive',
  ...(process.env.RAYNEO_RELAY_TEST_HTTPS === '1' ? ["sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources"] : []),
  'apt-get -o Acquire::Retries=3 update -qq',
  'apt-get -o Acquire::Retries=3 install -y -qq --no-install-recommends openssh-server systemd iproute2 >/dev/null',
  'mkdir -p /run/sshd /tmp/relay-check/relay /tmp/relay-check/secure-link /tmp/relay-check/root/etc/ssh /tmp/relay-check/root/etc/systemd/system /tmp/relay-check/root/var/lib',
  'cp /etc/ssh/ssh_host_ed25519_key.pub /tmp/relay-check/root/etc/ssh/ssh_host_ed25519_key.pub',
  ...files.map(path => `printf '%s' '${readFileSync(new URL('../../' + path, import.meta.url)).toString('base64')}' | base64 -d > /tmp/relay-check/${path}`),
  "cat > /tmp/relay-check/check.mjs <<'RAYNEO_INSTALL_TEST'",
  String.raw`import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createUnixRelayBundle } from './relay/unix-provision.mjs';
import { createInstallPlan, createLinuxInstallDriver, installRelay, checkInstalledRelay, checkRelayPrerequisites } from './relay/install.mjs';
const root = '/tmp/relay-check/root';
const key = readFileSync('/etc/ssh/ssh_host_ed25519_key.pub', 'utf8').trim().split(/\s+/).slice(0, 2).join(' ');
const source = '/tmp/relay-check/relay/server.mjs';
for (const failVerify of [false, true]) {
  const user = failVerify ? 'rayneofail' : 'rayneosuccess';
  const bundle = createUnixRelayBundle({ enrollment: { version: 1, installationId: randomUUID(), requestedBackends: ['paseo'], sshPublicKey: key },
    hosting: 'self-hosted', publicBaseUrl: 'https://relay.example.test:24443', relay: { host: 'relay.example.test', port: 2223, user, hostKey: key } });
  const plan = createInstallPlan(bundle, '/usr/local/bin/node');
  const run = (command, args) => {
    if (command === 'systemd-analyze') {
      if (failVerify) throw Error('simulated verification failure');
      args = args.map(arg => arg.startsWith('/etc/systemd/system/') ? join(root, arg) : arg);
    }
    if (command === 'systemctl') {
      if (args[0] === 'show') {
        if (args.includes('--property=FragmentPath')) return (args.includes(plan.sshUnitName) ? plan.sshUnitPath : plan.unitPath) + '\n';
        if (args.includes('--property=NeedDaemonReload')) return 'no\n';
        return args.includes('--property=ActiveState') ? 'inactive\n' : 'not-found\n';
      }
      return '';
    }
    if (command === 'sshd') args = args.map((arg, i) => i > 0 && args[i - 1] === '-f' ? join(root, arg) : arg);
    try { return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { if (!(command === 'getent' && error.status === 2)) console.error(command, error.message, String(error.stderr ?? '')); throw error; }
  };
  if (!failVerify) {
    const realHostDriver = createLinuxInstallDriver({ root: '/', serverSource: source, run });
    const prerequisites = await checkRelayPrerequisites(plan, realHostDriver);
    assert.equal(prerequisites.ready, prerequisites.portBinding === 'verified');
    assert.equal(prerequisites.networkReachability, 'unverified');
    assert.equal(existsSync(plan.directory), false);
    assert.throws(() => execFileSync('getent', ['passwd', user], { stdio: 'pipe' }), e => e.status === 2);
    // This container check is read-only on its root; the separate systemd fixture
    // exercises actual installation in the explicitly marked test distribution.
  }
  const driver = createLinuxInstallDriver({ root, serverSource: source, run });
  if (failVerify) {
    await assert.rejects(installRelay(plan, driver), { code: 'RELAY_INSTALL_FAILED' });
  } else {
    assert.equal((await installRelay(plan, driver)).installed, true);
    assert.deepEqual(await checkInstalledRelay(plan, driver), { installed: true, serviceActive: true, sshConfigured: true, encryption: 'unverified', modelMessagesSent: 0 });
    await driver.rollback(plan);
  }
  assert.equal(existsSync(join(root, plan.directory)), false);
  assert.throws(() => execFileSync('getent', ['passwd', user], { stdio: 'pipe' }), e => e.status === 2);
}
console.log('REAL_SSHD_AND_ACCOUNT_ROLLBACK_OK');`,
  'RAYNEO_INSTALL_TEST',
  'node /tmp/relay-check/check.mjs',
];
const result = spawnSync('docker', ['run', '--rm', '-i', process.env.RAYNEO_RELAY_TEST_IMAGE || 'node:22-bookworm-slim', 'sh', '-s'],
  { input: lines.join('\n') + '\n', encoding: 'utf8', timeout: 180000, windowsHide: true });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) process.stderr.write(`Isolated installer test failed: ${result.error.message}\n`);
if (result.error || result.status !== 0) process.exitCode = 1;
