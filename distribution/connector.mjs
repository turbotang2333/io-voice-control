import { createServer } from 'node:http';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import QRCode from 'qrcode';
import { createDashboardHandler } from './dashboard.mjs';
import { createConnectorActions } from './actions.mjs';
import { createSecureDashboardActions } from './secure-actions.mjs';
import { createSecureLinkActions } from '../secure-link/actions.mjs';
import { createHostedProvider } from './hosted-provider.mjs';
import { createPairingStore } from '../bridge/pairing.mjs';
import { autoStartConfiguredConnection } from './auto-start.mjs';
import { prepareExistingSecureHome } from './existing-secure-home.mjs';
import { createRoutedSecureActions } from './secure-action-routing.mjs';
import { createLocalConnectionStarter } from '../secure-link/local-backends.mjs';
import { createSearchPackageManager } from './search-package.mjs';
import { createSelfHostedActions } from './self-hosted.mjs';

const { values } = parseArgs({ options: { preview: { type: 'boolean' }, 'preview-state': { type: 'string', default: 'new' }, 'no-open': { type: 'boolean' }, 'auto-connect': { type: 'boolean' }, port: { type: 'string', default: '17470' } } });
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('INVALID_LOCAL_PORT');
if (!['new', 'prepared', 'configured', 'partial', 'disconnected', 'repair', 'none'].includes(values['preview-state'])
  || !values.preview && values['preview-state'] !== 'new') throw Error('INVALID_PREVIEW_STATE');
let actions;
if (values.preview) {
  const parent = join(homedir(), '.local/state/rayneo-paseo/distribution-20261109/ui-preview'); mkdirSync(parent, { recursive: true });
  const store = createPairingStore({ directory: mkdtempSync(join(parent, 'preview-')) });
  let phase = ['new', 'prepared', 'none'].includes(values['preview-state']) ? (values['preview-state'] === 'none' ? 'new' : values['preview-state']) : 'configured';
  let previewSelfHosted = false;
  const profiles = { paseo: { endpoint: 'https://example.test/trial/paseo', port: 7468, token: 'a'.repeat(64) }, codex: { endpoint: 'https://example.test/trial/codex', port: 19469, token: 'b'.repeat(64) } };
  actions = {
    status() {
      const connections = phase === 'configured' ? ['paseo', 'codex'].map(backend => {
        const ready = !['disconnected', 'repair'].includes(values['preview-state']) && !(values['preview-state'] === 'partial' && backend === 'codex');
        return { backend, ready, local: ready ? 'ready' : 'reconnecting', wireless: ready ? 'ready' : values['preview-state'] === 'repair' ? 'rejected' : 'network_unavailable' };
      }) : [];
      return { preview: true, phase, ...(previewSelfHosted ? { connectionMode: 'secure', hosting: 'self-hosted', encryption: 'verified', ipChangeAvailable: true } : {}), available: values['preview-state'] === 'none' ? [] : ['paseo', 'codex'], hostedEnrollmentAvailable: true, enrollmentAvailable: phase !== 'new',
        pairingEnabled: phase === 'configured', pairingReady: connections.some(c => c.ready), pairingState: store.status().kind, connections };
    },
    prepare() { phase = 'prepared'; return { prepared: true, modelMessagesSent: 0 }; },
    enrollment() { return { version: 1, preview: true, installationId: 'synthetic-preview' }; },
    invitation() { phase = 'configured'; return { configured: true, serverChanged: false }; },
    connect() { phase = 'configured'; return { preview: true, starting: true, modelMessagesSent: 0 }; },
    selfHostedCommand() { return { command: '示例：服务器安装命令' }; },
    selfHostedProgress() { return { state: 'waiting' }; },
    pairSelfHosted() { phase = 'configured'; previewSelfHosted = true; return { preview: true, starting: true }; },
    prepareSelfHosted() { return { bundleId: 'preview', directory: '示例：电脑上的服务器配置包文件夹', serverChanged: false }; },
    finishSelfHosted() { phase = 'configured'; previewSelfHosted = true; return { preview: true, starting: true }; },
    changeSelfHostedIp() { return { preview: true, pairingRequired: true }; },
    async pair() { const ticket = store.issue({ computerLabel: '测试电脑', profiles, publicBaseUrl: profiles.paseo.endpoint }); return { image: await QRCode.toDataURL(ticket.url, { width: 420, margin: 4 }), expiresAt: ticket.expiresAt }; },
  };
} else {
  const codeRoot = fileURLToPath(new URL('../', import.meta.url));
  const privateDirectory = join(homedir(), '.local-secrets/rayneo-paseo');
  const startLocalConnections = createLocalConnectionStarter({ codeRoot, privateDirectory }).start;
  const secure = createRoutedSecureActions({ privateDirectory,
    create: secureHome => createSecureLinkActions({ codeRoot, privateDirectory: secureHome, startLocalConnections }) });
  const legacy = createConnectorActions({ codeRoot });
  const prepareExisting = () => prepareExistingSecureHome({ privateDirectory });
  actions = createSecureDashboardActions({ legacy, secure, hostedRequest: createHostedProvider(),
    prepareExisting: async () => (await prepareExisting()).enrollment });
  Object.assign(actions, createSelfHostedActions({ legacy, secure, prepareExisting, stateDirectory: join(homedir(), '.local/state/rayneo-paseo') }));
}
let searchConfig = null;
try { searchConfig = JSON.parse(await readFile(new URL('./search-package-config.json', import.meta.url), 'utf8')); } catch {}
const searchPackage = createSearchPackageManager({ config: searchConfig });
actions.searchPackageStatus = () => searchPackage.status();
actions.searchPackageInstall = async () => {
  const status = await searchPackage.status();
  if (status.ready) return { started: false };
  if (['checking', 'downloading', 'installing', 'verifying'].includes(status.state)) {
    throw Object.assign(Error('SEARCH_BUSY'), { code: 'SEARCH_BUSY' });
  }
  if (!status.configured && !status.installed) throw Object.assign(Error('SEARCH_UNAVAILABLE'), { code: 'SEARCH_UNAVAILABLE' });
  void searchPackage.install().catch(() => {});
  return { started: true };
};
actions.searchPackageRemove = async () => { await searchPackage.remove(); return { removed: true }; };
const origin = `http://127.0.0.1:${port}`;
const server = createServer(createDashboardHandler({ actions, getOrigin: () => origin }));
server.requestTimeout = 30000; server.headersTimeout = 10000;
server.on('error', () => { console.error('连接器页面未能启动，请检查是否已打开另一个连接器窗口。'); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({ connectorPage: origin, preview: values.preview === true, modelMessagesSent: 0 }));
  if (values['auto-connect'] && !values.preview) void autoStartConfiguredConnection(actions);
  if (!values['no-open']) {
    const shell = join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const child = spawn(shell, ['-NoProfile', '-NonInteractive', '-Command', `Start-Process '${origin}'`], { windowsHide: true, stdio: 'ignore' }); child.on('error', () => {}); child.unref();
  }
});
process.once('SIGINT', () => server.close()); process.once('SIGTERM', () => server.close());
