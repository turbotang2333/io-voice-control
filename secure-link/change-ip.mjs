import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';
import { changeSelfHostedIp, loadSecureLink, restoreInterruptedSelfHostedIp } from './setup.mjs';

export async function changeIpCommand(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--ip', '--restore', '--private-directory', '--state-directory'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw Error('SECURE_ARGUMENTS_INVALID');
    options[args[i]] = args[i + 1];
  }
  const ip = options['--ip'];
  const privateDirectory = options['--private-directory'] ?? join(homedir(), '.local-secrets/rayneo-paseo');
  const stateDirectory = options['--state-directory'] ?? join(homedir(), '.local/state/rayneo-paseo');
  if (!isAbsolute(privateDirectory) || !isAbsolute(stateDirectory) || Boolean(ip) === Boolean(options['--restore'])) throw Error('SECURE_ARGUMENTS_INVALID');
  if (options['--restore']) return restoreInterruptedSelfHostedIp({ privateDirectory, stateDirectory, backupDirectory: options['--restore'] });
  if (isIP(ip) !== 4) throw Error('SECURE_ARGUMENTS_INVALID');
  const current = loadSecureLink(privateDirectory).invitation;
  const url = new URL(current.publicBaseUrl); url.hostname = ip;
  const invitation = { ...current, publicBaseUrl: url.origin, relay: { ...current.relay, host: ip } };
  return changeSelfHostedIp({ privateDirectory, stateDirectory, invitation });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  changeIpCommand(process.argv.slice(2)).then(result => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch(error => { const code = error.code ?? error.message; process.stderr.write((/^SECURE_[A-Z_]+$/.test(code ?? '') ? code : 'SECURE_IP_UPDATE_FAILED') + '\n'); process.exitCode = 1; });
}
