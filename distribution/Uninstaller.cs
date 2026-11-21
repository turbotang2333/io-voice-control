using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Windows.Forms;
using Microsoft.Win32;

internal static class UninstallLogic {
    internal static void Validate(string root, string secrets, bool deleteData) {
        string full = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar);
        if (!String.Equals(Path.GetFileName(full), "RayneoPaseoConnector", StringComparison.OrdinalIgnoreCase)
            || !File.Exists(Path.Combine(full, "manifest.json")) || !Directory.Exists(Path.Combine(full, "app"))
            || (File.GetAttributes(full) & FileAttributes.ReparsePoint) != 0) throw new IOException("无法确认连接器的安装目录，未删除文件。");
        if (deleteData && Directory.Exists(secrets)) {
            if ((File.GetAttributes(secrets) & FileAttributes.ReparsePoint) != 0 || !File.Exists(Path.Combine(secrets, "installation.json")))
                throw new IOException("检测到旧版共享配置，无法安全自动删除。请选择保留配置后卸载。");
        }
    }
    internal static void Cleanup(string root, string secrets, string state, bool deleteData) {
        Validate(root, secrets, deleteData);
        string secure = Path.Combine(state, "secure-link"), codex = Path.Combine(state, "codex-connector"), optionalSearch = Path.Combine(state, "optional-search"), enrollment = Path.Combine(state, "enrollment-request.json");
        foreach (string path in new[] { state, secure, codex, optionalSearch })
            if (deleteData && Directory.Exists(path) && (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
                throw new IOException("连接器状态目录包含链接，未删除。");
        if (deleteData && Directory.Exists(secrets)) Directory.Delete(secrets, true);
        if (deleteData) {
            if (Directory.Exists(secure)) Directory.Delete(secure, true);
            if (Directory.Exists(codex)) Directory.Delete(codex, true);
            if (Directory.Exists(optionalSearch)) Directory.Delete(optionalSearch, true);
            if (File.Exists(enrollment)) File.Delete(enrollment);
            foreach (string name in new[] { "daily-state.json", "daily-creations.json", "daily-navigation-owner.json", "daily-connection-health.json", "daily-supervisor.lock", "daily-relay-events.json" }) {
                string path = Path.Combine(state, name); if (File.Exists(path)) File.Delete(path);
            }
        }
        Directory.Delete(root, true);
    }
    internal static void StopInstalledProcesses(string root) {
        string tray = Path.Combine(root, "眼镜连接器.exe"), node = Path.Combine(root, "runtime", "node.exe");
        foreach (var process in Process.GetProcesses()) {
            try {
                string image = process.MainModule.FileName;
                if (!String.Equals(image, tray, StringComparison.OrdinalIgnoreCase) && !String.Equals(image, node, StringComparison.OrdinalIgnoreCase)) continue;
                string tool = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "taskkill.exe");
                using (var kill = Process.Start(new ProcessStartInfo(tool, "/PID " + process.Id + " /T /F") { UseShellExecute = false, CreateNoWindow = true })) {
                    if (kill != null) kill.WaitForExit(10000);
                }
            } catch { } finally { process.Dispose(); }
        }
    }
    internal static void RemoveShortcut(string link, string expected) {
        if (!File.Exists(link)) return;
        Type type = Type.GetTypeFromProgID("WScript.Shell"); object shell = Activator.CreateInstance(type);
        object shortcut = type.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { link });
        string target = shortcut.GetType().InvokeMember("TargetPath", BindingFlags.GetProperty, null, shortcut, null) as string;
        if (String.Equals(target, expected, StringComparison.OrdinalIgnoreCase)) File.Delete(link);
    }
    internal static void RemoveProductShortcuts(string directory, string expected) {
        foreach (string name in new[] { "雷鸟 iO 连接器.lnk", "眼镜连接器.lnk" })
            RemoveShortcut(Path.Combine(directory, name), expected);
    }
    internal static void RemoveRegistration(string target) {
        const string name = "RayneoPaseoConnector";
        using (var run = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true)) {
            if (run != null && String.Equals(run.GetValue(name) as string, "\"" + target + "\" --background", StringComparison.OrdinalIgnoreCase)) run.DeleteValue(name, false);
        }
        using (var uninstall = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall", true)) {
            if (uninstall != null) using (var entry = uninstall.OpenSubKey(name)) {
                string registered = entry == null ? null : entry.GetValue("InstallLocation") as string;
                if (String.Equals(registered, Path.GetDirectoryName(target), StringComparison.OrdinalIgnoreCase)) uninstall.DeleteSubKeyTree(name, false);
            }
        }
        using (var settings = Registry.CurrentUser.OpenSubKey(@"Software\RayneoPaseo", true)) {
            if (settings != null) settings.DeleteSubKeyTree("Connector", false);
        }
    }
}

internal sealed class UninstallForm : Form {
    readonly string root;
    readonly CheckBox deleteData = new CheckBox { Text = "同时删除设置、配对信息和智能搜索", AutoSize = true };
    public UninstallForm(string installRoot) {
        root = installRoot; Text = "卸载雷鸟 iO 连接器"; ClientSize = new Size(440, 180); FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false; StartPosition = FormStartPosition.CenterScreen;
        var panel = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, Padding = new Padding(18), WrapContents = false };
        panel.Controls.Add(new Label { Text = "卸载会关闭连接器并删除程序。", AutoSize = true }); panel.Controls.Add(deleteData);
        panel.Controls.Add(new Label { Text = "勾选后，下次使用需要重新连接和配对。", AutoSize = true });
        var button = new Button { Text = "卸载", AutoSize = true }; button.Click += Run; panel.Controls.Add(button); Controls.Add(panel);
    }
    void Run(object sender, EventArgs e) {
        try {
            string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), target = Path.Combine(root, "眼镜连接器.exe");
            string secrets = Path.Combine(home, @".local-secrets\rayneo-paseo"), state = Path.Combine(home, @".local\state\rayneo-paseo");
            UninstallLogic.Validate(root, secrets, deleteData.Checked);
            UninstallLogic.StopInstalledProcesses(root);
            UninstallLogic.Cleanup(root, secrets, state, deleteData.Checked);
            foreach (var folder in new[] { Environment.SpecialFolder.DesktopDirectory, Environment.SpecialFolder.Programs })
                UninstallLogic.RemoveProductShortcuts(Environment.GetFolderPath(folder), target);
            UninstallLogic.RemoveRegistration(target);
            MessageBox.Show(this, "卸载完成。", "雷鸟 iO 连接器", MessageBoxButtons.OK, MessageBoxIcon.Information); Close();
        } catch (Exception ex) { MessageBox.Show(this, "卸载未完成：" + ex.Message, "雷鸟 iO 连接器", MessageBoxButtons.OK, MessageBoxIcon.Error); }
    }
}
internal static class UninstallerEntry {
    [STAThread] static void Main(string[] args) {
        if (args.Length == 2 && args[0] == "--run") {
            Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false); Application.Run(new UninstallForm(args[1]));
            try {
                var info = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe"), "/d /c ping -n 3 127.0.0.1 >nul & del /f /q \"%RAYNEO_UNINSTALL_TEMP%\"") { UseShellExecute = false, CreateNoWindow = true };
                info.EnvironmentVariables["RAYNEO_UNINSTALL_TEMP"] = Application.ExecutablePath; Process.Start(info);
            } catch { }
            return;
        }
        string root = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", ".."));
        string temp = Path.Combine(Path.GetTempPath(), "rayneo-uninstall-" + Guid.NewGuid().ToString("N") + ".exe");
        try { File.Copy(Application.ExecutablePath, temp); Process.Start(new ProcessStartInfo(temp, "--run \"" + root + "\"") { UseShellExecute = false }); }
        catch (Exception ex) { MessageBox.Show("无法启动卸载：" + ex.Message, "雷鸟 iO 连接器", MessageBoxButtons.OK, MessageBoxIcon.Error); }
    }
}
