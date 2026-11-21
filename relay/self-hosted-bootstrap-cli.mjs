import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInstallPlan, createLinuxInstallDriver, installRelay } from './install.mjs';
import { createPairingInformation, encodePairingInformation } from './self-hosted-bootstrap.mjs';
import { startSelfHostedBootstrap } from './self-hosted-bootstrap-service.mjs';

async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('Linux 服务器需要 Node.js 22、OpenSSL 和管理员权限。开放 TCP 443 与 2222。用 --ip 填写公网 IPv4。'); return;
  }
  const automatic = args.length === 1 && args[0] === '--automatic';
  if (process.platform !== 'linux' || process.getuid?.() !== 0 || !automatic && (args.length !== 2 || args[0] !== '--ip'
    || isIP(args[1]) !== 4 || args[1].startsWith('127.') || args[1] === '0.0.0.0')) throw Error('BOOTSTRAP_INPUT_INVALID');
  let settings;
  if (automatic) {
    const input = readFileSync(0, 'utf8');
    if (input.length > 32768) throw Error('BOOTSTRAP_INPUT_INVALID');
    settings = JSON.parse(input);
    if (!settings || !/^[a-f0-9]{64}$/.test(settings.passphrase ?? '') || !/^[A-Za-z0-9_-]{43}$/.test(settings.secret ?? '')
      || !Number.isSafeInteger(settings.expiresAt) || settings.expiresAt <= Date.now() || settings.expiresAt > Date.now() + 900000
      || typeof settings.pfx !== 'string' || settings.pfx.length > 16384 || typeof settings.cert !== 'string' || settings.cert.length > 8192) throw Error('BOOTSTRAP_INPUT_INVALID');
    createPairingInformation({ host: settings.host, port: 2222, cert: Buffer.from(settings.cert, 'base64'), secret: settings.secret });
  }
  if (!existsSync('/run/sshd')) throw Object.assign(Error(), { code: 'SSHD_RUNTIME_MISSING' });
  const host = automatic ? settings.host : args[1], directory = mkdtempSync(join(tmpdir(), 'rayneo-bootstrap-'));
  let server;
  const cleanup = () => { try { rmSync(directory, { recursive: true }); } catch {} };
  try {
    const key = join(directory, 'key.pem'), certPath = join(directory, 'cert.pem'), pfxPath = join(directory, 'server.p12');
    const password = automatic ? settings.passphrase : randomBytes(32).toString('hex');
    const run = (args, env = process.env) => execFileSync('openssl', args, { env, stdio: 'pipe', timeout: 30000 });
    if (!automatic) { run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=RayneoBootstrap',
      '-addext', `subjectAltName=IP:${host}`, '-keyout', key, '-out', certPath]);
    run(['pkcs12', '-export', '-inkey', key, '-in', certPath, '-out', pfxPath, '-passout', 'env:RAYNEO_BOOTSTRAP_PASSWORD'],
      { ...process.env, RAYNEO_BOOTSTRAP_PASSWORD: password }); }
    const hostKey = readFileSync('/etc/ssh/ssh_host_ed25519_key.pub', 'utf8').trim().split(/\s+/).slice(0, 2).join(' ');
    const instance = await startSelfHostedBootstrap({ host, hostKey, cert: automatic ? Buffer.from(settings.cert, 'base64') : readFileSync(certPath), pfx: automatic ? Buffer.from(settings.pfx, 'base64') : readFileSync(pfxPath), passphrase: password,
      ...(automatic ? { secret: settings.secret, ttlMs: Math.min(300000, settings.expiresAt - Date.now()) } : {}),
      stopListeningBeforeInstall: true, install: async bundle => {
        try {
          const plan = createInstallPlan(bundle, process.execPath);
          const driver = createLinuxInstallDriver({ serverSource: fileURLToPath(new URL('./server.mjs', import.meta.url)) });
          for (const stage of ['preflight', 'createFiles', 'createAccount', 'verifySsh', 'startService', 'reloadSsh', 'rollback']) {
            const action = driver[stage].bind(driver);
            driver[stage] = async (...values) => {
              try { return await action(...values); }
              catch (error) { process.stderr.write('安装阶段 ' + stage + '：' + (error?.code || 'FAILED') + '\n'); throw error; }
            };
          }
          await installRelay(plan, driver);
          process.stdout.write('服务器安装完成。请回到电脑检查连接状态。\n');
        } catch (error) {
          process.stderr.write('安装未完成：' + (error?.code || 'RELAY_INSTALL_FAILED') + '\n');
          process.exitCode = 1; throw error;
        }
      } });
    server = instance.server;
    server.once('bootstrapExpired', () => { process.stderr.write('配对信息已过期，请重新运行安装命令。\n'); process.exitCode = 1; });
    server.once('close', cleanup);
    if (automatic) console.log('正在等待电脑自动连接，请保持此窗口打开。');
    else { console.log('请将下面的配对信息完整复制到电脑连接器，有效期 5 分钟，请勿分享：');
      console.log(encodePairingInformation(instance.info)); console.log('请保持此窗口打开，直到电脑连接完成。'); }
  } catch (error) { server?.close(); cleanup(); throw error; }
}
main(process.argv.slice(2)).catch(error => {
  const message = error?.code === 'SSHD_RUNTIME_MISSING' ? '系统 SSH 服务尚未就绪，请检查服务器的 SSH 服务后重试。'
    : error?.code === 'EADDRINUSE' ? '2222 端口已被占用，请检查服务器后重试。'
    : '安装未完成，请检查公网 IP、系统权限和服务器环境。';
  process.stderr.write(message + '\n'); process.exitCode = 1;
});
