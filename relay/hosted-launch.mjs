import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHostedService } from './hosted-service.mjs';

const fail = code => Object.assign(Error(code), { code });
const localPath = value => typeof value === 'string' && posix.isAbsolute(value) && posix.normalize(value) === value && !/[\0\r\n]/.test(value);

/** This is operator configuration; no service is opened while validating it. */
export function validateHostedLaunchConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || Object.keys(config).some(key => !['version', 'listenHost', 'listenPort', 'databasePath', 'tlsKeyPath', 'tlsCertPath', 'slots'].includes(key))
    || config.version !== 1 || !['127.0.0.1', '0.0.0.0'].includes(config.listenHost)
    || !Number.isInteger(config.listenPort) || config.listenPort < 1024 || config.listenPort > 65535
    || ![config.databasePath, config.tlsKeyPath, config.tlsCertPath].every(localPath)
    || !Array.isArray(config.slots) || config.slots.length < 1 || config.slots.length > 256) throw fail('HOSTED_LAUNCH_INVALID');
  return config;
}

function safeParents(path) {
  let parent = posix.dirname(path);
  while (true) {
    const stat = lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) throw fail('HOSTED_LAUNCH_INVALID');
    if (parent === '/') break;
    parent = posix.dirname(parent);
  }
}

function readRegular(path, { privateFile = false, allowSymlink = false, limit = 65536 } = {}) {
  let actual = path, stat = lstatSync(path);
  if (allowSymlink && process.platform !== 'win32') {
    safeParents(path); actual = realpathSync(path); safeParents(actual); stat = lstatSync(actual);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit
    || process.platform !== 'win32' && (privateFile && (stat.uid !== 0 || (stat.mode & 0o077) !== 0)
      || allowSymlink && (stat.uid !== 0 || (stat.mode & 0o022) !== 0))) throw fail('HOSTED_LAUNCH_INVALID');
  return readFileSync(actual);
}

/** Certificate links may rotate, but their paths and targets must remain root-controlled. */
export function loadHostedTls(config) {
  return { key: readRegular(config.tlsKeyPath, { privateFile: true, allowSymlink: true }),
    cert: readRegular(config.tlsCertPath, { allowSymlink: true }) };
}

export function refreshHostedTls(server, config) { server.setSecureContext(loadHostedTls(config)); }

async function main(args) {
  if (args.length !== 2 || args[0] !== '--config' || !localPath(args[1]) || process.platform !== 'linux' || process.getuid?.() !== 0) throw fail('HOSTED_LAUNCH_INVALID');
  const config = validateHostedLaunchConfig(JSON.parse(readRegular(args[1], { privateFile: true, limit: 131072 }).toString('utf8')));
  const tls = loadHostedTls(config);
  const service = await createHostedService({ databasePath: config.databasePath, slots: config.slots, tls });
  try {
    await new Promise((accept, reject) => { service.server.once('error', reject); service.server.listen(config.listenPort, config.listenHost, accept); });
  } catch (error) { await service.close(); throw error; }
  process.stdout.write('HOSTED_READY\n');
  const refresh = setInterval(() => {
    try { refreshHostedTls(service.server, config); }
    catch { process.stderr.write('HOSTED_TLS_RELOAD_FAILED\n'); }
  }, 15 * 60 * 1000);
  refresh.unref();
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    if (stopping) return; stopping = true;
    clearInterval(refresh);
    service.close().catch(() => { process.exitCode = 1; });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => { process.stderr.write('HOSTED_LAUNCH_FAILED\n'); process.exitCode = 1; });
}
