// Stop only bootstrap acceptance services whose enrolled key is present in this isolated test's /run directory.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
if (process.env.RAYNEO_ISOLATED_SYSTEMD_TEST !== '1' || process.getuid() !== 0 || !existsSync('/etc/rayneo-isolated-systemd-test-only')) throw Error('ISOLATION_REQUIRED');
const keys = new Set(readdirSync('/run').filter(name => name.startsWith('rayneo-bootstrap-acceptance-')).flatMap(name => {
  const file = join('/run', name, 'client.pub');
  return existsSync(file) ? [readFileSync(file, 'utf8').trim().split(/\s+/).slice(0, 2).join(' ')] : [];
}));
const root = '/var/lib/rayneo-relay';
let stopped = 0;
for (const id of existsSync(root) ? readdirSync(root) : []) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) continue;
  const file = join(root, id, 'authorized_keys'); if (!existsSync(file)) continue;
  const parts = readFileSync(file, 'utf8').trim().split(/\s+/), publicKey = parts.slice(1, 3).join(' ');
  if (!keys.has(publicKey)) continue;
  execFileSync('systemctl', ['disable', '--now', `rayneo-relay-${id}.service`, `rayneo-ssh-${id}.service`], { stdio: 'pipe', timeout: 30000 }); stopped++;
}
console.log('ISOLATED_TEST_SERVICES_STOPPED=' + stopped);
