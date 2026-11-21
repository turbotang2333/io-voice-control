import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

test('renamed shortcuts are created safely and both names can be removed on uninstall', { skip: process.platform !== 'win32' }, () => {
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/installer');
  mkdirSync(parent, { recursive: true }); const root = mkdtempSync(join(parent, 'shortcut-rename-'));
  const harness = join(root, 'RenameHarness.cs'), exe = join(root, 'test.exe');
  writeFileSync(harness, `using System; using System.IO;
class RenameHarness { static int Main(string[] args) {
 string dir=args[0], target=Path.Combine(dir,"connector.exe"), other=Path.Combine(dir,"other.exe");
 string oldLink=Path.Combine(dir,"眼镜连接器.lnk"), newLink=Path.Combine(dir,"雷鸟 iO 连接器.lnk");
 InstallerLogic.Shortcut(oldLink,target); InstallerLogic.Shortcut(newLink,other);
 try { InstallerLogic.EnsureProductShortcut(dir,target); return 1; } catch(IOException) {}
 File.Delete(newLink); InstallerLogic.EnsureProductShortcut(dir,target);
 if(!File.Exists(oldLink)||!File.Exists(newLink)) return 2;
 UninstallLogic.RemoveProductShortcuts(dir,other);
 if(!File.Exists(oldLink)||!File.Exists(newLink)) return 3;
 UninstallLogic.RemoveProductShortcuts(dir,target);
 return File.Exists(oldLink)||File.Exists(newLink) ? 4 : 0;
} }`);
  execFileSync(join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), ['/nologo', '/target:exe', '/main:RenameHarness', '/out:' + exe, '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.IO.Compression.dll', '/reference:System.IO.Compression.FileSystem.dll', resolve('distribution/Installer.cs'), resolve('distribution/Uninstaller.cs'), harness], { stdio: 'pipe', windowsHide: true });
  execFileSync(exe, [root], { stdio: 'pipe', windowsHide: true });
});

test('installer reuses its registered location and matching shortcuts, but protects other shortcuts', { skip: process.platform !== 'win32' }, () => {
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/installer');
  mkdirSync(parent, { recursive: true }); const root = mkdtempSync(join(parent, 'existing-'));
  const harness = join(root, 'ExistingHarness.cs'), exe = join(root, 'test.exe');
  writeFileSync(harness, `using System; using System.IO; using Microsoft.Win32; class ExistingHarness { static int Main(string[] args) {
    string key=@"Software\\RayneoPaseoLocationTest-"+Guid.NewGuid().ToString("N"), fallback=Path.Combine(args[0],"default"), custom=Path.Combine(args[0],"custom"), target=Path.Combine(custom,"connector.exe"), link=Path.Combine(args[0],"shortcut.lnk");
    try {
      if (InstallerLogic.InitialDestination(Registry.CurrentUser,key,fallback)!=fallback) return 1;
      using(var r=Registry.CurrentUser.CreateSubKey(key)) r.SetValue("InstallLocation",custom);
      if (InstallerLogic.InitialDestination(Registry.CurrentUser,key,fallback)!=custom) return 2;
      InstallerLogic.Shortcut(link,target);
      InstallerLogic.EnsureShortcutAvailable(link,target);
      try { InstallerLogic.EnsureShortcutAvailable(link,Path.Combine(args[0],"other.exe")); return 3; } catch(IOException) {}
      return File.Exists(link) ? 0 : 4;
    } finally { Registry.CurrentUser.DeleteSubKeyTree(key,false); }
  } }`);
  execFileSync(join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), ['/nologo', '/target:exe', '/main:ExistingHarness', '/out:' + exe, '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.IO.Compression.dll', '/reference:System.IO.Compression.FileSystem.dll', resolve('distribution/Installer.cs'), harness], { stdio: 'pipe', windowsHide: true });
  execFileSync(exe, [root], { stdio: 'pipe', windowsHide: true });
});

test('uninstall removes only connector-owned files and optionally its fresh-user configuration', { skip: process.platform !== 'win32' }, () => {
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/installer');
  mkdirSync(parent, { recursive: true }); const root = mkdtempSync(join(parent, 'uninstall-'));
  const harness = join(root, 'UninstallHarness.cs'), exe = join(root, 'test.exe');
  writeFileSync(harness, `using System; using System.IO; class UninstallHarness { static int Main(string[] args) {
    string root=args[0], app=Path.Combine(root,"RayneoPaseoConnector"), secrets=Path.Combine(root,"secrets"), state=Path.Combine(root,"state");
    Directory.CreateDirectory(Path.Combine(app,"app")); File.WriteAllText(Path.Combine(app,"manifest.json"),"{}");
    Directory.CreateDirectory(secrets); File.WriteAllText(Path.Combine(secrets,"installation.json"),"{}");
    Directory.CreateDirectory(Path.Combine(state,"secure-link")); Directory.CreateDirectory(Path.Combine(state,"codex-connector")); Directory.CreateDirectory(Path.Combine(state,"optional-search")); File.WriteAllText(Path.Combine(state,"enrollment-request.json"),"{}"); File.WriteAllText(Path.Combine(state,"other-data.txt"),"keep");
    UninstallLogic.Cleanup(app,secrets,state,true);
    if (Directory.Exists(app) || Directory.Exists(secrets) || Directory.Exists(Path.Combine(state,"secure-link")) || Directory.Exists(Path.Combine(state,"codex-connector")) || Directory.Exists(Path.Combine(state,"optional-search")) || !File.Exists(Path.Combine(state,"other-data.txt"))) return 1;
    Directory.CreateDirectory(app); File.WriteAllText(Path.Combine(app,"manifest.json"),"{}"); Directory.CreateDirectory(Path.Combine(app,"app"));
    Directory.CreateDirectory(secrets); File.WriteAllText(Path.Combine(secrets,"personal.txt"),"keep");
    try { UninstallLogic.Cleanup(app,secrets,state,true); return 2; } catch (IOException) {}
    if (!File.Exists(Path.Combine(secrets,"personal.txt")) || !Directory.Exists(app)) return 3;
    UninstallLogic.Cleanup(app,secrets,state,false);
    if (Directory.Exists(app) || !File.Exists(Path.Combine(secrets,"personal.txt"))) return 4;
    return 0; } }`);
  execFileSync(join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), ['/nologo', '/target:exe', '/main:UninstallHarness', '/out:' + exe, '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', resolve('distribution/Uninstaller.cs'), harness], { stdio: 'pipe', windowsHide: true });
  execFileSync(exe, [root], { stdio: 'pipe', windowsHide: true });
});

test('installation location rejects a drive root and resolves an absolute folder', { skip: process.platform !== 'win32' }, () => {
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/installer');
  mkdirSync(parent, { recursive: true }); const root = mkdtempSync(join(parent, 'location-'));
  const harness = join(root, 'LocationHarness.cs'), exe = join(root, 'test.exe');
  writeFileSync(harness, `using System; using System.IO; class LocationHarness { static int Main(string[] args) {
    if (InstallerLogic.ResolveDestination(args[0]) != Path.GetFullPath(args[0])) return 1;
    try { InstallerLogic.ResolveDestination(Path.GetPathRoot(args[0])); return 2; } catch (IOException) {}
    try { InstallerLogic.ResolveDestination("relative"); return 3; } catch (IOException) {}
    return 0; } }`);
  execFileSync(join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), ['/nologo', '/target:exe', '/main:LocationHarness', '/out:' + exe, '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.IO.Compression.dll', '/reference:System.IO.Compression.FileSystem.dll', resolve('distribution/Installer.cs'), harness], { stdio: 'pipe', windowsHide: true });
  execFileSync(exe, [join(root, 'install here')], { stdio: 'pipe', windowsHide: true });
});

test('installer exposes the underlying error and failed step', { skip: process.platform !== 'win32' }, () => {
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/installer');
  mkdirSync(parent, { recursive: true }); const root = mkdtempSync(join(parent, 'diagnostic-'));
  const harness = join(root, 'Harness.cs'), exe = join(root, 'test.exe');
  writeFileSync(harness, `using System; using System.Reflection;
class Harness { static int Main() {
 var method = typeof(InstallerLogic).GetMethod("DescribeError", BindingFlags.NonPublic | BindingFlags.Static);
 if (method == null) return 1;
 var error = new TargetInvocationException(new InvalidOperationException("underlying detail"));
 string result = (string)method.Invoke(null, new object[] { "shortcut", error });
 return result.Contains("shortcut") && result.Contains("underlying detail") ? 0 : 2;
} }`);
  const compiler = join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  execFileSync(compiler, ['/nologo', '/target:exe', '/main:Harness', '/out:' + exe, '/reference:System.Windows.Forms.dll',
    '/reference:System.Drawing.dll', '/reference:System.IO.Compression.dll', '/reference:System.IO.Compression.FileSystem.dll',
    resolve('distribution/Installer.cs'), harness], { stdio: 'pipe', windowsHide: true, timeout: 30000 });
  assert.doesNotThrow(() => execFileSync(exe, [], { stdio: 'pipe', windowsHide: true, timeout: 30000 }));
});

test('updating a connector keeps a recoverable old copy and leaves runtime unchanged', { skip: process.platform !== 'win32' }, () => {
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/installer');
  mkdirSync(parent, { recursive: true }); const root = mkdtempSync(join(parent, 'update-'));
  const harness = join(root, 'UpdateHarness.cs'), exe = join(root, 'test.exe');
  writeFileSync(harness, `using System; using System.IO; using System.IO.Compression;
class UpdateHarness { static int Main(string[] args) {
 string root=args[0], dest=Path.Combine(root,"installed"), zip=Path.Combine(root,"payload.zip");
 Directory.CreateDirectory(Path.Combine(dest,"app")); Directory.CreateDirectory(Path.Combine(dest,"runtime"));
 File.WriteAllText(Path.Combine(dest,"app","version"),"old"); File.WriteAllText(Path.Combine(dest,"runtime","node.exe"),"runtime");
 File.WriteAllText(Path.Combine(dest,"runtime","LICENSE"),"license"); File.WriteAllText(Path.Combine(dest,"Setup.cmd"),"setup"); File.WriteAllText(Path.Combine(dest,"manifest.json"),"old"); File.WriteAllText(Path.Combine(dest,"眼镜连接器.exe"),"old");
 using(var f=File.Create(zip)) using(var z=new ZipArchive(f,ZipArchiveMode.Create)) foreach(var pair in new[]{"app/version|new","runtime/node.exe|runtime","runtime/LICENSE|license","Setup.cmd|setup","manifest.json|new","眼镜连接器.exe|new"}) { var p=pair.Split('|'); using(var w=new StreamWriter(z.CreateEntry(p[0]).Open())) w.Write(p[1]); }
 using(var locked=new FileStream(Path.Combine(dest,"眼镜连接器.exe"),FileMode.Open,FileAccess.Read,FileShare.None)) {
   try { using(var f=File.OpenRead(zip)) InstallerLogic.Update(f,dest); return 3; } catch(IOException) {}
 }
 if(File.ReadAllText(Path.Combine(dest,"app","version"))!="old" || File.ReadAllText(Path.Combine(dest,"manifest.json"))!="old") return 4;
 if(Directory.GetDirectories(root,".ru-*").Length!=0 || Directory.GetDirectories(root,".rb-*").Length!=0) return 5;
 string bad=Path.Combine(root,"bad.zip");
 using(var f=File.Create(bad)) using(var z=new ZipArchive(f,ZipArchiveMode.Create)) { foreach(var unused in new[]{1,2}) using(var w=new StreamWriter(z.CreateEntry("app/duplicate").Open())) w.Write("data"); }
 try { using(var f=File.OpenRead(bad)) InstallerLogic.Update(f,dest); return 6; } catch(IOException) {}
 if(Directory.GetDirectories(root,".ru-*").Length!=0 || File.ReadAllText(Path.Combine(dest,"app","version"))!="old") return 7;
 string backup; using(var f=File.OpenRead(zip)) backup=InstallerLogic.Update(f,dest);
 if(File.ReadAllText(Path.Combine(dest,"app","version"))!="new" || File.ReadAllText(Path.Combine(backup,"app","version"))!="old") return 1;
 if(File.ReadAllText(Path.Combine(dest,"runtime","node.exe"))!="runtime") return 2;
 return 0; } }`);
  const compiler = join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  execFileSync(compiler, ['/nologo', '/target:exe', '/main:UpdateHarness', '/out:' + exe, '/reference:System.Windows.Forms.dll',
    '/reference:System.Drawing.dll', '/reference:System.IO.Compression.dll', '/reference:System.IO.Compression.FileSystem.dll',
    resolve('distribution/Installer.cs'), harness], { stdio: 'pipe', windowsHide: true, timeout: 30000 });
  assert.doesNotThrow(() => execFileSync(exe, [root], { stdio: 'pipe', windowsHide: true, timeout: 30000 }));
});

test('installer extracts a new package safely and refuses existing destinations and traversal', { skip: process.platform !== 'win32' }, () => {
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/installer');
  mkdirSync(parent, { recursive: true }); const root = mkdtempSync(join(parent, 'fixture-'));
  const harness = join(root, 'Harness.cs'), exe = join(root, 'test.exe');
  writeFileSync(harness, `using System; using System.IO; using System.IO.Compression;
class Harness { static int Main(string[] args) {
 string root=args[0], zip=Path.Combine(root,"safe.zip"), dest=Path.Combine(root,"dest");
 using(var f=File.Create(zip)) using(var z=new ZipArchive(f,ZipArchiveMode.Create)) { var e=z.CreateEntry("app/file.txt"); using(var w=new StreamWriter(e.Open())) w.Write("ok"); }
 long progress=-1, total=-1;
 using(var f=File.OpenRead(zip)) InstallerLogic.Extract(f,dest,null,delegate(long current,long expected) { if(current<progress || current>expected) throw new Exception("invalid progress"); progress=current; total=expected; });
 if(progress!=total || total!=2) return 5;
 if(File.ReadAllText(Path.Combine(dest,"app/file.txt"))!="ok") return 1;
 try { using(var f=File.OpenRead(zip)) InstallerLogic.Extract(f,dest); return 2; } catch(IOException) {}
 string bad=Path.Combine(root,"bad.zip"), other=Path.Combine(root,"other");
 using(var f=File.Create(bad)) using(var z=new ZipArchive(f,ZipArchiveMode.Create)) z.CreateEntry("../escape.txt");
 try { using(var f=File.OpenRead(bad)) InstallerLogic.Extract(f,other); return 3; } catch(InvalidDataException) {}
 if(File.Exists(Path.Combine(root,"escape.txt"))) return 4;
 return 0; } }`);
  const compiler = join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  execFileSync(compiler, ['/nologo', '/target:exe', '/main:Harness', '/out:' + exe, '/reference:System.Windows.Forms.dll',
    '/reference:System.Drawing.dll', '/reference:System.IO.Compression.dll', '/reference:System.IO.Compression.FileSystem.dll',
    resolve('distribution/Installer.cs'), harness], { stdio: 'pipe', windowsHide: true, timeout: 30000 });
  assert.doesNotThrow(() => execFileSync(exe, [root], { stdio: 'pipe', windowsHide: true, timeout: 30000 }));
});


test('installer preserves the selected startup option without changing another installation', { skip: process.platform !== 'win32' }, () => {
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/installer');
  mkdirSync(parent, { recursive: true }); const root = mkdtempSync(join(parent, 'registry-'));
  const harness = join(root, 'Harness.cs'), exe = join(root, 'test.exe');
  writeFileSync(harness, `using System; using Microsoft.Win32;
class Harness { static int Main() {
 string baseKey=@"Software\\RayneoPaseoInstallerTest-"+Guid.NewGuid().ToString("N"), run=baseKey+@"\\Run", settings=baseKey+@"\\Settings", path=@"C:\\sample\\connector.exe";
 try {
   InstallerLogic.ConfigureStartup(Registry.CurrentUser,run,settings,path,false);
   using(var r=Registry.CurrentUser.OpenSubKey(run)) if(r.GetValue("RayneoPaseoConnector")!=null) return 1;
   if(InstallerLogic.StartupEnabled(Registry.CurrentUser,run,path)) return 6;
   using(var s=Registry.CurrentUser.OpenSubKey(settings)) if((int)s.GetValue("startupConfigured")!=1) return 2;
   InstallerLogic.ConfigureStartup(Registry.CurrentUser,run,settings,path,true);
   using(var r=Registry.CurrentUser.OpenSubKey(run)) if((string)r.GetValue("RayneoPaseoConnector") != "\\\""+path+"\\\" --background") return 3;
   if(!InstallerLogic.StartupEnabled(Registry.CurrentUser,run,path)) return 7;
   using(var r=Registry.CurrentUser.OpenSubKey(run,true)) r.SetValue("RayneoPaseoConnector","other");
   try { InstallerLogic.ConfigureStartup(Registry.CurrentUser,run,settings,path,true); return 4; } catch(System.IO.IOException) {}
   using(var r=Registry.CurrentUser.OpenSubKey(run)) if((string)r.GetValue("RayneoPaseoConnector")!="other") return 5;
   return 0;
 } finally { Registry.CurrentUser.DeleteSubKeyTree(baseKey, false); }
} }`);
  const compiler = join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  execFileSync(compiler, ['/nologo', '/target:exe', '/main:Harness', '/out:' + exe, '/reference:System.Windows.Forms.dll',
    '/reference:System.Drawing.dll', '/reference:System.IO.Compression.dll', '/reference:System.IO.Compression.FileSystem.dll',
    resolve('distribution/Installer.cs'), harness], { stdio: 'pipe', windowsHide: true, timeout: 30000 });
  assert.doesNotThrow(() => execFileSync(exe, [], { stdio: 'pipe', windowsHide: true, timeout: 30000 }));
});
