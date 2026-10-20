using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Tint;

/// <summary>YouTube turned this connection away, which no other song in the queue would fare better against.</summary>
sealed class YouTubeRefusedException(string message) : Exception(message);

/// <summary>Where one YouTube song can be played from right now, and what kind of audio it is.</summary>
sealed record YouTubeStream(string Url, string Format, string Codec, double Kbps, DateTimeOffset Expires);

/// <summary>
/// YouTube Music in two halves. Questions about the catalog (search, albums, artists, playlists)
/// go to the service behind music.youtube.com, the same one that site asks. Getting a song's audio
/// is left to yt-dlp, a separate program that keeps up with YouTube's changes far better than
/// anything written here could. yt-dlp is not part of Tint: it is used from PATH, or from a copy
/// Tint downloads into its own data folder when asked to.
///
/// Signed out, YouTube sends its standard audio. For a Premium account's better audio, yt-dlp has
/// to ask as that person (their Google sign-in, kept here as a cookie file yt-dlp reads) and has to
/// ask the way the YouTube Music site does, which takes a token (see <see cref="YouTubeTokens"/>).
/// </summary>
sealed partial class YouTube : IDisposable
{
    const string Releases = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/";
    // The site sends its own version with every question. The service only checks that one is there.
    const string SiteVersion = "1.20260101.01.00";
    const string Site = "https://music.youtube.com";
    const string Browser = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

    static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(60) };
    static readonly string Folder = Path.Combine(Paths.Data, "youtube");
    static readonly string OwnTool = Path.Combine(Folder, Exe("yt-dlp"));
    // yt-dlp publishes one ready-to-run file per system; the Linux ones need no Python installed.
    static readonly string ReleaseFile = OperatingSystem.IsWindows() ? "yt-dlp.exe"
        : System.Runtime.InteropServices.RuntimeInformation.OSArchitecture == System.Runtime.InteropServices.Architecture.Arm64 ? "yt-dlp_linux_aarch64"
        : "yt-dlp_linux";
    static readonly string CookieFile = Path.Combine(Folder, "cookies.txt");

    readonly ConcurrentDictionary<string, Task<YouTubeStream>> _streams = new();
    readonly YouTubeTokens _tokens = new(Http, Folder);
    // yt-dlp writes the cookie file back when it finishes, so signed-in fetches take turns.
    readonly SemaphoreSlim _cookieGate = new(1);

    [GeneratedRegex("^[A-Za-z0-9_-]{11}$")]
    private static partial Regex VideoId();

    [GeneratedRegex(@"[?&]expire=(\d+)")]
    private static partial Regex Expiry();

    // ---- yt-dlp ---------------------------------------------------------------------------------

    /// <summary>Tint's own copy when there is one (it is the one kept up to date), else whatever PATH offers.</summary>
    static string? Tool() => File.Exists(OwnTool) ? OwnTool : OnPath(Exe("yt-dlp"));

    static string? Deno() => OnPath(Exe("deno"));

    /// <summary>A program's file name as it is on this system: "deno.exe" on Windows, "deno" elsewhere.</summary>
    internal static string Exe(string name) => OperatingSystem.IsWindows() ? name + ".exe" : name;

    static string? OnPath(string file) =>
        (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(folder => { try { return Path.Combine(folder, file); } catch { return ""; } })
            .FirstOrDefault(File.Exists);

    public async Task<object> Status()
    {
        var tool = Tool();
        string? version = null;
        if (tool != null)
        {
            try { version = (await Run(tool, TimeSpan.FromSeconds(20), "--version")).Output.Trim(); }
            catch { /* shown as "found, but it won't start" */ }
        }
        return new
        {
            tool = tool == null ? null : tool == OwnTool ? "own" : "path",
            version,
            // yt-dlp hands YouTube's player script to a JavaScript runtime. Without one it gets very little.
            runtime = Deno() != null || OnPath(Exe("node")) != null,
            deno = Deno() != null,
            signedIn = SignedIn,
            tokens = _tokens.Installed,
        };
    }

    // ---- the Google sign-in ---------------------------------------------------------------------

    public bool SignedIn => File.Exists(CookieFile);

    /// <summary>
    /// Keeps a Google sign-in for yt-dlp, in the cookie-file format it reads. Only YouTube's own
    /// cookies are passed in and kept, so the file is no use for the rest of the Google account.
    /// </summary>
    public void SaveCookies(IEnumerable<(string Domain, string Path, bool Secure, bool HttpOnly, long Expires, string Name, string Value)> cookies)
    {
        var text = new StringBuilder("# Netscape HTTP Cookie File\n# Written by Tint for yt-dlp. Anyone holding this file is signed in to YouTube as you.\n\n");
        foreach (var c in cookies)
        {
            text.Append(c.HttpOnly ? "#HttpOnly_" : "").Append(c.Domain).Append('\t')
                .Append(c.Domain.StartsWith('.') ? "TRUE" : "FALSE").Append('\t')
                .Append(c.Path).Append('\t')
                .Append(c.Secure ? "TRUE" : "FALSE").Append('\t')
                .Append(c.Expires).Append('\t')
                .Append(c.Name).Append('\t')
                .Append(c.Value).Append('\n');
        }
        Directory.CreateDirectory(Folder);
        File.WriteAllText(CookieFile, text.ToString(), new UTF8Encoding(false));
        _streams.Clear();
    }

    public void ForgetCookies()
    {
        try { File.Delete(CookieFile); } catch { }
        _streams.Clear();
    }

    /// <summary>Downloads the token add-on (and yt-dlp itself, if Tint has no copy of its own to load it into).</summary>
    public async Task InstallTokens()
    {
        var deno = Deno() ?? throw new InvalidOperationException("The token helper runs on Deno, which isn't on this computer. Install Deno, then start Tint again.");
        if (!File.Exists(OwnTool)) await Install();
        await _tokens.Install(deno);
        _streams.Clear();
    }

    public void Dispose() => _tokens.Dispose();

    /// <summary>Downloads the current yt-dlp into Tint's data folder, replacing an older copy.</summary>
    public async Task Install()
    {
        Directory.CreateDirectory(Folder);
        var bytes = await Http.GetByteArrayAsync(Releases + ReleaseFile);

        // The release lists a SHA-256 for every file in it. A download that doesn't match is not kept.
        var sums = await Http.GetStringAsync(Releases + "SHA2-256SUMS");
        var wanted = sums.Split('\n').Select(line => line.Split(' ', StringSplitOptions.RemoveEmptyEntries))
            .FirstOrDefault(parts => parts.Length == 2 && parts[1].Trim().TrimStart('*') == ReleaseFile)?[0];
        var got = Convert.ToHexString(SHA256.HashData(bytes));
        if (wanted == null || !got.Equals(wanted, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("The yt-dlp download didn't match its published checksum, so it wasn't kept.");

        var tmp = OwnTool + ".tmp";
        await File.WriteAllBytesAsync(tmp, bytes);
        if (!OperatingSystem.IsWindows())
            File.SetUnixFileMode(tmp, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        File.Move(tmp, OwnTool, overwrite: true);
        _streams.Clear();
    }

    /// <summary>Finds the best audio YouTube offers for a song. Answers are reused until they expire.</summary>
    public Task<YouTubeStream> Stream(string id, bool fresh)
    {
        if (!VideoId().IsMatch(id)) throw new ArgumentException("That isn't a YouTube song.");
        if (!fresh && _streams.TryGetValue(id, out var known) &&
            (!known.IsCompleted || (known.IsCompletedSuccessfully && known.Result.Expires > DateTimeOffset.UtcNow.AddMinutes(10))))
            return known;

        var task = Task.Run(() => Fetch(id));
        _streams[id] = task;
        // A failure isn't worth remembering: the next try may well work.
        task.ContinueWith(_ => _streams.TryRemove(new KeyValuePair<string, Task<YouTubeStream>>(id, task)), TaskContinuationOptions.NotOnRanToCompletion);
        return task;
    }

    async Task<YouTubeStream> Fetch(string id)
    {
        var tool = Tool() ?? throw new InvalidOperationException("YouTube songs need yt-dlp. Settings, under YouTube Music, can fetch it.");
        // "bestaudio" is the highest bitrate on offer, and Opus over AAC when they tie.
        var arguments = new List<string> { "--no-playlist", "--no-warnings", "-f", "bestaudio", "--print", "%(format_id)s\t%(acodec)s\t%(abr)s\t%(url)s" };

        bool signedIn = SignedIn;
        if (signedIn)
        {
            // Premium's audio is only offered to the YouTube Music site's player ("web_music"). The
            // usual players stay in the list so a song still plays if that one is turned away.
            arguments.AddRange(["--cookies", CookieFile, "--extractor-args", "youtube:player_client=web_music,default"]);
            // Plug-ins are only looked for next to Tint's own yt-dlp.
            if (tool == OwnTool && await _tokens.Address(Deno()) is { } helper)
                arguments.AddRange(["--extractor-args", "youtubepot-bgutilhttp:base_url=" + helper]);
        }
        arguments.AddRange(["--", (signedIn ? "https://music.youtube.com/watch?v=" : "https://www.youtube.com/watch?v=") + id]);

        int code;
        string output, errors;
        if (signedIn) await _cookieGate.WaitAsync();
        try
        {
            if (signedIn) await FreshCookies();
            (code, output, errors) = await Run(tool, TimeSpan.FromSeconds(signedIn ? 90 : 60), arguments.ToArray());
        }
        finally
        {
            if (signedIn) _cookieGate.Release();
        }

        var parts = output.Trim().Split('\t');
        if (code != 0 || parts.Length != 4 || !Uri.TryCreate(parts[3], UriKind.Absolute, out var address) || address.Scheme != Uri.UriSchemeHttps)
        {
            var reason = errors.Split('\n').Select(line => line.Trim()).LastOrDefault(line => line.StartsWith("ERROR:", StringComparison.Ordinal));
            // YouTube's check on listeners it can't place. yt-dlp's own advice for it is a Google sign-in.
            if (reason != null && reason.Contains("not a bot", StringComparison.OrdinalIgnoreCase))
                throw new YouTubeRefusedException(signedIn
                    ? "YouTube is asking for a sign-in even though Tint has one, so it has probably expired. Sign out and in again in Settings, under YouTube Music."
                    : "YouTube won't send this song to this connection without a Google sign-in. It does this when it suspects a program is asking.");
            throw new InvalidOperationException(reason == null
                ? "yt-dlp couldn't get this song from YouTube."
                : "yt-dlp couldn't get this song: " + Regex.Replace(reason[6..], @"^\s*\[[^\]]+\]\s*\S+:\s*", "").Trim());
        }

        double.TryParse(parts[2], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var kbps);
        // The address says when YouTube stops honouring it (about six hours on).
        var expires = Expiry().Match(parts[3]) is { Success: true } m && long.TryParse(m.Groups[1].Value, out var unix)
            ? DateTimeOffset.FromUnixTimeSeconds(unix)
            : DateTimeOffset.UtcNow.AddHours(1);
        return new YouTubeStream(parts[3], parts[0], parts[1].StartsWith("mp4a", StringComparison.Ordinal) ? "AAC" : parts[1] == "opus" ? "Opus" : parts[1], kbps, expires);
    }

    static async Task<(int Code, string Output, string Errors)> Run(string tool, TimeSpan limit, params string[] arguments)
    {
        var start = new ProcessStartInfo(tool)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        foreach (var argument in arguments) start.ArgumentList.Add(argument);
        start.Environment["PYTHONIOENCODING"] = "utf-8";

        using var process = Process.Start(start) ?? throw new InvalidOperationException("yt-dlp wouldn't start.");
        using var timeout = new CancellationTokenSource(limit);
        try
        {
            var output = process.StandardOutput.ReadToEndAsync(timeout.Token);
            var errors = process.StandardError.ReadToEndAsync(timeout.Token);
            await process.WaitForExitAsync(timeout.Token);
            return (process.ExitCode, await output, await errors);
        }
        catch (OperationCanceledException)
        {
            try { process.Kill(entireProcessTree: true); } catch { }
            throw new TimeoutException("yt-dlp took too long to answer.");
        }
    }

    // ---- the catalog ----------------------------------------------------------------------------

    /// <summary>
    /// Asks YouTube Music's own service a question and returns its answer as it came. With a Google
    /// sign-in the question is asked as that person, which is what makes their library answer.
    /// `next` is the older of YouTube's two ways of asking for the following page of a list.
    /// </summary>
    public async Task<string> Call(string endpoint, JsonNode? body, string? next)
    {
        if (endpoint is not ("search" or "browse" or "next")) throw new ArgumentException("Tint doesn't ask YouTube Music that.");
        var question = body as JsonObject ?? new JsonObject();
        question["context"] = new JsonObject
        {
            ["client"] = new JsonObject { ["clientName"] = "WEB_REMIX", ["clientVersion"] = SiteVersion, ["hl"] = "en" },
        };
        var address = $"{Site}/youtubei/v1/{endpoint}?prettyPrint=false";
        if (!string.IsNullOrEmpty(next)) address += $"&ctoken={Uri.EscapeDataString(next)}&continuation={Uri.EscapeDataString(next)}&type=next";
        var text = question.ToJsonString();

        await FreshCookies();
        var cookies = Cookies();
        using var reply = await Ask(address, text, cookies);
        // A sign-in YouTube no longer accepts shouldn't take search and the catalog down with it.
        if (cookies != null && reply.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
        {
            using var plain = await Ask(address, text, null);
            if (!plain.IsSuccessStatusCode) throw new HttpRequestException($"YouTube Music answered {(int)plain.StatusCode}.");
            return await plain.Content.ReadAsStringAsync();
        }
        if (!reply.IsSuccessStatusCode) throw new HttpRequestException($"YouTube Music answered {(int)reply.StatusCode}.");
        return await reply.Content.ReadAsStringAsync();
    }

    // ---- lyrics ---------------------------------------------------------------------------------

    // YouTube Music's Android app is sent lyrics with times; its web page only gets the plain text.
    const string AppClient = "ANDROID_MUSIC";
    const string AppVersion = "7.27.52";

    /// <summary>
    /// A song's lyrics as YouTube Music has them, timed when it can: Lyrics.Found's shape, or null
    /// when the song has none.
    /// </summary>
    public async Task<Lyrics.Found?> FindLyrics(string videoId)
    {
        var watch = JsonNode.Parse(await Call("next", new JsonObject { ["videoId"] = videoId }, null));
        // The "Lyrics" tab beside "Up next" leads to a page of its own.
        var page = Every(watch, "browseId").Select(id => id?.GetValue<string>()).FirstOrDefault(id => id?.StartsWith("MPLY") == true);
        if (page == null) return null;

        try
        {
            var question = new JsonObject
            {
                ["browseId"] = page,
                ["context"] = new JsonObject { ["client"] = new JsonObject { ["clientName"] = AppClient, ["clientVersion"] = AppVersion, ["hl"] = "en" } },
            };
            using var message = new HttpRequestMessage(HttpMethod.Post, $"{Site}/youtubei/v1/browse?prettyPrint=false");
            message.Content = new StringContent(question.ToJsonString(), Encoding.UTF8, "application/json");
            message.Headers.TryAddWithoutValidation("User-Agent", $"com.google.android.apps.youtube.music/{AppVersion} (Linux; U; Android 14) gzip");
            using var reply = await Http.SendAsync(message);
            if (reply.IsSuccessStatusCode)
            {
                var answer = JsonNode.Parse(await reply.Content.ReadAsStringAsync());
                var timed = Every(answer, "timedLyricsData").FirstOrDefault() as JsonArray;
                var lines = timed?.Select(line => new Lyrics.Line(
                        double.Parse(line?["cueRange"]?["startTimeMilliseconds"]?.GetValue<string>() ?? "0") / 1000,
                        line?["lyricLine"]?.GetValue<string>() ?? ""))
                    .ToList();
                if (lines is { Count: > 0 }) return new Lyrics.Found(lines, null, SourceIn(answer));
            }
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or System.Text.Json.JsonException or FormatException)
        {
            // The plain text below will do.
        }

        var plain = JsonNode.Parse(await Call("browse", new JsonObject { ["browseId"] = page }, null));
        var shelf = Every(plain, "musicDescriptionShelfRenderer").FirstOrDefault();
        var text = string.Concat((shelf?["description"]?["runs"] as JsonArray ?? []).Select(run => run?["text"]?.GetValue<string>()));
        return text.Length > 0 ? new Lyrics.Found(null, text, SourceIn(plain)) : null;
    }

    /// <summary>Who YouTube got the lyrics from, from its "Source: LyricFind" line.</summary>
    static string SourceIn(JsonNode? answer)
    {
        foreach (var node in Every(answer, "text"))
        {
            if (node is JsonValue value && value.TryGetValue<string>(out var text) && text.StartsWith("Source: ")) return text["Source: ".Length..];
        }
        return "YouTube Music";
    }

    /// <summary>Every value stored under `key`, at any depth.</summary>
    static IEnumerable<JsonNode?> Every(JsonNode? node, string key)
    {
        switch (node)
        {
            case JsonObject obj:
                foreach (var (name, value) in obj)
                {
                    if (name == key) yield return value;
                    foreach (var found in Every(value, key)) yield return found;
                }
                break;
            case JsonArray list:
                foreach (var item in list)
                {
                    foreach (var found in Every(item, key)) yield return found;
                }
                break;
        }
    }

    // YouTube Music's own number for the "Audio quality" setting of its web player, and for "High".
    const string QualitySetting = "304";
    const int QualityHigh = 3;
    bool _qualityAsked;

    /// <summary>
    /// Sets the audio quality of the account's YouTube Music web player to High, once a session.
    /// The site's player obeys that setting; nothing in the page itself can ask for more.
    /// </summary>
    public async Task PreferHighQuality()
    {
        if (_qualityAsked) return;
        _qualityAsked = true;
        await SetQuality(QualityHigh);
    }

    public async Task<bool> SetQuality(int level)
    {
        try
        {
            await FreshCookies();
            if (Cookies() is not { } cookies) return false;
            var question = new JsonObject
            {
                ["context"] = new JsonObject { ["client"] = new JsonObject { ["clientName"] = "WEB_REMIX", ["clientVersion"] = SiteVersion, ["hl"] = "en" } },
                ["settingItemId"] = QualitySetting,
                ["newValue"] = new JsonObject { ["intValue"] = level.ToString() },
            };
            using var reply = await Ask($"{Site}/youtubei/v1/account/set_setting?prettyPrint=false", question.ToJsonString(), cookies);
            return reply.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// Set by the window once the hidden YouTube Music page is in use. That page keeps renewing the
    /// sign-in's cookies, so the copy on disk is refreshed from the browser before it is relied on.
    /// </summary>
    public Func<Task>? RefreshCookies { get; set; }
    DateTime _cookiesFresh;

    async Task FreshCookies()
    {
        if (RefreshCookies == null || DateTime.UtcNow - _cookiesFresh < TimeSpan.FromMinutes(5)) return;
        _cookiesFresh = DateTime.UtcNow;
        try { await RefreshCookies(); } catch { /* the copy on disk will have to do */ }
    }

    static async Task<HttpResponseMessage> Ask(string address, string question, Dictionary<string, string>? cookies)
    {
        using var message = new HttpRequestMessage(HttpMethod.Post, address);
        message.Content = new StringContent(question, Encoding.UTF8, "application/json");
        message.Headers.TryAddWithoutValidation("Origin", Site);
        message.Headers.TryAddWithoutValidation("User-Agent", Browser);
        if (cookies != null && (cookies.GetValueOrDefault("SAPISID") ?? cookies.GetValueOrDefault("__Secure-3PAPISID")) is { } secret)
        {
            // How YouTube's own pages prove a request comes from the signed-in page: a hash of the
            // time, one of the sign-in cookies and the site's address.
            var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            var hash = Convert.ToHexStringLower(SHA1.HashData(Encoding.UTF8.GetBytes($"{now} {secret} {Site}")));
            message.Headers.TryAddWithoutValidation("Authorization", $"SAPISIDHASH {now}_{hash}");
            message.Headers.TryAddWithoutValidation("X-Origin", Site);
            message.Headers.TryAddWithoutValidation("X-Goog-AuthUser", "0");
            message.Headers.TryAddWithoutValidation("Cookie", string.Join("; ", cookies.Select(c => $"{c.Key}={c.Value}")));
        }
        return await Http.SendAsync(message);
    }

    /// <summary>The sign-in as yt-dlp keeps it (it rewrites the file as cookies are renewed), or null when signed out.</summary>
    static Dictionary<string, string>? Cookies()
    {
        try
        {
            using var file = new FileStream(CookieFile, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var reader = new StreamReader(file, Encoding.UTF8);
            var cookies = new Dictionary<string, string>();
            while (reader.ReadLine() is { } line)
            {
                if (line.StartsWith("#HttpOnly_", StringComparison.Ordinal)) line = line[10..];
                else if (line.StartsWith('#')) continue;
                var parts = line.Split('\t');
                if (parts.Length == 7 && parts[0].EndsWith("youtube.com", StringComparison.OrdinalIgnoreCase)) cookies[parts[5]] = parts[6];
            }
            return cookies.Count > 0 ? cookies : null;
        }
        catch (IOException)
        {
            return null;
        }
    }
}
