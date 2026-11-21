import { createHash, randomBytes } from 'node:crypto';
import { closeSync, lstatSync, openSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

const fail = () => Object.assign(Error('INVITE_STORE_INVALID'), { code: 'INVITE_STORE_INVALID' });
const validCode = value => typeof value === 'string' && /^rnp-[A-Za-z0-9_-]{43}$/.test(value);
const digest = value => createHash('sha256').update(value).digest('hex');

/** Codes are stored only as hashes. A claim is atomic across processes. */
export async function createInviteStore({ path, now = Date.now } = {}) {
  if (!isAbsolute(path ?? '') || typeof now !== 'function') throw fail();
  const parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink() || process.platform !== 'win32' && (parent.uid !== process.geteuid() || (parent.mode & 0o077))) throw fail();
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || process.platform !== 'win32' && (stat.uid !== process.geteuid() || (stat.mode & 0o077))) throw fail();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const fd = openSync(path, 'wx', 0o600); closeSync(fd);
  }
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout=3000; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS invites (code_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, binding TEXT, revoked INTEGER NOT NULL DEFAULT 0);');
  return {
    issue({ ttlMs = 7 * 86400000 } = {}) {
      const time = now();
      if (!Number.isSafeInteger(time) || !Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 30 * 86400000 || !Number.isSafeInteger(time + ttlMs)) throw fail();
      const code = 'rnp-' + randomBytes(32).toString('base64url');
      db.prepare('INSERT INTO invites (code_hash, expires_at) VALUES (?, ?)').run(digest(code), time + ttlMs);
      return code;
    },
    claim(code, binding) {
      if (!validCode(code) || typeof binding !== 'string' || !/^[a-f0-9]{64}$/.test(binding)) return false;
      const time = now(); if (!Number.isSafeInteger(time)) throw fail();
      return db.prepare('UPDATE invites SET binding = ? WHERE code_hash = ? AND revoked = 0 AND (binding = ? OR (binding IS NULL AND expires_at > ?))')
        .run(binding, digest(code), binding, time).changes === 1;
    },
    revoke(code) {
      if (!validCode(code)) return false;
      return db.prepare('UPDATE invites SET revoked = 1 WHERE code_hash = ? AND revoked = 0').run(digest(code)).changes === 1;
    },
    close() { db.close(); },
  };
}
