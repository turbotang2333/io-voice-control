import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, delimiter } from 'node:path';
import { hostProfile, renderHostBindings } from '../scripts/host-profile.mjs';
import { ensureZxing } from '../scripts/prepare-android-deps.mjs';

const sdk = join(process.env.LOCALAPPDATA ?? '', 'Android/Sdk');
const android = join(sdk, 'platforms/android-36/android.jar');
test('the complete Android addon including paired TLS compiles against the real Android SDK', { skip: !existsSync(android) }, async () => {
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/android-compile'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'fixture-')), classes = join(root, 'classes'), dex = join(root, 'dex');
  mkdirSync(classes); mkdirSync(dex);
  const generated = join(root, 'HostBindings.java'); writeFileSync(generated, renderHostBindings(hostProfile('1.0.6')));
  const source = 'android-addon/src/cn/yilu/rayneopaseo', zxing = await ensureZxing();
  execFileSync('javac', ['-encoding', 'UTF-8', '-source', '8', '-target', '8', '-classpath', android + delimiter + zxing, '-d', classes,
    ...readdirSync(source).filter(name => name.endsWith('.java')).map(name => join(source, name)), generated], { stdio: 'pipe' });
  const jar = join(root, 'addon.jar'); execFileSync('jar', ['--create', '--file', jar, '-C', classes, '.'], { stdio: 'pipe' });
  execFileSync('java', ['-cp', join(sdk, 'build-tools/36.0.0/lib/d8.jar'), 'com.android.tools.r8.D8', '--lib', android, '--min-api', '29', '--output', dex, jar, zxing], { stdio: 'pipe' });
  assert.ok(existsSync(join(dex, 'classes.dex')));
});
