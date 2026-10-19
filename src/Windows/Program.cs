namespace Tint;

static class Program
{
    [STAThread]
    static void Main(string[] args)
    {
        Updater.AfterRestart(args);

        // One window per user (per data folder, so a copy tried out with TINT_DATA can run beside
        // it): a second launch just brings the first one forward.
        var name = Environment.GetEnvironmentVariable("TINT_DATA") is { Length: > 0 }
            ? "Tint." + Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(Paths.Data.ToLowerInvariant())))[..16]
            : "Tint";
        using var mutex = new Mutex(true, $@"Local\{name}.SingleInstance", out bool first);
        using var wake = new EventWaitHandle(false, EventResetMode.AutoReset, $@"Local\{name}.Wake");
        if (!first)
        {
            wake.Set();
            return;
        }

        ApplicationConfiguration.Initialize();
        bool dev = args.Contains("--dev");
        var updater = new Updater(dev);
        var form = new MainForm(dev, updater);

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
        updater.Relaunch();
    }
}
