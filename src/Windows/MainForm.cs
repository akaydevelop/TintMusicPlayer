using System.Runtime.InteropServices;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Tint;

/// <summary>The window: a native frame, tinted to match the page, around a single WebView2.</summary>
sealed class MainForm : Form, IHost
{
    static readonly Color IdleBackground = Color.FromArgb(0x14, 0x26, 0x2B);
    static readonly Color IdleText = Color.FromArgb(0xED, 0xF2, 0xEF);

    readonly bool _dev;
    readonly Settings _settings;
    readonly Library _library;
    readonly LocalServer _server;
    readonly DiscordPresence _discord;
    readonly YouTube _youtube = new();
    readonly TaskbarButtons _taskbar = new();
    readonly WebView2 _web;
    SystemMedia? _media;
    YouTubePage? _youtubePage;
    long _nowPlayingAt;
    bool _playing;
    PageBridge? _bridge;
    CoreWebView2Environment? _environment;

    // Title bar colour animation, kept in step with the page's own colour transition.
    readonly System.Windows.Forms.Timer _chromeTimer = new() { Interval = 16 };
    Color _bgFrom, _bgTo, _fgFrom, _fgTo, _bgNow = IdleBackground, _fgNow = IdleText;
    long _chromeStart;
    const int ChromeMs = 900;

    bool _mini;
    Rectangle _fullBounds;
    bool _fullMaximized;

    public MainForm(bool dev, Updater updater)
    {
        _dev = dev;
        _settings = Settings.Load();
        _library = new Library(_settings);

        Text = "Tint";
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        BackColor = IdleBackground;
        AutoScaleMode = AutoScaleMode.Dpi;
        StartPosition = FormStartPosition.Manual;
        // The page has a layout for every size down to this: a low window becomes a strip of controls.
        MinimumSize = Scale(new Size(340, 300));
        RestoreBounds_();

        _web = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = IdleBackground };
        Controls.Add(_web);

        _discord = new DiscordPresence(_settings, _library.Covers);
        _server = new LocalServer(this, _settings, _library, new AppleToken(_settings), _discord, _youtube, updater, Paths.WebRoot(dev));
        _chromeTimer.Tick += (_, _) => StepChrome();
    }

    protected override async void OnLoad(EventArgs e)
    {
        base.OnLoad(e);
        ApplyChrome(_bgNow, _fgNow);
        _media = new SystemMedia(Handle, Command);
        try
        {
            _server.Start();
            _library.Start();

            // Songs follow one another without a click in between, so playback can't wait for a user gesture.
            // The media keys are answered by this window (SystemMedia), which knows the whole queue. The
            // browser would otherwise answer them too, for whichever single song it happens to be playing.
            var flags = "--autoplay-policy=no-user-gesture-required --disable-features=HardwareMediaKeyHandling";
            // Dev mode exposes the page to DevTools-protocol tooling on loopback, for scripted checks.
            if (_dev) flags += " --remote-debugging-port=9229";
            var options = new CoreWebView2EnvironmentOptions(flags);
            var environment = await CoreWebView2Environment.CreateAsync(null, Paths.WebViewData, options);
            await _web.EnsureCoreWebView2Async(environment);

            var core = _web.CoreWebView2;
            var s = core.Settings;
            s.IsStatusBarEnabled = false;
            s.IsZoomControlEnabled = false;
            s.IsSwipeNavigationEnabled = false;
            s.IsPasswordAutosaveEnabled = false;
            s.IsGeneralAutofillEnabled = false;
            s.AreDevToolsEnabled = _dev;
            s.AreDefaultContextMenusEnabled = _dev;
            s.AreBrowserAcceleratorKeysEnabled = _dev;

            core.DocumentTitleChanged += (_, _) => Text = string.IsNullOrWhiteSpace(core.DocumentTitle) ? "Tint" : core.DocumentTitle;
            // The main frame only ever shows the app itself. Apple's sign-in opens in its own popup window.
            core.NavigationStarting += (_, args) =>
            {
                if (!args.Uri.StartsWith(PageBridge.Base, StringComparison.OrdinalIgnoreCase)) args.Cancel = true;
            };

            _environment = environment;
            // The browser starts its audio process with the first sound, and starts a new one if that one stops.
            environment.ProcessInfosChanged += (_, _) => { if (_playing) NameInMixer(); };
            // Tint's page works the hidden YouTube Music page by messages; this is the way there.
            core.WebMessageReceived += (_, args) =>
            {
                if (args.Source.StartsWith(PageBridge.Base, StringComparison.OrdinalIgnoreCase)) _youtubePage?.Tell(args.WebMessageAsJson);
            };
            core.NewWindowRequested += OnNewWindowRequested;
            _bridge = new PageBridge(core, environment, _server, _library);
            core.Navigate(PageBridge.Base);
        }
        catch (Exception ex)
        {
            MessageBox.Show(this,
                "Tint couldn't start its player view.\n\n" + ex.Message +
                "\n\nTint needs the Microsoft Edge WebView2 Runtime, which ships with Windows 11. Reinstalling it from Microsoft usually fixes this.",
                "Tint", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
        }
    }

    // ---- Apple's sign-in window -------------------------------------------------------------------

    static bool IsApple(string? address) =>
        Uri.TryCreate(address, UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps &&
        (uri.Host == "apple.com" || uri.Host.EndsWith(".apple.com", StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// The page may open one kind of window: Apple's sign-in. It is hosted in a window that belongs
    /// to this one, so it closes with the app instead of lingering as a stray browser window.
    /// </summary>
    async void OnNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        bool blank = string.IsNullOrEmpty(e.Uri) || e.Uri == "about:blank";
        if (_environment == null || !(blank || IsApple(e.Uri)))
        {
            e.Handled = true; // refused: nothing opens
            return;
        }

        var deferral = e.GetDeferral();
        var size = e.WindowFeatures.HasSize
            ? new Size((int)e.WindowFeatures.Width, (int)e.WindowFeatures.Height)
            : new Size(520, 720);
        var window = new SignInWindow(this, Scale(new Size(Math.Clamp(size.Width, 420, 900), Math.Clamp(size.Height, 520, 900))));
        try
        {
            window.Show(this);
            await window.Web.EnsureCoreWebView2Async(_environment);

            var core = window.Web.CoreWebView2;
            core.Settings.AreDevToolsEnabled = _dev;
            core.Settings.IsStatusBarEnabled = false;
            core.DocumentTitleChanged += (_, _) => window.Text = string.IsNullOrWhiteSpace(core.DocumentTitle) ? "Apple Music" : core.DocumentTitle;
            core.WindowCloseRequested += (_, _) => window.Close();
            core.NavigationStarting += (_, args) =>
            {
                // Apple's sign-in pages only. The real music.apple.com site must never load in this
                // browser profile: it would install itself over the address Tint's own page uses.
                bool realSite = Uri.TryCreate(args.Uri, UriKind.Absolute, out var to) && to.Host.Equals("music.apple.com", StringComparison.OrdinalIgnoreCase);
                if (args.Uri != "about:blank" && (!IsApple(args.Uri) || realSite)) args.Cancel = true;
            };
            // Links such as "Forgot password?" go to the person's normal browser.
            core.NewWindowRequested += (_, args) =>
            {
                args.Handled = true;
                if (IsApple(args.Uri)) System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(args.Uri) { UseShellExecute = true });
            };
            e.NewWindow = core;
            e.Handled = true;
        }
        catch
        {
            window.Close();
            e.Handled = true;
        }
        finally
        {
            deferral.Complete();
        }
    }

    // ---- Google's sign-in window ------------------------------------------------------------------

    const string GoogleSignIn = "https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fmusic.youtube.com%2F";
    static readonly string[] YouTubeSites = { "https://music.youtube.com", "https://www.youtube.com" };

    /// <summary>
    /// Opens Google's sign-in and, once it lands on YouTube Music signed in, hands YouTube's cookies
    /// to yt-dlp's keeping and closes. The result says whether a sign-in was captured.
    /// </summary>
    public Task<bool> YouTubeSignIn()
    {
        var done = new TaskCompletionSource<bool>();
        if (_environment == null) return Task.FromResult(false);

        var window = new SignInWindow(this, Scale(new Size(520, 720)), "Google");
        window.FormClosed += (_, _) => done.TrySetResult(false);
        window.Show(this);
        _ = Open();
        return done.Task;

        async Task Open()
        {
            try
            {
                await window.Web.EnsureCoreWebView2Async(_environment);
                var core = window.Web.CoreWebView2;
                core.Settings.AreDevToolsEnabled = _dev;
                core.Settings.IsStatusBarEnabled = false;
                core.Settings.IsPasswordAutosaveEnabled = false;
                core.DocumentTitleChanged += (_, _) => window.Text = string.IsNullOrWhiteSpace(core.DocumentTitle) ? "Google" : core.DocumentTitle;
                core.WindowCloseRequested += (_, _) => window.Close();
                core.NavigationStarting += (_, args) =>
                {
                    // Sign-in can pass through other sites (a work account's own login page), but only secure ones.
                    if (args.Uri != "about:blank" && !args.Uri.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) args.Cancel = true;
                };
                // Help links go to the person's normal browser.
                core.NewWindowRequested += (_, args) =>
                {
                    args.Handled = true;
                    if (args.Uri.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
                        System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(args.Uri) { UseShellExecute = true });
                };
                core.NavigationCompleted += async (_, _) =>
                {
                    if (!Uri.TryCreate(core.Source, UriKind.Absolute, out var at) || !at.Host.Equals("music.youtube.com", StringComparison.OrdinalIgnoreCase)) return;
                    if (!await SaveYouTubeCookies(core)) return;
                    done.TrySetResult(true);
                    window.Close();
                };
                core.Navigate(GoogleSignIn);
            }
            catch
            {
                window.Close();
            }
        }
    }

    /// <summary>Opens the hidden YouTube Music page that plays songs with the site's own player.</summary>
    public Task<bool> OpenYouTubePage(bool again)
    {
        if (_environment == null) return Task.FromResult(false);
        if (_youtubePage == null)
        {
            _youtubePage = new YouTubePage(this, Path.Combine(Paths.WebRoot(_dev), "js", "youtube-page.js"));
            // And this is the way back: what the site's player reports goes to Tint's page.
            _youtubePage.Said += json => { try { _web.CoreWebView2?.PostWebMessageAsJson(json); } catch { } };
            // From here on the site renews the sign-in's cookies, so yt-dlp's copy is taken from the browser each time.
            _youtube.RefreshCookies = () => OnUi(() => _web.CoreWebView2 is { } core ? SaveYouTubeCookies(core) : Task.FromResult(false));
        }
        return _youtubePage.Open(_environment, _dev, again);
    }

    /// <summary>Copies YouTube's cookies from the browser to yt-dlp's keeping. False when the browser isn't signed in.</summary>
    async Task<bool> SaveYouTubeCookies(CoreWebView2 core)
    {
        var cookies = await YouTubeCookies(core);
        // This cookie is what YouTube's own pages sign their requests with. No sign-in, no cookie.
        if (!cookies.Any(c => c.Name is "SAPISID" or "__Secure-3PAPISID")) return false;
        _youtube.SaveCookies(cookies.Select(c => (c.Domain, c.Path, c.IsSecure, c.IsHttpOnly,
            c.IsSession ? 0 : new DateTimeOffset(c.Expires.ToUniversalTime()).ToUnixTimeSeconds(), c.Name, c.Value)));
        return true;
    }

    static async Task<List<CoreWebView2Cookie>> YouTubeCookies(CoreWebView2 core)
    {
        var all = new List<CoreWebView2Cookie>();
        foreach (var site in YouTubeSites)
            foreach (var cookie in await core.CookieManager.GetCookiesAsync(site))
                if (!all.Any(c => c.Name == cookie.Name && c.Domain == cookie.Domain && c.Path == cookie.Path)) all.Add(cookie);
        return all;
    }

    /// <summary>Forgets the Google sign-in: the copy yt-dlp uses, and the one in Tint's browser profile.</summary>
    public async Task YouTubeSignOut()
    {
        _youtube.ForgetCookies();
        if (_web.CoreWebView2 is not { } core) return;
        foreach (var site in YouTubeSites.Concat(new[] { "https://accounts.google.com", "https://www.google.com" }))
            foreach (var cookie in await core.CookieManager.GetCookiesAsync(site))
                core.CookieManager.DeleteCookie(cookie);
    }

    sealed class SignInWindow : Form
    {
        public WebView2 Web { get; } = new() { Dock = DockStyle.Fill };

        public SignInWindow(Form owner, Size size, string title = "Apple Music")
        {
            Text = title;
            Icon = owner.Icon;
            ShowInTaskbar = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.Manual;
            ClientSize = size;
            var area = Screen.FromControl(owner).WorkingArea;
            Location = new Point(
                Math.Clamp(owner.Left + (owner.Width - Width) / 2, area.Left, Math.Max(area.Left, area.Right - Width)),
                Math.Clamp(owner.Top + (owner.Height - Height) / 2, area.Top, Math.Max(area.Top, area.Bottom - Height)));
            Controls.Add(Web);
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            Web.Dispose();
            base.OnFormClosed(e);
        }
    }

    // ---- called from the local server ------------------------------------------------------------

    // The server asks from its own threads; the window answers on its own.
    Task<string?> IHost.PickFolder() => Task.FromResult(OnUi(PickFolder));
    Task<string?> IHost.PickKeyFile() => Task.FromResult(OnUi(PickKeyFile));
    void IHost.TintChrome(Color background, Color text, bool instant) => OnUi(() => TintChrome(background, text, instant));
    void IHost.SetMini(bool on) => OnUi(() => SetMini(on));
    Task<bool> IHost.YouTubeSignIn() => OnUi(YouTubeSignIn);
    Task IHost.YouTubeSignOut() => OnUi(YouTubeSignOut);
    Task<bool> IHost.OpenYouTubePage(bool again) => OnUi(() => OpenYouTubePage(again));
    void IHost.ShowNowPlaying(SystemTrack? track, bool playing, long at) => OnUi(() => ShowNowPlaying(track, playing, at));

    public void OnUi(Action action)
    {
        if (IsDisposed) return;
        if (InvokeRequired) Invoke(action); else action();
    }

    public T OnUi<T>(Func<T> func) => InvokeRequired ? Invoke(func) : func();

    public string? PickFolder()
    {
        using var dialog = new FolderBrowserDialog
        {
            Description = "Choose a folder that holds music",
            UseDescriptionForTitle = true,
            InitialDirectory = Environment.GetFolderPath(Environment.SpecialFolder.MyMusic),
        };
        return dialog.ShowDialog(this) == DialogResult.OK ? dialog.SelectedPath : null;
    }

    public string? PickKeyFile()
    {
        using var dialog = new OpenFileDialog
        {
            Title = "Choose your MusicKit private key",
            Filter = "MusicKit private key (*.p8)|*.p8|All files (*.*)|*.*",
        };
        return dialog.ShowDialog(this) == DialogResult.OK ? dialog.FileName : null;
    }

    public void Quit() => BeginInvoke(Close);

    public void BringForward()
    {
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Activate();
    }

    /// <summary>What the page says is playing, for Windows' media controls and the taskbar buttons.</summary>
    public void ShowNowPlaying(SystemTrack? track, bool playing, long at)
    {
        if (at < _nowPlayingAt) return; // an older report that took longer to get here
        _nowPlayingAt = at;
        // Sound starting is when Windows lists the browser's sound in the volume mixer, under the browser's name.
        if (playing && !_playing) NameInMixer();
        _playing = playing;
        _media?.Show(track, playing);
        _taskbar.Show(track != null, playing);
    }

    void NameInMixer() => MixerName.Claim(() => OnUi(BrowserProcesses));

    List<int> BrowserProcesses()
    {
        try
        {
            return _environment?.GetProcessInfos().Select(p => p.ProcessId).ToList() ?? new();
        }
        catch
        {
            return new(); // the browser is restarting
        }
    }

#if DEBUG
    /// <summary>Dev builds only: lets a script check that the taskbar took the preview buttons.</summary>
    public bool TaskbarButtonsAttached => _taskbar.Attached;
#endif

    /// <summary>Passes play, pause, toggle, next or previous to the page. Safe to call from any thread.</summary>
    void Command(string name)
    {
        try
        {
            BeginInvoke(() => _web.CoreWebView2?.PostWebMessageAsString(name));
        }
        catch (InvalidOperationException)
        {
            // The window is closing.
        }
    }

    const int WM_SETTINGCHANGE = 0x001A;
    const int WM_COMMAND = 0x0111;

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == TaskbarButtons.Created) _taskbar.Attach(Handle, DeviceDpi);
        else if (m.Msg == WM_SETTINGCHANGE) _taskbar.Restyle(DeviceDpi);
        else if (m.Msg == WM_COMMAND && TaskbarButtons.CommandFor(m.WParam) is { } command)
        {
            Command(command);
            return;
        }
        base.WndProc(ref m);
    }

    /// <summary>Switches between the full window and a small always-on-top player.</summary>
    public void SetMini(bool on)
    {
        if (on == _mini)
        {
            // Asked to open the library while the window was only dragged too narrow or too low to show it
            // (the page's breakpoints, 520 by 400): just make room for it.
            var least = Scale(new Size(520, 400));
            if (!on && WindowState == FormWindowState.Normal && (ClientSize.Width < least.Width || ClientSize.Height < least.Height))
            {
                var area = Screen.FromControl(this).WorkingArea;
                var size = Scale(new Size(1180, 760));
                size = new Size(Math.Min(size.Width, area.Width), Math.Min(size.Height, area.Height));
                Bounds = new Rectangle(
                    Math.Clamp(Left, area.Left, area.Right - size.Width),
                    Math.Clamp(Top, area.Top, area.Bottom - size.Height),
                    size.Width, size.Height);
            }
            return;
        }

        if (on)
        {
            _fullMaximized = WindowState == FormWindowState.Maximized;
            _fullBounds = _fullMaximized ? RestoreBounds : Bounds;
            WindowState = FormWindowState.Normal;
            var size = Scale(new Size(360, 700));
            var area = Screen.FromControl(this).WorkingArea;
            size.Height = Math.Min(size.Height, area.Height - 40);
            Bounds = new Rectangle(
                Math.Clamp(_fullBounds.Right - size.Width, area.Left, area.Right - size.Width),
                Math.Clamp(_fullBounds.Top, area.Top, area.Bottom - size.Height),
                size.Width, size.Height);
            TopMost = true;
        }
        else
        {
            TopMost = false;
            Bounds = _fullBounds;
            if (_fullMaximized) WindowState = FormWindowState.Maximized;
        }
        _mini = on;
    }

    // ---- title bar colour ------------------------------------------------------------------------

    public void TintChrome(Color background, Color text, bool instant)
    {
        if (instant)
        {
            _chromeTimer.Stop();
            ApplyChrome(background, text);
            return;
        }
        _bgFrom = _bgNow; _fgFrom = _fgNow;
        _bgTo = background; _fgTo = text;
        _chromeStart = Environment.TickCount64;
        _chromeTimer.Start();
    }

    void StepChrome()
    {
        double t = Math.Min(1.0, (Environment.TickCount64 - _chromeStart) / (double)ChromeMs);
        double eased = t < 0.5 ? 4 * t * t * t : 1 - Math.Pow(-2 * t + 2, 3) / 2;
        ApplyChrome(Mix(_bgFrom, _bgTo, eased), Mix(_fgFrom, _fgTo, eased));
        if (t >= 1.0) _chromeTimer.Stop();
    }

    void ApplyChrome(Color background, Color text)
    {
        _bgNow = background;
        _fgNow = text;
        if (!IsHandleCreated) return;

        int dark = background.GetBrightness() < 0.5f ? 1 : 0;
        int bg = ColorRef(background), fg = ColorRef(text);
        DwmSetWindowAttribute(Handle, DWMWA_USE_IMMERSIVE_DARK_MODE, ref dark, sizeof(int));
        DwmSetWindowAttribute(Handle, DWMWA_CAPTION_COLOR, ref bg, sizeof(int));
        DwmSetWindowAttribute(Handle, DWMWA_BORDER_COLOR, ref bg, sizeof(int));
        DwmSetWindowAttribute(Handle, DWMWA_TEXT_COLOR, ref fg, sizeof(int));
        if (BackColor != background) BackColor = background;
    }

    static Color Mix(Color a, Color b, double t) => Color.FromArgb(255,
        (int)Math.Round(a.R + (b.R - a.R) * t),
        (int)Math.Round(a.G + (b.G - a.G) * t),
        (int)Math.Round(a.B + (b.B - a.B) * t));

    static int ColorRef(Color c) => c.R | (c.G << 8) | (c.B << 16);

    const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
    const int DWMWA_BORDER_COLOR = 34;
    const int DWMWA_CAPTION_COLOR = 35;
    const int DWMWA_TEXT_COLOR = 36;

    [DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    // ---- window lifetime -------------------------------------------------------------------------

    Size Scale(Size logical) => new(logical.Width * DeviceDpi / 96, logical.Height * DeviceDpi / 96);

    void RestoreBounds_()
    {
        var wanted = _settings.Bounds is { Length: 4 } b ? new Rectangle(b[0], b[1], b[2], b[3]) : Rectangle.Empty;
        if (wanted.Width >= MinimumSize.Width && wanted.Height >= MinimumSize.Height &&
            Screen.AllScreens.Any(s => s.WorkingArea.IntersectsWith(wanted)))
        {
            Bounds = wanted;
        }
        else
        {
            var area = Screen.PrimaryScreen!.WorkingArea;
            var size = Scale(new Size(1180, 760));
            size = new Size(Math.Min(size.Width, area.Width - 80), Math.Min(size.Height, area.Height - 80));
            Bounds = new Rectangle(area.Left + (area.Width - size.Width) / 2, area.Top + (area.Height - size.Height) / 2, size.Width, size.Height);
        }
        if (_settings.Maximized) WindowState = FormWindowState.Maximized;
    }

    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        // A minimised player has nothing to draw, so let the browser give memory back.
        if (_web?.CoreWebView2 is { } core)
        {
            core.MemoryUsageTargetLevel = WindowState == FormWindowState.Minimized
                ? CoreWebView2MemoryUsageTargetLevel.Low
                : CoreWebView2MemoryUsageTargetLevel.Normal;
        }
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        bool maximized = _mini ? _fullMaximized : WindowState == FormWindowState.Maximized;
        var bounds = _mini ? _fullBounds : WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
        _settings.Bounds = new[] { bounds.X, bounds.Y, bounds.Width, bounds.Height };
        _settings.Maximized = maximized;
        _settings.Save();
        base.OnFormClosing(e);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _chromeTimer.Dispose();
            _media?.Dispose();
            _taskbar.Dispose();
            _youtubePage?.Dispose();
            _youtube.Dispose();
            _discord.Dispose();
            _server.Dispose();
            _library.Dispose();
        }
        base.Dispose(disposing);
    }
}
