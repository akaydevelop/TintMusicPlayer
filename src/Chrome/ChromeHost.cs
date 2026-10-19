using System.Diagnostics;
using System.Drawing;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Tint;

/// <summary>
/// The window of the Chrome-hosted build: an app window of an installed Chrome-family browser,
/// driven over the DevTools protocol. It does what the Windows build's MainForm, PageBridge and
/// YouTubePage do with WebView2:
///   • the page is shown under an address on music.apple.com, and every request below that
///     address is answered here (Fetch interception), never by Apple. Apple's web player token is
///     only honoured for pages on apple.com, and its sign-in only reports back to such a page;
///   • wwwroot/js/host-bridge.js gives the page WebView2's messaging, so the same scripts run;
///   • YouTube Music's own player runs in a hidden page, and Google's sign-in in a window of its own.
/// The system's media controls (MPRIS on Linux) are the browser's, fed by the page's Media Session.
/// </summary>
sealed class ChromeHost : IHost
{
    const string Origin = "https://music.apple.com";
    const string Prefix = "/tint/";
    const string Base = Origin + Prefix;
    const string Binding = "__tintSay";
    // Songs go to the page a piece at a time; it asks for the next piece as it plays.
    const int MediaPiece = 2 * 1024 * 1024;

    const string YouTubeHome = "https://music.youtube.com/";
    const string GoogleSignIn = "https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fmusic.youtube.com%2F";
    static readonly string[] YouTubeHosts = { "music.youtube.com", "www.youtube.com" };
    static readonly string[] GoogleHosts = { "accounts.google.com", "www.google.com" };
    static readonly string[] Commands = { "play", "pause", "toggle", "next", "previous" };

    static readonly HttpClient Http = new(new SocketsHttpHandler { UseProxy = false }) { Timeout = TimeSpan.FromSeconds(60) };

    readonly bool _dev;
    readonly Settings _settings;
    readonly Library _library;
    readonly YouTube _youtube;
    readonly TaskCompletionSource _closed = new(TaskCreationOptions.RunContinuationsAsynchronously);

    Process? _browser;
    Cdp? _cdp;
    string? _mainTarget, _main;
    int _windowId;

    // The window as last seen, kept for the next start.
    Rectangle _bounds;
    bool _maximized;
    bool _mini;
    Rectangle _fullBounds;
    bool _fullMaximized;

    // The hidden YouTube Music page.
    readonly SemaphoreSlim _youtubeGate = new(1);
    string? _youtubeTarget, _youtubeSession, _youtubeScript;
    Task<bool>? _youtubeOpening;
    TaskCompletionSource<bool>? _youtubeReady;

    // Google's sign-in window.
    string? _signInTarget;
    TaskCompletionSource<bool>? _signInDone;
    int _signInCapturing;

    public LocalServer? Server { get; set; }

    public ChromeHost(bool dev, Settings settings, Library library, YouTube youtube)
    {
        _dev = dev;
        _settings = settings;
        _library = library;
        _youtube = youtube;
    }

    Cdp Cdp => _cdp ?? throw new InvalidOperationException("The browser isn't running.");

    // ---- starting and stopping -------------------------------------------------------------------

    /// <summary>Opens the window and returns once it has been closed.</summary>
    public async Task Run()
    {
        var browser = Browser.Find() ?? throw new InvalidOperationException(
            "Tint needs Google Chrome, Microsoft Edge or Brave to show its window and play Apple Music. None of them was found. " +
            "Install one, or set TINT_BROWSER to the browser to use.");
        if (Browser.MayLackWidevine(browser))
            Console.Error.WriteLine($"Tint: using {browser}. Chromium is often packaged without Widevine, which Apple Music's full songs need; Google Chrome has it.");

        // The first thing shown is only a backdrop in the player's colours, while the page itself loads.
        const string Backdrop = "data:text/html,%3Ctitle%3ETint%3C/title%3E%3Cbody%20style=%22background:%2314262b%22%3E";
        (_browser, _cdp) = await Browser.Start(browser, Backdrop, Placement(), _dev);
        Cdp.Event += OnEvent;

        await Cdp.Send("Target.setDiscoverTargets", new JsonObject { ["discover"] = true });
        // The real music.apple.com, if it was ever opened in this profile, would leave a service
        // worker that answers for the whole site, Tint's address included.
        try { await Cdp.Send("Storage.clearDataForOrigin", new JsonObject { ["origin"] = Origin, ["storageTypes"] = "service_workers" }); }
        catch (CdpException) { }

        _mainTarget = await FindAppWindow();
        _main = await Attach(_mainTarget);
        await Cdp.Send("Runtime.addBinding", new JsonObject { ["name"] = Binding }, _main);
        await Cdp.Send("Page.enable", null, _main);
        await Cdp.Send("Runtime.enable", null, _main);
        await Cdp.Send("Inspector.enable", null, _main);
        await Cdp.Send("Page.addScriptToEvaluateOnNewDocument", new JsonObject { ["source"] = await BridgeScript() }, _main);
        await Cdp.Send("Fetch.enable", new JsonObject
        {
            ["patterns"] = new JsonArray(new JsonObject { ["urlPattern"] = Base + "*", ["requestStage"] = "Request" }),
        }, _main);

        var window = await Cdp.Send("Browser.getWindowForTarget", new JsonObject { ["targetId"] = _mainTarget });
        _windowId = window["windowId"]!.GetValue<int>();
        ReadBounds(window["bounds"] as JsonObject);
        if (_settings.Maximized) await SetWindowState("maximized");

        await Cdp.Send("Page.navigate", new JsonObject { ["url"] = Base }, _main);
        _ = WatchBounds();

        await Task.WhenAny(_closed.Task, Cdp.Closed);
        SaveBounds();
    }

    /// <summary>The window Chrome opened for --app. It shows up a moment after the browser starts.</summary>
    async Task<string> FindAppWindow()
    {
        for (int tries = 0; tries < 100; tries++)
        {
            var targets = await Cdp.Send("Target.getTargets");
            var page = (targets["targetInfos"] as JsonArray)?.OfType<JsonObject>()
                .FirstOrDefault(t => t["type"]?.GetValue<string>() == "page" && (t["url"]?.GetValue<string>() ?? "").StartsWith("data:text/html", StringComparison.Ordinal));
            if (page != null) return page["targetId"]!.GetValue<string>();
            await Task.Delay(100);
        }
        throw new InvalidOperationException("The browser started, but Tint's window never appeared.");
    }

    async Task<string> Attach(string target)
    {
        var attached = await Cdp.Send("Target.attachToTarget", new JsonObject { ["targetId"] = target, ["flatten"] = true });
        return attached["sessionId"]!.GetValue<string>();
    }

    async Task<string> BridgeScript() => await File.ReadAllTextAsync(Path.Combine(Paths.WebRoot(_dev), "js", "host-bridge.js"));

    Task? _stopping;

    /// <summary>Closes the browser, and with it every window Tint opened.</summary>
    public Task Stop()
    {
        lock (_closed) return _stopping ??= StopNow();
    }

    async Task StopNow()
    {
        _closed.TrySetResult();
        if (_cdp != null)
        {
            try { await _cdp.Send("Browser.close", null, null, TimeSpan.FromSeconds(3)); } catch { }
            await _cdp.DisposeAsync();
        }
        if (_browser is { } process)
        {
            try
            {
                using var patience = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                await process.WaitForExitAsync(patience.Token);
            }
            catch
            {
                try { process.Kill(entireProcessTree: true); } catch { }
            }
            process.Dispose();
        }
    }

    // ---- what the browser reports ----------------------------------------------------------------

    void OnEvent(string method, JsonObject p, string? session)
    {
        switch (method)
        {
            case "Fetch.requestPaused" when session == _main:
                _ = Task.Run(() => Answer(p));
                break;

            case "Runtime.bindingCalled" when p["name"]?.GetValue<string>() == Binding:
                var payload = p["payload"]?.GetValue<string>() ?? "";
                if (session == _main) _ = Task.Run(() => FromPage(payload));
                else if (session != null && session == _youtubeSession) _ = Task.Run(() => FromYouTube(payload));
                break;

            case "Target.targetDestroyed":
            case "Target.detachedFromTarget":
                var target = p["targetId"]?.GetValue<string>();
                var detached = p["sessionId"]?.GetValue<string>();
                if (target == _mainTarget || (detached != null && detached == _main)) _closed.TrySetResult();
                else if (target == _youtubeTarget || (detached != null && detached == _youtubeSession)) ForgetYouTube();
                else if (target != null && target == _signInTarget)
                {
                    _signInTarget = null;
                    _signInDone?.TrySetResult(false);
                }
                break;

            case "Target.targetInfoChanged":
                if (p["targetInfo"] is JsonObject info && info["targetId"]?.GetValue<string>() is { } changed && changed == _signInTarget)
                    _ = Task.Run(() => SignInMoved(info["url"]?.GetValue<string>()));
                break;

            case "Inspector.targetCrashed":
                // The page's process died. A fresh load brings the player back.
                if (session == _main) _ = Task.Run(() => Cdp.Send("Page.reload", null, _main));
                else if (session != null && session == _youtubeSession) _ = Task.Run(CloseYouTube);
                break;
        }
    }

    // ---- the page's address on music.apple.com ---------------------------------------------------

    /// <summary>Answers one request for Tint's address: songs from disk, everything else from the local server.</summary>
    async Task Answer(JsonObject p)
    {
        var requestId = p["requestId"]!.GetValue<string>();
        try
        {
            var request = (JsonObject)p["request"]!;
            var uri = new Uri(request["url"]!.GetValue<string>());
            var path = uri.AbsolutePath.StartsWith(Prefix, StringComparison.Ordinal) ? uri.AbsolutePath[Prefix.Length..] : "";
            var headers = request["headers"] as JsonObject ?? new JsonObject();

            if (path.StartsWith("media/", StringComparison.Ordinal))
            {
                await Media(requestId, Uri.UnescapeDataString(path[6..]), Header(headers, "Range"));
                return;
            }

            var server = Server ?? throw new InvalidOperationException("The local server isn't running.");
            using var message = new HttpRequestMessage(new HttpMethod(request["method"]!.GetValue<string>()), server.Origin + "/" + path + uri.Query);
            if (Header(headers, "X-Tint") is { } tint) message.Headers.TryAddWithoutValidation("X-Tint", tint);
            if (await PostData(requestId, request) is { } body)
            {
                message.Content = new ByteArrayContent(body);
                message.Content.Headers.TryAddWithoutValidation("Content-Type", "application/json");
            }

            using var reply = await Http.SendAsync(message);
            var bytes = await reply.Content.ReadAsByteArrayAsync();
            var answer = new JsonArray();
            if (reply.Content.Headers.ContentType is { } type) answer.Add(Pair("Content-Type", type.ToString()));
            if (reply.Headers.CacheControl is { } cache) answer.Add(Pair("Cache-Control", cache.ToString()));
            await Fulfill(requestId, (int)reply.StatusCode, answer, bytes);
        }
        catch (Exception ex)
        {
            if (_dev) Console.Error.WriteLine($"Tint: {p["request"]?["url"]} failed: {ex}");
            try { await Fulfill(requestId, 502, new JsonArray(Pair("X-Tint-Error", ex.GetType().Name)), []); } catch { }
        }
    }

    async Task<byte[]?> PostData(string requestId, JsonObject request)
    {
        if (request["postData"]?.GetValue<string>() is { } text) return Encoding.UTF8.GetBytes(text);
        if (request["hasPostData"]?.GetValue<bool>() != true) return null;
        // Large bodies aren't sent along with the event; they have to be asked for.
        var data = await Cdp.Send("Fetch.getRequestPostData", new JsonObject { ["requestId"] = requestId }, _main);
        return Encoding.UTF8.GetBytes(data["postData"]?.GetValue<string>() ?? "");
    }

    async Task Media(string requestId, string id, string? range)
    {
        var track = _library.Find(id);
        if (track == null || !track.Playable || !File.Exists(track.Path))
        {
            await Fulfill(requestId, 404, new JsonArray(), []);
            return;
        }

        await using var file = new FileStream(track.Path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 64 * 1024, FileOptions.Asynchronous);
        long length = file.Length;
        var headers = new JsonArray(
            Pair("Content-Type", LocalServer.MimeFor(track.Path)),
            Pair("Accept-Ranges", "bytes"),
            Pair("Cache-Control", "no-store"));

        var kind = HttpRange.Parse(range, length, out long start, out long end);
        if (kind == HttpRange.Result.Invalid)
        {
            headers.Add(Pair("Content-Range", $"bytes */{length}"));
            await Fulfill(requestId, 416, headers, []);
            return;
        }

        // A whole small file goes in one answer. Anything else goes a piece at a time: the media
        // player takes a shorter range than it asked for, and asks for the rest.
        bool whole = kind == HttpRange.Result.Whole && length <= MediaPiece;
        if (!whole) end = Math.Min(end, start + MediaPiece - 1);
        var bytes = new byte[length == 0 ? 0 : end - start + 1];
        file.Position = start;
        await file.ReadExactlyAsync(bytes);
        if (!whole) headers.Add(Pair("Content-Range", $"bytes {start}-{end}/{length}"));
        await Fulfill(requestId, whole ? 200 : 206, headers, bytes);
    }

    Task Fulfill(string requestId, int status, JsonArray headers, byte[] body) =>
        Cdp.Send("Fetch.fulfillRequest", new JsonObject
        {
            ["requestId"] = requestId,
            ["responseCode"] = status,
            ["responseHeaders"] = headers,
            ["body"] = Convert.ToBase64String(body),
        }, _main);

    static JsonObject Pair(string name, string value) => new() { ["name"] = name, ["value"] = value };

    static string? Header(JsonObject headers, string name) =>
        headers.FirstOrDefault(h => h.Key.Equals(name, StringComparison.OrdinalIgnoreCase)).Value?.GetValue<string>();

    // ---- messages between the pages --------------------------------------------------------------

    /// <summary>Something Tint's page posted. The only thing it posts is a request for the YouTube page.</summary>
    async Task FromPage(string payload)
    {
        if (Valid(payload) is not JsonObject message || message["to"]?.GetValue<string>() != "youtube") return;
        if (_youtubeSession is { } session) await Hear(session, message.ToJsonString());
    }

    /// <summary>Something the hidden YouTube Music page posted: its player's state, which Tint's page wants.</summary>
    async Task FromYouTube(string payload)
    {
        if (Valid(payload) is not JsonObject message) return;
        var said = message["is"]?.GetValue<string>();
        if (said == "ready") _youtubeReady?.TrySetResult(true);

        // The media keys and the system's player controls reach whichever page is playing. When
        // that is this one, what they ask for is passed to Tint's page, which owns the queue.
        if (said == "command")
        {
            var name = message["name"]?.GetValue<string>();
            if (name != null && Commands.Contains(name)) await HearMain(JsonValue.Create(name).ToJsonString());
            return;
        }
        await HearMain(message.ToJsonString());
    }

    /// <summary>
    /// The text a page posted, as JSON, or null. It is passed on only once parsed and written out
    /// again, so what reaches the other page can only ever be data.
    /// </summary>
    static JsonNode? Valid(string payload)
    {
        try { return JsonNode.Parse(payload); }
        catch (JsonException) { return null; }
    }

    Task HearMain(string json) => _main is { } session ? Hear(session, json) : Task.CompletedTask;

    async Task Hear(string session, string json)
    {
        try
        {
            await Cdp.Send("Runtime.evaluate", new JsonObject
            {
                ["expression"] = $"window.__tintHear && window.__tintHear({json})",
                ["returnByValue"] = true,
            }, session);
        }
        catch (CdpException) { /* the page is between loads */ }
    }

    async Task<JsonNode?> Evaluate(string expression, bool awaitPromise = false)
    {
        if (_main == null) return null;
        var result = await Cdp.Send("Runtime.evaluate", new JsonObject
        {
            ["expression"] = expression,
            ["returnByValue"] = true,
            ["awaitPromise"] = awaitPromise,
        }, _main, Timeout.InfiniteTimeSpan);
        return result["result"]?["value"];
    }

    // ---- the hidden YouTube Music page -----------------------------------------------------------

    public async Task<bool> OpenYouTubePage(bool again)
    {
        await _youtubeGate.WaitAsync();
        try
        {
            if (!again && _youtubeOpening is { IsFaulted: false, IsCanceled: false } known && !(known.IsCompleted && !known.Result)) return await Wait(known);
            _youtubeOpening = LoadYouTube();
        }
        finally
        {
            _youtubeGate.Release();
        }
        return await Wait(_youtubeOpening);

        static async Task<bool> Wait(Task<bool> opening)
        {
            try { return await opening; }
            catch { return false; }
        }
    }

    async Task<bool> LoadYouTube()
    {
        if (_youtubeSession == null)
        {
            _youtubeTarget = await HiddenPage();
            _youtubeSession = await Attach(_youtubeTarget);
            await Cdp.Send("Runtime.addBinding", new JsonObject { ["name"] = Binding }, _youtubeSession);
            await Cdp.Send("Page.enable", null, _youtubeSession);
            await Cdp.Send("Runtime.enable", null, _youtubeSession);
            await Cdp.Send("Inspector.enable", null, _youtubeSession);
            // From here on the site renews the sign-in's cookies, so yt-dlp's copy is taken from the browser each time.
            _youtube.RefreshCookies = SaveYouTubeCookies;
        }

        // Put in afresh each time, so a changed script (dev mode) is the one that runs.
        if (_youtubeScript != null)
        {
            try { await Cdp.Send("Page.removeScriptToEvaluateOnNewDocument", new JsonObject { ["identifier"] = _youtubeScript }, _youtubeSession); }
            catch (CdpException) { }
        }
        var script = await BridgeScript() + "\n" + await File.ReadAllTextAsync(Path.Combine(Paths.WebRoot(_dev), "js", "youtube-page.js"));
        var added = await Cdp.Send("Page.addScriptToEvaluateOnNewDocument", new JsonObject { ["source"] = script }, _youtubeSession);
        _youtubeScript = added["identifier"]?.GetValue<string>();

        var ready = _youtubeReady = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        await Cdp.Send("Page.navigate", new JsonObject { ["url"] = YouTubeHome }, _youtubeSession);
        var first = await Task.WhenAny(ready.Task, Task.Delay(TimeSpan.FromSeconds(40)));
        return first == ready.Task && ready.Task.Result;
    }

    /// <summary>
    /// A page nobody sees. Recent browsers can keep one with no window at all; older ones get a
    /// window of its own, minimised straight away.
    /// </summary>
    async Task<string> HiddenPage()
    {
        try
        {
            var made = await Cdp.Send("Target.createTarget", new JsonObject { ["url"] = "about:blank", ["background"] = true, ["hidden"] = true });
            return made["targetId"]!.GetValue<string>();
        }
        catch (CdpException)
        {
            var made = await Cdp.Send("Target.createTarget", new JsonObject { ["url"] = "about:blank", ["newWindow"] = true, ["background"] = true });
            var target = made["targetId"]!.GetValue<string>();
            try
            {
                var window = await Cdp.Send("Browser.getWindowForTarget", new JsonObject { ["targetId"] = target });
                await Cdp.Send("Browser.setWindowBounds", new JsonObject
                {
                    ["windowId"] = window["windowId"]!.GetValue<int>(),
                    ["bounds"] = new JsonObject { ["windowState"] = "minimized" },
                });
            }
            catch (CdpException) { }
            return target;
        }
    }

    void ForgetYouTube()
    {
        _youtubeTarget = _youtubeSession = _youtubeScript = null;
        _youtubeOpening = null;
        _youtubeReady?.TrySetResult(false);
    }

    async Task CloseYouTube()
    {
        var target = _youtubeTarget;
        ForgetYouTube();
        if (target != null)
        {
            try { await Cdp.Send("Target.closeTarget", new JsonObject { ["targetId"] = target }); } catch (CdpException) { }
        }
    }

    // ---- Google's sign-in ------------------------------------------------------------------------

    public async Task<bool> YouTubeSignIn()
    {
        if (_signInTarget is { } open && _signInDone is { } pending)
        {
            try { await Cdp.Send("Target.activateTarget", new JsonObject { ["targetId"] = open }); } catch (CdpException) { }
            return await pending.Task;
        }

        var done = _signInDone = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        _signInCapturing = 0;
        var made = await Cdp.Send("Target.createTarget", new JsonObject
        {
            ["url"] = GoogleSignIn,
            ["newWindow"] = true,
            ["width"] = 520,
            ["height"] = 720,
        });
        _signInTarget = made["targetId"]!.GetValue<string>();
        return await done.Task;
    }

    /// <summary>Once the sign-in lands on YouTube Music signed in, its cookies go to yt-dlp's keeping and the window closes.</summary>
    async Task SignInMoved(string? address)
    {
        if (!Uri.TryCreate(address, UriKind.Absolute, out var at) || !at.Host.Equals("music.youtube.com", StringComparison.OrdinalIgnoreCase)) return;
        if (Interlocked.Exchange(ref _signInCapturing, 1) == 1) return;
        try
        {
            // The site sets the last of its cookies as it loads.
            for (int tries = 0; tries < 10; tries++)
            {
                if (await SaveYouTubeCookies())
                {
                    _signInDone?.TrySetResult(true);
                    if (_signInTarget is { } target) await Cdp.Send("Target.closeTarget", new JsonObject { ["targetId"] = target });
                    return;
                }
                await Task.Delay(500);
            }
        }
        catch (CdpException) { }
        finally
        {
            Interlocked.Exchange(ref _signInCapturing, 0);
        }
    }

    /// <summary>Copies YouTube's cookies from the browser to yt-dlp's keeping. False when the browser isn't signed in.</summary>
    async Task<bool> SaveYouTubeCookies()
    {
        var cookies = await Cookies(YouTubeHosts);
        // This cookie is what YouTube's own pages sign their requests with. No sign-in, no cookie.
        if (!cookies.Any(c => Text(c, "name") is "SAPISID" or "__Secure-3PAPISID")) return false;
        _youtube.SaveCookies(cookies.Select(c => (
            Text(c, "domain"), Text(c, "path"),
            c["secure"]?.GetValue<bool>() ?? false, c["httpOnly"]?.GetValue<bool>() ?? false,
            c["session"]?.GetValue<bool>() == true ? 0L : (long)(c["expires"]?.GetValue<double>() ?? 0),
            Text(c, "name"), Text(c, "value"))));
        return true;
    }

    public async Task YouTubeSignOut()
    {
        _youtube.ForgetCookies();
        foreach (var cookie in await Cookies(YouTubeHosts.Concat(GoogleHosts)))
        {
            try
            {
                await Cdp.Send("Storage.deleteCookies", new JsonObject { ["name"] = Text(cookie, "name"), ["domain"] = Text(cookie, "domain"), ["path"] = Text(cookie, "path") });
            }
            catch (CdpException)
            {
                // Older browsers only offer this per page.
                if (_main != null)
                    await Cdp.Send("Network.deleteCookies", new JsonObject { ["name"] = Text(cookie, "name"), ["domain"] = Text(cookie, "domain"), ["path"] = Text(cookie, "path") }, _main);
            }
        }
    }

    /// <summary>The profile's cookies that a page on any of these hosts would be sent.</summary>
    async Task<List<JsonObject>> Cookies(IEnumerable<string> hosts)
    {
        var all = await Cdp.Send("Storage.getCookies");
        var wanted = hosts.ToList();
        return (all["cookies"] as JsonArray ?? new JsonArray()).OfType<JsonObject>()
            .Where(c => wanted.Any(host => Matches(Text(c, "domain"), host))).ToList();

        static bool Matches(string domain, string host) =>
            domain.StartsWith('.')
                ? host.Equals(domain[1..], StringComparison.OrdinalIgnoreCase) || host.EndsWith(domain, StringComparison.OrdinalIgnoreCase)
                : host.Equals(domain, StringComparison.OrdinalIgnoreCase);
    }

    static string Text(JsonObject o, string key) => o[key]?.GetValue<string>() ?? "";

    // ---- the window ------------------------------------------------------------------------------

    /// <summary>Where the window was last time, if that is still somewhere sensible.</summary>
    Browser.Placement? Placement()
    {
        if (_settings.Bounds is not { Length: 4 } b || b[2] < 340 || b[3] < 300) return null;
        return new Browser.Placement(b[0], b[1], b[2], b[3]);
    }

    void ReadBounds(JsonObject? bounds)
    {
        if (bounds == null) return;
        var state = bounds["windowState"]?.GetValue<string>();
        if (state is "minimized" or "fullscreen") return;
        _maximized = state == "maximized";
        if (state == "normal" && !_mini)
        {
            _bounds = new Rectangle(
                bounds["left"]?.GetValue<int>() ?? 0, bounds["top"]?.GetValue<int>() ?? 0,
                bounds["width"]?.GetValue<int>() ?? 0, bounds["height"]?.GetValue<int>() ?? 0);
        }
    }

    /// <summary>Notes where the window is, now and then, so it can open there next time.</summary>
    async Task WatchBounds()
    {
        while (!_closed.Task.IsCompleted)
        {
            await Task.Delay(1500);
            try { ReadBounds((await Cdp.Send("Browser.getWindowBounds", new JsonObject { ["windowId"] = _windowId }))["bounds"] as JsonObject); }
            catch (CdpException) { }
        }
    }

    void SaveBounds()
    {
        var bounds = _mini ? _fullBounds : _bounds;
        if (bounds.Width > 0 && bounds.Height > 0) _settings.Bounds = new[] { bounds.X, bounds.Y, bounds.Width, bounds.Height };
        _settings.Maximized = _mini ? _fullMaximized : _maximized;
        _settings.Save();
    }

    Task SetWindowState(string state) =>
        Cdp.Send("Browser.setWindowBounds", new JsonObject { ["windowId"] = _windowId, ["bounds"] = new JsonObject { ["windowState"] = state } });

    Task SetWindowBounds(Rectangle r) =>
        Cdp.Send("Browser.setWindowBounds", new JsonObject
        {
            ["windowId"] = _windowId,
            ["bounds"] = new JsonObject { ["left"] = r.X, ["top"] = r.Y, ["width"] = r.Width, ["height"] = r.Height },
        });

    /// <summary>The part of the screen windows may use, as the page sees it.</summary>
    async Task<Rectangle> WorkArea()
    {
        try
        {
            if (await Evaluate("[screen.availLeft, screen.availTop, screen.availWidth, screen.availHeight].join(',')") is JsonValue value)
            {
                var n = value.GetValue<string>().Split(',').Select(int.Parse).ToArray();
                if (n[2] > 0 && n[3] > 0) return new Rectangle(n[0], n[1], n[2], n[3]);
            }
        }
        catch { }
        return new Rectangle(0, 0, 1920, 1080);
    }

    public void SetMini(bool on) => _ = Task.Run(() => Mini(on));

    async Task Mini(bool on)
    {
        try
        {
            var area = await WorkArea();
            var now = (await Cdp.Send("Browser.getWindowBounds", new JsonObject { ["windowId"] = _windowId }))["bounds"] as JsonObject;
            ReadBounds(now);

            if (on == _mini)
            {
                // Asked to open the library while the window was only dragged too narrow or too low to show it
                // (the page's breakpoints, 520 by 400): just make room for it.
                if (!on && !_maximized && (_bounds.Width < 520 || _bounds.Height < 400))
                {
                    var size = new Size(Math.Min(1180, area.Width), Math.Min(760, area.Height));
                    await SetWindowBounds(new Rectangle(
                        Math.Clamp(_bounds.X, area.Left, Math.Max(area.Left, area.Right - size.Width)),
                        Math.Clamp(_bounds.Y, area.Top, Math.Max(area.Top, area.Bottom - size.Height)),
                        size.Width, size.Height));
                }
                return;
            }

            if (on)
            {
                _fullMaximized = _maximized;
                _fullBounds = _bounds;
                _mini = true;
                if (_fullMaximized) await SetWindowState("normal");
                var size = new Size(360, Math.Min(700, area.Height - 40));
                await SetWindowBounds(new Rectangle(
                    Math.Clamp(_fullBounds.Right - size.Width, area.Left, Math.Max(area.Left, area.Right - size.Width)),
                    Math.Clamp(_fullBounds.Top, area.Top, Math.Max(area.Top, area.Bottom - size.Height)),
                    size.Width, size.Height));
            }
            else
            {
                _mini = false;
                if (_fullBounds.Width > 0) await SetWindowBounds(_fullBounds);
                if (_fullMaximized) await SetWindowState("maximized");
            }
        }
        catch (CdpException) { }
    }

    /// <summary>Brings the window to the front, for a second launch of Tint.</summary>
    public void BringForward() => _ = Task.Run(async () =>
    {
        if (_mainTarget == null) return;
        try
        {
            var now = (await Cdp.Send("Browser.getWindowBounds", new JsonObject { ["windowId"] = _windowId }))["bounds"] as JsonObject;
            if (now?["windowState"]?.GetValue<string>() == "minimized") await SetWindowState(_maximized ? "maximized" : "normal");
            await Cdp.Send("Target.activateTarget", new JsonObject { ["targetId"] = _mainTarget });
        }
        catch (CdpException) { }
    });

    // The page sets its own theme-color, which is what colours the frame of a browser app window.
    public void TintChrome(Color background, Color text, bool instant) { }

    // The browser feeds the system's media controls from the page's Media Session (see system.js).
    public void ShowNowPlaying(SystemTrack? track, bool playing, long at) { }

    // ---- album art -------------------------------------------------------------------------------

    /// <summary>
    /// A JPEG thumbnail of a cover, drawn by the browser: there is no GDI+ here, and the browser's
    /// image decoders are well kept and run sandboxed, which suits pictures taken from music files.
    /// </summary>
    public async Task<byte[]?> Thumbnail(byte[] image, int size)
    {
        const string Draw = """
            (async (data, size) => {
              const picture = await createImageBitmap(await (await fetch('data:application/octet-stream;base64,' + data)).blob());
              const scale = Math.min(1, size / Math.min(picture.width, picture.height));
              const w = Math.max(1, Math.round(picture.width * scale)), h = Math.max(1, Math.round(picture.height * scale));
              const canvas = new OffscreenCanvas(w, h);
              const g = canvas.getContext('2d');
              g.imageSmoothingQuality = 'high';
              g.fillStyle = '#000';
              g.fillRect(0, 0, w, h);
              g.drawImage(picture, 0, 0, w, h);
              picture.close();
              const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.88 });
              const url = await new Promise((done) => { const r = new FileReader(); r.onload = () => done(r.result); r.readAsDataURL(jpeg); });
              return url.slice(url.indexOf(',') + 1);
            })
            """;
        try
        {
            var made = await Evaluate($"{Draw}({JsonValue.Create(Convert.ToBase64String(image)).ToJsonString()}, {size})", awaitPromise: true);
            return made is JsonValue v && v.TryGetValue<string>(out var text) ? Convert.FromBase64String(text) : null;
        }
        catch
        {
            return null; // not a picture the browser can read
        }
    }

    // ---- choosing files --------------------------------------------------------------------------

    public async Task<string?> PickFolder()
    {
        var music = Environment.GetFolderPath(Environment.SpecialFolder.MyMusic);
        if (Dialogs.Available) return await Dialogs.PickFolder("Choose a folder that holds music", music);
        // No dialog program on this system: the page asks for the path in words instead.
        return Expand(await Prompt("Type the full path of a folder that holds music:", music));
    }

    public async Task<string?> PickKeyFile()
    {
        if (Dialogs.Available) return await Dialogs.PickFile("Choose your MusicKit private key", "MusicKit private key", "*.p8");
        return Expand(await Prompt("Type the full path of your MusicKit private key (.p8):", ""));
    }

    async Task<string?> Prompt(string question, string suggestion)
    {
        try
        {
            var answer = await Evaluate($"prompt({JsonValue.Create(question).ToJsonString()}, {JsonValue.Create(suggestion).ToJsonString()})");
            return answer is JsonValue v && v.TryGetValue<string>(out var text) && text.Trim().Length > 0 ? text.Trim() : null;
        }
        catch (CdpException)
        {
            return null;
        }
    }

    static string? Expand(string? path) =>
        path == null ? null
        : path == "~" || path.StartsWith("~/", StringComparison.Ordinal) ? Environment.GetFolderPath(Environment.SpecialFolder.UserProfile) + path[1..]
        : path;
}
