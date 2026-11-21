import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

test('connector ZIP exposes its root files to the Windows compressed-folder reader', { skip: process.platform !== 'win32' }, () => {
  const parent = join(homedir(), '.local/state/rayneo-paseo/zip-archive-tests'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'fixture-')), source = join(root, 'source'), output = join(root, 'trial.zip');
  mkdirSync(join(source, 'app'), { recursive: true }); mkdirSync(join(source, 'runtime'));
  writeFileSync(join(source, 'Setup.cmd'), '@echo off\r\n'); writeFileSync(join(source, 'manifest.json'), '{}');
  writeFileSync(join(source, 'app/test.mjs'), 'export const fixture = true;'); writeFileSync(join(source, 'runtime/node.exe'), 'synthetic');
  const result = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', resolve('scripts/create-connector-archive.ps1'), '-SourceDirectory', source, '-OutputArchive', output],
    { encoding: 'utf8', stdio: 'pipe', timeout: 15000, windowsHide: true }));
  assert.equal(result.windowsShellVisibleItems, 4);
  assert.equal(result.dotPrefixedEntries, 0);
  assert.equal(result.files, 4);
});
