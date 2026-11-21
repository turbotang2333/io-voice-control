import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const invalid = () => Object.assign(new Error('CONNECTOR_IDENTITY_INVALID'), { code: 'CONNECTOR_IDENTITY_INVALID' });
export function openConnectorIdentity(path) {
  function read() {
    try {
      const bytes = readFileSync(path);
      if (bytes.length > 256) throw invalid();
      const value = JSON.parse(bytes.toString('utf8'));
      if (value?.version !== 1 || !/^codex_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.id)
        || Object.keys(value).some(k => !['version', 'id'].includes(k))) throw invalid();
      return value.id;
    } catch (error) { if (error.code === 'ENOENT') throw error; throw invalid(); }
  }
  try { return read(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const id = 'codex_' + randomUUID();
  try { writeFileSync(path, JSON.stringify({ version: 1, id }), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code === 'EEXIST') return read(); throw invalid(); }
  return id;
}
