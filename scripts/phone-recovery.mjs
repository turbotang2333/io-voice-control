import { createHash, createDecipheriv, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const header = Buffer.from('RAYNEO-PASEO-RECOVERY-1\n');
const names = ['rayneo_paseo_probe', 'rayneo_paseo_interaction', 'rayneo_paseo_shortcuts'];
const max = 1024 * 1024;
const fail = code => Object.assign(new Error(code), { code });
const sha = value => createHash('sha256').update(value).digest('hex');
export function decryptArchive(archive, key) {
  if (key.length !== 32 || archive.length < header.length + 28 || archive.length > max + header.length + 28
    || !archive.subarray(0, header.length).equals(header)) throw fail('INVALID_ARCHIVE');
  try {
    const cipher = createDecipheriv('aes-256-gcm', key, archive.subarray(header.length, header.length + 12));
    cipher.setAAD(header); cipher.setAuthTag(archive.subarray(-16));
    return Buffer.concat([cipher.update(archive.subarray(header.length + 12, -16)), cipher.final()]);
  } catch { throw fail('ARCHIVE_AUTHENTICATION_FAILED'); }
}
export function decodeSnapshot(bytes) {
  if (bytes.length > max) throw fail('INVALID_SNAPSHOT');
  let position = 0;
  const take = count => {
    if (count < 0 || position + count > bytes.length) throw fail('INVALID_SNAPSHOT');
    const value = bytes.subarray(position, position += count); return value;
  };
  const int = () => take(4).readInt32BE();
  const text = () => { const count = int(); if (count > 65536) throw fail('INVALID_SNAPSHOT'); return new TextDecoder('utf-8', { fatal: true }).decode(take(count)); };
  if (text() !== 'rayneo-paseo-settings-v1') throw fail('INVALID_SNAPSHOT');
  const groups = {};
  for (const name of names) {
    if (text() !== name) throw fail('INVALID_SNAPSHOT');
    const count = int(); if (count < 0 || count > 512) throw fail('INVALID_SNAPSHOT');
    const values = new Map();
    for (let i = 0; i < count; i++) {
      const key = text(), type = take(1)[0];
      if (!key || key.length > 256 || values.has(key)) throw fail('INVALID_SNAPSHOT');
      let value;
      switch (type) {
        case 1: value = text(); break;
        case 2: value = int(); break;
        case 3: value = take(8).readBigInt64BE(); break;
        case 4: value = take(1)[0]; if (value > 1) throw fail('INVALID_SNAPSHOT'); value = value === 1; break;
        case 5: value = take(4).readFloatBE(); break;
        case 6: {
          const size = int(); if (size < 0 || size > 256) throw fail('INVALID_SNAPSHOT');
          value = new Set(); for (let j = 0; j < size; j++) { const item = text(); if (value.has(item)) throw fail('INVALID_SNAPSHOT'); value.add(item); } break;
        }
        default: throw fail('INVALID_SNAPSHOT');
      }
      values.set(key, { type, value });
    }
    groups[name] = values;
  }
  if (position !== bytes.length) throw fail('INVALID_SNAPSHOT');
  const saved = groups[names[0]], owner = saved.get('navigation_owner'), epoch = saved.get('navigation_epoch');
  if (owner?.type !== 1 || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(owner.value)
    || ![2, 3].includes(epoch?.type) || Number(epoch.value) < 1 || !Number.isSafeInteger(Number(epoch.value))) throw fail('INVALID_IDENTITY');
  return { groups, owner: owner.value, epoch: Number(epoch.value), counts: Object.fromEntries(names.map(name => [name, groups[name].size])) };
}
export function navigationFloor(snapshot, states) {
  let floor = snapshot.epoch;
  for (const state of states) {
    if (state?.owner !== snapshot.owner) continue;
    if (state.version !== 1 || !Number.isSafeInteger(state.highestEpoch) || state.highestEpoch < 1) throw fail('INVALID_NAVIGATION_STATE');
    floor = Math.max(floor, state.highestEpoch);
  }
  if (floor >= 9007199254740989) throw fail('NAVIGATION_EPOCH_EXHAUSTED');
  return floor;
}
function privateDirectory(input) {
  const base = join(homedir(), '.local-secrets', 'rayneo-paseo', 'phone-recovery');
  mkdirSync(base, { recursive: true });
  const target = resolve(input || join(base, new Date().toISOString().replaceAll(':', '-') + '-' + randomBytes(4).toString('hex')));
  if (!target.startsWith(resolve(base) + sep)) throw fail('BACKUP_MUST_STAY_PRIVATE');
  mkdirSync(target, { recursive: true });
  if (!realpathSync(target).startsWith(realpathSync(base) + sep)) throw fail('BACKUP_PATH_IS_LINKED_OUTSIDE_PRIVATE_ROOT');
  return target;
}
export function checkedResponse(response, nonce) {
  if (response?.nonce !== nonce) throw fail('RECOVERY_RESPONSE_MISMATCH');
  if (response.ok !== true) throw fail(response.code === 'BUSY' ? 'PHONE_HAS_UNFINISHED_TURN' : 'PHONE_RECOVERY_REJECTED');
  return response;
}
export function checkedBackup(response, key) {
  const archive = Buffer.from(response.archive || '', 'base64'), plain = decryptArchive(archive, key), snapshot = decodeSnapshot(plain);
  if (sha(archive) !== response.archiveSha256 || sha(plain) !== response.snapshotSha256
    || names.some(name => snapshot.counts[name] !== response.preferenceCounts?.[name])
    || Object.keys(response.preferenceCounts || {}).length !== names.length) throw fail('BACKUP_VERIFICATION_FAILED');
  return { archive, snapshot };
}
export function requestMailbox(call, remote, nonce) {
  const pending = `${remote}/request-${nonce}.pending`;
  let staged = false, publicationAttempted = false;
  const list = () => call(['shell', 'ls', '-1', remote]).trim().split(/\r?\n/);
  return {
    publish(localRequest) {
      if (list().some(name => ['request.json', 'response.json'].includes(name))) throw fail('PENDING_PHONE_RECOVERY_REQUIRES_INSPECTION');
      staged = true; call(['push', localRequest, pending]);
      publicationAttempted = true;
      call(['shell', 'mv', '-n', pending, remote + '/request.json']);
      if (list().includes(pending.split('/').pop())) throw fail('PENDING_PHONE_RECOVERY_REQUIRES_INSPECTION');
    },
    cleanup() {
      if (staged) try { call(['shell', 'rm', '-f', pending]); } catch {}
      if (!publicationAttempted) return;
      for (const name of ['request.json', 'response.json']) {
        try {
          const value = JSON.parse(call(['shell', 'cat', remote + '/' + name]));
          if (value.nonce === nonce) call(['shell', 'rm', '-f', remote + '/' + name]);
        } catch { /* Unknown files and uncertain transfers require inspection. */ }
      }
    },
  };
}
export function launchRecoveryApp(call) {
  // Match a launcher tap: a bare component intent can target a background task
  // without resuming it on the phone, so onPostResume never consumes the request.
  return call(['shell', 'am', 'start', '-W', '-a', 'android.intent.action.MAIN',
    '-c', 'android.intent.category.LAUNCHER', '-f', '0x10200000', '-n',
    'com.rayneo.venus.pub/com.rayneo.venus.MainActivity']);
}
export function activateRecoveryApp(call) {
  // A HOME key event may still be in flight when the next launch arrives.
  // Wait for a real home activity transition before requesting onPostResume.
  call(['shell', 'am', 'start', '-W', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.HOME']);
  const state = call(['shell', 'dumpsys', 'activity', 'activities']);
  const resumed = state.split(/\r?\n/).filter(line => /topResumedActivity=|mResumedActivity=/.test(line));
  if (!resumed.length || resumed.some(line => line.includes('com.rayneo.venus.pub/'))) throw fail('HOME_TRANSITION_NOT_COMPLETE');
  return launchRecoveryApp(call);
}
export function submitRecoveryRequest(call, mailbox, localRequest, { idleRestart = false } = {}) {
  if (typeof idleRestart !== 'boolean') throw fail('INVALID_IDLE_RESTART');
  // Use only after the user has confirmed the app has no unsent or running turn.
  // Some phones refuse to resume an existing task from USB; stop before publish
  // so an in-progress restore can never be interrupted by this restart.
  if (idleRestart) call(['shell', 'am', 'force-stop', 'com.rayneo.venus.pub']);
  mailbox.publish(localRequest);
}
export async function runRecovery({ action, serial, directory, idleRestart = false, adb = join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe') }) {
  if (!['backup', 'verify', 'restore'].includes(action) || !/^[A-Za-z0-9._:-]+$/.test(serial || '') || typeof idleRestart !== 'boolean') throw fail('INVALID_ARGUMENTS');
  if (action !== 'backup' && !directory) throw fail('BACKUP_DIRECTORY_REQUIRED');
  const target = privateDirectory(directory), lock = join(homedir(), '.local-secrets', 'rayneo-paseo', 'phone-recovery', 'maintenance.lock');
  let fd;
  try { fd = openSync(lock, 'wx', 0o600); } catch { throw fail('RECOVERY_ALREADY_RUNNING_OR_NEEDS_INSPECTION'); }
  const remote = '/sdcard/Android/data/com.rayneo.venus.pub/files/paseo-recovery';
  const localRequest = join(target, 'request.json'), localResponse = join(target, 'response.json');
  const call = args => {
    try { return execFileSync(adb, ['-s', serial, ...args], { encoding: 'utf8', stdio: 'pipe', timeout: 30000, maxBuffer: 2 * max, windowsHide: true }); }
    catch { throw fail('USB_RECOVERY_OPERATION_FAILED'); }
  };
  let mailbox, response, completed = false, verifiedResponse = false;
  try {
    if (call(['get-state']).trim() !== 'device') throw fail('PHONE_NOT_READY');
    const nonce = randomBytes(32).toString('hex');
    let key, archive, snapshot;
    if (action === 'backup') {
      if (existsSync(join(target, 'backup.rpb')) || existsSync(join(target, 'key.bin'))) throw fail('BACKUP_DIRECTORY_ALREADY_USED');
      key = randomBytes(32); writeFileSync(join(target, 'key.bin'), key, { flag: 'wx', mode: 0o600 });
    } else {
      key = readFileSync(join(target, 'key.bin')); archive = readFileSync(join(target, 'backup.rpb'));
      snapshot = decodeSnapshot(decryptArchive(archive, key));
    }
    const request = { action, nonce, expiresAt: Date.now() + 120000, key: key.toString('base64') };
    if (archive) request.archive = archive.toString('base64');
    if (action === 'restore') {
      const state = join(homedir(), '.local', 'state', 'rayneo-paseo');
      const paths = ['daily-navigation-owner.json', 'usb-navigation-owner.json', 'recent-acceptance/paseo/navigation-owner.json',
        'recent-acceptance/codex/navigation-owner.json', 'codex-direct/navigation-owner.json'];
      const states = paths.filter(path => existsSync(join(state, path))).map(path => JSON.parse(readFileSync(join(state, path), 'utf8').replace(/^\uFEFF/, '')));
      request.epochFloor = navigationFloor(snapshot, states);
    }
    writeFileSync(localRequest, JSON.stringify(request), { mode: 0o600 });
    call(['shell', 'mkdir', '-p', remote]);
    mailbox = requestMailbox(call, remote, nonce); submitRecoveryRequest(call, mailbox, localRequest, { idleRestart });
    activateRecoveryApp(call);
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      try { call(['pull', remote + '/response.json', localResponse]); response = JSON.parse(readFileSync(localResponse, 'utf8')); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 500)); }
    }
    if (!response) throw fail('RECOVERY_RESULT_UNCERTAIN_DO_NOT_RETRY_RESTORE');
    checkedResponse(response, nonce); verifiedResponse = true;
    if (action === 'backup') {
      ({ archive, snapshot } = checkedBackup(response, key));
      writeFileSync(join(target, 'backup.rpb'), archive, { flag: 'wx', mode: 0o600 });
    } else if (!response.matchesCurrent || !response.identityMatches) throw fail('PHONE_SETTINGS_DO_NOT_MATCH_BACKUP');
    const receipt = { action, verifiedAt: new Date().toISOString(), archiveSha256: sha(archive), preferenceCounts: snapshot.counts,
      encrypted: true, identityPreserved: action === 'backup' ? true : response.identityMatches, matched: action === 'backup' ? true : response.matchesCurrent,
      officialLoginBackedUp: false, modelMessageSent: false };
    writeFileSync(join(target, action + '-receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
    completed = true;
    return { ...receipt, backupDirectory: target };
  } finally {
    try {
      if (mailbox) {
        mailbox.cleanup();
        // Never interrupt a turn the app explicitly reported as busy.
        if (verifiedResponse) {
          call(['shell', 'am', 'force-stop', 'com.rayneo.venus.pub']);
          if (completed) launchRecoveryApp(call);
        }
      }
    } finally {
      for (const path of [localRequest, localResponse]) try { unlinkSync(path); } catch {}
      if (fd !== undefined) closeSync(fd); try { unlinkSync(lock); } catch {}
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i += 2) {
      const key = { '--action': 'action', '--serial': 'serial', '--directory': 'directory', '--idle-restart': 'idleRestart' }[args[i]];
      if (!key || !args[i + 1] || options[key]) throw fail('INVALID_ARGUMENTS'); options[key] = args[i + 1];
    }
    if (options.idleRestart !== undefined) {
      if (!['true', 'false'].includes(options.idleRestart)) throw fail('INVALID_ARGUMENTS');
      options.idleRestart = options.idleRestart === 'true';
    }
    console.log(JSON.stringify(await runRecovery(options)));
  } catch (failure) { console.error(JSON.stringify({ ok: false, code: failure.code || 'RECOVERY_FAILED', modelMessageSent: false,
    recoveryHint: '若 USB 中断或结果不明，先核对回执和手机配置，再强停重开雷鸟；不要重复执行恢复。' })); process.exitCode = 1; }
}
