import { readFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:https';
import { QueueClient } from './client.mjs';
import { openJournal } from './journal.mjs';
import { createQueueGateway } from './gateway.mjs';
import { createQueueNavigation } from './navigation.mjs';
import { createConnectorSearch } from './search.mjs';
import { openConnectorIdentity } from './identity.mjs';
import { openCreationStore } from './creation-store.mjs';
import { createConnectorCreation } from './creation.mjs';
import { readCatalog } from './catalog.mjs';
import { validateProfile, createConnectorHandler } from './service.mjs';
import { createNavigationSession, openNavigationSessionStore } from '../../bridge/navigation-session.mjs';
import { loadEnabledPairing } from '../../bridge/pairing.mjs';
import { independentProfile, parseRunOptions } from './run-options.mjs';

// check never sends messages. serve is explicitly selected and stays on loopback.
let client, journal, server, sessions, search, creation;
try {
  const { mode, configPath, independentTest } = parseRunOptions(process.argv.slice(2));
  let profile;
  if (configPath) {
    const bytes = readFileSync(resolve(configPath));
    if (bytes.length > 16384) throw Object.assign(new Error(), { code: 'INVALID_PROFILE' });
    profile = independentProfile(validateProfile(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''))), independentTest);
  }
  client = new QueueClient({ executable: profile?.executable, threadId: profile?.threadId, codexHome: profile?.codexHome,
    sharedConnection: profile?.sharedConnection,
    catalog: profile?.navigation === true });
  await client.connect();
  const report = { connected: client.ready, desktopAvailable: client.isDesktopAvailable(),
    sharedRuntime: Boolean(profile?.sharedConnection),
    developerIdentityRequired: false, desktopRelaunched: false, modelMessagesSent: 0 };
  if (mode === 'check') {
    if (profile?.navigation) {
      const catalog = await readCatalog(client);
      report.projectCount = catalog.projects.length; report.threadCount = catalog.threads.length;
      report.navigation = true;
    } else if (profile) {
      const snapshot = await client.snapshot();
      report.configuredThreadReadable = snapshot.id === profile.threadId;
      report.pendingQueueCount = (await client.queued()).length;
    }
    console.log(JSON.stringify(report));
    if (!report.desktopAvailable) process.exitCode = 1;
  } else {
    const catalog = profile.navigation ? await readCatalog(client) : null;
    if (!profile.navigation) { await client.snapshot(); await client.queued(); }
    const root = join(homedir(), '.local/state/rayneo-paseo/codex-connector',
      independentTest ? 'independent-live-test' : profile.navigation ? 'navigation-' + createHash('sha256').update(resolve(profile.codexHome ?? join(homedir(), '.codex')).toLowerCase()).digest('hex').slice(0, 16)
        : createHash('sha256').update(profile.threadId).digest('hex').slice(0, 16));
    mkdirSync(root, { recursive: true });
    journal = openJournal(join(root, 'journal.json'), profile.navigation ? 'codex-navigation' : profile.threadId);
    if (profile.navigation && profile.threadId && !journal.getSelection()) {
      const initial = catalog.threads.find(t => t.id === profile.threadId);
      if (initial) journal.saveSelection({ projectId: initial.projectId, threadId: initial.id });
    }
    if (profile.navigation) {
      creation = createConnectorCreation(client, { store: openCreationStore(join(root, 'creations.json')), enabled: profile.creation === true });
      search = createConnectorSearch(client, { projectAliases: profile.searchAliases ?? {} });
    }
    const gateway = profile.navigation ? createQueueNavigation(client, { journal, search, creation,
      serverId: openConnectorIdentity(join(root, 'host-id.json')) }) : createQueueGateway(client, { journal });
    sessions = createNavigationSession({ backend: 'codex', conversationSearch: profile.navigation === true,
      codexCreation: profile.creation === true, agentCreation: () => gateway.creationSupported?.() === true,
      shortcuts: () => gateway.shortcutsSupported?.() === true,
      invalidate: () => gateway.invalidateListing?.(),
      store: openNavigationSessionStore(join(root, 'navigation-owner.json')) });
    server = createServer({ pfx: readFileSync(profile.pfxPath), passphrase: profile.password },
      createConnectorHandler({ client, gateway, token: profile.token, sessions, navigation: profile.navigation,
        pairing: loadEnabledPairing(join(homedir(), '.local-secrets/rayneo-paseo'), 'codex') }));
    server.requestTimeout = 330000; server.headersTimeout = 10000;
    await new Promise((accept, reject) => { server.once('error', reject); server.listen(profile.port, profile.host, accept); });
    console.log(profile.navigation ? '独立连接原型已启动，仅监听本机，支持项目和原对话编号选择。'
      : '独立连接原型已启动，仅监听本机，固定使用配置中的 Codex 原对话。');
    await Promise.race([client.whenDisconnected, new Promise(accept => {
      process.once('SIGINT', accept); process.once('SIGTERM', accept);
      if (process.connected) {
        process.on('message', message => { if (message?.type === 'stop') accept(); });
        process.once('disconnect', accept);
      }
    })]);
    if (!client.ready) process.exitCode = 1;
  }
} catch (e) {
  const known = new Set(['USAGE', 'INVALID_PROFILE', 'CONNECTOR_LOCKED', 'JOURNAL_INVALID', 'JOURNAL_TARGET_MISMATCH',
    'CHATGPT_LOGIN_REQUIRED', 'CODEX_NOT_INSTALLED', 'CODEX_RPC_REJECTED', 'CODEX_RPC_TIMEOUT', 'CODEX_DISCONNECTED']);
  console.error(JSON.stringify({ ok: false, code: known.has(e.code) ? e.code : 'CONNECTOR_FAILED',
    message: e.code === 'USAGE' ? '用法：run.mjs check，或 run.mjs serve --config 私有配置文件。' : '连接原型未就绪，请核对电脑配置。没有自动重发消息。' }));
  process.exitCode = 1;
} finally {
  sessions?.invalidateConnection();
  if (server) {
    const timer = setTimeout(() => server.closeAllConnections(), 1000).unref();
    await new Promise(accept => server.close(accept)); clearTimeout(timer);
  }
  await search?.close(); await creation?.close(); await client?.close(); journal?.close();
  if (process.connected) process.disconnect();
}
