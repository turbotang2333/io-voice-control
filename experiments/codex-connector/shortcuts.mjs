import { validId } from './journal.mjs';
import { readCatalog, projectForThread, label } from './catalog.mjs';

const messages = {
  INVALID_INPUT: '快捷目标格式无效，本次未切换。',
  SHORTCUT_UNSUPPORTED: '当前电脑入口未开启快捷方式，本次未切换。',
  SHORTCUT_HOST_CHANGED: '快捷方式属于另一个 Codex 连接器，请重新绑定。',
  SHORTCUT_TARGET_UNAVAILABLE: '快捷目标已不可用或归属变化，请重新绑定。',
};
const fail = code => Object.assign(new Error(messages[code]), { code });
export const shortcutThreadAvailable = (snapshot, threadId, catalog, projectId) => snapshot?.id === threadId
  && !snapshot.ephemeral && snapshot.canAcceptDirectInput !== false
  && !(typeof snapshot.source === 'object' && snapshot.source && 'subAgent' in snapshot.source)
  && projectForThread(snapshot, catalog) === projectId;

/** Resolves metadata only. No conversation creation, history bodies or task submission. */
export function createConnectorShortcuts(client, { serverId } = {}) {
  const supported = () => validId(serverId);
  const check = assertCurrent => { assertCurrent?.(); if (!supported()) throw fail('SHORTCUT_UNSUPPORTED'); };
  async function verify(target, assertCurrent) {
    check(assertCurrent);
    if (!target || !['agent', 'workspace'].includes(target.kind) || !validId(target.serverId)
      || !validId(target.workspaceId) || (target.kind === 'agent' ? !validId(target.agentId) : target.agentId !== undefined)) {
      throw fail('INVALID_INPUT');
    }
    if (target.serverId !== serverId) throw fail('SHORTCUT_HOST_CHANGED');
    const catalog = await readCatalog(client); check(assertCurrent);
    const project = catalog.projects.find(p => p.id === target.workspaceId);
    if (!project) throw fail('SHORTCUT_TARGET_UNAVAILABLE');
    const result = { kind: target.kind, serverId, workspaceId: project.id, workspaceName: label(project.name) };
    if (target.kind === 'agent') {
      const thread = catalog.threads.find(t => t.id === target.agentId && t.projectId === project.id);
      if (!thread) throw fail('SHORTCUT_TARGET_UNAVAILABLE');
      const snapshot = await client.bindThread(thread.id).snapshot(); check(assertCurrent);
      if (!shortcutThreadAvailable(snapshot, thread.id, catalog, project.id)) throw fail('SHORTCUT_TARGET_UNAVAILABLE');
      result.agentId = thread.id; result.agentName = label(snapshot.name || thread.name);
    }
    return result;
  }
  return {
    supported, verify,
    async resolve(input, assertCurrent) {
      check(assertCurrent);
      if (input?.target) return verify(input.target, assertCurrent);
      if (!input || !['agent', 'workspace'].includes(input.kind) || !validId(input.agentId)) throw fail('INVALID_INPUT');
      const catalog = await readCatalog(client); check(assertCurrent);
      const thread = catalog.threads.find(t => t.id === input.agentId);
      if (!thread) throw fail('SHORTCUT_TARGET_UNAVAILABLE');
      // Verify the anchor even for a project binding; never infer its project from an unverified ID.
      const anchor = await verify({ kind: 'agent', serverId, workspaceId: thread.projectId, agentId: thread.id }, assertCurrent);
      if (input.kind === 'agent') return anchor;
      const { agentId, agentName, ...project } = anchor;
      return { ...project, kind: 'workspace' };
    },
  };
}
