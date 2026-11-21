import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const fail = code => Object.assign(Error(code), { code });
const hash = code => createHash('sha256').update(code).digest();

export function loadEnabledPairing(privateRoot, backend) {
  const path = join(privateRoot, 'pairing-config.json');
  if (!existsSync(path)) return undefined;
  if (lstatSync(path).isSymbolicLink() || statSync(path).size > 2048) throw fail('PAIRING_PROFILE_INVALID');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  if (config.version !== 1 || !['paseo', 'codex'].includes(config.hostingBackend)) throw fail('PAIRING_PROFILE_INVALID');
  return config.hostingBackend === backend ? createPairingStore({ directory: join(privateRoot, 'pairing') }) : undefined;
}
function endpoint(value) {
  if (typeof value !== 'string' || value.length > 2048) throw fail('PAIRING_PROFILE_INVALID');
  let url; try { url = new URL(value); } catch { throw fail('PAIRING_PROFILE_INVALID'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase())
    || !/^[A-Za-z0-9/_-]*$/.test(url.pathname) || url.pathname.includes('//')) throw fail('PAIRING_PROFILE_INVALID');
  return url.href.replace(/\/+$/, '');
}
function validateProfiles(profiles) {
  if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)
    || Object.keys(profiles).length < 1 || Object.keys(profiles).some(k => !['paseo', 'codex'].includes(k))) throw fail('PAIRING_PROFILE_INVALID');
  const result = {};
  for (const [key, value] of Object.entries(profiles)) {
    if (!value || Object.keys(value).some(k => !['endpoint', 'port', 'token'].includes(k))
      || !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535 || !/^[a-f0-9]{64}$/.test(value.token ?? '')) throw fail('PAIRING_PROFILE_INVALID');
    result[key] = { endpoint: endpoint(value.endpoint), port: value.port, token: value.token };
  }
  if (result.paseo && result.codex && result.paseo.token === result.codex.token) throw fail('PAIRING_PROFILE_INVALID');
  return result;
}

/** Private local state only. The public QR has one short-lived proof; consuming it erases its credential copy. */
export function createPairingStore({ directory, ttlMs = 120000, now = Date.now } = {}) {
  if (!isAbsolute(directory ?? '') || !Number.isFinite(ttlMs) || ttlMs < 1000 || ttlMs > 300000) throw fail('PAIRING_PROFILE_INVALID');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink()) throw fail('PAIRING_STORAGE_FAILED');
  const file = join(directory, 'ticket.json');
  const read = (path = file) => {
    if (!existsSync(path)) return null;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw fail('PAIRING_STORAGE_FAILED');
    return JSON.parse(readFileSync(path, 'utf8'));
  };
  const privateFile = (prefix, digest) => join(directory, prefix + '-' + digest + '.json');
  const fresh = (path, state) => {
    const fd = openSync(path, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(state)); fsyncSync(fd); } finally { closeSync(fd); }
  };
  const write = state => {
    const temp = join(directory, 'ticket-' + randomBytes(12).toString('hex') + '.tmp');
    fresh(temp, state);
    try { renameSync(temp, file); } catch { try { unlinkSync(temp); } catch {} throw fail('PAIRING_STORAGE_FAILED'); }
  };
  const transientName = /^(?:(?:credentials|consumed)-[a-f0-9]{64}\.json|ticket-[a-f0-9]{24}\.tmp)$/;
  function cleanup() {
    for (const name of readdirSync(directory)) {
      if (!transientName.test(name)) continue;
      try {
        const path = join(directory, name), state = read(path);
        if (state && Number.isFinite(state.expiresAt) && now() >= state.expiresAt) unlinkSync(path);
      } catch { /* Never follow links or reclaim an unreadable/partial consumption marker. */ }
    }
  }
  let cleanupTimer;
  function scheduleCleanup() {
    clearTimeout(cleanupTimer);
    let earliest = Infinity;
    try {
      cleanup();
      for (const name of readdirSync(directory)) {
        if (!transientName.test(name)) continue;
        try {
          const state = read(join(directory, name));
          if (Number.isFinite(state?.expiresAt)) earliest = Math.min(earliest, state.expiresAt);
        } catch { /* Ignore unreadable files without following links. */ }
      }
    } catch { /* Retry transient filesystem failures without interrupting pairing. */ earliest = now() + 1000; }
    if (Number.isFinite(earliest)) {
      cleanupTimer = setTimeout(scheduleCleanup, Math.max(1000, Math.min(2147483647, earliest - now())));
      cleanupTimer.unref();
    }
  }
  scheduleCleanup();
  return {
    issue({ computerLabel, profiles, publicBaseUrl, certificateSha256 } = {}) {
      const safeProfiles = validateProfiles(profiles), base = endpoint(publicBaseUrl);
      if (certificateSha256 !== undefined && (typeof certificateSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(certificateSha256))) throw fail('PAIRING_PROFILE_INVALID');
      if (typeof computerLabel !== 'string' || !computerLabel.trim() || [...computerLabel].length > 60 || /[\p{Cc}\p{Cf}]/u.test(computerLabel)
        || !Object.values(safeProfiles).some(p => p.endpoint === base)) throw fail('PAIRING_PROFILE_INVALID');
      cleanup();
      const code = randomBytes(32).toString('base64url'), expiresAt = now() + ttlMs, digest = hash(code).toString('hex');
      // Publish complete private credentials before the atomic current-ticket pointer.
      fresh(privateFile('credentials', digest), { version: 1, expiresAt, computerLabel: computerLabel.trim(), profiles: safeProfiles,
        ...(certificateSha256 ? { certificateSha256 } : {}) });
      write({ version: 2, hash: digest, expiresAt, used: false });
      scheduleCleanup();
      return { url: base + '/pair#rayneo_pair=' + code + (certificateSha256 ? '&tls_sha256=' + certificateSha256 : ''), expiresAt };
    },
    claim(code) {
      if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(code)) throw fail('PAIRING_UNAVAILABLE');
      const state = read();
      // Old pending temporary tickets expire on upgrade; long-lived connection settings are unchanged.
      if (!state || state.version !== 2 || state.used || !Number.isFinite(state.expiresAt) || now() >= state.expiresAt
        || !/^[a-f0-9]{64}$/.test(state.hash ?? '') || !timingSafeEqual(hash(code), Buffer.from(state.hash, 'hex'))) throw fail('PAIRING_UNAVAILABLE');
      const credentialsPath = privateFile('credentials', state.hash), credentials = read(credentialsPath);
      if (!credentials || credentials.version !== 1 || credentials.expiresAt !== state.expiresAt) throw fail('PAIRING_UNAVAILABLE');
      const profiles = validateProfiles(credentials.profiles);
      if (credentials.certificateSha256 !== undefined && (typeof credentials.certificateSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(credentials.certificateSha256))) throw fail('PAIRING_UNAVAILABLE');
      const result = { version: credentials.certificateSha256 ? 2 : 1, computerLabel: credentials.computerLabel, profiles,
        ...(credentials.certificateSha256 ? { transport: { type: 'tls-passthrough-v1', certificateSha256: credentials.certificateSha256 } } : {}) };
      // A durable per-ticket marker is the single-consumer point. A crash can waste this ticket, never lock future tickets.
      try { fresh(privateFile('consumed', state.hash), { version: 1, expiresAt: state.expiresAt }); }
      catch (error) { throw fail(error?.code === 'EEXIST' ? 'PAIRING_UNAVAILABLE' : 'PAIRING_STORAGE_FAILED'); }
      // Required even after wx: an old paused claimant must not benefit from expiry cleanup deleting a prior marker.
      if (now() >= state.expiresAt) throw fail('PAIRING_UNAVAILABLE');
      unlinkSync(credentialsPath);
      return result;
    },
    cancel() {
      let previous; try { previous = read(); } catch { /* Cancellation can replace an invalid pending ticket. */ }
      write({ version: 2, used: true, expiresAt: now() });
      if (previous?.version === 2 && /^[a-f0-9]{64}$/.test(previous.hash ?? '')) {
        try {
          const path = privateFile('credentials', previous.hash), stat = lstatSync(path);
          if (stat.isFile() && !stat.isSymbolicLink()) unlinkSync(path);
        } catch { /* Expiry cleanup can remove a private copy that is temporarily unavailable. */ }
      }
      cleanup();
    },
    status() {
      const value = read();
      return { kind: !value ? 'none' : value.version !== 2 ? 'expired' : value.used ? 'cancelled'
        : /^[a-f0-9]{64}$/.test(value.hash ?? '') && existsSync(privateFile('consumed', value.hash)) ? 'claimed'
        : now() >= value.expiresAt ? 'expired' : 'waiting' };
    },
  };
}
