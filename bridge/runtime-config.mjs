const invalid = () => Object.assign(new Error('接入配置无效，请检查私有配置；不会公开监听或选择其他 Agent。'), { code: 'CONFIG_INVALID' });

export function resolveRuntimeConfig(profile, { daily = false, env = process.env } = {}) {
  // Paseo injects the developer's own ID into its child environment. It is not a voice target.
  return validateRuntimeConfig(daily ? profile : { ...profile,
    paseoUrl: env.PASEO_URL ?? profile.paseoUrl,
    paseoPassword: env.PASEO_PASSWORD ?? profile.paseoPassword,
    agentId: env.PASEO_AGENT_ID ?? profile.agentId,
    workspaceId: env.PASEO_WORKSPACE_ID ?? profile.workspaceId,
  }, { daily });
}

export function validateRuntimeConfig(raw, { daily = false } = {}) {
  if (!raw || !Number.isInteger(raw.port) || raw.port < 1024 || raw.port > 65535
    || typeof raw.apiToken !== 'string' || !/^[a-fA-F0-9]{64}$/.test(raw.apiToken)
    || (raw.host !== undefined && raw.host !== '127.0.0.1')) throw invalid();
  let url;
  try { url = new URL(raw.paseoUrl ?? 'ws://127.0.0.1:6767/ws'); } catch { throw invalid(); }
  if (!['ws:', 'wss:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/ws') throw invalid();
  const agentId = raw.agentId, workspaceId = raw.workspaceId;
  if (Boolean(agentId) !== Boolean(workspaceId) || (!daily && (!agentId || !workspaceId))
    || [agentId, workspaceId].some(value => value !== undefined && (typeof value !== 'string' || !value.trim()))) throw invalid();
  return {
    host: '127.0.0.1', port: raw.port, token: raw.apiToken, agentId, workspaceId, allowUnselected: daily,
    client: { url: url.href, password: raw.paseoPassword, connectTimeoutMs: 8000,
      reconnect: { enabled: true, baseDelayMs: 1000, maxDelayMs: 30000 } },
  };
}
