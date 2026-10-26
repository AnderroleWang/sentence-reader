using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("Sentence Reader")]
[assembly: AssemblyProduct("Sentence Reader")]
[assembly: AssemblyVersion("0.4.6.0")]
[assembly: AssemblyFileVersion("0.4.6.0")]

internal static class Launcher
{
    internal const string Name = "\u53e5\u8bfb";
    internal static readonly string Root = AppDomain.CurrentDomain.BaseDirectory;

    [STAThread]
    private static int Main(string[] args)
    {
        Application.EnableVisualStyles();
        int port = 8765;
        bool noOpen = Array.IndexOf(args, "--no-open") >= 0;
        foreach (string arg in args)
            if (arg.StartsWith("--port=", StringComparison.Ordinal) &&
                (!int.TryParse(arg.Substring(7), out port) || port < 1024 || port > 65515)) return 2;
        try
        {
            if (Array.IndexOf(args, "--install-shortcuts-only") >= 0) { InstallShortcuts(); return 0; }
            string instance = "Local\\SentenceReader.Launcher." + port;
            if (Array.IndexOf(args, "--quit") >= 0)
            {
                try { using (var stop = EventWaitHandle.OpenExisting(instance + ".Stop")) stop.Set(); }
                catch (WaitHandleCannotBeOpenedException) { }
                return 0;
            }
            bool created;
            using (var mutex = new Mutex(true, instance, out created))
            {
                if (!created)
                {
                    if (!noOpen) Open(FindServer(port) ?? "http://127.0.0.1:" + port + "/");
                    return 0;
                }
                using (var stop = new EventWaitHandle(false, EventResetMode.AutoReset, instance + ".Stop"))
                using (var context = new ReaderContext(port, noOpen, Array.IndexOf(args, "--no-shortcuts") < 0, stop)) Application.Run(context);
                mutex.ReleaseMutex();
            }
            return 0;
        }
        catch (Exception)
        {
            MessageBox.Show("\u542f\u52a8\u5931\u8d25\u3002\u8bf7\u5148\u5b8c\u6574\u89e3\u538b Windows \u4fbf\u643a\u5305\uff0c\u518d\u8fd0\u884c\u53e5\u8bfb.exe\u3002\n\u53ef\u7528 start.cmd \u67e5\u770b\u8be6\u7ec6\u9519\u8bef\u3002", Name, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    internal static string FindServer(int port)
    {
        for (int p = port; p < port + 20; p++)
        {
            string url = "http://127.0.0.1:" + p + "/";
            try
            {
                var request = (HttpWebRequest)WebRequest.Create(url + "api/health");
                request.Proxy = null; request.Timeout = 300; request.ReadWriteTimeout = 300;
                using (var response = request.GetResponse())
                using (var reader = new StreamReader(response.GetResponseStream()))
                {
                    char[] buffer = new char[2048]; int size = reader.ReadBlock(buffer, 0, buffer.Length);
                    if (Regex.IsMatch(new string(buffer, 0, size), "\"app\"\\s*:\\s*\"sentence-reader\"")) return url;
                }
            }
            catch (WebException) { }
        }
        return null;
    }

    internal static void Open(string url)
    {
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
        catch (System.ComponentModel.Win32Exception)
        {
            MessageBox.Show("\u8bf7\u5728\u6d4f\u89c8\u5668\u4e2d\u6253\u5f00\uff1a\n" + url, Name, MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
    }

    internal static void InstallShortcuts()
    {
        string programs = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Sentence Reader");
        Directory.CreateDirectory(programs);
        object shellObject = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
        try
        {
            dynamic shell = shellObject;
            foreach (string folder in new[] { Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), programs })
            {
                object linkObject = shell.CreateShortcut(Path.Combine(folder, Name + ".lnk"));
                try
                {
                    dynamic link = linkObject;
                    link.TargetPath = Application.ExecutablePath; link.Arguments = "";
                    link.WorkingDirectory = Root; link.IconLocation = Application.ExecutablePath + ",0";
                    link.Description = Name + " - Sentence Reader"; link.Save();
                }
                finally { Marshal.FinalReleaseComObject(linkObject); }
            }
        }
        finally { Marshal.FinalReleaseComObject(shellObject); }
    }
}

internal sealed class ReaderContext : ApplicationContext
{
    private readonly NotifyIcon icon;
    private readonly System.Windows.Forms.Timer timer;
    private readonly EventWaitHandle stop;
    private Process server;
    private string url;

    internal ReaderContext(int port, bool noOpen, bool createShortcuts, EventWaitHandle stopEvent)
    {
        stop = stopEvent;
        url = Launcher.FindServer(port);
        if (url == null)
        {
            string python = Path.Combine(Launcher.Root, "runtime", "pythonw.exe");
            if (!File.Exists(python) || !File.Exists(Path.Combine(Launcher.Root, "server.py"))) throw new FileNotFoundException();
            server = Process.Start(new ProcessStartInfo(python, "-X utf8 server.py --no-open --port " + port)
            {
                WorkingDirectory = Launcher.Root, UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardOutput = true, RedirectStandardError = true
            });
            server.OutputDataReceived += delegate { }; server.ErrorDataReceived += delegate { };
            server.BeginOutputReadLine(); server.BeginErrorReadLine();
            var deadline = DateTime.UtcNow.AddSeconds(12);
            while (url == null && !server.HasExited && DateTime.UtcNow < deadline)
            {
                Thread.Sleep(150); url = Launcher.FindServer(port);
            }
            if (url == null)
            {
                if (!server.HasExited) server.Kill();
                server.Dispose(); server = null; throw new InvalidOperationException();
            }
        }
        if (createShortcuts) { try { Launcher.InstallShortcuts(); } catch { } }
        var menu = new ContextMenuStrip();
        menu.Items.Add("\u6253\u5f00\u9605\u8bfb\u5668", null, delegate { Launcher.Open(url); });
        menu.Items.Add("\u521b\u5efa\u684c\u9762\u5feb\u6377\u65b9\u5f0f", null, delegate { Launcher.InstallShortcuts(); });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("\u9000\u51fa\u53e5\u8bfb", null, delegate
        {
            if (server == null || MessageBox.Show("\u8bf7\u786e\u8ba4\u5df2\u7ed3\u675f\u7ffb\u8bd1\u3002\u73b0\u5728\u5173\u95ed\u672c\u673a\u670d\u52a1\uff1f\n\u5df2\u4fdd\u5b58\u7684\u8bba\u6587\u548c\u7b14\u8bb0\u4f1a\u4fdd\u7559\u3002", Launcher.Name, MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes) ExitThread();
        });
        icon = new NotifyIcon { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath), Text = Launcher.Name + " - Sentence Reader", ContextMenuStrip = menu, Visible = true };
        icon.DoubleClick += delegate { Launcher.Open(url); };
        timer = new System.Windows.Forms.Timer { Interval = 400 };
        timer.Tick += delegate { if (stop.WaitOne(0)) ExitThread(); };
        timer.Start();
        if (!noOpen) Launcher.Open(url);
    }

    protected override void ExitThreadCore()
    {
        timer.Stop();
        icon.Visible = false;
        if (server != null && !server.HasExited) { server.Kill(); server.WaitForExit(3000); }
        base.ExitThreadCore();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) { if (timer != null) timer.Dispose(); if (icon != null) icon.Dispose(); if (server != null) server.Dispose(); }
        base.Dispose(disposing);
    }
}
