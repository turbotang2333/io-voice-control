import { lstatSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/** Never bypass a damaged primary identity; only use a separate home when no primary exists. */
export function createRoutedSecureActions({ privateDirectory, create } = {}) {
  if (!isAbsolute(privateDirectory ?? '') || typeof create !== 'function') throw Error('SECURE_CONFIGURATION_INVALID');
  const present = path => { try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
  const existing = join(privateDirectory, 'secure-existing'), cache = new Map();
  const active = () => {
    const primary = present(join(privateDirectory, 'secure-link')) || present(join(privateDirectory, 'secure-link-enabled.json'));
    const path = !primary && present(existing) ? existing : privateDirectory;
    if (!cache.has(path)) cache.set(path, create(path));
    return cache.get(path);
  };
  return Object.fromEntries(['status', 'configure', 'connect', 'pair', 'changeIp', 'restoreIp'].map(name => [name, (...args) => active()[name](...args)]));
}
