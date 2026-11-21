import { createServer } from 'node:https';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DesktopClient } from './desktop-client.mjs';
import { createDesktopNavigation, readDesktopCatalog } from './desktop-navigation.mjs';
import { openExperimentState } from './gateway.mjs';
import { createHandler } from './http.mjs';
import { createNavigationSession, openNavigationSessionStore } from '../../bridge/navigation-session.mjs';

const root = join(homedir(), '.local', 'state', 'rayneo-paseo', 'codex-direct');
const secrets = join(homedir(), '.local-secrets', 'rayneo-paseo');
const read = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const lockPath = join(root, 'process.lock');
let client, server, ownsLock = false, unsubscribe, sessions;
try {
  client = new DesktopClient();
  await client.connect();
  const catalog = await readDesktopCatalog(client);
  if (process.argv[2] === 'check') {
    console.log(JSON.stringify({ ready: true, existingDesktopConnection: true, navigation: true,
      projectCount: catalog.projects.length, availableLocalThreads: catalog.threads.length, modelMessageSent: false }));
  } else if (process.argv[2] === 'serve') {
    const config = read(join(secrets, 'codex-direct.json'));
    if (config.host !== '127.0.0.1' || config.port !== 17469) throw new Error('INVALID_PROFILE');
    const tls = read(join(secrets, 'local-test.json'));
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, backend: 'desktop-tools' }), { flag: 'wx', mode: 0o600 });
    ownsLock = true;
    const statePath = join(root, 'desktop-navigation-state.json');
    const fresh = !existsSync(statePath);
    const state = openExperimentState(statePath);
    if (fresh) {
      const previousPath = join(root, 'desktop-phone-state.json');
      if (existsSync(previousPath)) {
        const previous = read(previousPath);
        if (previous.version !== 1 || !Array.isArray(previous.requests)) throw new Error('INVALID_PREVIOUS_STATE');
        state.data.requests = previous.requests;
        const thread = catalog.threads.find(t => t.id === previous.threadId);
        if (thread) state.data.selection = { projectId: thread.projectId, threadId: thread.id };
      }
      state.save();
    }
    const gateway = createDesktopNavigation(client, { state });
    sessions = createNavigationSession({ backend: 'codex', store: openNavigationSessionStore(join(root, 'navigation-owner.json')), invalidate: gateway.invalidateListing });
    unsubscribe = client.subscribeConnectionStatus(() => sessions.invalidateConnection());
    server = createServer({ pfx: readFileSync(join(secrets, 'server.p12')), passphrase: tls.password },
      createHandler({ token: config.apiToken, gateway, sessions, isReady: () => client.ready }));
    server.requestTimeout = 210000; server.headersTimeout = 10000;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve); });
    console.log('Codex 桌面两级选择实验已启动，支持项目与 Agent 编号切换，仅监听本机 17469。');
    await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
  } else throw new Error('USAGE');
} catch {
  console.error('桌面共用实验未完成，请核对测试对话、桌面连接和进程锁；未自动重发消息。');
  process.exitCode = 1;
} finally {
  unsubscribe?.(); sessions?.invalidateConnection();
  if (server) {
    const timer = setTimeout(() => server.closeAllConnections(), 1000).unref();
    await new Promise(resolve => server.close(resolve)); clearTimeout(timer);
  }
  await client?.close();
  if (ownsLock) unlinkSync(lockPath);
}
