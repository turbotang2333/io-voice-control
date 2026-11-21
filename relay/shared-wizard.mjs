import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateSharedHostedLaunchConfig, createSharedHostedLaunchPlan, installSharedHostedService, loadSharedHostedTls } from './shared-hosted-launch.mjs';
import { createSharedInfrastructurePlan, inspectSharedInfrastructure, installSharedInfrastructure } from './shared-infrastructure.mjs';
import { createSharedLinuxInfrastructureDriver } from './shared-infrastructure-linux.mjs';
import { createSharedHostedLinuxDriver } from './shared-hosted-linux.mjs';

const fail = code => Object.assign(Error(code), { code });

export function prepareSharedHostedConfig({ answers, hostKey, nodePath, listenHost = '0.0.0.0' } = {}) {
  try {
    if (!answers || Object.keys(answers).some(key => !['publicBaseUrl', 'sshHost', 'sshPort', 'enrollmentPort', 'tlsKeyPath', 'tlsCertPath', 'maxAllocations'].includes(key))) throw Error();
    const endpoint = new URL(answers.publicBaseUrl);
    return validateSharedHostedLaunchConfig({ version: 1, listenHost, listenPort: answers.enrollmentPort,
      databasePath: '/var/lib/rayneo-paseo-shared-hosted/registry.sqlite', inviteDatabasePath: '/var/lib/rayneo-paseo-shared-hosted/invites.sqlite', tlsKeyPath: answers.tlsKeyPath, tlsCertPath: answers.tlsCertPath,
      maxAllocations: answers.maxAllocations,
      shared: { publicBaseUrl: answers.publicBaseUrl, relay: { host: answers.sshHost, port: answers.sshPort, hostKey } },
      infrastructure: { publicPort: Number(endpoint.port || 443), sshPort: answers.sshPort, suffix: endpoint.hostname, nodePath, listenHost } });
  } catch { throw fail('SHARED_WIZARD_INVALID'); }
}

export async function installSharedHostedStack({ config, inspectInfrastructure, installInfrastructure, inspectHosted, installHosted } = {}) {
  const safe = validateSharedHostedLaunchConfig(config);
  if ([inspectInfrastructure, installInfrastructure, inspectHosted, installHosted].some(value => typeof value !== 'function')) throw fail('SHARED_WIZARD_INVALID');
  if (await inspectInfrastructure(safe.infrastructure) !== true) await installInfrastructure(safe.infrastructure);
  if (await inspectHosted(safe) !== true) await installHosted(safe);
  return { installed: true, encryption: 'unverified' };
}

async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write('用法：node relay/shared-wizard.mjs --check 或 --install，可加 --answers 配置文件。\n需要已有域名和证书；安装会创建独立的共用中转与登记服务。\n'); return;
  }
  if (process.platform !== 'linux' || process.geteuid?.() !== 0 || !['--check', '--install'].includes(args[0])
    || !(args.length === 1 || args.length === 3 && args[1] === '--answers')) throw fail('SHARED_WIZARD_INVALID');
  let answers;
  if (args.length === 3) {
    const bytes = readFileSync(resolve(args[2])); if (bytes.length > 16384) throw fail('SHARED_WIZARD_INVALID');
    answers = JSON.parse(bytes.toString('utf8'));
  } else {
    if (!process.stdin.isTTY) throw fail('SHARED_WIZARD_INPUT_REQUIRED');
    const prompt = createInterface({ input: process.stdin, output: process.stderr });
    const ask = async (message, fallback) => (await prompt.question(`${message}${fallback ? ` [${fallback}]` : ''}：`)).trim() || fallback;
    try {
      const publicBaseUrl = await ask('中转地址，例如 https://relay.example.com:28443');
      answers = { publicBaseUrl, sshHost: await ask('服务器 SSH 域名', new URL(publicBaseUrl).hostname),
        sshPort: Number(await ask('共用 SSH 端口', '28444')), enrollmentPort: Number(await ask('共用登记端口', '28445')),
        tlsCertPath: await ask('登记服务证书路径'), tlsKeyPath: await ask('登记服务证书私钥路径'),
        maxAllocations: Number(await ask('允许登记的电脑数量上限', '1000')) };
    } finally { prompt.close(); }
  }
  const hostKey = readFileSync('/etc/ssh/ssh_host_ed25519_key.pub', 'utf8').trim().split(/\s+/).slice(0, 2).join(' ');
  const config = prepareSharedHostedConfig({ answers, hostKey, nodePath: process.execPath });
  const sourceRoot = fileURLToPath(new URL('..', import.meta.url));
  const infrastructureDriver = createSharedLinuxInfrastructureDriver({ sourceRoot, options: config.infrastructure });
  const hostedDriver = createSharedHostedLinuxDriver({ config });
  if (args[0] === '--check') {
    const installed = await inspectSharedInfrastructure(config.infrastructure);
    if (!installed) await infrastructureDriver.preflight(createSharedInfrastructurePlan(config.infrastructure));
    loadSharedHostedTls(config);
    const hostedReady = installed && await hostedDriver.check(createSharedHostedLaunchPlan(config));
    process.stdout.write(JSON.stringify({ ready: Boolean(installed && hostedReady), infrastructureInstalled: installed, hostedInstalled: hostedReady,
      prerequisites: 'partially_checked', networkReachability: 'unverified', encryption: 'unverified' }) + '\n');
    return;
  }
  const result = await installSharedHostedStack({ config, inspectInfrastructure: inspectSharedInfrastructure,
    installInfrastructure: value => installSharedInfrastructure(value, infrastructureDriver),
    inspectHosted: value => hostedDriver.check(createSharedHostedLaunchPlan(value)),
    installHosted: value => installSharedHostedService(value, hostedDriver) });
  process.stdout.write(JSON.stringify(result) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { process.stderr.write((/^SHARED_[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'SHARED_WIZARD_FAILED') + '\n'); process.exitCode = 1; });
}
