import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { validateRuntimeConfig } from '../bridge/runtime-config.mjs';
import { relayArguments } from '../bridge/supervisor.mjs';

const root = join(homedir(), '.local-secrets', 'rayneo-paseo');
const local = JSON.parse(readFileSync(join(root, 'local-test.json'), 'utf8'));
for (const name of ['server.p12', 'local.cer', 'apk-signing.p12']) {
  if (!existsSync(join(root, name))) throw new Error('Existing USB credential set is incomplete; refusing to replace it');
}
const path = join(root, 'daily.json');
if (!existsSync(path)) {
  const config = { version: 1, port: 7468, apiToken: randomBytes(32).toString('hex') };
  validateRuntimeConfig(config, { daily: true });
  writeFileSync(path, JSON.stringify(config, null, 2), { flag: 'wx', mode: 0o600 });
}
validateRuntimeConfig(JSON.parse(readFileSync(path, 'utf8')), { daily: true });
const hostFlag = process.argv.indexOf('--ssh-host');
const relayPath = join(root, 'relay.json');
if (!existsSync(relayPath)) {
  const relay = { version: 1, enabled: false, sshHost: hostFlag >= 0 ? process.argv[hostFlag + 1] : '', remotePort: 17477 };
  if (hostFlag >= 0) relayArguments(relay, 7468);
  writeFileSync(relayPath, JSON.stringify(relay, null, 2), { flag: 'wx', mode: 0o600 });
}
console.log('日常版独立令牌配置已准备；未输出令牌、未覆盖 USB 配置、未连接设备或服务器。');
