import { openSync, closeSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { createHostedEnrollment, validateHostedResponse } from '../distribution/hosted-enrollment.mjs';
import { createSharedRelayBundle } from './shared-configuration.mjs';

const fail = code => Object.assign(Error(code), { code });
const sampleKey = 'ssh-ed25519 ' + Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 1)]).toString('base64');
const sample = { version: 1, installationId: '00000000-0000-0000-0000-000000000001', requestedBackends: ['paseo'], sshPublicKey: sampleKey };

function ensurePrivateDatabase(path) {
  if (!isAbsolute(path ?? '')) throw fail('HOSTED_DATABASE_INVALID');
  const parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink() || process.platform !== 'win32' && (parent.uid !== process.geteuid() || (parent.mode & 0o077))) throw fail('HOSTED_DATABASE_INVALID');
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || process.platform !== 'win32' && (stat.uid !== process.geteuid() || (stat.mode & 0o077))) throw fail('HOSTED_DATABASE_INVALID');
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const fd = openSync(path, 'wx', 0o600); closeSync(fd); return false;
  }
}

export async function createSharedHostedAllocator({ databasePath, shared, activate, maxAllocations = 10000 } = {}) {
  if (typeof activate !== 'function' || !Number.isInteger(maxAllocations) || maxAllocations < 1 || maxAllocations > 1000000) throw fail('HOSTED_CONFIG_INVALID');
  let canonical;
  try {
    const bundle = createSharedRelayBundle({ enrollment: sample, hosting: 'project-hosted', shared });
    canonical = { publicBaseUrl: new URL(shared.publicBaseUrl).origin,
      relay: { host: bundle.invitation.relay.host, port: bundle.invitation.relay.port, hostKey: bundle.invitation.relay.hostKey } };
  } catch { throw fail('HOSTED_CONFIG_INVALID'); }
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { throw fail('HOSTED_DATABASE_UNSUPPORTED'); }
  const existing = ensurePrivateDatabase(databasePath), lockDirectory = databasePath + '.locks';
  try { mkdirSync(lockDirectory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const lockStat = lstatSync(lockDirectory);
  if (!lockStat.isDirectory() || lockStat.isSymbolicLink() || process.platform !== 'win32' && (lockStat.uid !== process.geteuid() || (lockStat.mode & 0o077))) throw fail('HOSTED_DATABASE_INVALID');
  const db = new DatabaseSync(databasePath); let closed = false, inFlight = 0;
  try {
    db.exec('PRAGMA busy_timeout=3000; PRAGMA synchronous=FULL;');
    if (!existing) {
      db.exec('BEGIN IMMEDIATE; CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK(id=1), definition TEXT NOT NULL); CREATE TABLE allocations (installation_id TEXT PRIMARY KEY, request TEXT NOT NULL, invitation TEXT NOT NULL, state TEXT NOT NULL); PRAGMA user_version=1;');
      db.prepare('INSERT INTO settings(id, definition) VALUES (1, ?)').run(JSON.stringify(canonical)); db.exec('COMMIT');
    } else if (db.prepare('PRAGMA user_version').get().user_version !== 1 || db.prepare('SELECT definition FROM settings WHERE id=1').get()?.definition !== JSON.stringify(canonical)) throw fail('HOSTED_CONFIG_CONFLICT');
  } catch (error) { db.close(); throw error; }
  const acquire = id => {
    let lock;
    try {
      const path = join(lockDirectory, id + '.sqlite'); ensurePrivateDatabase(path); lock = new DatabaseSync(path);
      lock.exec('PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS held (id INTEGER); BEGIN IMMEDIATE;');
      return () => { try { lock.exec('ROLLBACK'); } finally { lock.close(); } };
    } catch { try { lock?.close(); } catch {} throw fail('HOSTED_ALLOCATION_PENDING'); }
  };
  const normalize = value => { const result = createHostedEnrollment(value); result.requestedBackends.sort(); return result; };
  const bundleFor = enrollment => createSharedRelayBundle({ enrollment, hosting: 'project-hosted', shared: canonical });
  return {
    async provision(value) {
      if (closed) throw fail('HOSTED_DATABASE_CLOSED');
      const enrollment = normalize(value), text = JSON.stringify(enrollment), release = acquire(enrollment.installationId);
      try {
        const prior = db.prepare('SELECT request, invitation, state FROM allocations WHERE installation_id=?').get(enrollment.installationId);
        if (prior) {
          if (prior.request !== text) throw fail('HOSTED_ALLOCATION_CONFLICT');
          if (prior.state !== 'active') throw fail('HOSTED_ALLOCATION_PENDING');
          const expected = JSON.stringify(bundleFor(enrollment).invitation);
          if (prior.invitation !== expected) throw fail('HOSTED_ALLOCATION_CONFLICT');
          return validateHostedResponse(JSON.parse(prior.invitation), enrollment);
        }
        const bundle = bundleFor(enrollment), invitation = JSON.stringify(bundle.invitation);
        const inserted = db.prepare("INSERT INTO allocations (installation_id,request,invitation,state) SELECT ?,?,?,'reserved' WHERE (SELECT COUNT(*) FROM allocations) < ?")
          .run(enrollment.installationId, text, invitation, maxAllocations);
        if (inserted.changes !== 1) throw fail('HOSTED_CAPACITY_FULL');
        inFlight++;
        try {
          if (await activate(bundle) !== true) throw Error('activation unconfirmed');
          const updated = db.prepare("UPDATE allocations SET state='active' WHERE installation_id=? AND request=? AND invitation=? AND state='reserved'").run(enrollment.installationId, text, invitation);
          if (updated.changes !== 1) throw Error('reservation changed');
          return validateHostedResponse(JSON.parse(invitation), enrollment);
        } catch (error) {
          if (error?.code === 'HOSTED_ACTIVATION_CLEAN_FAILED') {
            const removed = db.prepare("DELETE FROM allocations WHERE installation_id=? AND request=? AND invitation=? AND state='reserved'").run(enrollment.installationId, text, invitation);
            if (removed.changes === 1) throw fail('HOSTED_ACTIVATION_RETRYABLE');
          }
          try { db.prepare("UPDATE allocations SET state='uncertain' WHERE installation_id=? AND state='reserved'").run(enrollment.installationId); } catch {}
          throw fail('HOSTED_ACTIVATION_UNCERTAIN');
        } finally { inFlight--; }
      } finally { release(); }
    },
    async reconcile(value, inspect) {
      if (closed) throw fail('HOSTED_DATABASE_CLOSED');
      if (typeof inspect !== 'function') throw fail('HOSTED_RECONCILIATION_INVALID');
      const enrollment = normalize(value), text = JSON.stringify(enrollment), release = acquire(enrollment.installationId);
      try {
        const prior = db.prepare('SELECT request, invitation, state FROM allocations WHERE installation_id=?').get(enrollment.installationId);
        if (!prior || prior.request !== text) throw fail('HOSTED_ALLOCATION_CONFLICT');
        const bundle = bundleFor(enrollment);
        if (prior.invitation !== JSON.stringify(bundle.invitation)) throw fail('HOSTED_RECONCILIATION_UNCONFIRMED');
        const invitation = validateHostedResponse(JSON.parse(prior.invitation), enrollment);
        if (prior.state === 'active') return invitation;
        if (!['reserved', 'uncertain'].includes(prior.state)) throw fail('HOSTED_ALLOCATION_PENDING');
        inFlight++;
        try {
          let confirmed = false; try { confirmed = await inspect(bundle) === true; } catch {}
          if (!confirmed) throw fail('HOSTED_RECONCILIATION_UNCONFIRMED');
          const updated = db.prepare("UPDATE allocations SET state='active' WHERE installation_id=? AND request=? AND invitation=? AND state IN ('reserved','uncertain')").run(enrollment.installationId, text, prior.invitation);
          if (updated.changes !== 1) throw fail('HOSTED_RECONCILIATION_UNCONFIRMED');
          return invitation;
        } finally { inFlight--; }
      } finally { release(); }
    },
    close() { if (inFlight) throw fail('HOSTED_ALLOCATION_PENDING'); if (!closed) { closed = true; db.close(); } },
  };
}
