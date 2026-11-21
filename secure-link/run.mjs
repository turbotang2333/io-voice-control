import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireSupervisorLock } from '../bridge/supervisor.mjs';
import { loadSecureLink } from './setup.mjs';
import { startSecureLinkService, inspectSecureLink } from './service.mjs';

export async function runSecureLink(args) {
  const [mode, ...rest] = args, options = {};
  if (!['start', 'check', 'status'].includes(mode)) throw Object.assign(Error(), { code: 'SECURE_ARGUMENTS_INVALID' });
  for (let i = 0; i < rest.length; i += 2) {
    if (!['--private-directory', '--state-directory'].includes(rest[i]) || !isAbsolute(rest[i + 1] ?? '') || options[rest[i]])
      throw Object.assign(Error(), { code: 'SECURE_ARGUMENTS_INVALID' });
    options[rest[i]] = rest[i + 1];
  }
  const privateDirectory = options['--private-directory'] ?? join(homedir(), '.local-secrets/rayneo-paseo');
  const stateDirectory = join(options['--state-directory'] ?? join(homedir(), '.local/state/rayneo-paseo'), 'secure-link');
  if (mode === 'check') { loadSecureLink(privateDirectory); return { configured: true, encryption: 'unverified', serviceStarted: false, modelMessagesSent: 0 }; }
  if (mode === 'status') return inspectSecureLink(loadSecureLink(privateDirectory));
  mkdirSync(stateDirectory, { recursive: true });
  const release = acquireSupervisorLock(join(stateDirectory, 'supervisor.lock'));
  let service;
  try {
    const config = loadSecureLink(privateDirectory);
    service = await startSecureLinkService({ configuration: config, getBackends: () => {
      const current = loadSecureLink(privateDirectory);
      if (current.certificateSha256 !== config.certificateSha256 || current.invitation.publicBaseUrl !== config.invitation.publicBaseUrl)
        throw Object.assign(Error(), { code: 'SECURE_IDENTITY_INVALID' });
      return current.backends;
    } });
    process.stdout.write('{"started":true,"encryption":"unverified","modelMessagesSent":0}\n');
    await new Promise(accept => {
      process.once('SIGINT', accept); process.once('SIGTERM', accept);
      process.on('message', value => { if (value === 'stop-secure-link') accept(); });
    });
    if (process.connected) process.disconnect();
  } finally { await service?.stop(); release(); }
  return { stopped: true, nativeAssistantsStopped: false, modelMessagesSent: 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runSecureLink(process.argv.slice(2)).then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => {
    process.stderr.write((error?.code === 'ENOENT' ? 'SECURE_CONFIGURATION_MISSING' : /^SECURE_[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'SECURE_START_FAILED') + '\n');
    process.exitCode = 1;
  });
}
