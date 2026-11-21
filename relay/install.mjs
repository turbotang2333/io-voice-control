import { createRelayBundle } from './provision.mjs';
import { createUnixRelayBundle } from './unix-provision.mjs';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, chownSync, closeSync, existsSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const fail = code => Object.assign(Error(code), { code });

/** Installation material contains public routing information only; private credentials stay on the computer. */
export function createInstallPlan(bundle, nodePath) {
  if (!/^\/[A-Za-z0-9_./-]+$/.test(nodePath ?? '') || nodePath.includes('..')) throw fail('RELAY_INSTALL_INPUT_INVALID');
  let validated;
  try {
    const create = bundle.invitation.version === 3 ? createUnixRelayBundle : createRelayBundle;
    validated = create({ enrollment: { version: 1, installationId: bundle.invitation.installationId,
      requestedBackends: bundle.invitation.backends, sshPublicKey: bundle.authorizedKey.split(' ').slice(1).join(' ').trim() },
      ...bundle.invitation });
    if (JSON.stringify(validated.relayConfig) !== JSON.stringify(bundle.relayConfig)
      || validated.authorizedKey !== bundle.authorizedKey || validated.sshdConfig !== bundle.sshdConfig) throw Error();
  } catch { throw fail('RELAY_INSTALL_INPUT_INVALID'); }
  const { invitation, relayConfig, authorizedKey } = validated;
  const directory = '/var/lib/rayneo-relay/' + invitation.installationId;
  const unitName = 'rayneo-relay-' + invitation.installationId + '.service';
  if (invitation.version === 3) {
    const sshUnitName = 'rayneo-ssh-' + invitation.installationId + '.service';
    const unitPath = '/etc/systemd/system/' + unitName, sshUnitPath = '/etc/systemd/system/' + sshUnitName;
    const capability = relayConfig.listenPort < 1024 ? 'AmbientCapabilities=CAP_NET_BIND_SERVICE\nCapabilityBoundingSet=CAP_NET_BIND_SERVICE\n'
      : 'CapabilityBoundingSet=\n';
    const serviceUnit = `[Unit]\nDescription=RayNeo encrypted relay ${invitation.installationId}\nAfter=network.target\n\n[Service]\nType=simple\nUser=${invitation.relay.user}\nGroup=${invitation.relay.user}\nNoNewPrivileges=yes\n${capability}ProtectSystem=strict\nProtectHome=yes\nPrivateTmp=yes\nPrivateDevices=yes\nRestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX\nUMask=0077\nExecStart=${nodePath} ${directory}/relay-server.mjs --config ${directory}/relay.json\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=multi-user.target\n`;
    const sshUnit = `[Unit]\nDescription=RayNeo dedicated SSH ${invitation.installationId}\nAfter=network.target\n\n[Service]\nType=simple\nExecStart=/usr/sbin/sshd -D -e -f ${directory}/sshd_config\nRestart=on-failure\nRestartSec=5\nNoNewPrivileges=yes\n\n[Install]\nWantedBy=multi-user.target\n`;
    return { isolation: 'unix', directory, unitName, unitPath, sshUnitName, sshUnitPath, sshUnit,
      sshdPath: directory + '/sshd_config', sshUser: invitation.relay.user, sshPort: invitation.relay.port,
      expectedHostKey: invitation.relay.hostKey, listenPort: relayConfig.listenPort, targetSocket: relayConfig.targetSocket,
      relayConfig, authorizedKey, sshdConfig: validated.sshdConfig, serviceUnit, nodePath };
  }
  const sshdPath = '/etc/ssh/sshd_config.d/20-rayneo-' + invitation.installationId + '.conf';
  const unitPath = '/etc/systemd/system/' + unitName;
  const sshdConfig = validated.sshdConfig.replace('Match all\n',
    `    AuthorizedKeysFile ${directory}/authorized_keys\n    AuthenticationMethods publickey\n    PubkeyAuthentication yes\n    PasswordAuthentication no\n    KbdInteractiveAuthentication no\n    PermitUserRC no\n    PermitTunnel no\nMatch all\n`);
  const capability = relayConfig.listenPort < 1024 ? 'AmbientCapabilities=CAP_NET_BIND_SERVICE\nCapabilityBoundingSet=CAP_NET_BIND_SERVICE\n'
    : 'CapabilityBoundingSet=\n';
  const serviceUnit = `[Unit]\nDescription=RayNeo encrypted relay ${invitation.installationId}\nAfter=network.target\n\n[Service]\nType=simple\nDynamicUser=yes\nNoNewPrivileges=yes\n${capability}ProtectSystem=strict\nProtectHome=yes\nPrivateTmp=yes\nPrivateDevices=yes\nRestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX\nUMask=0077\nExecStart=${nodePath} ${directory}/relay-server.mjs --config ${directory}/relay.json\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=multi-user.target\n`;
  return { directory, unitName, unitPath, sshdPath, sshUser: invitation.relay.user,
    expectedHostKey: invitation.relay.hostKey, listenPort: relayConfig.listenPort, remotePort: invitation.remotePort,
    relayConfig, authorizedKey, sshdConfig, serviceUnit, nodePath };
}

/** Driver owns only artifacts created by this invocation; its preflight must be read-only. */
export async function installRelay(plan, driver) {
  await driver.preflight(plan);
  try {
    await driver.createFiles(plan);
    await driver.createAccount(plan);
    await driver.verifySsh(plan);
    await driver.startService(plan);
    await driver.reloadSsh(plan);
    return { installed: true, encryption: 'unverified', modelMessagesSent: 0 };
  } catch (error) {
    try { await driver.rollback(plan); } catch { throw fail('RELAY_INSTALL_ROLLBACK_FAILED'); }
    throw fail('RELAY_INSTALL_FAILED');
  }
}

export async function checkInstalledRelay(plan, driver) {
  const value = await driver.check(plan);
  return { installed: value.installed === true, serviceActive: value.serviceActive === true,
    sshConfigured: value.sshConfigured === true, encryption: 'unverified', modelMessagesSent: 0 };
}

/** Checks host prerequisites without changing files, accounts, services, or binding ports. */
export async function checkRelayPrerequisites(plan, driver) {
  const result = await driver.preflight(plan, { readOnly: true });
  const portBinding = result?.portBinding === 'verified' ? 'verified' : 'unverified';
  return { ready: portBinding === 'verified', installed: false, portBinding, networkReachability: 'unverified', encryption: 'unverified', modelMessagesSent: 0 };
}

/** Linux/systemd installation; tests substitute an isolated root and command driver, never real system services. */
export function createLinuxInstallDriver({ root = '/', serverSource, platform = process.platform, uid = process.getuid?.(),
  strictOwners = true, writeData = writeFileSync, chownPath = chownSync,
  run = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }),
  probePort = port => new Promise(accept => {
    const socket = createServer();
    socket.once('error', () => accept(false));
    socket.listen(port, '0.0.0.0', () => socket.close(() => accept(true)));
  }) } = {}) {
  if (!isAbsolute(root ?? '') || !isAbsolute(serverSource ?? '')) throw fail('RELAY_INSTALL_INPUT_INVALID');
  const local = path => join(root, path.replace(/^\/+/, ''));
  const pathExists = path => { try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
  const created = [], createdDirectories = [];
  let accountCreated = false, accountCreationUncertain = false, unitEnabled = false, sshUnitEnabled = false, sshService, sshReloadAttempted = false;
  const command = (name, args) => String(run(name, args) ?? '');
  const secureDirectory = path => {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || strictOwners && (stat.uid !== 0 || (stat.mode & 0o022) !== 0)) throw fail('RELAY_DIRECTORY_UNSAFE');
  };
  const ensureDirectory = path => {
    if (!existsSync(path)) { mkdirSync(path, { mode: 0o755 }); createdDirectories.push(path); chmodSync(path, 0o755); }
    secureDirectory(path);
  };
  const put = (path, value, mode = 0o644) => {
    const fd = openSync(path, 'wx', mode);
    created.push(path);
    try { fchmodSync(fd, mode); writeData(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
  };
  const sshEffective = plan => {
    const configArgs = plan.isolation === 'unix' ? ['-f', plan.sshdPath] : [];
    command('sshd', ['-t', ...configArgs]);
    const output = command('sshd', ['-T', ...configArgs, '-C', `user=${plan.sshUser},host=localhost,addr=127.0.0.1`]);
    const values = new Map(output.trim().split(/\r?\n/).map(line => { const at = line.indexOf(' '); return [line.slice(0, at), line.slice(at + 1)]; }));
    const expected = { ...(plan.isolation === 'unix'
      ? { allowtcpforwarding: 'remote', permitlisten: 'none', allowstreamlocalforwarding: 'remote', streamlocalbindunlink: 'yes',
        streamlocalbindmask: '0177', chrootdirectory: plan.directory }
      : { allowtcpforwarding: 'remote', allowstreamlocalforwarding: 'no', gatewayports: 'no', permitlisten: `127.0.0.1:${plan.remotePort}` }),
      permittty: 'no', maxsessions: '0',
      authorizedkeysfile: plan.directory + '/authorized_keys', authenticationmethods: 'publickey', pubkeyauthentication: 'yes',
      passwordauthentication: 'no', kbdinteractiveauthentication: 'no', permituserrc: 'no', permittunnel: 'no' };
    if (Object.entries(expected).some(([key, value]) => values.get(key) !== value)) throw fail('RELAY_SSH_RESTRICTION_FAILED');
  };
  return {
    async preflight(plan, { readOnly = false } = {}) {
      if (platform !== 'linux' || uid !== 0) throw fail('RELAY_ROOT_REQUIRED');
      // A public TCP relay can otherwise expose an unrelated loopback service after the SSH tunnel drops.
      // Only the dedicated Unix-socket plan can be installed on an actual host.
      if (resolve(root) === resolve('/') && plan.isolation !== 'unix') throw fail('RELAY_ISOLATION_REQUIRED');
      if (Number(process.versions.node.split('.')[0]) < 22) throw fail('RELAY_NODE_UNSUPPORTED');
      const stat = lstatSync(serverSource);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 262144) throw fail('RELAY_INSTALL_INPUT_INVALID');
      for (const path of [plan.isolation === 'unix' ? '/etc/ssh' : '/etc/ssh/sshd_config.d', '/etc/systemd/system', '/var/lib']) secureDirectory(local(path));
      if ([plan.directory, plan.unitPath, plan.sshdPath, ...(plan.sshUnitPath ? [plan.sshUnitPath] : [])].some(path => pathExists(local(path)))) throw fail('RELAY_ALREADY_EXISTS');
      try { command('getent', ['passwd', plan.sshUser]); throw fail('RELAY_ACCOUNT_EXISTS'); }
      catch (error) { if (error.code === 'RELAY_ACCOUNT_EXISTS') throw error; if (error.status !== 2) throw fail('RELAY_ACCOUNT_CHECK_FAILED'); }
      const hostKey = readFileSync(local('/etc/ssh/ssh_host_ed25519_key.pub'), 'utf8').trim().split(/\s+/).slice(0, 2).join(' ');
      if (hostKey !== plan.expectedHostKey) throw fail('RELAY_HOST_KEY_MISMATCH');
      if (plan.isolation !== 'unix') {
        command('sshd', ['-t']);
        try { command('systemctl', ['is-active', '--quiet', 'sshd.service']); sshService = 'sshd.service'; }
        catch { command('systemctl', ['is-active', '--quiet', 'ssh.service']); sshService = 'ssh.service'; }
      }
      for (const unit of [plan.unitName, ...(plan.sshUnitName ? [plan.sshUnitName] : [])]) {
        if (command('systemctl', ['show', '--property=LoadState', '--value', unit]).trim() !== 'not-found') throw fail('RELAY_ALREADY_EXISTS');
      }
      const ports = [plan.listenPort, ...(plan.isolation === 'unix' ? [plan.sshPort] : [])];
      if (readOnly) {
        let portBinding = 'verified';
        for (const port of ports) {
          let busy = false;
          try { busy = Boolean(command('ss', ['-H', '-tan', `sport = :${port}`]).trim()); }
          catch { throw fail('RELAY_PORT_CHECK_UNAVAILABLE'); }
          if (busy) throw fail('RELAY_PORT_IN_USE');
          try { busy = Boolean(command('ss', ['-H', '-tBn', `sport = :${port}`]).trim()); }
          catch { portBinding = 'unverified'; }
          if (busy) throw fail('RELAY_PORT_IN_USE');
        }
        return { portBinding };
      } else for (const port of ports) if (!await probePort(port)) throw fail('RELAY_PORT_IN_USE');
    },
    async createFiles(plan) {
      ensureDirectory(local('/var/lib/rayneo-relay'));
      ensureDirectory(local(plan.directory));
      put(local(plan.directory + '/relay-server.mjs'), readFileSync(serverSource));
      put(local(plan.directory + '/relay.json'), JSON.stringify(plan.relayConfig) + '\n');
      put(local(plan.directory + '/authorized_keys'), plan.authorizedKey);
      put(local(plan.sshdPath), plan.sshdConfig);
      put(local(plan.unitPath), plan.serviceUnit);
      if (plan.isolation === 'unix') put(local(plan.sshUnitPath), plan.sshUnit);
    },
    async createAccount(plan) {
      accountCreationUncertain = true;
      command('useradd', ['--system', ...(plan.isolation === 'unix' ? ['--user-group'] : []), '--no-create-home', '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin', '--password', '*', plan.sshUser]);
      accountCreated = true;
      accountCreationUncertain = false;
      if (plan.isolation === 'unix') {
        const uidValue = Number(command('id', ['-u', plan.sshUser]).trim()), gidValue = Number(command('id', ['-g', plan.sshUser]).trim());
        if (!Number.isSafeInteger(uidValue) || uidValue <= 0 || !Number.isSafeInteger(gidValue) || gidValue <= 0) throw fail('RELAY_ACCOUNT_CHECK_FAILED');
        const tunnel = local(plan.directory + '/tunnel'); mkdirSync(tunnel, { mode: 0o700 }); createdDirectories.push(tunnel); chmodSync(tunnel, 0o700);
        chownPath(tunnel, uidValue, gidValue);
      }
    },
    async verifySsh(plan) { sshEffective(plan); command('systemd-analyze', ['verify', plan.unitPath, ...(plan.sshUnitPath ? [plan.sshUnitPath] : [])]); },
    async startService(plan) {
      command('systemctl', ['daemon-reload']);
      if (plan.isolation === 'unix') {
        sshUnitEnabled = true; command('systemctl', ['enable', '--now', plan.sshUnitName]);
        command('systemctl', ['is-active', '--quiet', plan.sshUnitName]);
      }
      // Treat a failed enable as potentially partial and clean up this new unit on rollback.
      unitEnabled = true; command('systemctl', ['enable', '--now', plan.unitName]);
      command('systemctl', ['is-active', '--quiet', plan.unitName]);
    },
    async reloadSsh(plan) { if (plan.isolation !== 'unix') { sshReloadAttempted = true; command('systemctl', ['reload', sshService]); } },
    async rollback(plan) {
      const errors = [];
      const attempt = operation => { try { operation(); } catch (error) { errors.push(error); } };
      if (unitEnabled) attempt(() => command('systemctl', ['disable', '--now', plan.unitName]));
      if (sshUnitEnabled) attempt(() => command('systemctl', ['disable', '--now', plan.sshUnitName]));
      for (const unit of [...(unitEnabled ? [plan.unitName] : []), ...(sshUnitEnabled ? [plan.sshUnitName] : [])]) {
        attempt(() => {
          const state = command('systemctl', ['show', '--property=ActiveState', '--value', unit]).trim();
          if (state !== 'inactive' && state !== 'failed') throw fail('RELAY_INSTALL_ROLLBACK_FAILED');
        });
      }
      // Preserve the account and unit files if a service could still be running.
      if (errors.length) throw fail('RELAY_INSTALL_ROLLBACK_FAILED');
      // A failed useradd can leave an account behind. Its ownership is ambiguous:
      // preserve the installation for inspection unless absence is confirmed.
      if (accountCreationUncertain) {
        try { command('getent', ['passwd', plan.sshUser]); throw fail('RELAY_INSTALL_ROLLBACK_FAILED'); }
        catch (error) { if (error.status !== 2) throw fail('RELAY_INSTALL_ROLLBACK_FAILED'); }
      }
      const tunnel = local(plan.directory + '/tunnel');
      if (plan.isolation === 'unix' && createdDirectories.includes(tunnel)) attempt(() => {
        const socket = join(tunnel, 'relay.sock');
        let stat; try { stat = lstatSync(socket); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
        if (!stat.isSocket()) throw fail('RELAY_INSTALL_ROLLBACK_FAILED');
        unlinkSync(socket);
      });
      if (errors.length) throw fail('RELAY_INSTALL_ROLLBACK_FAILED');
      for (const path of created.reverse()) attempt(() => unlinkSync(path));
      if (accountCreated) attempt(() => command('userdel', [plan.sshUser]));
      for (const path of createdDirectories.reverse()) attempt(() => rmdirSync(path));
      attempt(() => command('systemctl', ['daemon-reload']));
      if (sshReloadAttempted) attempt(() => { command('sshd', ['-t']); command('systemctl', ['reload', sshService]); });
      if (errors.length) throw fail('RELAY_INSTALL_ROLLBACK_FAILED');
    },
    async check(plan) {
      let installed = false, serviceActive = false, sshConfigured = false;
      try {
        const files = [plan.unitPath, plan.sshdPath, plan.directory + '/authorized_keys', plan.directory + '/relay.json',
          plan.directory + '/relay-server.mjs', ...(plan.sshUnitPath ? [plan.sshUnitPath] : [])];
        const safeFiles = files.every(path => {
          const stat = lstatSync(local(path));
          return stat.isFile() && !stat.isSymbolicLink() && (!strictOwners || stat.uid === 0 && (stat.mode & 0o022) === 0);
        });
        if (strictOwners) {
          secureDirectory(local('/var/lib/rayneo-relay')); secureDirectory(local(plan.directory));
          if (plan.isolation === 'unix') {
            const tunnel = lstatSync(local(plan.directory + '/tunnel'));
            const uidValue = Number(command('id', ['-u', plan.sshUser]).trim()), gidValue = Number(command('id', ['-g', plan.sshUser]).trim());
            if (!tunnel.isDirectory() || tunnel.isSymbolicLink() || tunnel.uid !== uidValue || tunnel.gid !== gidValue || (tunnel.mode & 0o777) !== 0o700) throw fail('RELAY_DIRECTORY_UNSAFE');
          }
        }
        const hostKey = readFileSync(local('/etc/ssh/ssh_host_ed25519_key.pub'), 'utf8').trim().split(/\s+/).slice(0, 2).join(' ');
        installed = safeFiles && hostKey === plan.expectedHostKey && readFileSync(local(plan.unitPath), 'utf8') === plan.serviceUnit
          && readFileSync(local(plan.sshdPath), 'utf8') === plan.sshdConfig
          && readFileSync(local(plan.directory + '/authorized_keys'), 'utf8') === plan.authorizedKey
          && readFileSync(local(plan.directory + '/relay.json'), 'utf8') === JSON.stringify(plan.relayConfig) + '\n'
          && readFileSync(local(plan.directory + '/relay-server.mjs')).equals(readFileSync(serverSource))
          && (!plan.sshUnitPath || readFileSync(local(plan.sshUnitPath), 'utf8') === plan.sshUnit);
        if (installed) { try {
          command('systemctl', ['is-active', '--quiet', plan.unitName]);
          if (plan.sshUnitName) command('systemctl', ['is-active', '--quiet', plan.sshUnitName]);
          if (plan.isolation === 'unix') {
            if (command('systemctl', ['show', '--property=FragmentPath', '--value', plan.unitName]).trim() !== plan.unitPath
              || command('systemctl', ['show', '--property=FragmentPath', '--value', plan.sshUnitName]).trim() !== plan.sshUnitPath
              || command('systemctl', ['show', '--property=NeedDaemonReload', '--value', plan.unitName]).trim() !== 'no'
              || command('systemctl', ['show', '--property=NeedDaemonReload', '--value', plan.sshUnitName]).trim() !== 'no') throw fail('RELAY_SERVICE_MISMATCH');
          }
          serviceActive = true;
        } catch {} }
        if (installed) { try { sshEffective(plan); sshConfigured = true; } catch {} }
      } catch { /* A missing or damaged installation remains unverified. */ }
      return { installed, serviceActive, sshConfigured };
    },
  };
}

async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write('只读检查不会安装服务，也不会验证外网连接。\nnode relay/install.mjs --check   检查服务器条件，不修改系统\nnode relay/install.mjs --install 安装专用中转和受限 SSH 账号\nnode relay/install.mjs --status  检查已安装服务\n'); return;
  }
  if (args.length !== 1 || !['--check', '--install', '--status'].includes(args[0])) throw fail('RELAY_INSTALL_INPUT_INVALID');
  if (process.platform !== 'linux') throw fail('RELAY_ROOT_REQUIRED');
  const directory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const read = (name, limit = 16384) => {
    const path = join(directory, name), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw fail('RELAY_INSTALL_INPUT_INVALID');
    return readFileSync(path, 'utf8');
  };
  const invitation = JSON.parse(read('invitation.json'));
  const bundle = { invitation, relayConfig: JSON.parse(read('relay.json')), authorizedKey: read('authorized-key'), sshdConfig: read('sshd.conf') };
  const plan = createInstallPlan(bundle, process.execPath);
  const driver = createLinuxInstallDriver({ serverSource: join(directory, 'relay-server.mjs') });
  if (args[0] === '--check') {
    process.stdout.write(JSON.stringify(await checkRelayPrerequisites(plan, driver)) + '\n');
  } else if (args[0] === '--install') process.stdout.write(JSON.stringify(await installRelay(plan, driver)) + '\n');
  else process.stdout.write(JSON.stringify(await checkInstalledRelay(plan, driver)) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write((/^RELAY_[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'RELAY_INSTALL_FAILED') + '\n');
    process.exitCode = 1;
  });
}
