import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createPaseoConnection } from './paseo-connection.mjs';
import { createNavigationSession, openNavigationSessionStore } from './navigation-session.mjs';
import { createVoiceGateway } from './voice-selection.mjs';
import { createConversationSearch } from './conversation-search.mjs';
import { createAgentCreation } from './agent-creation.mjs';
import { openCreationStore } from './creation-store.mjs';
import { createRequestHandler } from './http.mjs';
import { createStateStore } from './state-store.mjs';
import { resolveRuntimeConfig } from './runtime-config.mjs';
import { createSecureContext } from 'node:tls';
import { loadEnabledPairing } from './pairing.mjs';

let client, search;
try {
  const daily = process.argv.includes('--daily');
  const root = join(homedir(), '.local-secrets', 'rayneo-paseo');
  const local = JSON.parse(readFileSync(join(root, 'local-test.json'), 'utf8'));
  const profile = daily ? JSON.parse(readFileSync(join(root, 'daily.json'), 'utf8')) : local;
  const config = resolveRuntimeConfig(profile, { daily });
  const tls = { pfx: readFileSync(join(root, 'server.p12')), passphrase: local.password };
  createSecureContext(tls);
  const stateStore = daily ? createStateStore(join(homedir(), '.local', 'state', 'rayneo-paseo', 'daily-state.json')) : undefined;
  if (process.argv.includes('--check')) {
    console.log('私有配置、TLS 和选择状态检查通过；未连接 Paseo、未监听、未发送消息。');
  } else {
    // The SDK reconnects transport only. No application-level request replay is enabled.
    const quiet = { debug() {}, info() {}, warn() {}, error() {} };
    client = createPaseoConnection({ ...config.client, logger: quiet });
    search = createConversationSearch(client, { refreshMs: 30000, projectAliases: profile.searchAliases ?? {} });
    const creation = createAgentCreation(client, { store: openCreationStore(join(homedir(), '.local', 'state', 'rayneo-paseo', daily ? 'daily-creations.json' : 'usb-creations.json')) });
    const gateway = createVoiceGateway(client, { ...config, stateStore, search, creation });
    const sessions = createNavigationSession({ backend: 'paseo', conversationSearch: true,
      agentCreation: gateway.creationSupported,
      shortcuts: gateway.shortcutsSupported,
      store: openNavigationSessionStore(join(homedir(), '.local', 'state', 'rayneo-paseo', daily ? 'daily-navigation-owner.json' : 'usb-navigation-owner.json')),
      invalidate: gateway.invalidateListing });
    const unsubscribe = client.subscribeConnectionStatus(() => sessions.invalidateConnection());
    const server = createServer(tls, createRequestHandler({ token: config.token, gateway, sessions, pairing: daily ? loadEnabledPairing(root, 'paseo') : undefined,
      isReady: () => client.getConnectionState().status === 'connected' }));
    server.requestTimeout = 330000;
    server.headersTimeout = 10000;
    server.on('error', async () => { console.error('本机接入服务启动失败，请检查端口是否已占用。'); process.exitCode = 1; await Promise.allSettled([search.close(), client.close()]); });
    server.listen(config.port, config.host, () => {
      client.ensureConnected();
      console.log('本机 HTTPS 接入服务已启动；等待 Paseo 连接，不自动发送或重发消息。');
    });
    const stop = () => {
      unsubscribe(); sessions.invalidateConnection();
      const force = setTimeout(() => { server.closeAllConnections(); }, 1000).unref();
      server.close(async () => { clearTimeout(force); await Promise.allSettled([search.close(), client.close()]); });
    };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  }
} catch {
  console.error('接入服务未启动：请检查私有配置、签名证书和状态文件。USB 模式还需指定已授权的 Agent 与项目。');
  process.exitCode = 1;
  if (search) await search.close();
  if (client) await client.close();
}
