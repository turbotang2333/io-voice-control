import { sharedHostname, createSharedSshConfig } from './shared-configuration.mjs';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, join } from 'node:path';

const fail = () => { throw Object.assign(Error('SHARED_INFRASTRUCTURE_INVALID'), { code: 'SHARED_INFRASTRUCTURE_INVALID' }); };

export function isSafeSharedNode(path) {
  try {
    if (process.platform !== 'linux' || !isAbsolute(path)) return false;
    const actual = realpathSync(path), executable = lstatSync(actual);
    if (!executable.isFile() || executable.isSymbolicLink() || executable.uid !== 0 || (executable.mode & 0o022) || !(executable.mode & 0o001)) return false;
    for (const value of [path, actual]) {
      let parent = dirname(value);
      while (true) {
        const stat = lstatSync(parent);
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) || !(stat.mode & 0o001)) return false;
        if (parent === '/') break;
        parent = dirname(parent);
      }
    }
    return true;
  } catch { return false; }
}

// Only prepares deterministic files. Installation and service startup are separate operations.
export function createSharedInfrastructurePlan({ publicPort, sshPort, suffix, nodePath, listenHost = '0.0.0.0' } = {}) {
  if (!Number.isInteger(publicPort) || publicPort < 1 || publicPort > 65535 || !Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535
    || publicPort === sshPort || !['0.0.0.0', '127.0.0.1'].includes(listenHost) || !/^\/[A-Za-z0-9_./-]+$/.test(nodePath ?? '') || nodePath.includes('..')) fail();
  sharedHostname('00000000-0000-0000-0000-000000000000', suffix);
  const routerConfig = { version: 1, listenHost, listenPort: publicPort, suffix };
  const sshdConfig = createSharedSshConfig({ port: sshPort, listenHost });
  const capability = publicPort < 1024 ? 'AmbientCapabilities=CAP_NET_BIND_SERVICE\nCapabilityBoundingSet=CAP_NET_BIND_SERVICE\n' : 'CapabilityBoundingSet=\n';
  const routerUnit = `[Unit]\nDescription=RayNeo shared encrypted relay\nAfter=network.target\n\n[Service]\nType=simple\nUser=rayneo-router\nGroup=rayneo-relay\nNoNewPrivileges=yes\n${capability}ProtectSystem=strict\nProtectHome=yes\nPrivateTmp=yes\nPrivateDevices=yes\nRestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX\nUMask=0077\nExecStart=${nodePath} /opt/rayneo-paseo-shared/relay/shared-router-launch.mjs --config /etc/rayneo-paseo-shared/router.json\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=multi-user.target\n`;
  const sshUnit = `[Unit]\nDescription=RayNeo shared restricted SSH\nAfter=network.target\n\n[Service]\nType=simple\nExecStart=/usr/sbin/sshd -D -e -f /etc/rayneo-paseo-shared/sshd_config\nRestart=on-failure\nRestartSec=5\nNoNewPrivileges=yes\n\n[Install]\nWantedBy=multi-user.target\n`;
  const files = { '/etc/rayneo-paseo-shared/router.json': JSON.stringify(routerConfig) + '\n',
    '/etc/rayneo-paseo-shared/sshd_config': sshdConfig,
    '/etc/systemd/system/rayneo-shared-router.service': routerUnit,
    '/etc/systemd/system/rayneo-shared-ssh.service': sshUnit };
  const sourceFiles = ['relay/shared-router-launch.mjs', 'relay/shared-router.mjs', 'relay/shared-client-hello.mjs', 'relay/shared-configuration.mjs',
    'relay/shared-hosted-launch.mjs', 'relay/shared-hosted-service.mjs', 'relay/shared-hosted-runtime.mjs', 'relay/shared-hosted-allocator.mjs', 'relay/invite-store.mjs', 'relay/invite-admin.mjs',
    'relay/shared-account-driver.mjs', 'relay/shared-infrastructure.mjs', 'relay/hosted-allocator.mjs', 'relay/hosted-server.mjs',
    'relay/unix-provision.mjs', 'secure-link/config.mjs', 'distribution/hosted-enrollment.mjs'].map(path => '/opt/rayneo-paseo-shared/' + path);
  return { routerConfig, sshdConfig, routerUnit, sshUnit, files, sourceFiles };
}

export async function inspectSharedInfrastructure(options, { root = '/', strictOwners = true,
  run = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }) } = {}) {
  try {
    if (!isAbsolute(root) || typeof run !== 'function') return false;
    const plan = createSharedInfrastructurePlan(options), local = path => join(root, path.replace(/^\/+/, ''));
    if (strictOwners && !isSafeSharedNode(options.nodePath)) return false;
    const safe = (path, directory) => {
      const stat = lstatSync(local(path));
      return (directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1) && !stat.isSymbolicLink()
        && (!strictOwners || stat.uid === 0 && !(stat.mode & 0o022));
    };
    for (const path of ['/etc', '/etc/rayneo-paseo-shared', '/etc/systemd', '/etc/systemd/system', '/opt', '/opt/rayneo-paseo-shared',
      '/opt/rayneo-paseo-shared/relay', '/opt/rayneo-paseo-shared/secure-link', '/opt/rayneo-paseo-shared/distribution', '/var', '/var/lib', '/var/lib/rayneo-shared']) {
      if (!safe(path, true)) return false;
    }
    for (const [path, content] of Object.entries(plan.files)) if (!safe(path, false) || readFileSync(local(path), 'utf8') !== content) return false;
    for (const path of plan.sourceFiles) if (!safe(path, false)) return false;
    const command = (name, args) => String(run(name, args) ?? '').trim();
    const group = command('getent', ['group', 'rayneo-relay']).split(':');
    const user = command('getent', ['passwd', 'rayneo-router']).split(':');
    if (group.length !== 4 || group[0] !== 'rayneo-relay' || !/^\d+$/.test(group[2]) || Number(group[2]) === 0
      || user.length !== 7 || user[0] !== 'rayneo-router' || !/^\d+$/.test(user[2]) || Number(user[2]) === 0
      || user[3] !== group[2] || user[6] !== '/usr/sbin/nologin' || command('id', ['-G', 'rayneo-router']) !== group[2]) return false;
    command('sshd', ['-t', '-f', '/etc/rayneo-paseo-shared/sshd_config']);
    for (const unit of ['rayneo-shared-router.service', 'rayneo-shared-ssh.service']) {
      command('systemctl', ['is-active', '--quiet', unit]);
      if (command('systemctl', ['show', '--property=FragmentPath', '--value', unit]) !== '/etc/systemd/system/' + unit
        || command('systemctl', ['show', '--property=NeedDaemonReload', '--value', unit]) !== 'no') return false;
    }
    return true;
  } catch { return false; }
}

export async function installSharedInfrastructure(options, driver) {
  const plan = createSharedInfrastructurePlan(options);
  if (!driver || ['preflight', 'createFiles', 'createAccounts', 'verify', 'start', 'check', 'rollback'].some(name => typeof driver[name] !== 'function')) fail();
  await driver.preflight(plan);
  try {
    await driver.createFiles(plan);
    await driver.createAccounts(plan);
    await driver.verify(plan);
    await driver.start(plan);
    if (await driver.check(plan) !== true) throw Error('shared infrastructure unverified');
    return { installed: true, encryption: 'unverified' };
  } catch {
    try { await driver.rollback(plan); } catch { throw Object.assign(Error('SHARED_INSTALL_UNCERTAIN'), { code: 'SHARED_INSTALL_UNCERTAIN' }); }
    throw Object.assign(Error('SHARED_INSTALL_FAILED'), { code: 'SHARED_INSTALL_FAILED' });
  }
}
