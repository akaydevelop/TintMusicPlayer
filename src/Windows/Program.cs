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
