import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

for (const replaced of [['classes2.dex'], ['classes2.dex', 'classes3.dex']]) {
  test(`APK assembly replaces ${replaced.join(', ')} while preserving official resources and other DEX`, () => {
    const state = join(homedir(), '.local', 'state', 'rayneo-paseo', 'test-host-compatibility');
    mkdirSync(state, { recursive: true });
    const out = mkdtempSync(join(state, 'apk-'));
    const script = `import importlib.util, pathlib, sys, zipfile
sys.dont_write_bytecode = True
root = pathlib.Path(sys.argv[1])
spec = importlib.util.spec_from_file_location('assemble', sys.argv[2])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
stock = {'classes.dex': b'one', 'classes2.dex': b'two', 'classes3.dex': b'three', 'classes4.dex': b'four',
         'AndroidManifest.xml': b'manifest', 'resources.arsc': b'resources', 'lib/arm64-v8a/libnative.so': b'library',
         'assets/official.bin': b'official asset', 'META-INF/CERT.RSA': b'old signature'}
def write_zip(path, entries):
    with zipfile.ZipFile(path, 'w') as result:
        for name, value in entries.items(): result.writestr(name, value)
original, built, addon, cert, output = [root / name for name in ['stock.apk', 'built.apk', 'addon.dex', 'local.cer', 'out.apk']]
write_zip(original, stock)
write_zip(built, {name: b'patched:' + name.encode() for name in ['classes.dex', 'classes2.dex', 'classes3.dex', 'classes4.dex', 'classes5.dex']})
addon.write_bytes(b'addon'); cert.write_bytes(b'certificate')
replaced = sys.argv[3:]
module.assemble_apk(original, built, addon, cert, output, replaced)
with zipfile.ZipFile(output) as result:
    for name, value in stock.items():
        if name == 'META-INF/CERT.RSA': assert name not in result.namelist()
        else: assert result.read(name) == (b'patched:' + name.encode() if name in replaced else value), name
    assert result.read('classes5.dex') == b'patched:classes5.dex'
    assert result.read('classes6.dex') == b'addon'
    assert result.read('assets/rayneo-paseo-local.cer') == b'certificate'
    assert b'Apache License' in result.read('assets/ZXING-LICENSE.txt')
    project = pathlib.Path(sys.argv[2]).resolve().parent.parent
    assert result.read('assets/RAYNEO-PASEO-LICENSE.txt') == (project / 'LICENSE').read_bytes()
    assert result.read('assets/RAYNEO-PASEO-THIRD-PARTY-NOTICES.md') == (project / 'THIRD_PARTY_NOTICES.md').read_bytes()
    assert len(result.namelist()) == len(stock) + 5
    assert result.testzip() is None
wireless = root / 'wireless.apk'
module.assemble_apk(original, built, addon, cert, wireless, replaced, wireless_only=True)
with zipfile.ZipFile(wireless) as result:
    assert 'assets/rayneo-paseo-local.cer' not in result.namelist()
    assert result.read('assets/rayneo-paseo-wireless-only') == b'1'
    assert result.read('classes6.dex') == b'addon'
write_zip(original, {**stock, 'assets/rayneo-paseo-local.cer': b'unexpected'})
blocked_certificate = root / 'blocked-certificate.apk'
try:
    module.assemble_apk(original, built, addon, cert, blocked_certificate, replaced, wireless_only=True)
    raise AssertionError('existing local certificate accepted in wireless release')
except ValueError: assert not blocked_certificate.exists()
write_zip(original, stock)
# Reject an unexpected source DEX before creating an output.
for extra in ['classes5.dex', 'classes10.dex']:
    write_zip(original, {**stock, extra: b'collision'})
    blocked = root / ('blocked-' + extra + '.apk')
    try:
        module.assemble_apk(original, built, addon, cert, blocked, replaced)
        raise AssertionError('unexpected DEX accepted: ' + extra)
    except ValueError: assert not blocked.exists()
print('APK preservation checks passed')
`;
    const python = process.env.PYTHON_EXECUTABLE || join(process.env.LOCALAPPDATA, 'Python', 'pythoncore-3.14-64', 'python.exe');
    const result = spawnSync(python, ['-', out, resolve('scripts/assemble-apk.py'), ...replaced], { input: script, encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /APK preservation checks passed/);
  });
}

test('APK assembly preserves seven stock DEX files and places extensions after them', () => {
  const state = join(homedir(), '.local', 'state', 'rayneo-paseo', 'test-host-compatibility');
  mkdirSync(state, { recursive: true });
  const out = mkdtempSync(join(state, 'apk-seven-'));
  const script = `import importlib.util, pathlib, sys, zipfile
root = pathlib.Path(sys.argv[1]); spec = importlib.util.spec_from_file_location('assemble', sys.argv[2]); module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
stock = {('classes.dex' if i == 1 else f'classes{i}.dex'): f'original-{i}'.encode() for i in range(1, 8)}
def write(path, entries):
    with zipfile.ZipFile(path, 'w') as z:
        for n, v in entries.items(): z.writestr(n, v)
original, built, addon, cert, output = [root / n for n in ['stock.apk', 'built.apk', 'addon.dex', 'local.cer', 'out.apk']]
write(original, stock); write(built, {**stock, 'classes4.dex': b'patched', 'classes8.dex': b'hooks'}); addon.write_bytes(b'addon'); cert.write_bytes(b'certificate')
module.assemble_apk(original, built, addon, cert, output, ['classes4.dex'], 'classes8.dex', 'classes9.dex')
with zipfile.ZipFile(output) as z:
    for n, value in stock.items(): assert z.read(n) == (b'patched' if n == 'classes4.dex' else value), n
    assert z.read('classes8.dex') == b'hooks' and z.read('classes9.dex') == b'addon'
`;
  const python = process.env.PYTHON_EXECUTABLE || join(process.env.LOCALAPPDATA, 'Python', 'pythoncore-3.14-64', 'python.exe');
  const result = spawnSync(python, ['-', out, resolve('scripts/assemble-apk.py')], { input: script, encoding: 'utf8' });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
});
