import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const reasons = new Set(['port_in_use', 'remote_forward_failed', 'authentication_failed', 'host_key_failed',
  'connection_timeout', 'connection_refused', 'connection_lost', 'dns_failed', 'network_unreachable',
  'executable_missing', 'permission_denied', 'unknown_exit', 'stopped']);

/** Classify in memory. Never retain or expose SSH stderr, destinations or credentials. */
export function classifySshFailure(stderr = '', errorCode) {
  if (errorCode === 'ENOENT') return 'executable_missing';
  if (['EACCES', 'EPERM'].includes(errorCode)) return 'permission_denied';
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(stderr)) return 'host_key_failed';
  if (/Permission denied \(|Authentication failed|No supported authentication methods/i.test(stderr)) return 'authentication_failed';
  if (/Address already in use/i.test(stderr)) return 'port_in_use';
  // OpenSSH's generic forwarding error does not establish why the server refused it.
  if (/remote port forwarding failed|remote forward failure/i.test(stderr)) return 'remote_forward_failed';
  if (/Could not resolve hostname|Name or service not known/i.test(stderr)) return 'dns_failed';
  if (/Network is unreachable|No route to host/i.test(stderr)) return 'network_unreachable';
  if (/Connection timed out|Operation timed out|Timeout, server/i.test(stderr)) return 'connection_timeout';
  if (/Connection refused/i.test(stderr)) return 'connection_refused';
  if (/Connection reset|Broken pipe|Connection .*closed|Connection to .*closed|Connection .*aborted/i.test(stderr)) return 'connection_lost';
  return 'unknown_exit';
}

function cleanEvent(event) {
  if (!event || !['started', 'exited', 'restarting'].includes(event.type)
    || typeof event.at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(event.at)) return null;
  const clean = { type: event.type, at: event.at };
  for (const key of ['pid', 'exitCode', 'durationMs', 'delayMs']) {
    if (Number.isSafeInteger(event[key]) && event[key] >= 0) clean[key] = event[key];
  }
  if (reasons.has(event.reason)) clean.reason = event.reason;
  if (typeof event.intentional === 'boolean') clean.intentional = event.intentional;
  if (typeof event.signal === 'string' && /^SIG[A-Z0-9]{1,12}$/.test(event.signal)) clean.signal = event.signal;
  return clean;
}

export function pruneRelayEvents(path, now = Date.now()) {
  let saved;
  try {
    if (statSync(path).size > 65536) return;
    saved = JSON.parse(readFileSync(path, 'utf8'));
  } catch { return; }
  if (!Array.isArray(saved.events)) return;
  const events = saved.events.map(cleanEvent).filter(event => {
    if (!event) return false;
    const time = Date.parse(event.at);
    return Number.isFinite(time) && time >= now - 14 * 24 * 60 * 60 * 1000 && time <= now;
  });
  if (events.length === saved.events.length) return;
  const temp = path + '.tmp';
  writeFileSync(temp, JSON.stringify({ version: 1, updatedAt: new Date(now).toISOString(), events }) + '\n', { mode: 0o600 });
  renameSync(temp, path);
}

/** A bounded, revalidated history survives supervisor reloads without storing raw process output. */
export function recordRelayEvent(path, event) {
  pruneRelayEvents(path);
  let history = [];
  try {
    if (statSync(path).size <= 65536) {
      const saved = JSON.parse(readFileSync(path, 'utf8'));
      if (Array.isArray(saved.events)) history = saved.events.slice(-31).map(cleanEvent).filter(Boolean);
    }
  } catch { /* An absent or damaged diagnostic file must not prevent recovery. */ }
  const entry = cleanEvent({ ...event, at: new Date().toISOString() });
  if (!entry) return;
  mkdirSync(dirname(path), { recursive: true });
  const temp = path + '.tmp';
  writeFileSync(temp, JSON.stringify({ version: 1, updatedAt: entry.at, events: [...history, entry] }) + '\n', { mode: 0o600 });
  renameSync(temp, path);
}
