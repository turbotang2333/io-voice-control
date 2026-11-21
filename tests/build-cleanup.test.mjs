import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve('scripts/build-cleanup.ps1');
const fixtures = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/build-cleanup');
function root() { mkdirSync(fixtures, { recursive: true }); return mkdtempSync(join(fixtures, 'run-')); }
function run(args) {
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-File', script, ...args], { encoding: 'utf8' }));
}
function build(state, name) {
  const directory = join(state, name);
  mkdirSync(join(directory, 'host-258'), { recursive: true });
  writeFileSync(join(directory, 'host-258', 'decoded.txt'), 'decoded');
  writeFileSync(join(directory, 'host-rebuilt.apk'), 'intermediate');
  writeFileSync(join(directory, 'rayneo-paseo-voice-probe-1.0.10.apk'), 'signed');
  run(['-Mode', 'Register', '-StateRoot', state, '-BuildDirectory', directory, '-HostVersionCode', '258', '-Artifact', join(directory, 'rayneo-paseo-voice-probe-1.0.10.apk')]);
  return directory;
}
test('preview keeps two newest builds and only confirmed cleanup removes older intermediates', { skip: process.platform !== 'win32' }, () => {
  const state = root(), first = build(state, 'one'), second = build(state, 'two'), third = build(state, 'three');
  const preview = run(['-Mode', 'Preview', '-StateRoot', state]);
  assert.equal(preview.candidates.length, 1);
  assert.equal(preview.candidates[0].buildDirectory, first);
  assert.ok(preview.candidates[0].bytes >= 19);
  assert.ok(existsSync(join(first, 'host-rebuilt.apk')));
  const result = run(['-Mode', 'Apply', '-StateRoot', state, '-PlanId', preview.planId]);
  assert.equal(result.deletedTargets, 2);
  assert.ok(existsSync(result.receipt));
  assert.ok(!existsSync(join(first, 'host-rebuilt.apk')));
  assert.ok(!existsSync(join(first, 'host-258')));
  assert.ok(existsSync(join(first, 'rayneo-paseo-voice-probe-1.0.10.apk')));
  assert.ok(existsSync(join(second, 'host-rebuilt.apk')));
  assert.ok(existsSync(join(third, 'host-rebuilt.apk')));
});
test('a running process referencing a candidate prevents cleanup', { skip: process.platform !== 'win32' }, () => {
  const state = root(), first = build(state, 'one'); build(state, 'two'); build(state, 'three');
  const preview = run(['-Mode', 'Preview', '-StateRoot', state]);
  const worker = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', first], { windowsHide: true });
  try {
    const attempt = spawnSync('powershell.exe', ['-NoProfile', '-File', script, '-Mode', 'Apply', '-StateRoot', state, '-PlanId', preview.planId], { encoding: 'utf8' });
    assert.notEqual(attempt.status, 0);
    assert.ok(existsSync(join(first, 'host-rebuilt.apk')));
  } finally { worker.kill(); }
});
test('changed candidate after preview is rejected without deleting anything', { skip: process.platform !== 'win32' }, () => {
  const state = root(), first = build(state, 'one'); build(state, 'two'); build(state, 'three');
  const preview = run(['-Mode', 'Preview', '-StateRoot', state]);
  writeFileSync(join(first, 'host-258', 'new.txt'), 'new');
  const attempt = spawnSync('powershell.exe', ['-NoProfile', '-File', script, '-Mode', 'Apply', '-StateRoot', state, '-PlanId', preview.planId], { encoding: 'utf8' });
  assert.notEqual(attempt.status, 0);
  assert.ok(existsSync(join(first, 'host-rebuilt.apk')));
  assert.ok(existsSync(join(first, 'host-258', 'new.txt')));
});
test('cleanup without a reviewed plan and unregistered old folders are never removed', { skip: process.platform !== 'win32' }, () => {
  const state = root();
  const unknown = join(state, 'unknown'); mkdirSync(unknown); writeFileSync(join(unknown, 'host-rebuilt.apk'), 'keep');
  build(state, 'one'); build(state, 'two');
  const preview = run(['-Mode', 'Preview', '-StateRoot', state]);
  assert.equal(preview.candidates.length, 0);
  const attempt = spawnSync('powershell.exe', ['-NoProfile', '-File', script, '-Mode', 'Apply', '-StateRoot', state], { encoding: 'utf8' });
  assert.notEqual(attempt.status, 0);
  assert.ok(existsSync(join(unknown, 'host-rebuilt.apk')));
});
test('a newly registered build invalidates an earlier cleanup plan', { skip: process.platform !== 'win32' }, () => {
  const state = root(), first = build(state, 'one'); build(state, 'two'); build(state, 'three');
  const preview = run(['-Mode', 'Preview', '-StateRoot', state]);
  build(state, 'four');
  const attempt = spawnSync('powershell.exe', ['-NoProfile', '-File', script, '-Mode', 'Apply', '-StateRoot', state, '-PlanId', preview.planId], { encoding: 'utf8' });
  assert.notEqual(attempt.status, 0);
  assert.ok(existsSync(join(first, 'host-rebuilt.apk')));
});
test('a corrupted host code cannot redirect a cleanup candidate', { skip: process.platform !== 'win32' }, () => {
  const state = root(), first = build(state, 'one'); build(state, 'two'); build(state, 'three');
  const records = join(state, 'build-history');
  const recordPath = readdirSync(records).map(name => join(records, name)).find(path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')).buildDirectory === first);
  const record = JSON.parse(readFileSync(recordPath, 'utf8').replace(/^\uFEFF/, ''));
  record.hostVersionCode = '258\\..\\..\\other'; writeFileSync(recordPath, JSON.stringify(record));
  const attempt = spawnSync('powershell.exe', ['-NoProfile', '-File', script, '-Mode', 'Preview', '-StateRoot', state], { encoding: 'utf8' });
  assert.notEqual(attempt.status, 0);
  assert.ok(existsSync(join(first, 'host-rebuilt.apk')));
});
test('a junction inside a candidate prevents preview and leaves its target intact', { skip: process.platform !== 'win32' }, () => {
  const state = root(), first = build(state, 'one'); build(state, 'two'); build(state, 'three');
  const external = join(state, 'external'); mkdirSync(external); writeFileSync(join(external, 'keep.txt'), 'keep');
  symlinkSync(external, join(first, 'host-258', 'linked'), 'junction');
  const attempt = spawnSync('powershell.exe', ['-NoProfile', '-File', script, '-Mode', 'Preview', '-StateRoot', state], { encoding: 'utf8' });
  assert.notEqual(attempt.status, 0);
  assert.ok(existsSync(join(external, 'keep.txt')));
  assert.ok(existsSync(join(first, 'host-rebuilt.apk')));
});
test('successful build output offers a confirmation command for an older build', { skip: process.platform !== 'win32' }, () => {
  const fixture = root();
  const stdout = execFileSync('powershell.exe', ['-NoProfile', '-File', resolve('tests/fixtures/build-cleanup-harness.ps1'), '-FixtureRoot', fixture, '-ProjectRoot', resolve('.')], { encoding: 'utf8' });
  const lastLine = stdout.trim().split(/\r?\n/).at(-1);
  const result = JSON.parse(lastLine);
  assert.equal(result.cleanup.requires_confirmation, true);
  assert.equal(result.cleanup.candidates.length, 1);
  assert.match(result.cleanup.candidates[0].buildDirectory, /[\\/]one$/);
  assert.match(result.cleanup.confirm_then_run, /-Mode Apply -PlanId [0-9a-f]{64}$/);
  assert.ok(existsSync(join(result.cleanup.candidates[0].buildDirectory, 'host-258', 'decoded.txt')));
});
