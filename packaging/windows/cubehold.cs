// cubehold for Windows: a tray app that runs the panel (node server.mjs) hidden,
// restarts it if it crashes, and opens it in the browser.
//
// Written for the C# 5 compiler that ships with the .NET Framework in every
// Windows 10/11 (see packaging/build.ts), so no SDK is needed to build it and
// no runtime to install it.
//
// Minecraft servers run in the agent daemon, which the panel starts outside
// this app's process tree: quitting the app stops the panel, not the servers,
// unless the owner asks for that too.
//
// Command line:
//   cubehold.exe               start (or, if already running, open the panel)
//   cubehold.exe --background  start without opening the browser (sign-in autostart)
//   cubehold.exe --quit        close a running cubehold; servers keep running (installer updates)
//   cubehold.exe --uninstall   close cubehold, stop the servers and the agent (uninstaller)

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace Cubehold
{
    static class Program
    {
        public const string MutexName = @"Local\cubehold.Tray";
        public const string QuitEventName = @"Local\cubehold.Quit";

        [STAThread]
        static int Main(string[] args)
        {
            var list = new List<string>(args);
            if (list.Contains("--quit")) return Commands.Quit(false);
            if (list.Contains("--uninstall")) return Commands.Quit(true);

            bool background = list.Contains("--background");
            bool first;
            using (var mutex = new Mutex(true, MutexName, out first))
            {
                if (!first)
                {
                    // Already running: just show the panel.
                    if (!background) Shell.Open(Launcher.Load().Url);
                    return 0;
                }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new TrayContext(!background));
                GC.KeepAlive(mutex);
            }
            return 0;
        }
    }

    /// <summary>Where things are, and the panel's environment from launcher.env.</summary>
    sealed class Launcher
    {
        public string DataDir;
        public string AppDir;
        public string NodeExe;
        public string LogFile;
        public string Url;
        public readonly Dictionary<string, string> Env =
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        /// <summary>%LOCALAPPDATA%\cubehold\launcher.env: KEY=VALUE lines passed to the panel (PORT, HOST, DATA_DIR, ...).</summary>
        public static string EnvFile
        {
            get
            {
                return Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "cubehold", "launcher.env");
            }
        }

        public static Launcher Load()
        {
            var l = new Launcher();
            l.DataDir = Path.GetDirectoryName(EnvFile);
            try
            {
                if (File.Exists(EnvFile))
                {
                    foreach (var raw in File.ReadAllLines(EnvFile))
                    {
                        var line = raw.Trim();
                        if (line.Length == 0 || line.StartsWith("#")) continue;
                        int i = line.IndexOf('=');
                        if (i <= 0) continue;
                        l.Env[line.Substring(0, i).Trim()] = line.Substring(i + 1).Trim();
                    }
                }
            }
            catch (IOException) { }
            string value;
            if (l.Env.TryGetValue("DATA_DIR", out value) && value.Length > 0) l.DataDir = value;
            // The panel's default is the same folder; say it explicitly so both always agree.
            l.Env["DATA_DIR"] = l.DataDir;
            string port = l.Env.TryGetValue("PORT", out value) && value.Length > 0 ? value : "4000";
            string host = l.Env.TryGetValue("HOST", out value) && value.Length > 0 ? value : "127.0.0.1";
            if (host == "0.0.0.0" || host == "::") host = "127.0.0.1";
            l.Url = "http://" + (host.Contains(":") ? "[" + host + "]" : host) + ":" + port + "/";
            l.AppDir = NewestAppDir();
            l.NodeExe = l.AppDir == null ? null : Path.Combine(l.AppDir, @"node\node.exe");
            l.LogFile = Path.Combine(l.DataDir, @"logs\panel.log");
            return l;
        }

        public static string InstallDir
        {
            get { return Path.GetDirectoryName(Application.ExecutablePath); }
        }

        /// <summary>
        /// Each version lives in its own app-VERSION folder, so an update never
        /// replaces files an agent that still hosts servers is running from.
        /// </summary>
        public static string NewestAppDir()
        {
            string best = null;
            Version bestVersion = null;
            foreach (var dir in AppDirs())
            {
                var v = VersionOf(dir);
                if (v == null) continue;
                if (!File.Exists(Path.Combine(dir, "server.mjs"))) continue;
                if (!File.Exists(Path.Combine(dir, @"node\node.exe"))) continue;
                if (bestVersion == null || v > bestVersion)
                {
                    best = dir;
                    bestVersion = v;
                }
            }
            return best;
        }

        public static string[] AppDirs()
        {
            try { return Directory.GetDirectories(InstallDir, "app-*"); }
            catch (IOException) { return new string[0]; }
        }

        public static Version VersionOf(string dir)
        {
            var m = Regex.Match(Path.GetFileName(dir), @"^app-(\d+(\.\d+){1,3})");
            Version v;
            return m.Success && Version.TryParse(m.Groups[1].Value, out v) ? v : null;
        }

        public ProcessStartInfo NodeCommand(string arguments)
        {
            var psi = new ProcessStartInfo(NodeExe, arguments);
            psi.WorkingDirectory = AppDir;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            foreach (var kv in Env) psi.EnvironmentVariables[kv.Key] = kv.Value;
            return psi;
        }

        /// <summary>Run `server.mjs ARGS` and return its output, or null if it failed or timed out.</summary>
        public string RunCli(string arguments, int timeoutMs)
        {
            if (AppDir == null) return null;
            var psi = NodeCommand("server.mjs " + arguments);
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            try
            {
                using (var p = Process.Start(psi))
                {
                    var output = p.StandardOutput.ReadToEndAsync();
                    p.StandardError.ReadToEndAsync();
                    if (!p.WaitForExit(timeoutMs))
                    {
                        try { p.Kill(); } catch (InvalidOperationException) { }
                        return null;
                    }
                    return output.Result;
                }
            }
            catch (Exception)
            {
                return null;
            }
        }

        /// <summary>Servers the agent is running, from `agent status --json`; -1 if unknown.</summary>
        public int RunningServers()
        {
            var json = RunCli("agent status --json", 15000);
            if (json == null) return -1;
            var m = Regex.Match(json, "\"running\":\\[([^\\]]*)\\]");
            if (!m.Success) return -1;
            return Regex.Matches(m.Groups[1].Value, "\"[^\"]*\"").Count;
        }

        public bool AgentRunning
        {
            get { return File.Exists(Path.Combine(DataDir, "agent.json")); }
        }

        /// <summary>Ask the agent to stop every server gracefully and exit, then wait for it.</summary>
        public bool StopAgent(int timeoutMs)
        {
            if (!AgentRunning) return true;
            RunCli("agent stop", 30000);
            var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
            while (DateTime.UtcNow < deadline)
            {
                if (!AgentRunning) return true;
                Thread.Sleep(500);
            }
            return !AgentRunning;
        }
    }

    static class Shell
    {
        public static void Open(string target)
        {
            try { Process.Start(new ProcessStartInfo(target) { UseShellExecute = true }); }
            catch (Exception) { }
        }
    }

    static class Autostart
    {
        const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";

        public static bool Enabled
        {
            get
            {
                using (var key = Registry.CurrentUser.OpenSubKey(RunKey))
                {
                    return key != null && key.GetValue("cubehold") != null;
                }
            }
            set
            {
                using (var key = Registry.CurrentUser.CreateSubKey(RunKey))
                {
                    if (value) key.SetValue("cubehold", "\"" + Application.ExecutablePath + "\" --background");
                    else key.DeleteValue("cubehold", false);
                }
            }
        }
    }

    static class Commands
    {
        /// <summary>
        /// Close a running cubehold (installer updates). With stopServers (the
        /// uninstaller) also stop every server and the agent, and remove autostart.
        /// </summary>
        public static int Quit(bool stopServers)
        {
            EventWaitHandle quit;
            if (EventWaitHandle.TryOpenExisting(Program.QuitEventName, out quit))
            {
                quit.Set();
                quit.Dispose();
                // Wait for the tray to let go of its mutex.
                for (int i = 0; i < 100; i++)
                {
                    Mutex m;
                    if (!Mutex.TryOpenExisting(Program.MutexName, out m)) break;
                    m.Dispose();
                    Thread.Sleep(100);
                }
            }
            if (stopServers)
            {
                Launcher.Load().StopAgent(120000);
                try { Autostart.Enabled = false; } catch (Exception) { }
            }
            return 0;
        }
    }

    /// <summary>Kills the panel when this app goes away, however it goes away.</summary>
    sealed class Job : IDisposable
    {
        [StructLayout(LayoutKind.Sequential)]
        struct BasicLimits
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct IoCounters
        {
            public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
            public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct ExtendedLimits
        {
            public BasicLimits Basic;
            public IoCounters Io;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr CreateJobObject(IntPtr attributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, int size);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool CloseHandle(IntPtr handle);

        const int ExtendedLimitInformation = 9;
        const uint KillOnJobClose = 0x2000;

        IntPtr handle;

        public Job()
        {
            handle = CreateJobObject(IntPtr.Zero, null);
            var info = new ExtendedLimits();
            info.Basic.LimitFlags = KillOnJobClose;
            SetInformationJobObject(handle, ExtendedLimitInformation, ref info, Marshal.SizeOf(typeof(ExtendedLimits)));
        }

        public void Add(Process p)
        {
            if (handle != IntPtr.Zero) AssignProcessToJobObject(handle, p.Handle);
        }

        public void Dispose()
        {
            if (handle != IntPtr.Zero) CloseHandle(handle);
            handle = IntPtr.Zero;
        }
    }

    /// <summary>A never-shown window: it hears Windows sign-out, shutdown and the installer's close requests.</summary>
    sealed class SessionWindow : Form
    {
        const int WM_QUERYENDSESSION = 0x0011;
        const int WM_ENDSESSION = 0x0016;
        const long ENDSESSION_CLOSEAPP = 0x1;

        readonly TrayContext owner;

        public SessionWindow(TrayContext owner)
        {
            this.owner = owner;
            ShowInTaskbar = false;
            FormBorderStyle = FormBorderStyle.None;
            Opacity = 0;
            CreateHandle();
        }

        protected override void SetVisibleCore(bool value)
        {
            base.SetVisibleCore(false);
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_QUERYENDSESSION)
            {
                bool closeApp = (m.LParam.ToInt64() & ENDSESSION_CLOSEAPP) != 0;
                owner.OnSessionEnding(Handle, closeApp);
                m.Result = (IntPtr)1;
                return;
            }
            if (m.Msg == WM_ENDSESSION)
            {
                if (m.WParam != IntPtr.Zero) owner.OnSessionEnd(Handle);
                m.Result = IntPtr.Zero;
                return;
            }
            base.WndProc(ref m);
        }
    }

    sealed class TrayContext : ApplicationContext
    {
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern bool ShutdownBlockReasonCreate(IntPtr hwnd, string reason);

        [DllImport("user32.dll")]
        static extern bool ShutdownBlockReasonDestroy(IntPtr hwnd);

        static readonly int[] RestartDelays = { 2, 5, 15, 30, 60 };

        readonly NotifyIcon icon = new NotifyIcon();
        readonly ToolStripMenuItem autostartItem;
        readonly SessionWindow window;
        readonly Job job = new Job();
        readonly System.Windows.Forms.Timer health = new System.Windows.Forms.Timer();
        readonly System.Windows.Forms.Timer restartTimer = new System.Windows.Forms.Timer();
        readonly List<DateTime> crashes = new List<DateTime>();
        readonly Queue<string> lastLines = new Queue<string>();
        readonly object logLock = new object();
        readonly EventWaitHandle quitEvent;

        Launcher launcher;
        Process panel;
        StreamWriter log;
        bool openWhenReady;
        bool running;
        bool quitting;
        bool stoppingServers;

        public TrayContext(bool openBrowser)
        {
            openWhenReady = openBrowser;
            window = new SessionWindow(this);

            var menu = new ContextMenuStrip();
            var open = new ToolStripMenuItem("Open cubehold", null, delegate { OpenPanel(); });
            open.Font = new Font(open.Font, FontStyle.Bold);
            menu.Items.Add(open);
            menu.Items.Add(new ToolStripSeparator());
            autostartItem = new ToolStripMenuItem("Start when I sign in", null, delegate { ToggleAutostart(); });
            menu.Items.Add(autostartItem);
            menu.Items.Add(new ToolStripMenuItem("Open data folder", null, delegate { Shell.Open(launcher.DataDir); }));
            menu.Items.Add(new ToolStripMenuItem("Open log", null, delegate { Shell.Open(launcher.LogFile); }));
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(new ToolStripMenuItem("Restart panel", null, delegate { RestartPanel(); }));
            menu.Items.Add(new ToolStripMenuItem("Quit", null, delegate { AskAndQuit(); }));
            menu.Opening += delegate { autostartItem.Checked = SafeAutostart(); };

            icon.Icon = LoadIcon();
            icon.ContextMenuStrip = menu;
            icon.DoubleClick += delegate { OpenPanel(); };
            icon.BalloonTipClicked += delegate { if (!running) Shell.Open(launcher.LogFile); };
            SetStatus("cubehold is starting…");
            icon.Visible = true;

            health.Interval = 1000;
            health.Tick += delegate { CheckHealth(); };
            restartTimer.Tick += delegate
            {
                restartTimer.Stop();
                StartPanel();
            };

            // The installer and uninstaller ask a running copy to quit through this event.
            quitEvent = new EventWaitHandle(false, EventResetMode.AutoReset, Program.QuitEventName);
            var waiter = new Thread(delegate ()
            {
                if (quitEvent.WaitOne()) window.BeginInvoke(new Action(QuitNow));
            });
            waiter.IsBackground = true;
            waiter.Start();

            StartPanel();
        }

        static Icon LoadIcon()
        {
            using (var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("cubehold.ico"))
            {
                if (s != null) return new Icon(s, SystemInformation.SmallIconSize);
            }
            return Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        }

        void SetStatus(string text)
        {
            // NotifyIcon tooltips are limited to 63 characters.
            icon.Text = text.Length > 63 ? text.Substring(0, 63) : text;
        }

        void StartPanel()
        {
            if (quitting) return;
            launcher = Launcher.Load();
            if (launcher.AppDir == null)
            {
                SetStatus("cubehold cannot start");
                icon.ShowBalloonTip(10000, "cubehold cannot start", "Its program files are missing. Reinstall cubehold.", ToolTipIcon.Error);
                return;
            }
            OpenLog();
            var psi = launcher.NodeCommand("server.mjs");
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;
            var p = new Process();
            p.StartInfo = psi;
            p.EnableRaisingEvents = true;
            p.OutputDataReceived += (s, e) => WriteLog(e.Data);
            p.ErrorDataReceived += (s, e) => WriteLog(e.Data);
            p.Exited += delegate { window.BeginInvoke(new Action(() => OnPanelExit(p))); };
            try
            {
                p.Start();
            }
            catch (Exception err)
            {
                WriteLog("could not start the panel: " + err.Message);
                OnPanelExit(null);
                return;
            }
            job.Add(p);
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            panel = p;
            running = false;
            SetStatus("cubehold is starting…");
            health.Start();
        }

        void CheckHealth()
        {
            if (panel == null || running) return;
            var url = launcher.Url + "health";
            ThreadPool.QueueUserWorkItem(delegate
            {
                bool ok = false;
                try
                {
                    var req = (HttpWebRequest)WebRequest.Create(url);
                    req.Proxy = null;
                    req.Timeout = 1500;
                    using (var res = (HttpWebResponse)req.GetResponse())
                    {
                        ok = res.StatusCode == HttpStatusCode.OK;
                    }
                }
                catch (WebException) { }
                if (ok) window.BeginInvoke(new Action(OnPanelReady));
            });
        }

        void OnPanelReady()
        {
            if (running || panel == null) return;
            running = true;
            health.Stop();
            SetStatus("cubehold is running");
            // By now the panel has replaced an idle agent left in an older version's folder.
            CleanOldVersions();
            if (openWhenReady)
            {
                openWhenReady = false;
                Shell.Open(launcher.Url);
            }
        }

        void OnPanelExit(Process p)
        {
            if (p != null && p != panel) return;
            health.Stop();
            running = false;
            panel = null;
            if (quitting) return;
            int code = -1;
            try { if (p != null) code = p.ExitCode; } catch (InvalidOperationException) { }
            WriteLog("panel exited with code " + code);
            // 75: the panel asked to be restarted (for example to apply new settings).
            if (code == 75)
            {
                StartPanel();
                return;
            }
            var now = DateTime.UtcNow;
            crashes.Add(now);
            crashes.RemoveAll(t => now - t > TimeSpan.FromMinutes(10));
            if (crashes.Count >= 5)
            {
                SetStatus("cubehold stopped");
                icon.ShowBalloonTip(15000, "cubehold stopped", LastError() + "\nClick to open the log. \"Restart panel\" tries again.", ToolTipIcon.Error);
                return;
            }
            int delay = RestartDelays[Math.Min(crashes.Count - 1, RestartDelays.Length - 1)];
            SetStatus("cubehold stopped; restarting in " + delay + " s");
            restartTimer.Interval = delay * 1000;
            restartTimer.Start();
        }

        string LastError()
        {
            lock (logLock)
            {
                foreach (var line in lastLines)
                {
                    if (line.Contains("EADDRINUSE"))
                        return "Port " + PortOf(launcher.Url) + " is used by another program. Set PORT in " + Launcher.EnvFile + ".";
                }
                var arr = lastLines.ToArray();
                for (int i = arr.Length - 1; i >= 0; i--)
                {
                    if (arr[i].Trim().Length > 0 && !arr[i].StartsWith("panel exited")) return arr[i].Trim();
                }
            }
            return "The panel keeps stopping.";
        }

        static string PortOf(string url)
        {
            var m = Regex.Match(url, @":(\d+)/");
            return m.Success ? m.Groups[1].Value : "4000";
        }

        void OpenPanel()
        {
            if (running) Shell.Open(launcher.Url);
            else if (panel != null) openWhenReady = true;
            else
            {
                openWhenReady = true;
                RestartPanel();
            }
        }

        void RestartPanel()
        {
            restartTimer.Stop();
            crashes.Clear();
            StopPanel();
            StartPanel();
        }

        void StopPanel()
        {
            var p = panel;
            panel = null;
            running = false;
            health.Stop();
            if (p == null) return;
            try
            {
                if (!p.HasExited)
                {
                    p.Kill();
                    p.WaitForExit(5000);
                }
            }
            catch (Exception) { }
        }

        void ToggleAutostart()
        {
            try { Autostart.Enabled = !SafeAutostart(); }
            catch (Exception err)
            {
                MessageBox.Show("Could not change the sign-in setting: " + err.Message, "cubehold", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        static bool SafeAutostart()
        {
            try { return Autostart.Enabled; }
            catch (Exception) { return false; }
        }

        void AskAndQuit()
        {
            if (stoppingServers) return;
            int count = launcher.RunningServers();
            if (count > 0)
            {
                var answer = MessageBox.Show(
                    (count == 1 ? "A Minecraft server is" : count + " Minecraft servers are") +
                    " running.\n\nYes: save the worlds and stop " + (count == 1 ? "it" : "them") + ", then quit.\n" +
                    "No: keep " + (count == 1 ? "it" : "them") + " running and quit. Players stay connected, but backups, " +
                    "schedules and cloud power-down wait until cubehold runs again.",
                    "Quit cubehold",
                    MessageBoxButtons.YesNoCancel,
                    MessageBoxIcon.Question,
                    MessageBoxDefaultButton.Button1);
                if (answer == DialogResult.Cancel) return;
                if (answer == DialogResult.Yes)
                {
                    stoppingServers = true;
                    SetStatus("Saving worlds and stopping servers…");
                    icon.ShowBalloonTip(5000, "cubehold", "Saving worlds and stopping servers…", ToolTipIcon.Info);
                    var l = launcher;
                    ThreadPool.QueueUserWorkItem(delegate
                    {
                        l.StopAgent(180000);
                        window.BeginInvoke(new Action(QuitNow));
                    });
                    return;
                }
            }
            QuitNow();
        }

        void QuitNow()
        {
            if (quitting) return;
            quitting = true;
            restartTimer.Stop();
            StopPanel();
            icon.Visible = false;
            icon.Dispose();
            job.Dispose();
            CloseLog();
            ExitThread();
        }

        /// <summary>
        /// Windows is signing out or shutting down: save the worlds first. The
        /// installer closing this app (closeApp) only needs the panel gone.
        /// </summary>
        public void OnSessionEnding(IntPtr hwnd, bool closeApp)
        {
            if (closeApp || stoppingServers || !launcher.AgentRunning) return;
            stoppingServers = true;
            ShutdownBlockReasonCreate(hwnd, "Saving Minecraft worlds and stopping servers…");
            var l = launcher;
            ThreadPool.QueueUserWorkItem(delegate { l.RunCli("agent stop", 30000); });
        }

        public void OnSessionEnd(IntPtr hwnd)
        {
            if (stoppingServers)
            {
                // Windows shows the reason above while this waits.
                var deadline = DateTime.UtcNow.AddSeconds(90);
                while (launcher.AgentRunning && DateTime.UtcNow < deadline) Thread.Sleep(250);
                ShutdownBlockReasonDestroy(hwnd);
            }
            QuitNow();
        }

        /// <summary>Remove older app-VERSION folders once no agent runs from them.</summary>
        void CleanOldVersions()
        {
            var current = launcher.AppDir;
            ThreadPool.QueueUserWorkItem(delegate
            {
                foreach (var dir in Launcher.AppDirs())
                {
                    if (string.Equals(dir, current, StringComparison.OrdinalIgnoreCase)) continue;
                    var v = Launcher.VersionOf(dir);
                    var cv = Launcher.VersionOf(current);
                    if (v == null || cv == null || v >= cv) continue;
                    if (InUse(dir)) continue;
                    try { Directory.Delete(dir, true); }
                    catch (Exception) { }
                }
            });
        }

        static bool InUse(string dir)
        {
            var prefix = Path.GetFullPath(dir).TrimEnd('\\') + "\\";
            foreach (var p in Process.GetProcessesByName("node"))
            {
                try
                {
                    if (p.MainModule.FileName.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return true;
                }
                catch (Exception) { }
                finally { p.Dispose(); }
            }
            return false;
        }

        void OpenLog()
        {
            lock (logLock)
            {
                if (log != null) return;
                try
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(launcher.LogFile));
                    var info = new FileInfo(launcher.LogFile);
                    if (info.Exists && info.Length > 5 * 1024 * 1024)
                    {
                        var old = launcher.LogFile + ".1";
                        if (File.Exists(old)) File.Delete(old);
                        File.Move(launcher.LogFile, old);
                    }
                    var stream = new FileStream(launcher.LogFile, FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete);
                    log = new StreamWriter(stream, new UTF8Encoding(false));
                    log.AutoFlush = true;
                }
                catch (Exception)
                {
                    log = null;
                }
            }
        }

        void WriteLog(string line)
        {
            if (line == null) return;
            lock (logLock)
            {
                lastLines.Enqueue(line);
                while (lastLines.Count > 30) lastLines.Dequeue();
                if (log == null) return;
                try { log.WriteLine(line); }
                catch (Exception) { }
            }
        }

        void CloseLog()
        {
            lock (logLock)
            {
                if (log != null) log.Dispose();
                log = null;
            }
        }
    }
}
