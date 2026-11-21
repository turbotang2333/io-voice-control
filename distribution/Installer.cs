using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Windows.Forms;
using Microsoft.Win32;

internal static class InstallerLogic {
    internal static string ResolveDestination(string value) {
        if (String.IsNullOrWhiteSpace(value) || !Path.IsPathRooted(value)) throw new IOException("请选择有效的安装目录。");
        string full = Path.GetFullPath(value).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        string root = Path.GetPathRoot(full).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        if (String.Equals(full, root, StringComparison.OrdinalIgnoreCase)) throw new IOException("请选择磁盘中的文件夹。");
        return full;
    }
    internal static string InitialDestination(RegistryKey root, string keyPath, string fallback) {
        try {
            using (var key = root.OpenSubKey(keyPath)) {
                string saved = key == null ? null : key.GetValue("InstallLocation") as string;
                if (!String.IsNullOrWhiteSpace(saved)) return ResolveDestination(saved);
            }
        } catch { }
        return fallback;
    }
    internal static void EnsureShortcutAvailable(string path, string target) {
        if (!File.Exists(path)) return;
        Type type = Type.GetTypeFromProgID("WScript.Shell");
        object shell = Activator.CreateInstance(type);
        object shortcut = type.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { path });
        string existing = shortcut.GetType().InvokeMember("TargetPath", BindingFlags.GetProperty, null, shortcut, null) as string;
        if (!String.Equals(existing, target, StringComparison.OrdinalIgnoreCase)) throw new IOException("已有同名快捷方式指向其他程序，请先检查。");
    }
    static bool SameFile(string first, string second) {
        using (var hash = SHA256.Create()) using (var a = File.OpenRead(first)) using (var b = File.OpenRead(second)) {
            byte[] x = hash.ComputeHash(a), y = hash.ComputeHash(b);
            for (int i = 0; i < x.Length; i++) if (x[i] != y[i]) return false;
            return true;
        }
    }
    internal static string Update(Stream source, string destination, Action<long, long> onProgress = null) {
        string root = Path.GetFullPath(destination), parent = Path.GetDirectoryName(root);
        if (!Directory.Exists(Path.Combine(root, "app")) || !File.Exists(Path.Combine(root, "manifest.json"))
            || !File.Exists(Path.Combine(root, "眼镜连接器.exe"))) throw new IOException("现有安装不完整，请先检查。");
        string stage = Path.Combine(parent, ".ru-" + Guid.NewGuid().ToString("N").Substring(0, 12));
        string backup = Path.Combine(parent, ".rb-" + Guid.NewGuid().ToString("N").Substring(0, 12));
        bool preserveRecovery = false, stageOwned = false, backupOwned = false;
        try {
        Extract(source, stage, delegate { stageOwned = true; }, onProgress);
        foreach (string name in new[] { "node.exe", "LICENSE" }) {
            if (!SameFile(Path.Combine(root, "runtime", name), Path.Combine(stage, "runtime", name)))
                throw new IOException("运行环境版本不同，暂不能自动更新，原安装已保留。");
        }
        if (!SameFile(Path.Combine(root, "Setup.cmd"), Path.Combine(stage, "Setup.cmd")))
            throw new IOException("安装文件版本不同，暂不能自动更新，原安装已保留。");
        if (!Directory.Exists(Path.Combine(stage, "app")) || !File.Exists(Path.Combine(stage, "manifest.json"))
            || !File.Exists(Path.Combine(stage, "眼镜连接器.exe"))) throw new IOException("更新包不完整。");
        if (Directory.Exists(backup) || File.Exists(backup)) throw new IOException("更新备份位置已存在，请重试。");
        Directory.CreateDirectory(backup);
        backupOwned = true;
        bool oldApp = false, oldManifest = false, oldExe = false, newApp = false, newManifest = false, newExe = false;
        try {
            Directory.Move(Path.Combine(root, "app"), Path.Combine(backup, "app")); oldApp = true;
            File.Move(Path.Combine(root, "manifest.json"), Path.Combine(backup, "manifest.json")); oldManifest = true;
            File.Move(Path.Combine(root, "眼镜连接器.exe"), Path.Combine(backup, "眼镜连接器.exe")); oldExe = true;
            Directory.Move(Path.Combine(stage, "app"), Path.Combine(root, "app")); newApp = true;
            File.Move(Path.Combine(stage, "manifest.json"), Path.Combine(root, "manifest.json")); newManifest = true;
            File.Move(Path.Combine(stage, "眼镜连接器.exe"), Path.Combine(root, "眼镜连接器.exe")); newExe = true;
            try { Directory.Delete(stage, true); } catch { /* Keep this update's staging files if Windows still holds them. */ }
            return backup;
        } catch {
            try {
                if (newExe) File.Move(Path.Combine(root, "眼镜连接器.exe"), Path.Combine(stage, "眼镜连接器.exe"));
                if (newManifest) File.Move(Path.Combine(root, "manifest.json"), Path.Combine(stage, "manifest.json"));
                if (newApp) Directory.Move(Path.Combine(root, "app"), Path.Combine(stage, "app"));
                if (oldExe) File.Move(Path.Combine(backup, "眼镜连接器.exe"), Path.Combine(root, "眼镜连接器.exe"));
                if (oldManifest) File.Move(Path.Combine(backup, "manifest.json"), Path.Combine(root, "manifest.json"));
                if (oldApp) Directory.Move(Path.Combine(backup, "app"), Path.Combine(root, "app"));
            } catch { preserveRecovery = true; throw new IOException("更新失败且无法自动恢复，请保留更新备份并联系作者。"); }
            throw;
        }
        } catch {
            if (!preserveRecovery) {
                try { if (stageOwned && Directory.Exists(stage) && (File.GetAttributes(stage) & FileAttributes.ReparsePoint) == 0) Directory.Delete(stage, true); } catch { }
                try { if (backupOwned && Directory.Exists(backup) && (File.GetAttributes(backup) & FileAttributes.ReparsePoint) == 0) Directory.Delete(backup, false); } catch { }
            }
            throw;
        }
    }
    internal static string DescribeError(string step, Exception error) {
        Exception detail = error;
        while (detail.InnerException != null) detail = detail.InnerException;
        return "安装未完成（" + step + "）：" + detail.Message;
    }
    internal static void ConfigureStartup(RegistryKey root, string runPath, string settingsPath, string target, bool enabled) {
        const string name = "RayneoPaseoConnector";
        string command = "\"" + target + "\" --background";
        using (var run = root.CreateSubKey(runPath)) {
            object current = run.GetValue(name);
            if (current != null && !String.Equals(current as string, command, StringComparison.OrdinalIgnoreCase)) throw new IOException("检测到另一份连接器的开机启动设置，请先核对已有版本。");
            if (enabled) run.SetValue(name, command);
            else if (current != null) run.DeleteValue(name, false);
        }
        using (var settings = root.CreateSubKey(settingsPath)) settings.SetValue("startupConfigured", 1, RegistryValueKind.DWord);
    }
    internal static bool StartupEnabled(RegistryKey root, string runPath, string target) {
        using (var run = root.OpenSubKey(runPath)) {
            return run != null && String.Equals(run.GetValue("RayneoPaseoConnector") as string,
                "\"" + target + "\" --background", StringComparison.OrdinalIgnoreCase);
        }
    }
    internal static void RegisterUninstall(string destination) {
        string executable = Path.Combine(destination, "app", "distribution", "uninstall.exe");
        if (!File.Exists(executable)) throw new IOException("安装包缺少卸载程序。");
        using (var key = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\RayneoPaseoConnector")) {
            key.SetValue("DisplayName", "雷鸟 iO 连接器");
            key.SetValue("InstallLocation", destination);
            key.SetValue("UninstallString", "\"" + executable + "\"");
            key.SetValue("DisplayIcon", Path.Combine(destination, "眼镜连接器.exe"));
            key.SetValue("NoModify", 1, RegistryValueKind.DWord); key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
        }
    }
    internal static void Extract(Stream source, string destination, Action onCreated = null, Action<long, long> onProgress = null) {
        string root = Path.GetFullPath(destination);
        if (Directory.Exists(root) || File.Exists(root)) throw new IOException("安装目录已存在，请先核对已有文件。");
        using (var archive = new ZipArchive(source, ZipArchiveMode.Read, true)) {
            long total = 0, extracted = 0;
            foreach (var entry in archive.Entries) {
                string target = Path.GetFullPath(Path.Combine(root, entry.FullName.Replace('/', Path.DirectorySeparatorChar)));
                if (!target.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("安装包中的文件路径无效。");
                checked { total += entry.Length; }
            }
            Directory.CreateDirectory(root);
            if (onCreated != null) onCreated();
            if (onProgress != null) onProgress(0, total);
            foreach (var entry in archive.Entries) {
                string target = Path.GetFullPath(Path.Combine(root, entry.FullName.Replace('/', Path.DirectorySeparatorChar)));
                if (entry.FullName.EndsWith("/")) { Directory.CreateDirectory(target); continue; }
                Directory.CreateDirectory(Path.GetDirectoryName(target));
                using (var input = entry.Open()) using (var output = new FileStream(target, FileMode.CreateNew)) {
                    byte[] buffer = new byte[65536]; int count;
                    while ((count = input.Read(buffer, 0, buffer.Length)) > 0) {
                        output.Write(buffer, 0, count); extracted += count;
                        if (onProgress != null) onProgress(extracted, total);
                    }
                }
            }
        }
    }
    internal static void Shortcut(string path, string target) {
        Type type = Type.GetTypeFromProgID("WScript.Shell");
        object shell = Activator.CreateInstance(type);
        object shortcut = type.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { path });
        Type st = shortcut.GetType();
        st.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] { target });
        st.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut, new object[] { Path.GetDirectoryName(target) });
        st.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
    }
    internal static void EnsureProductShortcut(string directory, string target) {
        string link = Path.Combine(directory, "雷鸟 iO 连接器.lnk");
        EnsureShortcutAvailable(link, target);
        Shortcut(link, target);
    }
}
internal sealed class InstallerForm : Form {
    readonly CheckBox startup = new CheckBox { Text = "登录 Windows 后自动启动连接器", AutoSize = true, Checked = false };
    readonly Button install = new Button { Text = "安装并打开", AutoSize = true };
    readonly Label status = new Label { AutoSize = false, Height = 55, Dock = DockStyle.Bottom };
    readonly ProgressBar progress = new ProgressBar { Width = 440, Height = 20, Minimum = 0, Maximum = 100, Visible = false };
    readonly TextBox location = new TextBox { ReadOnly = true, Width = 330 };
    readonly Button browse = new Button { Text = "更改位置", AutoSize = true };
    string destination = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RayneoPaseoConnector");
    public InstallerForm() {
        Text = "安装雷鸟 iO 连接器"; ClientSize = new Size(520, 360); FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false; StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.White; Font = new Font("Microsoft YaHei UI", 9F);
        var panel = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, Padding = new Padding(24, 20, 24, 12) };
        panel.Controls.Add(new Label { AutoSize = false, Width = 450, Height = 38, Text = "雷鸟 iO 连接器", Font = new Font(Font.FontFamily, 16F, FontStyle.Bold), ForeColor = Color.FromArgb(27, 50, 50) });
        destination = InstallerLogic.InitialDestination(Registry.CurrentUser, @"Software\Microsoft\Windows\CurrentVersion\Uninstall\RayneoPaseoConnector", destination);
        location.Text = destination;
        try { startup.Checked = InstallerLogic.StartupEnabled(Registry.CurrentUser, @"Software\Microsoft\Windows\CurrentVersion\Run", Path.Combine(destination, "眼镜连接器.exe")); } catch { }
        var pathPanel = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight, WrapContents = false };
        pathPanel.Controls.Add(location); pathPanel.Controls.Add(browse); panel.Controls.Add(new Label { Text = "安装位置", AutoSize = true }); panel.Controls.Add(pathPanel);
        browse.Click += delegate { using (var dialog = new FolderBrowserDialog { Description = "选择安装位置，程序会在其中创建 RayneoPaseoConnector 文件夹。", ShowNewFolderButton = true }) {
            if (dialog.ShowDialog(this) == DialogResult.OK) { destination = Path.Combine(dialog.SelectedPath, "RayneoPaseoConnector"); location.Text = destination; }
        } };
        panel.Controls.Add(startup);
        panel.Controls.Add(new Label { AutoSize = false, Width = 440, Height = 38, Text = "运行后可在右下角找到连接器。", ForeColor = Color.FromArgb(90, 105, 105) });
        install.FlatStyle = FlatStyle.Flat; install.BackColor = Color.FromArgb(28, 104, 101); install.ForeColor = Color.White;
        install.FlatAppearance.BorderSize = 0; install.Padding = new Padding(12, 5, 12, 5);
        panel.Controls.Add(progress);
        var buttonRow = new FlowLayoutPanel { Width = 440, Height = 48, FlowDirection = FlowDirection.RightToLeft, WrapContents = false };
        buttonRow.Controls.Add(install); panel.Controls.Add(buttonRow); Controls.Add(panel); Controls.Add(status); install.Click += Install;
    }
    void ReportProgress(long current, long total) {
        int value = total <= 0 ? 100 : (int)Math.Min(100, (double)current * 100 / total);
        if (value != progress.Value) { progress.Value = value; progress.Refresh(); }
    }
    void Install(object sender, EventArgs e) {
        string target = Path.Combine(destination, "眼镜连接器.exe");
        string command = "\"" + target + "\" --background";
        string step = "检查现有安装";
        const string runPath = @"Software\Microsoft\Windows\CurrentVersion\Run", name = "RayneoPaseoConnector";
        try {
            destination = InstallerLogic.ResolveDestination(destination);
            using (var existing = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\RayneoPaseoConnector")) {
                string current = existing == null ? null : existing.GetValue("InstallLocation") as string;
                if (current != null && !String.Equals(Path.GetFullPath(current), destination, StringComparison.OrdinalIgnoreCase))
                    throw new IOException("已在其他位置安装连接器，请先卸载旧版本。");
            }
            using (var run = Registry.CurrentUser.OpenSubKey(runPath)) {
                object current = run == null ? null : run.GetValue(name);
                if (current != null && !String.Equals(current as string, command, StringComparison.OrdinalIgnoreCase)) throw new IOException("检测到另一份连接器的开机启动设置，请先核对已有版本。");
            }
            string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            string programs = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
            InstallerLogic.EnsureShortcutAvailable(Path.Combine(desktop, "雷鸟 iO 连接器.lnk"), target);
            InstallerLogic.EnsureShortcutAvailable(Path.Combine(programs, "雷鸟 iO 连接器.lnk"), target);
            if (Directory.Exists(destination)) {
                install.Enabled = false; startup.Enabled = false; browse.Enabled = false; progress.Value = 0; progress.Visible = true; progress.Refresh(); status.Text = "正在更新，请稍候……"; status.Refresh();
                step = "更新现有安装（请先退出右下角连接器）";
                using (var payload = Assembly.GetExecutingAssembly().GetManifestResourceStream("connector.zip")) {
                    if (payload == null) throw new IOException("安装包不完整，请重新下载。");
                    InstallerLogic.Update(payload, destination, ReportProgress);
                }
                step = "创建快捷方式";
                InstallerLogic.EnsureProductShortcut(desktop, target);
                InstallerLogic.EnsureProductShortcut(programs, target);
                step = "设置开机启动";
                InstallerLogic.ConfigureStartup(Registry.CurrentUser, runPath, @"Software\RayneoPaseo\Connector", target, startup.Checked);
                step = "注册卸载程序";
                InstallerLogic.RegisterUninstall(destination);
                step = "打开连接器";
                Process.Start(new ProcessStartInfo(target) { UseShellExecute = true, WorkingDirectory = destination });
                Close(); return;
            }
            install.Enabled = false; startup.Enabled = false; browse.Enabled = false; progress.Value = 0; progress.Visible = true; progress.Refresh(); status.Text = "正在安装，请稍候……"; status.Refresh();
            step = "解压安装文件";
            using (var payload = Assembly.GetExecutingAssembly().GetManifestResourceStream("connector.zip")) {
                if (payload == null) throw new IOException("安装包不完整，请重新下载。");
                InstallerLogic.Extract(payload, destination, null, ReportProgress);
            }
            status.Text = "正在完成安装……"; status.Refresh();
            if (!File.Exists(target)) throw new IOException("安装包缺少连接器。");
            step = "创建桌面快捷方式";
            InstallerLogic.EnsureProductShortcut(desktop, target);
            step = "创建开始菜单快捷方式";
            InstallerLogic.EnsureProductShortcut(programs, target);
            step = "设置开机启动";
            InstallerLogic.ConfigureStartup(Registry.CurrentUser, runPath, @"Software\RayneoPaseo\Connector", target, startup.Checked);
            step = "注册卸载程序";
            InstallerLogic.RegisterUninstall(destination);
            step = "打开连接器";
            Process.Start(new ProcessStartInfo(target) { UseShellExecute = true, WorkingDirectory = destination });
            Close();
        } catch (Exception ex) {
            status.Text = InstallerLogic.DescribeError(step, ex);
            install.Enabled = true; startup.Enabled = true; browse.Enabled = true; progress.Visible = false;
            MessageBox.Show(this, status.Text, "安装未完成", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
internal static class InstallerEntry {
    [STAThread] static void Main() { Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false); Application.Run(new InstallerForm()); }
}
