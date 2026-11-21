import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, copyFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

test('portable startup helpers find the bundled runtime with no Node on PATH', { skip: process.platform !== 'win32' }, () => {
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/node-runtime'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'fixture-')), scripts = join(root, 'app/scripts'); mkdirSync(scripts, { recursive: true });
  mkdirSync(join(root, 'runtime')); writeFileSync(join(root, 'manifest.json'), '{}');
  copyFileSync(process.execPath, join(root, 'runtime/node.exe'));
  copyFileSync('scripts/resolve-node.ps1', join(scripts, 'resolve-node.ps1'));
  const executable = execFileSync(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-File', join(scripts, 'resolve-node.ps1')],
    { env: { ...process.env, PATH: '' }, encoding: 'utf8', windowsHide: true, stdio: 'pipe' }).trim();
  assert.equal(executable, join(root, 'runtime/node.exe'));
  assert.equal(execFileSync(executable, ['--version'], { encoding: 'utf8', env: { ...process.env, PATH: '' } }).trim(), process.version);
});
