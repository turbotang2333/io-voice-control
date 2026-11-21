import { isAbsolute, win32 } from 'node:path';
import { validId } from './journal.mjs';
import { parseCodexCommand } from '../codex-direct/navigation.mjs';
import { createHandler } from '../codex-direct/http.mjs';
import { validateSharedConnection } from './shared-connection.mjs';
import { normalizeProjectAliases } from '../../bridge/conversation-search.mjs';

const fail = code => Object.assign(new Error(code), { code });

export function validateProfile(value) {
  if (!value || value.host !== '127.0.0.1' || !Number.isSafeInteger(value.port) || value.port < 1024 || value.port > 65535
    || [7468, 17469, 18468, 18469].includes(value.port) || !/^[a-f0-9]{64}$/.test(value.token)
    || (value.navigation !== undefined && typeof value.navigation !== 'boolean')
    || (value.creation !== undefined && typeof value.creation !== 'boolean') || (value.creation === true && value.navigation !== true)
    || (value.navigation !== true && !validId(value.threadId)) || (value.threadId !== undefined && !validId(value.threadId))
    || typeof value.pfxPath !== 'string' || !isAbsolute(value.pfxPath)
    || typeof value.password !== 'string' || (value.executable !== undefined && !isAbsolute(value.executable))
    || (value.codexHome !== undefined && !isAbsolute(value.codexHome))
    || Object.keys(value).some(k => !['host', 'port', 'token', 'threadId', 'pfxPath', 'password', 'executable', 'codexHome', 'navigation', 'creation', 'sharedConnection', 'searchAliases'].includes(k))) {
    throw fail('INVALID_PROFILE');
  }
  try {
    if (value.searchAliases !== undefined) normalizeProjectAliases(value.searchAliases);
    return { ...value, ...(value.sharedConnection === undefined ? {} : { sharedConnection: validateSharedConnection(value.sharedConnection) }) };
  }
  catch { throw fail('INVALID_PROFILE'); }
}

export function createConnectorHandler({ client, gateway, token, sessions, pairing, navigation = false }) {
  if (navigation) return createHandler({ token, sessions, gateway, pairing, isReady: () => client.isDesktopAvailable() });
  const localCommands = {
    async submit(input) {
      if (!validId(input.requestId) || typeof input.text !== 'string' || !input.text.trim() || [...input.text].length > 4096) throw fail('INVALID_INPUT');
      const command = parseCodexCommand(input.text);
      if (!command) {
        try { return await gateway.submit(input); }
        catch (e) { if (e.code === 'DESKTOP_UNAVAILABLE') throw fail('CODEX_DISCONNECTED'); throw e; }
      }
      input.assertCurrent?.();
      const snapshot = await client.snapshot();
      input.assertCurrent?.();
      const label = s => String(s ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, 60);
      let text;
      if (command.type === 'project') text = `当前项目：${label(win32.basename(snapshot.cwd ?? '未分组对话'))}。`;
      else if (command.type === 'thread') text = `当前 Agent：${label(snapshot.name ?? '已配置的 Codex 对话')}。`;
      else text = '独立连接原型目前固定使用电脑配置的原对话，可以查询当前项目和当前 Agent。编号切换尚未接入。';
      return { requestId: input.requestId, status: 'control', text };
    },
  };
  return createHandler({ token, sessions, gateway: localCommands, pairing, isReady: () => client.isDesktopAvailable() });
}
