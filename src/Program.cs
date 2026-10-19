namespace Tint;

static class Program
{
    [STAThread]
    static void Main(string[] args)
    {
        // One window per user: a second launch just brings the first one forward.
        using var mutex = new Mutex(true, @"Local\Tint.SingleInstance", out bool first);
        using var wake = new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\Tint.Wake");
        if (!first)
        {
            wake.Set();
            return;
        }

        ApplicationConfiguration.Initialize();
        var form = new MainForm(dev: args.Contains("--dev"));

        var waker = new Thread(() =>
        {
            while (wake.WaitOne())
            {
                if (form.IsDisposed) break;
                try { form.BeginInvoke(form.BringForward); }
                catch { break; }
            }
        })
        { IsBackground = true, Name = "Tint.Wake" };
        waker.Start();

        Application.Run(form);
    }
}

static class Paths
{
    public static readonly string Data = Directory.CreateDirectory(
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Tint")).FullName;

    public static readonly string Art = Directory.CreateDirectory(Path.Combine(Data, "art")).FullName;
    public static readonly string WebViewData = Path.Combine(Data, "WebView2");
    public static readonly string SettingsFile = Path.Combine(Data, "settings.json");
    public static readonly string LibraryFile = Path.Combine(Data, "library.json");

    /// <summary>The folder the UI is served from. In dev mode this is the source tree, so edits show up on reload.</summary>
    public static string WebRoot(bool dev)
    {
        if (dev)
        {
            for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir != null; dir = dir.Parent)
            {
                if (File.Exists(Path.Combine(dir.FullName, "Tint.csproj")))
                    return Path.Combine(dir.FullName, "wwwroot");
            }
        }
        return Path.Combine(AppContext.BaseDirectory, "wwwroot");
    }
}
