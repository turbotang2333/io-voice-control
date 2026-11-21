import { randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

const fail = code => Object.assign(new Error('导航会话已变化，本次未发送。请重新列出名单。'), { code });
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const epochValid = value => Number.isSafeInteger(value) && value > 0;
const stateValid = s => s?.version === 1 && ((s.owner === null && s.highestEpoch === 0)
  || (uuid(s.owner) && epochValid(s.highestEpoch)));

/** Only phone ownership and a monotonic high-water mark; never selection or task data. */
export function openNavigationSessionStore(path) {
  let state = { version: 1, owner: null, highestEpoch: 0 };
  try {
    const bytes = readFileSync(path);
    if (bytes.length > 2048) throw fail('NAVIGATION_STATE_INVALID');
    state = JSON.parse(bytes.toString('utf8'));
    if (!stateValid(state)) throw fail('NAVIGATION_STATE_INVALID');
  } catch (error) { if (error.code !== 'ENOENT') throw fail('NAVIGATION_STATE_INVALID'); }
  return {
    load: () => ({ ...state }),
    save(next) {
      if (!stateValid(next)) throw fail('NAVIGATION_STATE_INVALID');
      mkdirSync(dirname(path), { recursive: true });
      const temp = `${path}.${randomUUID()}.tmp`;
      let fd;
      try {
        fd = openSync(temp, 'wx', 0o600); writeFileSync(fd, JSON.stringify(next));
        fsyncSync(fd); closeSync(fd); fd = undefined;
        renameSync(temp, path); state = { version: 1, owner: next.owner, highestEpoch: next.highestEpoch };
      } catch { throw fail('STATE_WRITE_FAILED'); }
      finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temp); } catch {} }
    },
  };
}

/** One authenticated phone per independently locked service. No raw IDs/tokens are logged. */
export function createNavigationSession({ backend, store, invalidate, now = Date.now, conversationSearch = false, agentCreation = () => false, shortcuts = () => false, codexCreation = false }) {
  if (!['paseo', 'codex'].includes(backend) || typeof invalidate !== 'function') throw fail('INVALID_INPUT');
  let state = store.load();
  if (!stateValid(state)) throw fail('NAVIGATION_STATE_INVALID');
  let generation = randomUUID(), revision = 0, active;
  const challenges = new Map();
  const validate = ({ installationId, epoch } = {}) => {
    if (!uuid(installationId) || !epochValid(epoch)) throw fail('INVALID_INPUT');
    if (state.owner && state.owner !== installationId) throw fail('NAVIGATION_OWNER_MISMATCH');
    if (epoch < state.highestEpoch) throw fail('NAVIGATION_SESSION_STALE');
  };
  const same = identity => active && active.installationId === identity.installationId && active.epoch === identity.epoch;
  const binding = () => ({ sessionToken: active.sessionToken, generation, backend, conversationSearch: conversationSearch === true,
    agentCreation: (backend === 'paseo' || codexCreation === true) && agentCreation() === true, shortcuts: shortcuts() === true });
  const prune = () => {
    for (const [key, value] of challenges) if (value.expiresAt <= now()) challenges.delete(key);
  };
  return {
    challenge(identity) {
      validate(identity);
      if (same(identity)) return { binding: binding() };
      prune();
      if (challenges.size >= 32) throw fail('NAVIGATION_HANDSHAKE_BUSY');
      const challenge = randomUUID();
      challenges.set(challenge, { ...identity, revision, generation, backend, expiresAt: now() + 30000 });
      return { challenge };
    },
    bind({ challenge, installationId, epoch } = {}) {
      validate({ installationId, epoch });
      const pending = challenges.get(challenge);
      if (!pending || pending.expiresAt <= now() || pending.generation !== generation || pending.backend !== backend
        || pending.installationId !== installationId || pending.epoch !== epoch) throw fail('NAVIGATION_SESSION_STALE');
      if (pending.confirmed && same({ installationId, epoch }) && active.sessionToken === pending.confirmed) return { binding: binding() };
      if (pending.revision !== revision) throw fail('NAVIGATION_SESSION_STALE');
      const next = { version: 1, owner: installationId, highestEpoch: epoch };
      try { store.save(next); } catch { throw fail('STATE_WRITE_FAILED'); }
      state = next;
      invalidate(); revision++;
      active = { installationId, epoch, sessionToken: randomUUID() };
      pending.confirmed = active.sessionToken;
      return { binding: binding() };
    },
    authorize(identity = {}) {
      if (!uuid(identity.sessionToken) || !uuid(identity.generation)) throw fail('NAVIGATION_SESSION_REQUIRED');
      validate(identity);
      const expected = active;
      const assertCurrent = () => {
        if (!expected || active !== expected || !same(identity) || identity.sessionToken !== active.sessionToken
          || identity.generation !== generation || (identity.backend !== undefined && identity.backend !== backend)) {
          throw fail('NAVIGATION_SESSION_STALE');
        }
      };
      assertCurrent();
      return assertCurrent;
    },
    invalidateConnection() {
      active = undefined; generation = randomUUID(); revision++; challenges.clear(); invalidate();
    },
  };
}

/** This endpoint is called only AFTER the HTTP layer authenticates its Bearer token. */
export async function navigationHandshake(request, manager) {
  let size = 0; const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 4096) throw fail('INVALID_INPUT');
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('INVALID_INPUT'); }
  if (body.action === 'challenge') return manager.challenge(body);
  if (body.action === 'bind') return manager.bind(body);
  throw fail('INVALID_INPUT');
}

export function authorizeNavigationRequest(request, response, manager) {
  const assertSession = manager.authorize({
    installationId: request.headers['x-navigation-owner'], epoch: Number(request.headers['x-navigation-epoch']),
    sessionToken: request.headers['x-navigation-session'], generation: request.headers['x-navigation-generation'],
  });
  return () => {
    assertSession();
    if (request.aborted || response.destroyed) throw fail('NAVIGATION_SESSION_STALE');
  };
}
