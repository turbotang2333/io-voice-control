import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedInfrastructurePlan } from './shared-infrastructure.mjs';

const fail = code => Object.assign(Error(code), { code });

// Produces a new directory of public source files; does not install or contact a server.
export function writeSharedInstallerBundle({ output } = {}) {
  if (!isAbsolute(output ?? '') || existsSync(output)) throw fail('SHARED_BUNDLE_EXISTS');
  const plan = createSharedInfrastructurePlan({ publicPort: 24443, sshPort: 2222, suffix: 'relay.example.test', nodePath: '/usr/bin/node' });
  const paths = [...plan.sourceFiles.map(path => path.replace('/opt/rayneo-paseo-shared/', '')),
    'relay/shared-infrastructure-linux.mjs', 'relay/shared-hosted-linux.mjs', 'relay/shared-wizard.mjs',
    'relay/shared-hosted-upgrade-plan.mjs', 'relay/shared-hosted-upgrade-load.mjs', 'relay/shared-hosted-upgrade-files.mjs', 'relay/shared-hosted-upgrade-driver.mjs', 'relay/shared-hosted-upgrade-lock.mjs',
    'relay/shared-hosted-upgrade-transaction.mjs', 'relay/shared-hosted-upgrade-guard.mjs', 'relay/shared-hosted-upgrade-guard-plan.mjs',
    'relay/shared-hosted-guard-install.mjs', 'relay/shared-hosted-guard-linux.mjs', 'relay/shared-hosted-systemd-service.mjs', 'relay/shared-hosted-upgrade-cli.mjs'];
  mkdirSync(output, { mode: 0o755 });
  for (const directory of ['relay', 'secure-link', 'distribution']) mkdirSync(join(output, directory), { mode: 0o755 });
  for (const path of paths) writeFileSync(join(output, path), readFileSync(new URL('../' + path, import.meta.url)), { flag: 'wx', mode: 0o644 });
  return { prepared: true, installed: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--output') throw fail('SHARED_BUNDLE_INVALID');
    process.stdout.write(JSON.stringify(writeSharedInstallerBundle({ output: resolve(process.argv[3]) })) + '\n');
  } catch (error) { process.stderr.write((/^SHARED_[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'SHARED_BUNDLE_FAILED') + '\n'); process.exitCode = 1; }
}
