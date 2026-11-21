import { parseArgs } from 'node:util';
import { basename } from 'node:path';
import { createPaseoClient } from '@getpaseo/client';
import { readConversation, readDirectory } from './reader.mjs';

let client;
try {
  let values;
  try {
    ({ values } = parseArgs({ options: {
      help: { type: 'boolean', short: 'h' }, query: { type: 'string' },
      agent: { type: 'string' }, limit: { type: 'string', default: '20' },
      'show-text': { type: 'boolean', default: false },
    } }));
    if (values.help) {
      console.log('只读 Paseo 检查：npm run probe -- [--query 项目名称] [--agent ID] [--limit 1..100] [--show-text]\n连接地址从 PASEO_URL 读取，默认使用本机标准端口；密码可用 PASEO_PASSWORD。默认不输出对话正文。');
      process.exit(0);
    }
    if (!Number.isInteger(Number(values.limit)) || Number(values.limit) < 1 || Number(values.limit) > 100 ||
        (values.agent !== undefined && !values.agent.trim()) ||
        (values.query !== undefined && !values.query.trim()) ||
        (values['show-text'] && !values.agent)) throw new Error('invalid arguments');
  } catch {
    throw Object.assign(new Error('参数不正确，请运行 npm run probe -- --help。'), { code: 'INVALID_ARGUMENTS' });
  }
  const url = process.env.PASEO_URL ?? 'ws://localhost:6767/ws';
  client = createPaseoClient({
    url, ...(process.env.PASEO_PASSWORD ? { password: process.env.PASEO_PASSWORD } : {}),
    connectTimeoutMs: 8000, reconnect: { enabled: false },
  });
  await client.connect();
  const directory = await readDirectory(client, { query: values.query ?? basename(process.cwd()) });
  const conversation = values.agent ? await readConversation(client, {
    agentId: values.agent, limit: Number(values.limit), includeText: values['show-text'],
  }) : undefined;
  console.log(JSON.stringify({ readOnly: true, directory, ...(conversation ? { conversation } : {}) }, null, 2));
} catch (error) {
  const safeCodes = new Set(['INVALID_ARGUMENTS', 'INVALID_INPUT', 'INVALID_PAGE', 'MISSING_SCOPE', 'AGENT_NOT_FOUND', 'IDENTITY_MISMATCH', 'HISTORY_FAILED']);
  const known = safeCodes.has(error.code);
  console.error(JSON.stringify({ error: {
    code: known ? error.code : 'PASEO_READ_FAILED',
    message: known ? error.message : '无法读取 Paseo，请检查连接地址、服务状态和认证。',
  } }));
  process.exitCode = 1;
} finally {
  if (client) await client.close();
}
