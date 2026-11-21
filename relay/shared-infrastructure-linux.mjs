import { execFileSync } from 'node:child_process';
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, isAbsolute, join } from 'node:path';
import { inspectSharedInfrastructure, isSafeSharedNode } from './shared-infrastructure.mjs';

const fail = code => Object.assign(Error(code), { code });

// Creates only a new, separate shared installation. Existing artifacts are never adopted.
export function createSharedLinuxInfrastructureDriver({ sourceRoot, options,
  run = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }) } = {}) {
  if (process.platform !== 'linux' || process.geteuid?.() !== 0 || !isAbsolute(sourceRoot ?? '') || typeof run !== 'function') throw fail('SHARED_INSTALL_INVALID');
  const command = (name, args) => String(run(name, args) ?? '').trim();
  const exists = path => { try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
  const safeDir = path => {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022)) throw fail('SHARED_INSTALL_UNSAFE_PATH');
  };
  const absentAccount = (type, name) => {
    try { command('getent', [type, name]); return false; }
    catch (error) { if (error.status === 2) return true; throw error; }
  };
  const probe = (host, port) => new Promise(resolve => {
    const server = createServer(); server.once('error', () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
  const dirs = [], files = [], unitsAttempted = [];
  let accountCreated = false, accountUncertain = false, groupCreated = false, groupUncertain = false;
  const createDir = path => { mkdirSync(path, { mode: 0o755 }); dirs.push(path); chmodSync(path, 0o755); };
  const createFile = (path, content) => {
    const fd = openSync(path, 'wx', 0o644); files.push(path);
    try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
    chmodSync(path, 0o644);
  };
  const source = path => join(sourceRoot, path.replace('/opt/rayneo-paseo-shared/', ''));
  return {
    async preflight(plan) {
      for (const parent of ['/etc', '/etc/systemd', '/etc/systemd/system', '/opt', '/var', '/var/lib', '/run/sshd']) safeDir(parent);
      for (const path of ['/etc/rayneo-paseo-shared', '/opt/rayneo-paseo-shared', '/var/lib/rayneo-shared', ...Object.keys(plan.files)]) {
        if (exists(path)) throw fail('SHARED_INSTALL_EXISTS');
      }
      if (!absentAccount('group', 'rayneo-relay') || !absentAccount('passwd', 'rayneo-router')) throw fail('SHARED_INSTALL_EXISTS');
      for (const path of plan.sourceFiles) {
        const stat = lstatSync(source(path));
        if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) || stat.size > 1048576) throw fail('SHARED_INSTALL_SOURCE_UNSAFE');
      }
      if (!isSafeSharedNode(options.nodePath)) throw fail('SHARED_INSTALL_NODE_UNSAFE');
      try { command(options.nodePath, ['--input-type=module', '-e', "import {DatabaseSync} from 'node:sqlite'; new DatabaseSync(':memory:').close();"]); }
      catch { throw fail('SHARED_INSTALL_NODE_UNSUPPORTED'); }
      if (!await probe(plan.routerConfig.listenHost, plan.routerConfig.listenPort)
        || !await probe(plan.routerConfig.listenHost, options.sshPort)) throw fail('SHARED_INSTALL_PORT_IN_USE');
    },
    async createFiles(plan) {
      for (const path of ['/etc/rayneo-paseo-shared', '/opt/rayneo-paseo-shared', '/opt/rayneo-paseo-shared/relay',
        '/opt/rayneo-paseo-shared/secure-link', '/opt/rayneo-paseo-shared/distribution', '/var/lib/rayneo-shared']) createDir(path);
      for (const [path, content] of Object.entries(plan.files)) createFile(path, content);
      for (const path of plan.sourceFiles) createFile(path, readFileSync(source(path)));
    },
    async createAccounts() {
      groupUncertain = true; command('groupadd', ['--system', 'rayneo-relay']); groupCreated = true; groupUncertain = false;
      accountUncertain = true;
      command('useradd', ['--system', '--no-create-home', '--gid', 'rayneo-relay', '--shell', '/usr/sbin/nologin', 'rayneo-router']);
      accountCreated = true; accountUncertain = false;
    },
    async verify() {
      command('sshd', ['-t', '-f', '/etc/rayneo-paseo-shared/sshd_config']);
      command('systemd-analyze', ['verify', '/etc/systemd/system/rayneo-shared-router.service', '/etc/systemd/system/rayneo-shared-ssh.service']);
    },
    async start() {
      command('systemctl', ['daemon-reload']);
      for (const unit of ['rayneo-shared-ssh.service', 'rayneo-shared-router.service']) {
        unitsAttempted.push(unit); command('systemctl', ['enable', '--now', unit]); command('systemctl', ['is-active', '--quiet', unit]);
      }
    },
    async check() { return inspectSharedInfrastructure(options, { run }); },
    async rollback() {
      if (accountUncertain && !absentAccount('passwd', 'rayneo-router') || groupUncertain && !absentAccount('group', 'rayneo-relay')) throw fail('SHARED_INSTALL_UNCERTAIN');
      for (const unit of unitsAttempted.reverse()) {
        command('systemctl', ['disable', '--now', unit]);
        if (!['inactive', 'failed'].includes(command('systemctl', ['show', '--property=ActiveState', '--value', unit]))) throw fail('SHARED_INSTALL_UNCERTAIN');
      }
      for (const path of files.reverse()) unlinkSync(path);
      if (accountCreated) command('userdel', ['rayneo-router']);
      if (groupCreated) command('groupdel', ['rayneo-relay']);
      for (const path of dirs.reverse()) rmdirSync(path);
      command('systemctl', ['daemon-reload']);
    },
  };
}
