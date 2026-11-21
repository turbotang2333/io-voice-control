import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, mkdtempSync } from 'node:fs';

test('recovery journals encrypt credentials and still open valid legacy journals', () => {
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/recovery-journal'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'fixture-'));
  const names = ['SecretEnvelope', 'RecoveryJournal', 'SettingsSnapshot', 'ConnectionProfiles', 'BridgeEndpoint', 'InteractionPreferences', 'ShortcutBindings', 'ShortcutScopes', 'VoiceCommand'];
  execFileSync('javac', ['-encoding', 'UTF-8', '-d', root, ...names.map(name => `android-addon/src/cn/yilu/rayneopaseo/${name}.java`),
    'android-addon/tests/RecoveryJournalTest.java'], { stdio: 'pipe' });
  assert.match(execFileSync('java', ['-cp', root, 'cn.yilu.rayneopaseo.RecoveryJournalTest'], { encoding: 'utf8' }), /recovery journal checks passed/);
});
