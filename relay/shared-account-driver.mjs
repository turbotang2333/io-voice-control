import { execFileSync } from 'node:child_process';
import { chmodSync, chownSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateSecureInvitation, validateSshPublicKey } from '../secure-link/config.mjs';
import { accountForInstallation, sharedSocket } from './shared-configuration.mjs';

const fail = code => Object.assign(Error(code), { code });
const base = '/var/lib/rayneo-shared';

// Infrastructure must already be installed and independently checked by the caller.
// On any uncertain failure, preserve all artifacts for inspection, never adopt or delete them.
export function createSharedAccountDriver({ group, verifyInfrastructure,
  run = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }) } = {}) {
  if (process.platform !== 'linux' || process.geteuid?.() !== 0 || !/^[a-z_][a-z0-9_-]{0,31}$/.test(group ?? '')
    || typeof verifyInfrastructure !== 'function' || typeof run !== 'function') throw fail('SHARED_ACCOUNT_CONFIG_INVALID');
  const command = (name, args) => String(run(name, args) ?? '').trim();
  const validate = bundle => {
    try {
      const invitation = validateSecureInvitation(bundle.invitation), account = accountForInstallation(invitation.installationId);
      if (invitation.version !== 3 || invitation.relay.user !== account || bundle.targetSocket !== sharedSocket(invitation.installationId)
        || typeof bundle.authorizedKey !== 'string' || !bundle.authorizedKey.endsWith('\n')) throw Error();
      const key = validateSshPublicKey(bundle.authorizedKey.slice('restrict,port-forwarding '.length, -1));
      if (bundle.authorizedKey !== `restrict,port-forwarding ${key}\n`) throw Error();
      return { account, directory: join(base, account), key: bundle.authorizedKey };
    } catch { throw fail('SHARED_ACCOUNT_INPUT_INVALID'); }
  };
  const infrastructure = async () => {
    if (await verifyInfrastructure() !== true) throw fail('SHARED_INFRASTRUCTURE_UNVERIFIED');
    const stat = lstatSync(base);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022)) throw fail('SHARED_INFRASTRUCTURE_UNVERIFIED');
    const entry = command('getent', ['group', group]).split(':');
    if (entry.length !== 4 || entry[0] !== group || !/^\d+$/.test(entry[2]) || Number(entry[2]) === 0) throw fail('SHARED_INFRASTRUCTURE_UNVERIFIED');
    return Number(entry[2]);
  };
  const check = (value, gid) => {
    const account = command('getent', ['passwd', value.account]).split(':');
    if (account.length !== 7 || account[0] !== value.account || !/^\d+$/.test(account[2]) || Number(account[2]) === 0
      || Number(account[3]) !== gid || account[6] !== '/usr/sbin/nologin') return false;
    const groups = command('id', ['-G', value.account]).split(/\s+/);
    if (groups.length !== 1 || Number(groups[0]) !== gid) return false;
    const directory = lstatSync(value.directory), file = lstatSync(join(value.directory, 'authorized_keys'));
    const tunnel = lstatSync(join(value.directory, 'tunnel'));
    return directory.isDirectory() && !directory.isSymbolicLink() && directory.uid === 0 && (directory.mode & 0o7777) === 0o755
      && file.isFile() && !file.isSymbolicLink() && file.uid === 0 && (file.mode & 0o7777) === 0o644 && file.nlink === 1
      && readFileSync(join(value.directory, 'authorized_keys'), 'utf8') === value.key
      && tunnel.isDirectory() && !tunnel.isSymbolicLink() && tunnel.uid === Number(account[2]) && tunnel.gid === gid && (tunnel.mode & 0o7777) === 0o2710;
  };
  return {
    async activate(bundle) {
      const value = validate(bundle), gid = await infrastructure();
      try { lstatSync(value.directory); throw fail('SHARED_ACCOUNT_EXISTS'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      try { command('getent', ['passwd', value.account]); throw fail('SHARED_ACCOUNT_EXISTS'); }
      catch (error) { if (error.status !== 2) throw error; }
      mkdirSync(value.directory, { mode: 0o755 }); chmodSync(value.directory, 0o755);
      const path = join(value.directory, 'authorized_keys'), fd = openSync(path, 'wx', 0o644);
      try { writeFileSync(fd, value.key); fsyncSync(fd); } finally { closeSync(fd); }
      chmodSync(path, 0o644);
      // Regular UID range is larger than Linux's small pool of system UIDs;
      // these accounts still have no home, password login, shell or sessions.
      command('useradd', ['--no-create-home', '--gid', group, '--shell', '/usr/sbin/nologin', value.account]);
      const uid = Number(command('id', ['-u', value.account]));
      if (!Number.isInteger(uid) || uid <= 0) throw fail('SHARED_ACCOUNT_UNCONFIRMED');
      const tunnel = join(value.directory, 'tunnel'); mkdirSync(tunnel, { mode: 0o700 });
      chownSync(tunnel, uid, gid); chmodSync(tunnel, 0o2710);
      if (!check(value, gid)) throw fail('SHARED_ACCOUNT_UNCONFIRMED');
      return true;
    },
    async inspect(bundle) {
      const value = validate(bundle);
      try { return check(value, await infrastructure()); } catch { return false; }
    },
  };
}
