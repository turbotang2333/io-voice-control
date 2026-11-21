import { createHash, randomUUID } from 'node:crypto';
import { readVoiceWorkspaces, readVoiceAgents } from './reader.mjs';

export const creationMessages = Object.freeze({
  CREATION_UNSUPPORTED: '当前电脑入口不支持语音新建，本次未创建。请更新电脑接入服务。',
  CREATION_PROFILE: '找不到唯一可用的日常工作配置，本次未创建。请在 Paseo 检查配置。',
  CREATION_NAME: '请在新建对话后补充名称，最多 40 个字符。',
  CREATION_SCOPE: '请先选择可用项目，再说新建对话和名称。',
  CREATION_DUPLICATE: '当前项目已有同名对话，本次未创建。请换个名称，或列出 Agent 选择已有对话。',
  CREATION_REPLAY: '此创建请求已处理，没有重复创建。请列出 Agent 核对后选择。',
  CREATION_UNCERTAIN: '创建结果暂时未确认，请在 Paseo 核对，不要重复新建。',
  CREATION_STORE_WRITE_FAILED: '创建记录未能保存，本次未继续创建或切换。请在 Paseo 核对。',
  CREATION_SELECTION: '新对话已创建，但未能切换。请列出 Agent 核对后选择，不要重复新建。',
});
const fail = code => Object.assign(new Error(creationMessages[code] ?? creationMessages.CREATION_UNCERTAIN), { code });
const nameKey = value => String(value).normalize('NFKC').replace(/\s+/gu, '').toLowerCase();
const label = value => String(value).replace(/[\r\n]+/g, ' ').slice(0, 60);

function profileConfig(config, name) {
  let matches = config?.agentProfiles?.filter(p => p.name === name);
  // A fresh installation may have one user-named profile rather than the developer's preferred name.
  if (matches?.length === 0 && config.agentProfiles.length === 1) matches = config.agentProfiles;
  if (matches?.length !== 1) throw fail('CREATION_PROFILE');
  const profile = matches[0];
  if (typeof profile.provider !== 'string' || !/^[a-z0-9_-]+$/i.test(profile.provider)
    || (profile.model !== undefined && (typeof profile.model !== 'string' || !profile.model.trim()))) throw fail('CREATION_PROFILE');
  const result = { provider: profile.provider + (profile.model ? '/' + profile.model : '') };
  for (const key of ['modeId', 'thinkingOptionId']) {
    if (profile[key] !== undefined) {
      if (typeof profile[key] !== 'string' || !profile[key]) throw fail('CREATION_PROFILE');
      result[key] = profile[key];
    }
  }
  if (profile.featureValues !== undefined) {
    if (!profile.featureValues || typeof profile.featureValues !== 'object' || Array.isArray(profile.featureValues)) throw fail('CREATION_PROFILE');
    result.featureValues = JSON.parse(JSON.stringify(profile.featureValues));
  }
  return result;
}

/** Creates one empty root Agent in an already visible workspace. Selection is owned by the voice gateway. */
export function createAgentCreation(client, { store, profileName = '日常工作', timeoutMs = 45000 } = {}) {
  const supported = () => Boolean(store && client.supportsAgentCreation?.());
  return {
    supported,
    async create({ requestId, title, workspaceId, assertCurrent, onUpdate }) {
      assertCurrent?.();
      if (!supported()) throw fail('CREATION_UNSUPPORTED');
      if (typeof title !== 'string' || !title.trim() || [...title.trim()].length > 40 || /[\p{Cc}\p{Cf}]/u.test(title)) throw fail('CREATION_NAME');
      title = title.trim();
      if (store.get(requestId)) throw fail('CREATION_REPLAY');
      const nameHash = createHash('sha256').update(nameKey(title)).digest('hex');
      const visible = (await readVoiceWorkspaces(client)).find(w => w.id === workspaceId);
      if (!visible?.projectKey) throw fail('CREATION_SCOPE');
      const { config: daemonConfig } = await client.config.get();
      const config = profileConfig(daemonConfig, profileName);
      assertCurrent?.();
      for (const pending of store.pending(workspaceId, nameHash)) {
        const { agent } = await client.agents.ref(pending.agentId).refresh();
        assertCurrent?.();
        if (!agent || agent.id !== pending.agentId || agent.workspaceId !== workspaceId) throw fail('CREATION_UNCERTAIN');
        store.markCreated(pending.requestId);
      }
      if ((await readVoiceAgents(client, visible)).some(a => nameKey(a.name) === nameKey(title))) throw fail('CREATION_DUPLICATE');
      const workspace = client.workspaces.ref(workspaceId), snapshot = await workspace.refresh();
      const latest = (await readVoiceWorkspaces(client)).find(w => w.id === workspaceId);
      assertCurrent?.();
      if (!snapshot || snapshot.id !== workspaceId || snapshot.archivedAt || !snapshot.workspaceDirectory
        || latest?.projectKey !== visible.projectKey || snapshot.project?.projectKey !== visible.projectKey) throw fail('CREATION_SCOPE');
      const agentId = randomUUID();
      try { store.reserve(requestId, { workspaceId, agentId, nameHash }); }
      catch (error) { throw fail(['CREATION_REPLAY', 'CREATION_UNCERTAIN'].includes(error?.code) ? error.code : 'CREATION_STORE_WRITE_FAILED'); }
      assertCurrent?.();
      try { onUpdate?.({ type: 'state', state: 'creating' }); } catch {}
      // The SDK may reconnect this exact keyed operation. Both the key and target ID stay fixed.
      const operation = Promise.resolve().then(() => {
        assertCurrent?.();
        return workspace.agents.create({ config, title, agentId, idempotencyKey: `rayneo-create-${agentId}` });
      }).then(handle => {
        const agent = handle.current?.();
        if (!agent || handle.id !== agentId || agent.id !== agentId || agent.workspaceId !== workspaceId || agent.archivedAt) throw fail('CREATION_UNCERTAIN');
        store.markCreated(requestId);
        return { agentId, workspaceId, name: label(title), workspaceName: label(visible.name) };
      });
      let timer;
      try {
        const target = await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(fail('CREATION_UNCERTAIN')), timeoutMs); })]);
        assertCurrent?.();
        return target;
      } catch (error) {
        if (/^NAVIGATION_/.test(error?.code ?? '')) throw error;
        throw fail('CREATION_UNCERTAIN');
      } finally { clearTimeout(timer); }
    },
  };
}
