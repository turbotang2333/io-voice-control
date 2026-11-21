import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, copyFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { get } from 'node:http';

test('tray exit stops its connector and its child processes', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/tray-logic');
  mkdirSync(parent, { recursive: true }); const root = mkdtempSync(join(parent, 'exit-'));
  const marker = join(root, 'child.txt'), script = join(root, 'fixture.cjs');
  writeFileSync(script, `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(process.argv[2],String(child.pid));setInterval(()=>{},1000);`);
  const child = spawn(process.execPath, [script, marker], { windowsHide: true, stdio: 'ignore' });
  t.after(() => { if (child.exitCode === null) try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'pipe', windowsHide: true }); } catch {} });
  const deadline = Date.now() + 10000; while (!existsSync(marker) && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
  assert.ok(existsSync(marker)); const grandchildPid = Number(readFileSync(marker, 'utf8'));
  const harness = join(root, 'StopHarness.cs'), exe = join(root, 'test.exe');
  writeFileSync(harness, `using System; class StopHarness { static int Main(string[] args) { return TrayLogic.StopTree(int.Parse(args[0])) ? 0 : 1; } }`);
  execFileSync(join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), ['/nologo', '/target:exe', '/main:StopHarness', '/out:' + exe, '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.Web.Extensions.dll', resolve('distribution/Tray.cs'), harness], { stdio: 'pipe', windowsHide: true });
  execFileSync(exe, [String(child.pid)], { stdio: 'pipe', windowsHide: true });
  await new Promise(r => setTimeout(r, 300));
  assert.throws(() => process.kill(grandchildPid, 0));
});

test('Windows tray interprets connection status conservatively and quotes its startup command',
  { skip: process.platform !== 'win32' }, () => {
    const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/tray-logic');
    mkdirSync(parent, { recursive: true }); const root = mkdtempSync(join(parent, 'fixture-'));
    const harness = join(root, 'Harness.cs'), output = join(root, 'test.exe');
    writeFileSync(harness, `using System; class Harness { static int Main() {
      if (TrayLogic.StartupCommand(@"C:\\Folder With Space\\app.exe") != (char)34 + @"C:\\Folder With Space\\app.exe" + (char)34 + " --background") return 1;
      if (TrayLogic.Status(null) != "unavailable") return 2;
      if (TrayLogic.Status("not-json") != "unavailable") return 3;
      if (TrayLogic.Status("{\\"phase\\":\\"new\\"}") != "setup") return 4;
      if (TrayLogic.Status("{\\"phase\\":\\"configured\\",\\"connectionMode\\":\\"secure\\",\\"encryption\\":\\"verified\\",\\"connections\\":[{\\"ready\\":true}]}") != "ready") return 5;
      if (TrayLogic.Status("{\\"phase\\":\\"configured\\",\\"connectionMode\\":\\"secure\\",\\"encryption\\":\\"unverified\\",\\"connections\\":[{\\"ready\\":true}]}") != "unavailable") return 6;
      if (TrayLogic.Status("{\\"phase\\":\\"configured\\",\\"connectionMode\\":\\"secure\\",\\"encryption\\":\\"verified\\",\\"connections\\":[{\\"ready\\":false}]}") != "unavailable") return 7;
      if (TrayLogic.Status("{\\"phase\\":\\"configured\\",\\"connectionMode\\":\\"secure\\",\\"encryption\\":\\"verified\\",\\"connections\\":[{\\"ready\\":true},{\\"ready\\":false}]}") != "ready") return 8;
      if (TrayLogic.Status("{\\"phase\\":\\"configured\\",\\"connectionMode\\":\\"secure\\",\\"encryption\\":\\"verified\\",\\"connections\\":[{\\"ready\\":false},{\\"ready\\":true}]}") != "ready") return 14;
      if (!TrayLogic.CanUseStartup(null, "ours") || !TrayLogic.CanUseStartup("ours", "ours")) return 9;
      if (TrayLogic.CanUseStartup("another app", "ours")) return 10;
      int port = TrayLogic.FreePort();
      if (port < 1024 || port > 65535) return 11;
      int preferred = TrayLogic.FreePort();
      if (TrayLogic.PreferredPort(preferred) != preferred || TrayLogic.PreferredPort(preferred) != preferred) return 12;
      var occupied = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, preferred);
      occupied.Start();
      try { if (TrayLogic.PreferredPort(preferred) == preferred) return 13; }
      finally { occupied.Stop(); }
      return 0; } }`);
    const compiler = join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    execFileSync(compiler, ['/nologo', '/target:exe', '/main:Harness', '/out:' + output,
      '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.Web.Extensions.dll',
      resolve('distribution/Tray.cs'), harness], { stdio: 'pipe', windowsHide: true, timeout: 30000 });
    execFileSync(output, [], { stdio: 'pipe', windowsHide: true, timeout: 10000 });
  });

test('native tray starts a background connector on an isolated port without registering startup in the test',
  { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
    const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/tray-logic');
    mkdirSync(parent, { recursive: true }); const root = mkdtempSync(join(parent, 'native-'));
    const runtime = join(root, 'runtime'), app = join(root, 'app/distribution');
    mkdirSync(runtime, { recursive: true }); mkdirSync(app, { recursive: true });
    copyFileSync(process.execPath, join(runtime, 'node.exe'));
    const marker = join(root, 'ready.json');
    writeFileSync(join(app, 'launch.mjs'), `import {createServer} from 'node:http';import{writeFileSync}from'node:fs';
      const i=process.argv.indexOf('--port'),port=Number(process.argv[i+1]);
      if(!process.argv.includes('--auto-connect')||!process.argv.includes('--no-open'))process.exit(1);
      createServer((req,res)=>res.end(JSON.stringify({phase:'new'}))).listen(port,'127.0.0.1',()=>writeFileSync(${JSON.stringify(marker)},JSON.stringify({port,pid:process.pid})));`);
    const exe = join(root, 'tray.exe');
    execFileSync(join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
      ['/nologo', '/target:winexe', '/define:RAYNEO_TRAY_TEST', '/out:' + exe, '/reference:System.Windows.Forms.dll',
        '/reference:System.Drawing.dll', '/reference:System.Web.Extensions.dll', resolve('distribution/Tray.cs')],
      { stdio: 'pipe', windowsHide: true, timeout: 30000 });
    const child = spawn(exe, ['--background'], { cwd: root, windowsHide: true, stdio: 'ignore' });
    t.after(() => { if (child.exitCode === null) try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'pipe', windowsHide: true }); } catch {} });
    const deadline = Date.now() + 20000;
    while (!existsSync(marker) && child.exitCode === null && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
    assert.ok(existsSync(marker), 'test connector should start');
    const ready = JSON.parse(readFileSync(marker));
    const status = await new Promise((accept, reject) => { get(`http://127.0.0.1:${ready.port}/api/status`, res => {
      let text = ''; res.on('data', b => text += b); res.on('end', () => accept(JSON.parse(text)));
    }).on('error', reject); });
    assert.equal(status.phase, 'new');
  });

test('tray opens only the status page owned by its own connector process',
  { skip: process.platform !== 'win32' }, async t => {
    const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/tray-logic');
    mkdirSync(parent, { recursive: true }); const root = mkdtempSync(join(parent, 'owner-'));
    const harness = join(root, 'Harness.cs'), output = join(root, 'test.exe');
    writeFileSync(harness, `using System; class Harness { static int Main(string[] args) {
      int port = int.Parse(args[0]), owner = int.Parse(args[1]);
      if (!TrayLogic.OwnsPort(port, owner)) return 1;
      if (TrayLogic.OwnsPort(port, owner + 1000000)) return 2;
      return 0; } }`);
    execFileSync(join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
      ['/nologo', '/target:exe', '/main:Harness', '/out:' + output, '/reference:System.Windows.Forms.dll',
        '/reference:System.Drawing.dll', '/reference:System.Web.Extensions.dll', resolve('distribution/Tray.cs'), harness],
      { stdio: 'pipe', windowsHide: true, timeout: 30000 });
    const server = createServer(); await new Promise((accept, reject) => server.once('error', reject).listen(0, '127.0.0.1', accept));
    t.after(() => new Promise(accept => server.close(accept)));
    execFileSync(output, [String(server.address().port), String(process.pid)], { stdio: 'pipe', windowsHide: true, timeout: 10000 });
  });
