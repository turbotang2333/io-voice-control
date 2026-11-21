import { openSync, closeSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { createHostedEnrollment, validateHostedResponse } from '../distribution/hosted-enrollment.mjs';
import { createUnixRelayBundle } from './unix-provision.mjs';

const fail = code => Object.assign(Error(code), { code });
const sampleKey = 'ssh-ed25519 ' + Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 1)]).toString('base64');
const sampleEnrollment = { version: 1, installationId: '00000000-0000-0000-0000-000000000001', requestedBackends: ['paseo'], sshPublicKey: sampleKey };

function canonicalSlot(value) {
  if (!value || !/^[a-z0-9_-]{1,32}$/.test(value.id ?? '')) throw fail('HOSTED_SLOT_INVALID');
  try {
    const { invitation } = createUnixRelayBundle({ enrollment: sampleEnrollment, hosting: 'project-hosted', publicBaseUrl: value.publicBaseUrl, relay: value.relay });
    return { id: value.id, publicBaseUrl: invitation.publicBaseUrl, relay: invitation.relay };
  } catch { throw fail('HOSTED_SLOT_INVALID'); }
}

function ensurePrivateDatabase(path) {
  if (!isAbsolute(path ?? '')) throw fail('HOSTED_DATABASE_INVALID');
  const parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink() || process.platform !== 'win32' && (parent.uid !== process.geteuid() || (parent.mode & 0o077))) throw fail('HOSTED_DATABASE_INVALID');
  let existing = true;
  try { const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || process.platform !== 'win32' && (stat.uid !== process.geteuid() || (stat.mode & 0o077))) throw fail('HOSTED_DATABASE_INVALID'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const fd = openSync(path, 'wx', 0o600); closeSync(fd); existing = false;
  }
  return existing;
}

/** Reserve once, activate once, and never reuse an uncertain allocation automatically. */
export async function createHostedAllocator({ databasePath, slots, activate } = {}) {
  if (!Array.isArray(slots) || slots.length < 1 || slots.length > 256 || typeof activate !== 'function') throw fail('HOSTED_SLOT_INVALID');
  const configured = slots.map(canonicalSlot);
  if (new Set(configured.map(slot => slot.id)).size !== configured.length) throw fail('HOSTED_SLOT_CONFLICT');
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { throw fail('HOSTED_DATABASE_UNSUPPORTED'); }
  const existing = ensurePrivateDatabase(databasePath);
  const lockDirectory = databasePath + '.locks';
  try { mkdirSync(lockDirectory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const lockStat = lstatSync(lockDirectory);
  if (!lockStat.isDirectory() || lockStat.isSymbolicLink() || process.platform !== 'win32' && (lockStat.uid !== process.geteuid() || (lockStat.mode & 0o077))) throw fail('HOSTED_DATABASE_INVALID');
  const db = new DatabaseSync(databasePath); let closed = false, inFlight = 0;
  const acquire = installationId => {
    let lock;
    try {
      const path = join(lockDirectory, installationId + '.sqlite');
      ensurePrivateDatabase(path); lock = new DatabaseSync(path);
      lock.exec('PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS held (id INTEGER); BEGIN IMMEDIATE;');
      return () => { try { lock.exec('ROLLBACK'); } finally { lock.close(); } };
    } catch { try { lock?.close(); } catch {} throw fail('HOSTED_ALLOCATION_PENDING'); }
  };
  const transaction = action => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = action(); db.exec('COMMIT'); return result; }
    catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  };
  try {
    db.exec('PRAGMA busy_timeout=3000; PRAGMA synchronous=FULL;');
    if (!existing) db.exec(`CREATE TABLE slots (id TEXT PRIMARY KEY, definition TEXT NOT NULL);
      CREATE TABLE allocations (installation_id TEXT PRIMARY KEY, slot_id TEXT NOT NULL UNIQUE, request TEXT NOT NULL, invitation TEXT NOT NULL, state TEXT NOT NULL);
      PRAGMA user_version=1;`);
    else if (db.prepare('PRAGMA user_version').get().user_version !== 1) throw fail('HOSTED_DATABASE_INVALID');
    transaction(() => {
      const all = new Map(db.prepare('SELECT id, definition FROM slots').all().map(row => [row.id, row.definition]));
      for (const entry of configured) {
        const definition = JSON.stringify(entry), old = all.get(entry.id);
        if (old !== undefined && old !== definition) throw fail('HOSTED_SLOT_CONFLICT');
        all.set(entry.id, definition);
      }
      const ports = new Set(), users = new Set();
      for (const definition of all.values()) {
        const item = canonicalSlot(JSON.parse(definition)), publicPort = Number(new URL(item.publicBaseUrl).port || 443);
        if (ports.has(publicPort) || ports.has(item.relay.port) || publicPort === item.relay.port || users.has(item.relay.user)) throw fail('HOSTED_SLOT_CONFLICT');
        ports.add(publicPort); ports.add(item.relay.port); users.add(item.relay.user);
      }
      const insert = db.prepare('INSERT OR IGNORE INTO slots (id, definition) VALUES (?, ?)');
      for (const entry of configured) insert.run(entry.id, JSON.stringify(entry));
    });
  } catch (error) { db.close(); throw error; }
  return {
    async provision(value) {
      if (closed) throw fail('HOSTED_DATABASE_CLOSED');
      const enrollment = createHostedEnrollment(value);
      enrollment.requestedBackends.sort();
      const requestText = JSON.stringify(enrollment);
      const release = acquire(enrollment.installationId);
      try {
      const selected = transaction(() => {
        const previous = db.prepare('SELECT request, invitation, state FROM allocations WHERE installation_id = ?').get(enrollment.installationId);
        if (previous) {
          if (previous.request !== requestText) throw fail('HOSTED_ALLOCATION_CONFLICT');
          if (previous.state !== 'active') throw fail('HOSTED_ALLOCATION_PENDING');
          return { invitation: validateHostedResponse(JSON.parse(previous.invitation), enrollment) };
        }
        const taken = db.prepare('SELECT 1 FROM allocations WHERE slot_id = ?');
        const slot = configured.find(item => !taken.get(item.id));
        if (!slot) throw fail('HOSTED_CAPACITY_FULL');
        const bundle = createUnixRelayBundle({ enrollment, hosting: 'project-hosted', publicBaseUrl: slot.publicBaseUrl, relay: slot.relay });
        db.prepare('INSERT INTO allocations (installation_id, slot_id, request, invitation, state) VALUES (?, ?, ?, ?, ?)')
          .run(enrollment.installationId, slot.id, requestText, JSON.stringify(bundle.invitation), 'reserved');
        return { bundle, slotId: slot.id };
      });
      if (selected.invitation) return selected.invitation;
      const invitation = structuredClone(selected.bundle.invitation);
      inFlight++;
      try {
        if (await activate(selected.bundle) !== true) throw Error('activation not confirmed');
        const result = db.prepare("UPDATE allocations SET state = 'active' WHERE installation_id = ? AND state = 'reserved' AND slot_id = ? AND request = ? AND invitation = ?")
          .run(enrollment.installationId, selected.slotId, requestText, JSON.stringify(invitation));
        if (result.changes !== 1) throw Error('reservation changed');
        return invitation;
      } catch (error) {
        if (error?.code === 'HOSTED_ACTIVATION_CLEAN_FAILED') {
          try {
            const removed = db.prepare("DELETE FROM allocations WHERE installation_id = ? AND state = 'reserved' AND slot_id = ? AND request = ? AND invitation = ?")
              .run(enrollment.installationId, selected.slotId, requestText, JSON.stringify(invitation));
            if (removed.changes === 1) throw fail('HOSTED_ACTIVATION_RETRYABLE');
          } catch (cleanupError) { if (cleanupError.code === 'HOSTED_ACTIVATION_RETRYABLE') throw cleanupError; }
        }
        try { db.prepare("UPDATE allocations SET state = 'uncertain' WHERE installation_id = ? AND state = 'reserved'").run(enrollment.installationId); } catch {}
        throw fail('HOSTED_ACTIVATION_UNCERTAIN');
      } finally { inFlight--; }
      } finally { release(); }
    },
    /** Inspect an uncertain activation; a crash with an in-progress reservation is never assumed safe. */
    async reconcile(value, inspect) {
      if (closed) throw fail('HOSTED_DATABASE_CLOSED');
      if (typeof inspect !== 'function') throw fail('HOSTED_RECONCILIATION_INVALID');
      const enrollment = createHostedEnrollment(value); enrollment.requestedBackends.sort();
      const requestText = JSON.stringify(enrollment);
      const release = acquire(enrollment.installationId);
      try {
      const previous = db.prepare('SELECT request, invitation, state, slot_id FROM allocations WHERE installation_id = ?').get(enrollment.installationId);
      if (!previous || previous.request !== requestText) throw fail('HOSTED_ALLOCATION_CONFLICT');
      const invitation = validateHostedResponse(JSON.parse(previous.invitation), enrollment);
      if (previous.state === 'active') return invitation;
      if (!['uncertain', 'reserved'].includes(previous.state)) throw fail('HOSTED_ALLOCATION_PENDING');
      const slotRow = db.prepare('SELECT definition FROM slots WHERE id = ?').get(previous.slot_id);
      if (!slotRow) throw fail('HOSTED_RECONCILIATION_UNCONFIRMED');
      const slot = canonicalSlot(JSON.parse(slotRow.definition));
      const bundle = createUnixRelayBundle({ enrollment, hosting: 'project-hosted', publicBaseUrl: slot.publicBaseUrl, relay: slot.relay });
      if (JSON.stringify(bundle.invitation) !== previous.invitation) throw fail('HOSTED_RECONCILIATION_UNCONFIRMED');
      inFlight++;
      try {
        let confirmed = false;
        try { confirmed = await inspect(bundle) === true; } catch {}
        if (!confirmed) throw fail('HOSTED_RECONCILIATION_UNCONFIRMED');
        const result = db.prepare("UPDATE allocations SET state = 'active' WHERE installation_id = ? AND state IN ('uncertain', 'reserved') AND slot_id = ? AND request = ? AND invitation = ?")
          .run(enrollment.installationId, previous.slot_id, requestText, previous.invitation);
        if (result.changes !== 1) throw fail('HOSTED_RECONCILIATION_UNCONFIRMED');
        return invitation;
      } finally { inFlight--; }
      } finally { release(); }
    },
    close() { if (inFlight) throw fail('HOSTED_ALLOCATION_PENDING'); if (!closed) { closed = true; db.close(); } },
  };
}

/** Retry only by inspecting the reserved service, never by repeating a possibly partial installation. */
export function createHostedProvisioner({ allocator, inspect } = {}) {
  if (typeof allocator?.provision !== 'function' || typeof allocator?.reconcile !== 'function' || typeof inspect !== 'function') throw fail('HOSTED_RECONCILIATION_INVALID');
  return async enrollment => {
    try { return await allocator.provision(enrollment); }
    catch (error) { if (error.code !== 'HOSTED_ALLOCATION_PENDING') throw error; return allocator.reconcile(enrollment, inspect); }
  };
}
