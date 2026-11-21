import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { isAbsolute, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { createUnixRelayBundle } from './unix-provision.mjs';

const fail = code => Object.assign(Error(code), { code });
function json(path) { const bytes = readFileSync(path); if (bytes.length > 16384) throw fail('RELAY_INPUT_INVALID'); return JSON.parse(bytes.toString('utf8')); }

/** Emit operator-owned deployment material. Never uploads keys, edits sshd, starts a service, or spends money. */
export function writeRelayBundle({ output, bundle } = {}) {
  if (!isAbsolute(output ?? '') || existsSync(output)) throw fail('RELAY_OUTPUT_EXISTS');
  const validated = createUnixRelayBundle({ enrollment: { version: 1, installationId: bundle.invitation.installationId,
    requestedBackends: bundle.invitation.backends, sshPublicKey: bundle.authorizedKey.split(' ').slice(1).join(' ').trim() },
    ...bundle.invitation });
  mkdirSync(output, { mode: 0o700 });
  for (const [name, value] of Object.entries({ 'invitation.json': JSON.stringify(validated.invitation, null, 2) + '\n',
    'relay.json': JSON.stringify(validated.relayConfig, null, 2) + '\n', 'authorized-key': validated.authorizedKey, 'sshd.conf': validated.sshdConfig,
    'relay-server.mjs': readFileSync(new URL('./server.mjs', import.meta.url)),
    'run.sh': '#!/bin/sh\nset -eu\nexec node "$(dirname "$0")/relay-server.mjs" --config "$(dirname "$0")/relay.json"\n' })) {
    writeFileSync(join(output, name), value, { flag: 'wx', mode: name === 'run.sh' ? 0o700 : 0o600 });
  }
  mkdirSync(join(output, 'relay'), { mode: 0o700 });
  mkdirSync(join(output, 'secure-link'), { mode: 0o700 });
  for (const path of ['relay/install.mjs', 'relay/provision.mjs', 'relay/unix-provision.mjs', 'secure-link/config.mjs']) {
    writeFileSync(join(output, path), readFileSync(new URL('../' + path, import.meta.url)), { flag: 'wx', mode: 0o600 });
  }
  return { prepared: true, installed: false, serverChanged: false, modelMessagesSent: 0 };
}

async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write('已有服务器和访问地址的用户：node relay/wizard.mjs --request <电脑申请JSON> --output <新的配置包目录>\n可加 --answers <配置JSON> 跳过问答。生成配置包不会修改系统或启动服务。\n'); return;
  }
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--request', '--output', '--answers'].includes(args[i]) || !args[i + 1] || values[args[i]]) throw fail('RELAY_INPUT_INVALID');
    values[args[i]] = resolve(args[i + 1]);
  }
  if (!values['--request'] || !values['--output']) throw fail('RELAY_INPUT_INVALID');
  const enrollment = json(values['--request']);
  let answers;
  if (values['--answers']) answers = json(values['--answers']);
  else {
    if (!process.stdin.isTTY) throw fail('RELAY_INPUT_REQUIRED');
    const prompt = createInterface({ input: process.stdin, output: process.stderr });
    const ask = async (text, fallback = '') => (await prompt.question(text + (fallback ? ` [${fallback}]` : '') + '：')).trim() || fallback;
    try {
      const publicBaseUrl = await ask('手机访问中转的 HTTPS 地址（可使用公网 IPv4 或域名，中转端口必须可用）');
      const host = await ask('SSH 服务器地址', new URL(publicBaseUrl).hostname);
      const port = Number(await ask('中转专用 SSH 端口（需要空闲）', '2222'));
      const user = await ask('中转专用 SSH 账号');
      const hostKey = await ask('服务器 SSH Ed25519 公钥');
      answers = { hosting: 'self-hosted', publicBaseUrl, relay: { host, port, user, hostKey } };
    } finally { prompt.close(); }
  }
  const bundle = createUnixRelayBundle({ ...answers, enrollment });
  process.stdout.write(JSON.stringify(writeRelayBundle({ output: values['--output'], bundle })) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => { process.stderr.write('RELAY_PREPARATION_FAILED\n'); process.exitCode = 1; });
}
