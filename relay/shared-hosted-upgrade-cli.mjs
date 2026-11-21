import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { loadSharedHostedUpgradePlan } from './shared-hosted-upgrade-load.mjs';
import { createSharedHostedGuardPlan } from './shared-hosted-upgrade-guard-plan.mjs';
import { createSharedHostedGuardLinuxDriver } from './shared-hosted-guard-linux.mjs';
import { installSharedHostedGuard } from './shared-hosted-guard-install.mjs';
import { createSharedHostedUpgradeDriver, recoverSharedHostedUpgrade } from './shared-hosted-upgrade-driver.mjs';
import { createSharedHostedSystemdService } from './shared-hosted-systemd-service.mjs';
import { executeSharedHostedUpgrade } from './shared-hosted-upgrade-transaction.mjs';

const fail = code => Object.assign(Error(code), { code });
const root = '/', candidateRoot = '/run/rayneo-paseo-hosted-upgrade/bundle';
async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write('Usage: node shared-hosted-upgrade-cli.mjs --check | --install-guard | --upgrade | --recover\n'); return;
  }
  if (process.platform !== 'linux' || process.geteuid?.() !== 0 || args.length !== 1
    || !['--check', '--install-guard', '--upgrade', '--recover'].includes(args[0])) throw fail('SHARED_HOSTED_UPGRADE_CLI_INVALID');
  if (args[0] === '--recover') {
    process.stdout.write(JSON.stringify(await recoverSharedHostedUpgrade({ root })) + '\n'); return;
  }
  const plan = loadSharedHostedUpgradePlan({ root, candidateRoot });
  if (args[0] === '--check') {
    const service = createSharedHostedSystemdService();
    const guardReady = await service.guardReady(plan.nextConfig.infrastructure.nodePath);
    const serviceHealthy = await service.isActive() && await service.verifyOld(plan.nextConfig);
    process.stdout.write(JSON.stringify({ checked: true, changedFiles: plan.sourceChanges.length, guardReady, serviceHealthy }) + '\n'); return;
  }
  if (args[0] === '--install-guard') {
    const nodePath = plan.nextConfig.infrastructure.nodePath;
    const driver = createSharedHostedGuardLinuxDriver({ root, nodePath });
    process.stdout.write(JSON.stringify(await installSharedHostedGuard(createSharedHostedGuardPlan({ nodePath }), driver)) + '\n'); return;
  }
  process.stdout.write(JSON.stringify(await executeSharedHostedUpgrade(plan, createSharedHostedUpgradeDriver({ root }))) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write((/^SHARED_[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'SHARED_HOSTED_UPGRADE_CLI_FAILED') + '\n'); process.exitCode = 1;
  });
}
