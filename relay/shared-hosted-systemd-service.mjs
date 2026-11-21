import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import tls from 'node:tls';
import { loadSharedHostedTls } from './shared-hosted-launch.mjs';
import { createSharedHostedGuardPlan } from './shared-hosted-upgrade-guard-plan.mjs';
import { createHostedEnrollment } from '../distribution/hosted-enrollment.mjs';
import { isSafeSharedNode } from './shared-infrastructure.mjs';

const unit = 'rayneo-shared-hosted.service';
const fail = () => Object.assign(Error('SHARED_HOSTED_SERVICE_UNVERIFIED'), { code: 'SHARED_HOSTED_SERVICE_UNVERIFIED' });
const testKey = n => 'ssh-ed25519 ' + Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, n)]).toString('base64');

export function selectExistingEnrollment(db) {
  const row = db.prepare("SELECT request FROM allocations WHERE state='active' LIMIT 1").get();
  if (!row) throw fail();
  return createHostedEnrollment(JSON.parse(row.request));
}

async function reserveExistingEnrollment(config) {
  if (config.databasePath !== '/var/lib/rayneo-paseo-shared-hosted/registry.sqlite') throw fail();
  let parent = dirname(config.databasePath);
  while (true) {
    const s = lstatSync(parent);
    if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== 0 || (s.mode & 0o022)) throw fail();
    if (parent === '/') break; parent = dirname(parent);
  }
  const stat = lstatSync(config.databasePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== 0 || (stat.mode & 0o077)) throw fail();
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(config.databasePath, { readOnly: true });
  let enrollment;
  try { enrollment = selectExistingEnrollment(db); } finally { db.close(); }
  // Hold the installation lock while probing. Even if the invite check were broken,
  // the enrollment handler cannot create or modify an allocation for this identity.
  const directory = config.databasePath + '.locks', lockPath = join(directory, enrollment.installationId + '.sqlite');
  const dir = lstatSync(directory), lockStat = lstatSync(lockPath);
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== 0 || (dir.mode & 0o077)
    || !lockStat.isFile() || lockStat.isSymbolicLink() || lockStat.nlink !== 1 || lockStat.uid !== 0 || (lockStat.mode & 0o077)) throw fail();
  const lock = new DatabaseSync(lockPath, { timeout: 0 });
  try { lock.exec('BEGIN IMMEDIATE'); } catch { lock.close(); throw fail(); }
  let released = false;
  return { enrollment, release() { if (!released) { released = true; try { lock.exec('ROLLBACK'); } finally { lock.close(); } } } };
}

// A local, pinned-certificate health probe. It does not create registrations or send model messages.
export function createSharedHostedSystemdService({
  run = args => execFileSync('systemctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }),
  readCertificate = config => loadSharedHostedTls(config).cert,
  reserveEnrollment = reserveExistingEnrollment,
  guardRoot = '/',
  attempts = 20,
} = {}) {
  if (typeof run !== 'function' || typeof readCertificate !== 'function' || typeof reserveEnrollment !== 'function' || !isAbsolute(guardRoot) || !Number.isInteger(attempts) || attempts < 1 || attempts > 100) throw fail();
  guardRoot = resolve(guardRoot);
  const state = () => String(run(['show', unit, '--property=ActiveState', '--value'])).trim();
  const probe = (config, requestBody) => new Promise(resolve => {
    let fingerprint;
    try { fingerprint = new X509Certificate(readCertificate(config)).fingerprint256; } catch { resolve(false); return; }
    let done = false, data = Buffer.alloc(0), socket;
    const finish = result => { if (!done) { done = true; clearTimeout(timer); socket?.destroy(); resolve(result); } };
    const timer = setTimeout(() => finish(false), 3000);
    try {
      socket = tls.connect({ host: '127.0.0.1', port: config.listenPort, servername: config.shared.relay.host, rejectUnauthorized: false });
      socket.once('secureConnect', () => {
        try {
          if (socket.getPeerCertificate().fingerprint256 !== fingerprint) return finish(false);
          const body = requestBody ? JSON.stringify(requestBody) : '';
          const head = requestBody ? `POST /v1/enroll HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n`
            : 'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n';
          socket.write(head + body);
        } catch { finish(false); }
      });
      socket.on('data', chunk => {
        data = Buffer.concat([data, chunk]); if (data.length > 8192) return finish(false);
        const end = data.indexOf('\r\n'); if (end < 0) return;
        const line = data.subarray(0, end).toString('ascii'), expected = requestBody ? 403 : 404;
        finish(new RegExp(`^HTTP/1\\.[01] ${expected}(?: |$)`).test(line));
      });
      socket.once('end', () => finish(false)); socket.once('error', () => finish(false));
    } catch { finish(false); }
  });
  const verify = async (config, requireInvite) => {
    let reservation;
    try {
      let requestBody;
      if (requireInvite) {
        reservation = await reserveEnrollment(config);
        if (!reservation || typeof reservation.release !== 'function') throw fail();
        const old = createHostedEnrollment(reservation.enrollment);
        const replacement = old.sshPublicKey === testKey(1) ? testKey(2) : testKey(1);
        requestBody = { ...old, sshPublicKey: replacement };
      }
      for (let i = 0; i < attempts; i++) {
        if (state() === 'active' && await probe(config) && (!requestBody || await probe(config, requestBody))) return true;
        if (i + 1 < attempts) await new Promise(resolve => setTimeout(resolve, 200));
      }
    } catch {} finally { if (reservation && typeof reservation.release === 'function') await reservation.release(); }
    return false;
  };
  return {
    async isActive() { try { return state() === 'active'; } catch { return false; } },
    async canProbeEnrollment(config) {
      let reservation;
      try { reservation = await reserveEnrollment(config); createHostedEnrollment(reservation.enrollment); return typeof reservation.release === 'function'; }
      catch { return false; }
      finally { if (reservation && typeof reservation.release === 'function') await reservation.release(); }
    },
    async guardReady(nodePath) {
      try {
        const plan = createSharedHostedGuardPlan({ nodePath }), production = guardRoot === '/';
        const readGuardFile = (path, privateFile = false) => {
          const full = join(guardRoot, path.slice(1));
          if (!production && !full.startsWith(guardRoot + sep)) throw fail();
          let parent = dirname(full);
          while (true) {
            const s = lstatSync(parent);
            if (!s.isDirectory() || s.isSymbolicLink() || production && (s.uid !== 0 || (s.mode & 0o022))) throw fail();
            if (parent === guardRoot) break;
            const next = dirname(parent); if (next === parent) throw fail(); parent = next;
          }
          const s = lstatSync(full);
          if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > 1024 * 1024
            || production && (s.uid !== 0 || (s.mode & (privateFile ? 0o077 : 0o022)))) throw fail();
          const fd = openSync(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          try { const actual = fstatSync(fd); if (actual.ino !== s.ino || actual.dev !== s.dev) throw fail(); return readFileSync(fd); }
          finally { closeSync(fd); }
        };
        if (!readGuardFile(plan.guardPath).equals(plan.guardSource) || readGuardFile(plan.dropInPath).toString('utf8') !== plan.dropIn) return false;
        if (!readGuardFile(plan.lockPath, true).subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))) return false;
        if (production) {
          if (!isSafeSharedNode(nodePath)) return false;
          execFileSync(nodePath, ['--check', plan.guardPath], { stdio: 'pipe', timeout: 10000 });
        }
        if (String(run(['show', unit, '--property=NeedDaemonReload', '--value'])).trim() !== 'no') return false;
        const pre = String(run(['show', unit, '--property=ExecStartPre', '--value']));
        return pre.includes(`argv[]=${nodePath} ${plan.guardPath} --verify-live ;`);
      } catch { return false; }
    },
    async stop() { run(['stop', unit]); if (!['inactive', 'failed'].includes(state())) throw fail(); },
    async start() { run(['reset-failed', unit]); run(['start', unit]); if (state() !== 'active') throw fail(); },
    verifyNew: config => verify(config, true),
    verifyOld: config => verify(config, false),
  };
}
