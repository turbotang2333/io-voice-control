import { execFileSync } from 'node:child_process';
import { randomUUID, X509Certificate } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSshPublicKey } from '../secure-link/config.mjs';

const fail = code => Object.assign(Error(code), { code });
function read(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw fail('CONNECTOR_EXISTING_CONFIGURATION');
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
}
function defaultProtect(directory) {
  if (process.platform !== 'win32') return;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    fileURLToPath(new URL('./protect-directory.ps1', import.meta.url)), '-Directory', directory],
    { windowsHide: true, stdio: 'pipe', timeout: 30000 });
}
function defaultKey(path) {
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path], { windowsHide: true, stdio: 'pipe', timeout: 30000 });
}
function enrollment(root) {
  const meta = read(join(root, 'installation.json'));
  if (meta.version !== 1 || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(meta.installationId ?? '')
    || !Array.isArray(meta.backends) || !meta.backends.length || meta.backends.some(name => !['paseo', 'codex'].includes(name))) throw fail('CONNECTOR_SETUP_INVALID');
  const keyPath = join(root, 'relay-key.pem.pub'), stat = lstatSync(keyPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw fail('CONNECTOR_SETUP_INVALID');
  return { version: 1, installationId: meta.installationId, requestedBackends: [...meta.backends],
    sshPublicKey: validateSshPublicKey(readFileSync(keyPath, 'utf8').trim().split(/\s+/).slice(0, 2).join(' ')) };
}

/** Make a separate protected identity for an existing installation; never rewrite its current settings. */
export async function prepareExistingSecureHome({ privateDirectory, prepareKey = defaultKey, protectDirectory = defaultProtect } = {}) {
  if (!isAbsolute(privateDirectory ?? '') || lstatSync(privateDirectory).isSymbolicLink() || !lstatSync(privateDirectory).isDirectory()) throw fail('CONNECTOR_SETUP_INVALID');
  const target = join(privateDirectory, 'secure-existing');
  if (existsSync(target)) {
    if (lstatSync(target).isSymbolicLink() || !lstatSync(target).isDirectory()) throw fail('CONNECTOR_SETUP_INVALID');
    return { privateDirectory: target, enrollment: enrollment(target), reused: true };
  }
  const staging = mkdtempSync(join(privateDirectory, '.secure-existing-'));
  try {
    await protectDirectory(staging);
    const cert = join(privateDirectory, 'local.cer'), certStat = lstatSync(cert);
    if (!certStat.isFile() || certStat.isSymbolicLink() || certStat.size > 16384) throw fail('CONNECTOR_SETUP_INVALID');
    new X509Certificate(readFileSync(cert));
    copyFileSync(cert, join(staging, 'local.cer'));
    const backends = [];
    for (const [name, file, token] of [['paseo', 'daily.json', 'apiToken'], ['codex', 'shared-runtime/connector.json', 'token']]) {
      const source = join(privateDirectory, file); if (!existsSync(source)) continue;
      const value = read(source);
      if (!Number.isInteger(value.port) || value.port < 1024 || value.port > 65535 || !/^[a-f0-9]{64}$/.test(value[token] ?? '')) throw fail('CONNECTOR_SETUP_INVALID');
      if (name === 'codex') mkdirSync(join(staging, 'shared-runtime'), { mode: 0o700 });
      writeFileSync(join(staging, file), JSON.stringify({ port: value.port, [token]: value[token] }), { flag: 'wx', mode: 0o600 });
      backends.push(name);
    }
    if (!backends.length) throw fail('CONNECTOR_SETUP_INVALID');
    writeFileSync(join(staging, 'installation.json'), JSON.stringify({ version: 1, installationId: randomUUID(), backends,
      phase: 'awaiting-invitation' }), { flag: 'wx', mode: 0o600 });
    await prepareKey(join(staging, 'relay-key.pem'));
    enrollment(staging);
    if (existsSync(target)) throw fail('CONNECTOR_ALREADY_PREPARED');
    renameSync(staging, target);
    return { privateDirectory: target, enrollment: enrollment(target), reused: false };
  } finally {
    if (existsSync(staging) && !lstatSync(staging).isSymbolicLink() && resolve(staging).startsWith(resolve(privateDirectory) + sep)
      && realpathSync(staging).startsWith(realpathSync(privateDirectory) + sep)) rmSync(staging, { recursive: true });
  }
}
