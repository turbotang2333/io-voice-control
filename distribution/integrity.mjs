import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

const fail = () => Object.assign(Error('PACKAGE_INTEGRITY_FAILED'), { code: 'PACKAGE_INTEGRITY_FAILED' });
async function fingerprint(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Detects incomplete extraction and accidental file changes; this is not a publisher signature. */
export async function verifyConnectorPackage(root) {
  try {
    if (!isAbsolute(root) || (await lstat(root)).isSymbolicLink()) throw fail();
    const manifestPath = join(root, 'manifest.json'), stat = await lstat(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw fail();
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (manifest.format !== 1 || manifest.platform !== 'win32' || manifest.architecture !== process.arch
      || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 100000) throw fail();
    const entries = new Map();
    for (const entry of manifest.files) {
      if (typeof entry.path !== 'string' || entry.path.length > 1000 || /[\\:\0]/.test(entry.path)
        || entry.path.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))
        || !/^(?:app\/|runtime\/|Setup\.cmd$|眼镜连接器\.exe$)/.test(entry.path)
        || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)
        || entries.has(entry.path.toLowerCase())) throw fail();
      entries.set(entry.path.toLowerCase(), entry);
    }
    const seen = new Set();
    async function walk(directory, prefix = '') {
      for (const name of await readdir(directory)) {
        const path = prefix ? prefix + '/' + name : name, file = join(directory, name), info = await lstat(file);
        if (info.isSymbolicLink()) throw fail();
        if (info.isDirectory()) { await walk(file, path); continue; }
        if (path === 'manifest.json') continue;
        const entry = entries.get(path.toLowerCase());
        if (!info.isFile() || !entry || info.size !== entry.bytes || await fingerprint(file) !== entry.sha256) throw fail();
        seen.add(path.toLowerCase());
      }
    }
    await walk(root);
    if (seen.size !== entries.size) throw fail();
    for (const required of ['runtime/node.exe', 'runtime/license', 'setup.cmd', 'app/distribution/launch.mjs', 'app/distribution/connector.mjs', 'app/bridge/server.mjs']) {
      if (!seen.has(required)) throw fail();
    }
    return { verified: true, version: manifest.version, files: seen.size };
  } catch { throw fail(); }
}
