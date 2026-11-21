import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { desktopAvailable } from './client.mjs';
const run = promisify(execFile);
const fail = code => Object.assign(new Error(code), { code });

// The installed desktop handles this wake-only URL without navigating its visible window.
// It reads the existing queue and resumes only when queued input exists. No message is put in the URL.
export function createDesktopWake({ isAvailable = () => process.platform === 'win32' && desktopAvailable(), now = Date.now,
  launch = uri => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Start-Process -FilePath '${uri}' -WindowStyle Hidden -ErrorAction Stop`], { windowsHide: true, timeout: 10000 }) } = {}) {
  const lastWake = new Map();
  return {
    available: isAvailable,
    async run(threadId) {
      if (typeof threadId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(threadId)) throw fail('INVALID_TARGET');
      if (!isAvailable()) throw fail('DESKTOP_UNAVAILABLE');
      if (lastWake.has(threadId) && now() - lastWake.get(threadId) < 5000) return;
      lastWake.set(threadId, now());
      try { await launch('codex://threads/wake/' + threadId); }
      catch { throw fail('DESKTOP_WAKE_UNCONFIRMED'); }
    },
  };
}
