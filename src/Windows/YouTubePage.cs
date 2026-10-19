using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Tint;

/// <summary>
/// A second browser view, never seen, that keeps music.youtube.com open and signed in so its own
/// player can play YouTube songs. A song starts in a second or two this way, where yt-dlp takes
/// several to find the same audio. A small script put into that page (wwwroot\js\youtube-page.js)
/// does what Tint's page asks and reports back; this class carries the messages between the two.
/// </summary>
sealed class YouTubePage : IDisposable
{
    const string Home = "https://music.youtube.com/";

    readonly WebView2 _view;
    readonly string _scriptFile;
    string? _scriptId;
    bool _wired;
    Task<bool>? _opening;
    TaskCompletionSource<bool>? _ready;

    /// <summary>What the script in the page has to say, as JSON.</summary>
    public event Action<string>? Said;

    public YouTubePage(Control window, string scriptFile)
    {
        _scriptFile = scriptFile;
        // It has a real size, so the site lays itself out and plays as it would in a window, but
        // sits far outside the part of Tint's window that is drawn. Disabled, it can never take the
        // keyboard away from the page the person is using.
        _view = new WebView2 { Location = new Point(-6000, 0), Size = new Size(1024, 700), TabStop = false, Enabled = false };
        window.Controls.Add(_view);
    }

    /// <summary>Opens the site if it isn't open, and waits for its player. False when it didn't come up.</summary>
    public Task<bool> Open(CoreWebView2Environment environment, bool dev, bool again = false)
    {
        if (!again && _opening is { IsFaulted: false, IsCanceled: false } known && !(known.IsCompleted && !known.Result)) return known;
        return _opening = Load(environment, dev);
    }

    async Task<bool> Load(CoreWebView2Environment environment, bool dev)
    {
        await _view.EnsureCoreWebView2Async(environment);
        var core = _view.CoreWebView2;
        if (!_wired)
        {
            _wired = true;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.AreDevToolsEnabled = dev;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.IsPasswordAutosaveEnabled = false;
            core.Settings.IsGeneralAutofillEnabled = false;
            // Not a sound until Tint's page has said how loud it should be (see Tell).
            core.IsMuted = true;
            // The site and Google's sign-in behind it, and nothing else, ever load here.
            core.NavigationStarting += (_, args) =>
            {
                bool ours = Uri.TryCreate(args.Uri, UriKind.Absolute, out var to) && to.Scheme == Uri.UriSchemeHttps &&
                    (to.Host.EndsWith(".youtube.com", StringComparison.OrdinalIgnoreCase) || to.Host.EndsWith(".google.com", StringComparison.OrdinalIgnoreCase));
                if (!ours && args.Uri != "about:blank") args.Cancel = true;
            };
            core.NewWindowRequested += (_, args) => args.Handled = true;
            core.WebMessageReceived += (_, args) =>
            {
                if (!args.Source.StartsWith(Home, StringComparison.OrdinalIgnoreCase)) return;
                var json = args.WebMessageAsJson;
                if (json.Contains("\"is\":\"ready\"", StringComparison.Ordinal)) _ready?.TrySetResult(true);
                Said?.Invoke(json);
            };
            // If the site's process dies, the next song opens it afresh.
            core.ProcessFailed += (_, _) => { _opening = null; _ready?.TrySetResult(false); };
        }

        if (_scriptId != null) core.RemoveScriptToExecuteOnDocumentCreated(_scriptId);
        _scriptId = await core.AddScriptToExecuteOnDocumentCreatedAsync(await File.ReadAllTextAsync(_scriptFile));

        var ready = _ready = new TaskCompletionSource<bool>();
        core.Navigate(Home);
        var first = await Task.WhenAny(ready.Task, Task.Delay(TimeSpan.FromSeconds(40)));
        return first == ready.Task && ready.Task.Result;
    }

    /// <summary>Passes a request from Tint's page to the script in the site.</summary>
    public void Tell(string json)
    {
        try
        {
            if (_view.CoreWebView2 is not { } core) return;
            // The first word on volume is what lets the page be heard at all.
            if (core.IsMuted && json.Contains("\"do\":\"volume\"", StringComparison.Ordinal)) core.IsMuted = false;
            core.PostWebMessageAsJson(json);
        }
        catch { }
    }

    public void Dispose() => _view.Dispose();
}
