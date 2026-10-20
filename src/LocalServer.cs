using System.Diagnostics;
using System.Drawing;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Tint;

/// <summary>
/// Serves the UI, the local music files and a small JSON API to the embedded browser over loopback.
/// A fixed port keeps the page's origin stable, which is what lets the Apple Music sign-in persist.
/// </summary>
sealed class LocalServer : IDisposable
{
    const int FirstPort = 47813;

    static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    static readonly Dictionary<string, string> Mime = new(StringComparer.OrdinalIgnoreCase)
    {
        [".html"] = "text/html; charset=utf-8",
        [".css"] = "text/css; charset=utf-8",
        [".js"] = "text/javascript; charset=utf-8",
        [".json"] = "application/json; charset=utf-8",
        [".svg"] = "image/svg+xml",
        [".png"] = "image/png",
        [".jpg"] = "image/jpeg",
        [".ico"] = "image/x-icon",
        [".woff2"] = "font/woff2",
        [".mp3"] = "audio/mpeg",
        [".m4a"] = "audio/mp4",
        [".m4b"] = "audio/mp4",
        [".aac"] = "audio/aac",
        [".flac"] = "audio/flac",
        [".wav"] = "audio/wav",
        [".ogg"] = "audio/ogg",
        [".oga"] = "audio/ogg",
        [".opus"] = "audio/ogg",
    };

    public static string MimeFor(string path) => Mime.GetValueOrDefault(Path.GetExtension(path), "application/octet-stream");

    readonly IHost _host;
    readonly Settings _settings;
    readonly Library _library;
    readonly AppleToken _token;
    readonly DiscordPresence _discord;
    readonly YouTube _youtube;
    readonly Lyrics _lyrics;
    readonly Updater _updater;
    readonly string _webRoot;
    HttpListener? _listener;

    public int Port { get; private set; }
    public string Origin => $"http://127.0.0.1:{Port}";

    public LocalServer(IHost host, Settings settings, Library library, AppleToken token, DiscordPresence discord, YouTube youtube, Updater updater, string webRoot)
    {
        _updater = updater;
        _youtube = youtube;
        _lyrics = new Lyrics(youtube);
        _host = host;
        _settings = settings;
        _library = library;
        _token = token;
        _discord = discord;
        _webRoot = Path.GetFullPath(webRoot);
    }

    public void Start()
    {
        for (int port = FirstPort; port < FirstPort + 12; port++)
        {
            var listener = new HttpListener();
            listener.Prefixes.Add($"http://127.0.0.1:{port}/");
            try
            {
                listener.Start();
                _listener = listener;
                Port = port;
                _ = AcceptLoop(listener);
                return;
            }
            catch (HttpListenerException)
            {
                listener.Close();
            }
        }
        throw new InvalidOperationException("Tint couldn't open a local port to serve its interface.");
    }

    async Task AcceptLoop(HttpListener listener)
    {
        while (listener.IsListening)
        {
            HttpListenerContext context;
            try { context = await listener.GetContextAsync(); }
            catch { break; }
            _ = Task.Run(() => Handle(context));
        }
    }

    async Task Handle(HttpListenerContext context)
    {
        var req = context.Request;
        var res = context.Response;
        try
        {
            if (!IsOurPage(req))
            {
                res.StatusCode = 403;
                return;
            }

            var path = Uri.UnescapeDataString(req.Url!.AbsolutePath);
            if (path.StartsWith("/media/", StringComparison.Ordinal)) await ServeMedia(req, res, path[7..]);
            else if (path.StartsWith("/art/", StringComparison.Ordinal)) await ServeArt(req, res, path[5..]);
            else if (path.StartsWith("/api/", StringComparison.Ordinal)) await ServeApi(req, res, path[5..]);
            else await ServeStatic(req, res, path);
        }
        catch (HttpListenerException) { /* the page stopped listening, e.g. it skipped to another song */ }
        catch (IOException) { }
        catch (ObjectDisposedException) { }
        catch (Exception ex)
        {
            try
            {
                res.StatusCode = 500;
                await WriteJson(res, new { error = ex.Message });
            }
            catch { }
        }
        finally
        {
            try { res.Close(); } catch { }
        }
    }

    /// <summary>
    /// Only the app's own page may talk to this server. Checking Host stops DNS-rebinding, checking Origin
    /// stops other sites, and the custom header on writes can't be sent cross-site without a preflight.
    /// </summary>
    bool IsOurPage(HttpListenerRequest req)
    {
        var host = req.Headers["Host"];
        if (host != $"127.0.0.1:{Port}" && host != $"localhost:{Port}") return false;

        var origin = req.Headers["Origin"];
        if (origin != null && origin != Origin && origin != $"http://localhost:{Port}") return false;

        if (req.HttpMethod is not ("GET" or "HEAD") && req.Headers["X-Tint"] != "1") return false;
        return true;
    }

    // ---- static files --------------------------------------------------------------------------

    async Task ServeStatic(HttpListenerRequest req, HttpListenerResponse res, string path)
    {
        if (path == "/") path = "/index.html";
        var file = Path.GetFullPath(Path.Combine(_webRoot, path.TrimStart('/').Replace('/', Path.DirectorySeparatorChar)));
        if (!file.StartsWith(_webRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) || !File.Exists(file))
        {
            res.StatusCode = 404;
            return;
        }
        res.AddHeader("Cache-Control", "no-cache");
        await SendFile(req, res, file, Mime.GetValueOrDefault(Path.GetExtension(file), "application/octet-stream"));
    }

    async Task ServeMedia(HttpListenerRequest req, HttpListenerResponse res, string id)
    {
        var track = _library.Find(id);
        if (track == null || !track.Playable || !File.Exists(track.Path))
        {
            res.StatusCode = 404;
            return;
        }
        res.AddHeader("Cache-Control", "no-store");
        await SendFile(req, res, track.Path, Mime.GetValueOrDefault(Path.GetExtension(track.Path), "application/octet-stream"));
    }

    async Task ServeArt(HttpListenerRequest req, HttpListenerResponse res, string key)
    {
        int.TryParse(req.QueryString["s"], out var size);
        var file = await _library.ArtFile(key, size <= 0 ? 320 : size);
        if (file == null)
        {
            res.StatusCode = 404;
            return;
        }
        // The key changes whenever the source artwork does, so the browser may keep these forever.
        res.AddHeader("Cache-Control", "public, max-age=31536000, immutable");
        await SendFile(req, res, file, "image/jpeg");
    }

    static async Task SendFile(HttpListenerRequest req, HttpListenerResponse res, string file, string mime)
    {
        await using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete,
            64 * 1024, FileOptions.Asynchronous | FileOptions.SequentialScan);
        long length = stream.Length, start, end;

        res.ContentType = mime;
        res.AddHeader("Accept-Ranges", "bytes");

        switch (HttpRange.Parse(req.Headers["Range"], length, out start, out end))
        {
            case HttpRange.Result.Invalid:
                res.StatusCode = 416;
                res.AddHeader("Content-Range", $"bytes */{length}");
                return;
            case HttpRange.Result.Partial:
                res.StatusCode = 206;
                res.AddHeader("Content-Range", $"bytes {start}-{end}/{length}");
                break;
        }

        long remaining = length == 0 ? 0 : end - start + 1;
        res.ContentLength64 = remaining;
        if (req.HttpMethod == "HEAD") return;

        stream.Position = start;
        var buffer = new byte[64 * 1024];
        while (remaining > 0)
        {
            int read = await stream.ReadAsync(buffer.AsMemory(0, (int)Math.Min(buffer.Length, remaining)));
            if (read == 0) break;
            await res.OutputStream.WriteAsync(buffer.AsMemory(0, read));
            remaining -= read;
        }
    }

    // ---- API -----------------------------------------------------------------------------------

    async Task ServeApi(HttpListenerRequest req, HttpListenerResponse res, string route)
    {
        res.AddHeader("Cache-Control", "no-store");
        bool post = req.HttpMethod == "POST";
        JsonNode? body = null;
        if (post && req.HasEntityBody)
        {
            using var reader = new StreamReader(req.InputStream, Encoding.UTF8);
            var text = await reader.ReadToEndAsync();
            if (text.Length > 0) body = JsonNode.Parse(text);
        }

        switch (route)
        {
            case "library":
                await WriteJson(res, LibraryPayload());
                return;

            case "library/status":
                await WriteJson(res, new { version = _library.Version, scanning = _library.Scanning, done = _library.Done, total = _library.Total });
                return;

            case "rescan" when post:
                _library.Rescan();
                await WriteJson(res, new { ok = true });
                return;

            case "settings" when !post:
                await WriteJson(res, SettingsPayload());
                return;

            case "settings" when post:
                ApplySettings(body);
                await WriteJson(res, SettingsPayload());
                return;

            case "pick-folder" when post:
                await WriteJson(res, new { path = await _host.PickFolder() });
                return;

            case "pick-key" when post:
                await WriteJson(res, await PickKey());
                return;

            case "apple-token":
                {
                    var (token, error, source) = await _token.Get(fresh: req.QueryString["fresh"] == "1");
                    await WriteJson(res, new { token, error, source });
                    return;
                }

            case "chrome" when post:
                {
                    var bg = ParseColor(body?["bg"]?.GetValue<string>());
                    var fg = ParseColor(body?["fg"]?.GetValue<string>());
                    if (bg != null && fg != null) _host.TintChrome(bg.Value, fg.Value, body?["instant"]?.GetValue<bool>() ?? false);
                    await WriteJson(res, new { ok = true });
                    return;
                }

            case "mini" when post:
                {
                    bool on = body?["on"]?.GetValue<bool>() ?? false;
                    _host.SetMini(on);
                    await WriteJson(res, new { ok = true });
                    return;
                }

            case "presence" when post:
                _discord.Update(ReadNowPlaying(body));
                await WriteJson(res, new { ok = true });
                return;

            case "update" when !post:
                await WriteJson(res, await _updater.Status(check: req.QueryString["check"] == "1", force: req.QueryString["force"] == "1"));
                return;

            case "update/download" when post:
                _updater.Download();
                await WriteJson(res, await _updater.Status(check: false));
                return;

            case "update/restart" when post:
                {
                    bool ok = _updater.Apply();
                    await WriteJson(res, await _updater.Status(check: false));
                    if (ok) _host.Quit();
                    return;
                }

            case "youtube/status":
                await WriteJson(res, await _youtube.Status());
                return;

            case "youtube/install" when post:
                try
                {
                    await _youtube.Install();
                    await WriteJson(res, new { ok = true });
                }
                catch (Exception ex)
                {
                    await WriteJson(res, new { ok = false, error = ex.Message });
                }
                return;

            case "youtube/tokens" when post:
                try
                {
                    await _youtube.InstallTokens();
                    await WriteJson(res, new { ok = true });
                }
                catch (Exception ex)
                {
                    await WriteJson(res, new { ok = false, error = ex.Message });
                }
                return;

            case "youtube/signin" when post:
                await WriteJson(res, new { ok = await _host.YouTubeSignIn() });
                return;

            case "youtube/signout" when post:
                await _host.YouTubeSignOut();
                await WriteJson(res, new { ok = true });
                return;

            case "youtube/page" when post:
                {
                    bool again = body?["again"]?.GetValue<bool>() ?? false;
                    // The site plays at the quality set in the account, so that is put to High first.
                    await _youtube.PreferHighQuality();
                    await WriteJson(res, new { ok = await _host.OpenYouTubePage(again) });
                    return;
                }

            case "youtube/stream":
                try
                {
                    var stream = await _youtube.Stream(req.QueryString["id"] ?? "", fresh: req.QueryString["fresh"] == "1");
                    await WriteJson(res, new { url = stream.Url, format = stream.Format, codec = stream.Codec, kbps = Math.Round(stream.Kbps) });
                }
                catch (Exception ex)
                {
                    // Said in words on the page, so it travels as an answer and not as a failed request.
                    await WriteJson(res, new { error = ex.Message, refused = ex is YouTubeRefusedException });
                }
                return;

            case "youtube/call" when post:
                {
                    var answer = Encoding.UTF8.GetBytes(await _youtube.Call(body?["endpoint"]?.GetValue<string>() ?? "", body?["body"], body?["next"]?.GetValue<string>()));
                    res.ContentType = "application/json; charset=utf-8";
                    res.ContentLength64 = answer.Length;
                    await res.OutputStream.WriteAsync(answer);
                    return;
                }

            case "lyrics":
                {
                    var q = req.QueryString;
                    double.TryParse(q["duration"], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var duration);
                    try
                    {
                        var found = await _lyrics.Find(q["youtube"], q["title"] ?? "", q["artist"] ?? "", q["album"] ?? "", duration);
                        await WriteJson(res, new { found });
                    }
                    catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or System.Text.Json.JsonException)
                    {
                        res.StatusCode = 502;
                        await WriteJson(res, new { error = "The lyrics services didn't answer. Try again in a moment." });
                    }
                    return;
                }

            case "system" when post:
                {
                    var track = await ReadSystemTrack(body);
                    bool playing = body?["playing"]?.GetValue<bool>() ?? false;
                    long at = body?["at"]?.GetValue<long>() ?? 0;
                    _host.ShowNowPlaying(track, playing, at);
                    await WriteJson(res, new { ok = true });
                    return;
                }

#if DEBUG
            case "debug/youtube-quality":
                await WriteJson(res, new { ok = await _youtube.SetQuality(int.Parse(req.QueryString["level"] ?? "3")) });
                return;

#if WINDOWS
            case "debug/taskbar" when _host is MainForm form:
                await WriteJson(res, new { attached = form.OnUi(() => form.TaskbarButtonsAttached) });
                return;
#endif

            case "debug/cover":
                await WriteJson(res, new { url = await _discord.FindCover(req.QueryString["artist"] ?? "", req.QueryString["album"] ?? "") });
                return;
#endif

            case "discord/status":
                await WriteJson(res, new { status = _discord.Status, user = _discord.User, problem = _discord.Problem });
                return;

            case "open" when post:
                {
                    // Help links only. Anything else stays inside the app.
                    var url = body?["url"]?.GetValue<string>() ?? "";
                    bool allowed = url.StartsWith("https://developer.apple.com/", StringComparison.Ordinal)
                        || url.StartsWith("https://discord.com/developers/", StringComparison.Ordinal)
                        || url == "https://music.apple.com/account/settings"
                        || url.StartsWith("https://github.com/akaydevelop/TintMusicPlayer/releases/", StringComparison.Ordinal);
                    if (allowed) Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
                    await WriteJson(res, new { ok = allowed });
                    return;
                }
        }

        res.StatusCode = 404;
    }

    object LibraryPayload()
    {
        var tracks = _library.Tracks;
        return new
        {
            version = _library.Version,
            scanning = _library.Scanning,
            skippedProtected = _library.Protected,
            tracks = tracks.Select(t => new
            {
                id = t.Id,
                title = t.Title,
                artist = t.Artist,
                albumArtist = t.AlbumArtist,
                album = t.Album,
                genre = t.Genre,
                trackNo = t.TrackNo,
                discNo = t.DiscNo,
                year = t.Year,
                duration = Math.Round(t.Duration, 2),
                art = t.ArtKey,
                added = t.Added,
                playable = t.Playable,
                reason = t.Reason,
            }),
        };
    }

    /// <summary>What the page says is playing, or null when it is paused or stopped.</summary>
    static NowPlaying? ReadNowPlaying(JsonNode? body)
    {
        if (body is not JsonObject o || o["playing"]?.GetValue<bool>() != true) return null;
        var title = o["title"]?.GetValue<string>();
        if (string.IsNullOrWhiteSpace(title)) return null;

        // Discord fetches the cover itself, so only a public https address is any use to it.
        var art = o["art"]?.GetValue<string>();
        if (art != null && !(Uri.TryCreate(art, UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps)) art = null;

        return new NowPlaying(
            title,
            o["artist"]?.GetValue<string>() ?? "",
            o["album"]?.GetValue<string>() ?? "",
            Math.Max(0, o["duration"]?.GetValue<double>() ?? 0),
            Math.Max(0, o["position"]?.GetValue<double>() ?? 0),
            art,
            DateTimeOffset.UtcNow);
    }

    /// <summary>The current song for the system's media controls, or null when the queue is empty.</summary>
    async Task<SystemTrack?> ReadSystemTrack(JsonNode? body)
    {
        if (body is not JsonObject o) return null;
        var title = o["title"]?.GetValue<string>();
        if (string.IsNullOrWhiteSpace(title)) return null;

        // A cover is either one of the library's own thumbnails or a public address at Apple.
        string? artFile = null, artUrl = null;
        if (o["artKey"]?.GetValue<string>() is { } key) artFile = await _library.ArtFile(key, 320);
        else if (o["artUrl"]?.GetValue<string>() is { } url && Uri.TryCreate(url, UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps) artUrl = url;

        return new SystemTrack(title, o["artist"]?.GetValue<string>() ?? "", o["album"]?.GetValue<string>() ?? "", artFile, artUrl);
    }

    object SettingsPayload() => new
    {
        folders = _settings.Folders,
        keepDark = _settings.KeepDark,
        discord = new { enabled = _settings.DiscordEnabled, appId = _settings.DiscordAppId ?? "" },
        youtube = _settings.YouTubeEnabled,
        youtubePlayer = _settings.YouTubePlayer,
        apple = new
        {
            teamId = _settings.AppleTeamId ?? "",
            keyId = _settings.AppleKeyId ?? "",
            hasKey = !string.IsNullOrEmpty(_settings.ApplePrivateKeyProtected),
            hasToken = !string.IsNullOrEmpty(_settings.AppleRawTokenProtected),
            useWeb = _settings.AppleUseWebToken,
        },
    };

    void ApplySettings(JsonNode? body)
    {
        if (body is not JsonObject o) return;
        bool foldersChanged = false;

        if (o["folders"] is JsonArray folders)
        {
            var next = folders.Select(f => f?.GetValue<string>() ?? "").Where(f => f.Length > 0 && Directory.Exists(f))
                .Distinct(StringComparer.OrdinalIgnoreCase).ToList();
            foldersChanged = !next.SequenceEqual(_settings.Folders, StringComparer.OrdinalIgnoreCase);
            _settings.Folders = next;
        }
        if (o["keepDark"] is JsonValue keepDark) _settings.KeepDark = keepDark.GetValue<bool>();
        if (o["youtube"] is JsonValue youtube) _settings.YouTubeEnabled = youtube.GetValue<bool>();
        if (o["youtubePlayer"] is JsonValue youtubePlayer) _settings.YouTubePlayer = youtubePlayer.GetValue<string>() == "ytdlp" ? "ytdlp" : "page";
        if (o["appleTeamId"] is JsonValue team) _settings.AppleTeamId = team.GetValue<string>().Trim();
        if (o["appleKeyId"] is JsonValue keyId) _settings.AppleKeyId = keyId.GetValue<string>().Trim();
        if (o["appleToken"] is JsonValue token)
        {
            var value = token.GetValue<string>().Trim();
            _settings.AppleRawTokenProtected = value.Length == 0 ? null : Settings.Protect(value);
        }
        if (o["appleUseWeb"] is JsonValue useWeb) _settings.AppleUseWebToken = useWeb.GetValue<bool>();
        if (o["forgetApple"] is JsonValue forget && forget.GetValue<bool>())
        {
            _settings.AppleTeamId = _settings.AppleKeyId = null;
            _settings.ApplePrivateKeyProtected = _settings.AppleRawTokenProtected = null;
            _settings.AppleUseWebToken = false;
        }

        bool discordChanged = false;
        if (o["discordEnabled"] is JsonValue discordOn)
        {
            _settings.DiscordEnabled = discordOn.GetValue<bool>();
            discordChanged = true;
        }
        if (o["discordAppId"] is JsonValue discordId)
        {
            // Application IDs are long numbers. Anything else is a paste gone wrong, so it isn't kept.
            var value = discordId.GetValue<string>().Trim();
            _settings.DiscordAppId = value.Length is >= 15 and <= 22 && value.All(char.IsAsciiDigit) ? value : null;
            discordChanged = true;
        }

        _settings.Save();
        if (foldersChanged) _library.Rescan();
        if (discordChanged) _discord.Reconfigure();
    }

    async Task<object> PickKey()
    {
        var file = await _host.PickKeyFile();
        if (file == null) return new { ok = false, cancelled = true };
        try
        {
            var info = new FileInfo(file);
            if (info.Length > 16 * 1024) throw new InvalidDataException("That file is too large to be a MusicKit key.");
            var pem = File.ReadAllText(file);
            AppleToken.Validate(pem);
            _settings.ApplePrivateKeyProtected = Settings.Protect(pem);

            // Apple names the download AuthKey_<KeyID>.p8, so the Key ID can usually be filled in for free.
            string? keyId = null;
            var name = Path.GetFileNameWithoutExtension(file);
            if (name.StartsWith("AuthKey_", StringComparison.OrdinalIgnoreCase) && name.Length == 18)
            {
                keyId = name[8..];
                if (string.IsNullOrEmpty(_settings.AppleKeyId)) _settings.AppleKeyId = keyId;
            }
            _settings.Save();
            return new { ok = true, keyId };
        }
        catch (Exception ex)
        {
            return new { ok = false, error = "That doesn't look like a MusicKit private key (.p8). " + ex.Message };
        }
    }

    static Color? ParseColor(string? hex)
    {
        if (hex == null || hex.Length != 7 || hex[0] != '#') return null;
        return int.TryParse(hex.AsSpan(1), System.Globalization.NumberStyles.HexNumber, null, out var rgb)
            ? Color.FromArgb(255, (rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255)
            : null;
    }

    static async Task WriteJson(HttpListenerResponse res, object payload)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(payload, Json);
        res.ContentType = "application/json; charset=utf-8";
        res.ContentLength64 = bytes.Length;
        await res.OutputStream.WriteAsync(bytes);
    }

    public void Dispose()
    {
        try { _listener?.Close(); } catch { }
    }
}
