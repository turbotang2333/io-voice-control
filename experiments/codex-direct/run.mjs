import { createServer, request } from 'node:https';
import { randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createSecureContext } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { CodexRpc } from './app-server.mjs';
import { createCodexGateway, openExperimentState } from './gateway.mjs';
import { createHandler } from './http.mjs';
import { createCodexNavigation } from './navigation.mjs';

const stateRoot = join(homedir(), '.local', 'state', 'rayneo-paseo', 'codex-direct');
const secretsRoot = join(homedir(), '.local-secrets', 'rayneo-paseo');
const profilePath = join(secretsRoot, 'codex-direct.json');
const command = process.argv[2];
let rpc, server, ownsLock = false;
let phase = 'configuration';
const lockPath = join(stateRoot, 'process.lock');

function readProfile() {
  const config = JSON.parse(readFileSync(profilePath, 'utf8'));
  if (config.version !== 1 || config.host !== '127.0.0.1' || config.port !== 17469
      || !/^[a-f0-9]{64}$/.test(config.apiToken) || !existsSync(config.executable)) throw new Error('INVALID_PROFILE');
  return config;
}
function lock() {
  // Deliberately no automatic stale-lock deletion: an uncertain task requires inspection.
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 });
  ownsLock = true;
}
async function connect() {
  phase = 'initialize';
  rpc = new CodexRpc(readProfile().executable);
  await rpc.initialize();
  return rpc;
}
function tlsSettings() {
  const local = JSON.parse(readFileSync(join(secretsRoot, 'local-test.json'), 'utf8'));
  const tls = { pfx: readFileSync(join(secretsRoot, 'server.p12')), passphrase: local.password };
  createSecureContext(tls);
  return tls;
}
function phoneRequest(text, requestId, { authenticated = true, health = false } = {}) {
  const config = readProfile();
  const ca = new X509Certificate(readFileSync(join(secretsRoot, 'local.cer'))).toString();
  return new Promise((resolve, reject) => {
    const req = request({ hostname: config.host, port: config.port, path: health ? '/healthz' : '/v1/chat/completions',
      method: health ? 'GET' : 'POST', ca, timeout: 195000,
      headers: { ...(authenticated ? { authorization: `Bearer ${config.apiToken}` } : {}),
        'idempotency-key': requestId, 'content-type': 'application/json' },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        try {
          const frames = Buffer.concat(chunks).toString('utf8').trim().split('\n').map(line => JSON.parse(line));
          resolve({ httpStatus: response.statusCode, frames, ...frames.at(-1) });
        } catch { reject(new Error('INVALID_PHONE_RESPONSE')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('PHONE_REQUEST_TIMEOUT')));
    req.end(health ? undefined : JSON.stringify({ stream: true, messages: [{ role: 'user', content: text }] }));
  });
}
async function cleanup() {
  if (server) {
    const force = setTimeout(() => server.closeAllConnections(), 1000).unref();
    await new Promise(resolve => server.close(resolve));
    clearTimeout(force);
  }
  await rpc?.close();
  if (ownsLock) { unlinkSync(lockPath); ownsLock = false; }
}

try {
  mkdirSync(join(stateRoot, 'sandbox'), { recursive: true });
  if (command === 'prepare') {
    if (!existsSync(profilePath)) {
      const executable = process.platform === 'win32'
        ? join(process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe')
        : process.env.CODEX_DIRECT_BIN;
      if (!executable || !existsSync(executable)) throw new Error('CODEX_BINARY_NOT_FOUND');
      mkdirSync(secretsRoot, { recursive: true });
      writeFileSync(profilePath, JSON.stringify({ version: 1, host: '127.0.0.1', port: 17469,
        executable, apiToken: randomBytes(32).toString('hex') }), { flag: 'wx', mode: 0o600 });
    }
    readProfile(); tlsSettings();
    console.log('实验配置已准备，独立 HTTPS 端口 17469；令牌未显示，服务未启动。');
  } else if (command === 'check') {
    readProfile(); tlsSettings();
    await connect();
    console.log('Codex stdio 与 ChatGPT 登录检查通过；未创建会话、未发送任务。');
  } else if (command === 'fixtures') {
    // These are real, dedicated Codex conversations, never copies of personal history.
    await connect();
    const fixtures = [
      { key: 'a', name: '眼镜切换测试 A', cwd: fileURLToPath(new URL('../../', import.meta.url)), marker: '青松' },
      { key: 'b', name: '眼镜切换测试 B', cwd: join(stateRoot, 'sandbox'), marker: '海豚' },
    ];
    const manifest = [];
    for (const item of fixtures) {
      const state = openExperimentState(join(stateRoot, `fixture-${item.key}-state.json`));
      const existing = state.data.requests.find(r => r.id === 'seed-v1');
      if (existing && existing.status !== 'idle') throw new Error('FIXTURE_OUTCOME_UNKNOWN');
      const gateway = await createCodexGateway(rpc, { state, cwd: item.cwd });
      await rpc.request('thread/name/set', { threadId: gateway.threadId, name: item.name });
      if (!existing) {
        const result = await gateway.submit({ requestId: 'seed-v1', text: `这是独立切换测试，请记住本会话测试代号是${item.marker}。只回复这个代号，不使用工具。` });
        if (result.status !== 'idle' || !result.text?.includes(item.marker)) throw new Error('FIXTURE_SEED_FAILED');
      }
      manifest.push({ key: item.key, name: item.name, cwd: item.cwd, threadId: gateway.threadId, seeded: true });
      console.log(`测试会话 ${item.key.toUpperCase()} 已准备；没有向日常会话发送消息。`);
    }
    writeFileSync(join(stateRoot, 'navigation-fixtures.json'), JSON.stringify({ preparedAt: new Date().toISOString(), fixtures: manifest }, null, 2));
  } else if (command === 'smoke') {
    lock();
    const state = openExperimentState(join(stateRoot, 'smoke-state.json'));
    const marker = 'RAYNEO' + randomBytes(4).toString('hex').toUpperCase();
    const started = Date.now();
    await connect();
    phase = 'open-first-thread';
    let gateway = await createCodexGateway(rpc, { state, cwd: join(stateRoot, 'sandbox') });
    const firstThread = gateway.threadId;
    const config = readProfile();
    server = createServer(tlsSettings(), createHandler({ token: config.apiToken,
      gateway: { submit: input => gateway.submit(input) }, isReady: () => !rpc.closed }));
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve); });
    const health = await phoneRequest('', 'health', { health: true });
    const unauthorized = await phoneRequest('', 'unauthorized', { health: true, authenticated: false });
    const firstId = randomUUID();
    const firstText = `请记住本次测试代号 ${marker}。只回复这个代号，不使用工具。`;
    const first = await phoneRequest(firstText, firstId);
    if (first.status !== 'idle' || !first.text?.includes(marker)) throw new Error('FIRST_TURN_FAILED');
    const firstMs = Date.now() - started;
    console.log('第一轮回复通过；正在重启独立 Codex 进程并恢复同一会话。');
    await rpc.close();
    await connect();
    phase = 'resume-thread';
    gateway = await createCodexGateway(rpc, { state: openExperimentState(join(stateRoot, 'smoke-state.json')), cwd: join(stateRoot, 'sandbox') });
    const replay = await phoneRequest(firstText, firstId);
    const second = await phoneRequest('刚才请你记住的本次测试代号是什么？只回复代号，不使用工具。', randomUUID());
    const deltaCount = [...first.frames, ...second.frames].filter(frame => frame.type === 'text').length;
    const receipt = { checkedAt: new Date().toISOString(), transport: 'stdio', provider: 'codex',
      verifiedTls: health.httpStatus === 200, unauthorizedRejected: unauthorized.httpStatus === 401,
      phoneWireContract: [first, second].every(value => value.httpStatus === 200 && value.type === 'done'),
      firstTurn: first.status === 'idle', contextAfterRestart: second.status === 'idle' && second.text?.includes(marker),
      sameThread: gateway.threadId === firstThread, durableDedup: replay.status === 'unknown',
      deltaCount, firstMs, totalMs: Date.now() - started };
    writeFileSync(join(stateRoot, 'smoke-receipt.json'), JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify(receipt));
    if (!receipt.contextAfterRestart || !receipt.sameThread || !receipt.durableDedup || !deltaCount
        || !receipt.verifiedTls || !receipt.unauthorizedRejected || !receipt.phoneWireContract) throw new Error('SMOKE_FAILED');
  } else if (command === 'serve') {
    lock();
    const config = readProfile();
    await connect();
    const state = openExperimentState(join(stateRoot, 'phone-state.json'));
    if (!state.data.threadId) await createCodexGateway(rpc, { state, cwd: join(stateRoot, 'sandbox') });
    const gateway = await createCodexNavigation(rpc, { state, cwd: join(stateRoot, 'sandbox') });
    server = createServer(tlsSettings(), createHandler({ token: config.apiToken, gateway, isReady: () => !rpc.closed }));
    server.requestTimeout = 210000;
    server.headersTimeout = 10000;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve); });
    console.log('Codex 实验 HTTPS 已启动，仅监听 127.0.0.1:17469；没有连接 Paseo。');
    // One experiment session, one owner. Exiting the glasses doesn't cancel submitted work.
    await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
  } else {
    console.log('用法：node experiments/codex-direct/run.mjs prepare|check|fixtures|smoke|serve');
    process.exitCode = 1;
  }
} catch (error) {
  if (error.rpcError) {
    const message = error.rpcError.message ?? '';
    console.error(JSON.stringify({ phase, rpcCode: error.rpcError.code,
      hints: ['rollout', 'not found', 'does not exist', 'database', 'locked', 'config', 'sandbox', 'invalid', 'permission', 'busy', 'thread'].filter(word => message.toLowerCase().includes(word)) }));
  }
  const allowed = ['FIRST_TURN_FAILED', 'SMOKE_FAILED', 'CHATGPT_LOGIN_REQUIRED', 'CODEX_RPC_FAILED', 'CODEX_RPC_TIMEOUT', 'CODEX_DISCONNECTED', 'CODEX_BUSY', 'WRONG_THREAD'];
  console.error(`实验未完成：${allowed.includes(error.code ?? error.message) ? error.code ?? error.message : '请检查独立实验配置、进程锁和本机 Codex 状态'}。未重试任务。`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
