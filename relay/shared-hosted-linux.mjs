import { execFileSync } from 'node:child_process';
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { inspectSharedInfrastructure } from './shared-infrastructure.mjs';
import { loadSharedHostedTls, validateSharedHostedLaunchConfig } from './shared-hosted-launch.mjs';

const fail = code => Object.assign(Error(code), { code });
const configPath = '/etc/rayneo-paseo-shared/hosted.json';
const unitPath = '/etc/systemd/system/rayneo-shared-hosted.service';
const stateDirectory = '/var/lib/rayneo-paseo-shared-hosted';
const unit = 'rayneo-shared-hosted.service';

export function createSharedHostedLinuxDriver({ config, run = (name, args) => execFileSync(name, args,
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }) } = {}) {
  if (process.platform !== 'linux' || process.geteuid?.() !== 0 || typeof run !== 'function') throw fail('SHARED_HOSTED_INSTALL_INVALID');
  const safe = validateSharedHostedLaunchConfig(config), command = (name, args) => String(run(name, args) ?? '').trim();
  const exists = path => { try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
  const files = []; let directoryCreated = false, startAttempted = false;
  const createFile = (path, content, mode) => {
    const fd = openSync(path, 'wx', mode); files.push(path);
    try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
    chmodSync(path, mode);
  };
  const available = () => new Promise(resolve => {
    const server = createServer(); server.once('error', () => resolve(false));
    server.listen(safe.listenPort, safe.listenHost, () => server.close(() => resolve(true)));
  });
  const tlsReady = () => new Promise(resolve => {
    let expected;
    try { expected = new X509Certificate(loadSharedHostedTls(safe).cert).fingerprint256; } catch { resolve(false); return; }
    const socket = tls.connect({ host: '127.0.0.1', port: safe.listenPort, servername: safe.shared.relay.host, rejectUnauthorized: false });
    socket.setTimeout(2000, () => socket.destroy());
    socket.once('secureConnect', () => { const match = socket.getPeerCertificate().fingerprint256 === expected; socket.destroy(); resolve(match); });
    socket.once('error', () => resolve(false)); socket.once('close', () => resolve(false));
  });
  return {
    async preflight() {
      if (!await inspectSharedInfrastructure(safe.infrastructure, { run })) throw fail('SHARED_INFRASTRUCTURE_UNVERIFIED');
      for (const path of [configPath, unitPath, stateDirectory]) if (exists(path)) throw fail('SHARED_HOSTED_INSTALL_EXISTS');
      try { tls.createSecureContext(loadSharedHostedTls(safe)); } catch { throw fail('SHARED_HOSTED_TLS_INVALID'); }
      if (!await available()) throw fail('SHARED_HOSTED_PORT_IN_USE');
    },
    async createFiles(plan) {
      mkdirSync(stateDirectory, { mode: 0o700 }); directoryCreated = true; chmodSync(stateDirectory, 0o700);
      createFile(configPath, plan.configFile, 0o600); createFile(unitPath, plan.serviceUnit, 0o644);
    },
    async verify() { command('systemd-analyze', ['verify', unitPath]); },
    async start() {
      command('systemctl', ['daemon-reload']); startAttempted = true;
      command('systemctl', ['enable', '--now', unit]); command('systemctl', ['is-active', '--quiet', unit]);
    },
    async check(plan) {
      try {
        const folder = lstatSync(stateDirectory), conf = lstatSync(configPath), unitFile = lstatSync(unitPath);
        if (!folder.isDirectory() || folder.isSymbolicLink() || folder.uid !== 0 || (folder.mode & 0o777) !== 0o700
          || !conf.isFile() || conf.isSymbolicLink() || conf.uid !== 0 || (conf.mode & 0o777) !== 0o600
          || !unitFile.isFile() || unitFile.isSymbolicLink() || unitFile.uid !== 0 || (unitFile.mode & 0o022)
          || readFileSync(configPath, 'utf8') !== plan.configFile || readFileSync(unitPath, 'utf8') !== plan.serviceUnit) return false;
        if (!await inspectSharedInfrastructure(safe.infrastructure, { run })) return false;
        command('systemctl', ['is-active', '--quiet', unit]);
        if (command('systemctl', ['show', '--property=FragmentPath', '--value', unit]) !== unitPath
          || command('systemctl', ['show', '--property=NeedDaemonReload', '--value', unit]) !== 'no') return false;
        for (let attempt = 0; attempt < 20; attempt++) {
          if (await tlsReady()) return true;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        return false;
      } catch { return false; }
    },
    async rollback() {
      if (startAttempted) {
        command('systemctl', ['disable', '--now', unit]);
        if (!['inactive', 'failed'].includes(command('systemctl', ['show', '--property=ActiveState', '--value', unit]))) throw fail('SHARED_HOSTED_INSTALL_UNCERTAIN');
        if (exists(safe.databasePath) || exists(safe.databasePath + '.locks')) throw fail('SHARED_HOSTED_INSTALL_UNCERTAIN');
      }
      for (const path of files.reverse()) unlinkSync(path);
      if (directoryCreated) rmdirSync(stateDirectory);
      command('systemctl', ['daemon-reload']);
    },
  };
}
