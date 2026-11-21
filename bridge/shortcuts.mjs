import { readVoiceWorkspaces } from './reader.mjs';

const fail = (code, message) => Object.assign(new Error(message), { code });
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
// Older Paseo hosts may use a directory string as the workspace identity. Never normalize or execute it as a path.
const validWorkspaceId = value => typeof value === 'string' && value.length <= 4096 && value.trim().length > 0 && !/[\p{Cc}]/u.test(value);
const unavailable = () => fail('SHORTCUT_TARGET_UNAVAILABLE', '快捷目标已不可用，本次未切换。请在手机重新绑定。');
const label = value => String(value ?? '未命名').replace(/[\r\n\p{Cc}]/gu, ' ').slice(0, 60);

/** Resolves identities and metadata only. This module cannot prompt or create an Agent. */
export function createShortcutTargets(client) {
  const host = () => client.getServerId?.();
  const supported = () => validId(host());
  const checkHost = (expected, assertCurrent) => {
    assertCurrent?.();
    if (!supported()) throw fail('SHORTCUT_UNSUPPORTED', '当前电脑入口不支持快捷方式，本次未切换。');
    if (host() !== expected) throw fail('SHORTCUT_HOST_CHANGED', '快捷方式属于另一台 Paseo 主机，本次未切换。请重新绑定。');
  };
  async function verify(target, assertCurrent) {
    if (!target || !['agent', 'workspace'].includes(target.kind) || !validId(target.serverId) || !validWorkspaceId(target.workspaceId)
      || (target.kind === 'agent' ? !validId(target.agentId) : target.agentId !== undefined)) {
      throw fail('INVALID_INPUT', '快捷目标格式不正确，本次未切换。');
    }
    checkHost(target.serverId, assertCurrent);
    const workspace = (await readVoiceWorkspaces(client)).find(w => w.id === target.workspaceId);
    checkHost(target.serverId, assertCurrent);
    if (!workspace) throw unavailable();
    const result = { kind: target.kind, serverId: target.serverId, workspaceId: workspace.id, workspaceName: label(workspace.name) };
    if (target.kind === 'agent') {
      const refreshed = await client.agents.ref(target.agentId).refresh();
      checkHost(target.serverId, assertCurrent);
      const agent = refreshed?.agent;
      if (!agent || agent.id !== target.agentId || agent.workspaceId !== workspace.id || agent.archivedAt) throw unavailable();
      result.agentId = agent.id; result.agentName = label(agent.title);
    }
    return result;
  }
  return {
    supported, verify,
    async resolve(input, assertCurrent) {
      assertCurrent?.();
      if (input?.target) return verify(input.target, assertCurrent);
      if (!input || !['agent', 'workspace'].includes(input.kind) || !validId(input.agentId)) {
        throw fail('INVALID_INPUT', '请选择绑定类型并填写有效的 Agent ID。');
      }
      const serverId = host(); checkHost(serverId, assertCurrent);
      const refreshed = await client.agents.ref(input.agentId).refresh();
      checkHost(serverId, assertCurrent);
      const agent = refreshed?.agent;
      if (!agent || agent.id !== input.agentId || !validWorkspaceId(agent.workspaceId) || agent.archivedAt) throw unavailable();
      return verify({ kind: input.kind, serverId, workspaceId: agent.workspaceId,
        ...(input.kind === 'agent' ? { agentId: agent.id } : {}) }, assertCurrent);
    },
  };
}
