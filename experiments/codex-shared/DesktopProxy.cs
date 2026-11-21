using System;
using System.Diagnostics;
using System.Text;
using System.Threading.Tasks;
using System.IO;

// A private launch-time override only. Does not patch or replace the installed Codex binary.
class DesktopProxy {
    static async Task Pump(Stream source, Stream target, bool close) {
        try {
            var bytes = new byte[8192]; int count;
            while ((count = await source.ReadAsync(bytes, 0, bytes.Length)) > 0) {
                await target.WriteAsync(bytes, 0, count);
                await target.FlushAsync();
            }
        } catch (IOException) {} finally { if (close) { try { target.Close(); } catch {} } }
    }
    static string Quote(string value) {
        var result = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { result.Append('\\', slashes * 2 + 1); result.Append(c); }
            else { result.Append('\\', slashes); result.Append(c); }
            slashes = 0;
        }
        result.Append('\\', slashes * 2); return result.Append('"').ToString();
    }
    static int Main(string[] args) {
        try {
            string node = Environment.GetEnvironmentVariable("RAYNEO_SHARED_NODE");
            string entry = Environment.GetEnvironmentVariable("RAYNEO_SHARED_ENTRY");
            if (String.IsNullOrEmpty(node) || String.IsNullOrEmpty(entry)) return 2;
            var command = new StringBuilder(Quote(entry));
            foreach (string arg in args) command.Append(" ").Append(Quote(arg));
            using (var process = Process.Start(new ProcessStartInfo(node, command.ToString()) {
                UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true })) {
                var input = Pump(Console.OpenStandardInput(), process.StandardInput.BaseStream, true);
                var output = Pump(process.StandardOutput.BaseStream, Console.OpenStandardOutput(), false);
                var error = Pump(process.StandardError.BaseStream, Console.OpenStandardError(), false);
                process.WaitForExit(); Task.WaitAll(output, error); return process.ExitCode;
            }
        } catch { return 1; }
    }
}
