using System;
using System.Collections;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.Principal;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

internal static class TrayLogic {
    internal static bool StopTree(int pid) {
        if (pid <= 0) return false;
        try {
            string taskkill = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "taskkill.exe");
            using (var process = Process.Start(new ProcessStartInfo(taskkill, "/PID " + pid + " /T /F") {
                UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden })) {
                return process != null && process.WaitForExit(10000) && process.ExitCode == 0;
            }
        } catch { return false; }
    }
    internal static int PreferredPort(int preferred) {
        var listener = new TcpListener(IPAddress.Loopback, preferred);
        try { listener.ExclusiveAddressUse = true; listener.Start(); return preferred; }
        catch (SocketException) { return FreePort(); }
        finally { listener.Stop(); }
    }
    internal static int FreePort() {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        try { listener.Start(); return ((IPEndPoint)listener.LocalEndpoint).Port; }
        finally { listener.Stop(); }
    }
    [DllImport("iphlpapi.dll", SetLastError = true)]
    static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool order, int family, int kind, int reserved);
    [StructLayout(LayoutKind.Sequential)]
    struct TcpRow { internal uint state, localAddress, localPort, remoteAddress, remotePort, owner; }
    internal static bool OwnsPort(int port, int pid) {
        if (port < 1 || port > 65535 || pid < 1) return false;
        int size = 0; GetExtendedTcpTable(IntPtr.Zero, ref size, false, 2, 3, 0);
        if (size < 4 || size > 16 * 1024 * 1024) return false;
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try {
            if (GetExtendedTcpTable(buffer, ref size, false, 2, 3, 0) != 0) return false;
            int count = Marshal.ReadInt32(buffer), rowSize = Marshal.SizeOf(typeof(TcpRow));
            if (count < 0 || count > (size - 4) / rowSize) return false;
            for (int i = 0; i < count; i++) {
                var row = (TcpRow)Marshal.PtrToStructure(IntPtr.Add(buffer, 4 + i * rowSize), typeof(TcpRow));
                int value = (int)(((row.localPort & 255) << 8) | ((row.localPort >> 8) & 255));
                if (value == port && row.owner == (uint)pid) return true;
            }
        } catch { } finally { Marshal.FreeHGlobal(buffer); }
        return false;
    }
    internal static string StartupCommand(string path) { return "\"" + path + "\" --background"; }
    internal static bool CanUseStartup(object current, string expected) { return current == null || current is string && (string)current == expected; }
    internal static string Status(string text) {
        try {
            var data = new JavaScriptSerializer().DeserializeObject(text) as System.Collections.Generic.Dictionary<string, object>;
            if (data == null) return "unavailable";
            object phase; if (!data.TryGetValue("phase", out phase)) return "unavailable";
            if ((string)phase == "new" || (string)phase == "prepared" || (string)phase == "incomplete") return "setup";
            object mode, encryption, error, values;
            if ((string)phase != "configured" || !data.TryGetValue("connectionMode", out mode) || (string)mode != "secure"
                || !data.TryGetValue("encryption", out encryption) || (string)encryption != "verified"
                || data.TryGetValue("secureError", out error) && error != null
                || !data.TryGetValue("connections", out values)) return "unavailable";
            bool any = false;
            foreach (object value in (IEnumerable)values) {
                var item = value as System.Collections.Generic.Dictionary<string, object>; object ready;
                if (item == null || !item.TryGetValue("ready", out ready) || !(ready is bool)) return "unavailable";
                if ((bool)ready) any = true;
            }
            if (any) return "ready";
        } catch { }
        return "unavailable";
    }
}

internal sealed class TrayApplication : ApplicationContext {
    const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    const string SettingsKey = @"Software\RayneoPaseo\Connector";
    const string StartupName = "RayneoPaseoConnector";
    readonly int port;
    readonly string page;
    readonly EventWaitHandle openRequested;
    readonly NotifyIcon icon;
    readonly ToolStripMenuItem startup;
    readonly System.Windows.Forms.Timer timer;
    readonly Process connector;
    bool checking;
    bool hasStarted;
    readonly bool background;
    readonly string executable;
    readonly Icon startingIcon = CreateGlassesIcon(Color.Gray, "");
    readonly Icon readyIcon = CreateGlassesIcon(Color.ForestGreen, "✓");
    readonly Icon warningIcon = CreateGlassesIcon(Color.DarkOrange, "!");
    readonly Icon errorIcon = CreateGlassesIcon(Color.Firebrick, "×");

    [DllImport("user32.dll", CharSet = CharSet.Auto)] static extern bool DestroyIcon(IntPtr handle);
    static Icon CreateGlassesIcon(Color color, string marker) {
        using (var bitmap = new Bitmap(32, 32)) using (var graphics = Graphics.FromImage(bitmap)) {
            graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            graphics.Clear(Color.Transparent);
            using (var pen = new Pen(Color.FromArgb(25, 92, 94), 3)) {
                graphics.DrawEllipse(pen, 1, 8, 12, 10); graphics.DrawEllipse(pen, 17, 8, 12, 10);
                graphics.DrawLine(pen, 13, 12, 17, 12);
            }
            using (var brush = new SolidBrush(color)) graphics.FillEllipse(brush, 18, 17, 13, 13);
            if (!String.IsNullOrEmpty(marker)) using (var font = new Font("Segoe UI Symbol", 9, FontStyle.Bold, GraphicsUnit.Pixel)) {
                var format = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
                graphics.DrawString(marker, font, Brushes.White, new RectangleF(18, 17, 13, 13), format); format.Dispose();
            }
            IntPtr handle = bitmap.GetHicon();
            try { using (var temporary = Icon.FromHandle(handle)) return (Icon)temporary.Clone(); }
            finally { DestroyIcon(handle); }
        }
    }

    internal TrayApplication(bool runInBackground, EventWaitHandle openSignal) {
        background = runInBackground; executable = Application.ExecutablePath;
        openRequested = openSignal; port = TrayLogic.PreferredPort(38649); page = "http://127.0.0.1:" + port + "/";
        startup = new ToolStripMenuItem("开机后自动启动") { CheckOnClick = false };
        startup.Click += delegate { SetStartup(!startup.Checked); };
        var menu = new ContextMenuStrip();
        menu.Items.Add("打开连接页面", null, delegate { OpenPage(); });
        menu.Items.Add(startup);
        menu.Items.Add("退出连接器", null, delegate { ExitThread(); });
        icon = new NotifyIcon { Icon = startingIcon, Text = "眼镜连接器：正在启动", Visible = true, ContextMenuStrip = menu };
        icon.MouseClick += delegate(object sender, MouseEventArgs e) { if (e.Button == MouseButtons.Left) OpenPage(); };
#if !RAYNEO_TRAY_TEST
        ConfigureStartup();
#endif
        string root = AppDomain.CurrentDomain.BaseDirectory;
        var info = new ProcessStartInfo(Path.Combine(root, "runtime", "node.exe"),
            "\"" + Path.Combine(root, "app", "distribution", "launch.mjs") + "\" --no-open --auto-connect --port " + port) {
            WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden };
        try { connector = Process.Start(info); } catch { icon.Text = "眼镜连接器：无法启动"; }
        timer = new System.Windows.Forms.Timer { Interval = 2500 };
        timer.Tick += delegate { Check(); }; timer.Start();
    }
    void ConfigureStartup() {
        try {
            using (var settings = Registry.CurrentUser.CreateSubKey(SettingsKey)) {
                if (settings.GetValue("startupConfigured") == null) {
                    using (var run = Registry.CurrentUser.CreateSubKey(RunKey)) {
                        string command = TrayLogic.StartupCommand(executable);
                        if (!TrayLogic.CanUseStartup(run.GetValue(StartupName), command)) throw new InvalidOperationException();
                        run.SetValue(StartupName, command);
                    }
                    settings.SetValue("startupConfigured", 1, RegistryValueKind.DWord);
                }
            }
            using (var run = Registry.CurrentUser.OpenSubKey(RunKey)) startup.Checked = run != null && (run.GetValue(StartupName) as string) == TrayLogic.StartupCommand(executable);
        } catch { startup.Checked = false; }
    }
    void SetStartup(bool enabled) {
        try {
            using (var run = Registry.CurrentUser.CreateSubKey(RunKey)) {
                if (enabled) {
                    string command = TrayLogic.StartupCommand(executable);
                    if (!TrayLogic.CanUseStartup(run.GetValue(StartupName), command)) throw new InvalidOperationException();
                    run.SetValue(StartupName, command);
                }
                else if ((run.GetValue(StartupName) as string) == TrayLogic.StartupCommand(executable)) run.DeleteValue(StartupName, false);
            }
            startup.Checked = enabled;
        } catch { icon.ShowBalloonTip(5000, "眼镜连接器", "无法更改自动启动设置，请检查电脑权限。", ToolTipIcon.Warning); }
    }
    void OpenPage() {
        if (connector == null || connector.HasExited || !TrayLogic.OwnsPort(port, connector.Id)) {
            icon.ShowBalloonTip(5000, "眼镜连接器", "连接页面无法启动，请检查是否已有其他连接器。", ToolTipIcon.Warning); return;
        }
        try { Process.Start(new ProcessStartInfo(page) { UseShellExecute = true }); } catch { }
    }
    void Check() {
        if (openRequested.WaitOne(0)) OpenPage();
        if (connector == null || connector.HasExited) { icon.Icon = errorIcon; icon.Text = "眼镜连接器：无法启动"; return; }
        if (!TrayLogic.OwnsPort(port, connector.Id)) { icon.Icon = startingIcon; icon.Text = "眼镜连接器：正在启动"; return; }
        if (checking) return;
        checking = true;
        var client = new WebClient();
        client.DownloadStringCompleted += delegate(object sender, DownloadStringCompletedEventArgs e) {
            checking = false; client.Dispose();
            if (!icon.Visible) return;
            string state = e.Error != null || e.Cancelled ? "unavailable" : TrayLogic.Status(e.Result);
            icon.Icon = state == "ready" ? readyIcon : warningIcon;
            icon.Text = state == "ready" ? "眼镜连接器：至少一个渠道可用" : state == "setup" ? "眼镜连接器：请完成连接" : "眼镜连接器：连接未就绪";
            if (!hasStarted && e.Error == null && !e.Cancelled) { hasStarted = true; if (!background) OpenPage(); }
        };
        try { client.DownloadStringAsync(new Uri(page + "api/status")); } catch { checking = false; client.Dispose(); }
    }
    protected override void ExitThreadCore() {
        timer.Stop(); icon.Visible = false; icon.Dispose();
        startingIcon.Dispose(); readyIcon.Dispose(); warningIcon.Dispose(); errorIcon.Dispose();
        try { if (connector != null && !connector.HasExited && !TrayLogic.StopTree(connector.Id)) connector.Kill(); } catch { }
        base.ExitThreadCore();
    }
}

internal static class TrayEntry {
    [STAThread] static void Main(string[] args) {
        string sid = WindowsIdentity.GetCurrent().User.Value;
        string suffix = sid;
#if RAYNEO_TRAY_TEST
        suffix += "-Test";
#endif
        string signalName = @"Local\RayneoPaseoConnectorOpen-" + suffix;
        bool first;
        using (var mutex = new Mutex(true, @"Local\RayneoPaseoConnector-" + suffix, out first)) {
            if (!first) {
                if (Array.IndexOf(args, "--background") < 0) try { using (var signal = EventWaitHandle.OpenExisting(signalName)) signal.Set(); } catch { }
                return;
            }
            bool created;
            using (var signal = new EventWaitHandle(false, EventResetMode.AutoReset, signalName, out created)) {
            Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new TrayApplication(Array.IndexOf(args, "--background") >= 0, signal));
            }
        }
    }
}
