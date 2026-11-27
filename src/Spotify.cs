using System.Collections.Concurrent;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Tint;

/// <summary>
/// Spotify integration:
/// 1. Official OAuth 2.0 PKCE authentication and token refresh for Spotify Premium playback and Web API.
/// 2. Public embed reader for Spotify links (used when signed out, and as a fallback for non-owned playlists).
/// </summary>
sealed partial class Spotify
{
    public sealed record Song(string Title, string Artist, double Duration, bool Explicit, string? SpotifyId);

    /// <summary>`Kind` is track, album or playlist; a track's own song is the only one in `Songs`.</summary>
    public sealed record Found(string Kind, string Title, string Artist, string? Art, List<Song> Songs);

    const string Scopes =
        "streaming user-read-email user-read-private user-library-read user-library-modify " +
        "playlist-read-private playlist-read-collaborative playlist-modify-public playlist-modify-private " +
        "user-read-playback-state user-modify-playback-state";

    static readonly HttpClient Http = CreateHttp();

    readonly Settings _settings;
    readonly SemaphoreSlim _tokenGate = new(1);
    readonly ConcurrentDictionary<string, Task<Found?>> _found = new();

    string? _accessToken;
    DateTimeOffset _expiresAt;
    string? _userName;
    string? _userId;
    bool? _premium;
    string? _lastError;

    // Pending PKCE authorization flow, awaiting /spotify-callback.
    readonly object _authGate = new();
    PendingAuth? _pending;

    sealed record PendingAuth(string State, string Verifier, string RedirectUri, string ClientId, TaskCompletionSource<bool> Done);

    public Spotify(Settings settings)
    {
        _settings = settings;
    }

    static HttpClient CreateHttp()
    {
        var http = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
        // The embed page is served whole only to something that looks like a browser.
        http.DefaultRequestHeaders.UserAgent.ParseAdd("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36");
        return http;
    }

    // ---- OAuth 2.0 PKCE --------------------------------------------------------------------------

    public bool HasClientId => !string.IsNullOrWhiteSpace(_settings.SpotifyClientId);
    public bool IsSignedIn => HasClientId && !string.IsNullOrEmpty(Settings.Unprotect(_settings.SpotifyRefreshTokenProtected));

    public (string AuthorizeUrl, Task<bool> Completed) BeginSignIn(string redirectUri)
    {
        var clientId = _settings.SpotifyClientId?.Trim();
        if (string.IsNullOrEmpty(clientId))
            throw new InvalidOperationException("Add your Spotify Client ID in Settings first.");

        var verifier = Base64Url(RandomNumberGenerator.GetBytes(48));
        var challenge = Base64Url(SHA256.HashData(Encoding.ASCII.GetBytes(verifier)));
        var state = Base64Url(RandomNumberGenerator.GetBytes(24));
        var done = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);

        lock (_authGate)
        {
            _pending?.Done.TrySetResult(false);
            _pending = new PendingAuth(state, verifier, redirectUri, clientId, done);
        }

        var url = "https://accounts.spotify.com/authorize"
            + "?response_type=code"
            + "&client_id=" + Uri.EscapeDataString(clientId)
            + "&scope=" + Uri.EscapeDataString(Scopes)
            + "&redirect_uri=" + Uri.EscapeDataString(redirectUri)
            + "&state=" + Uri.EscapeDataString(state)
            + "&code_challenge_method=S256"
            + "&code_challenge=" + Uri.EscapeDataString(challenge)
            + "&show_dialog=false";

        return (url, done.Task);
    }

    public async Task<(bool Ok, string Message)> CompleteCallback(string? code, string? state, string? error)
    {
        PendingAuth? flow;
        lock (_authGate)
        {
            flow = _pending;
            if (flow != null && flow.State == state) _pending = null;
        }

        if (flow == null || flow.State != state)
            return (false, "That sign-in request has expired. Please try again from Tint.");

        if (!string.IsNullOrEmpty(error) || string.IsNullOrEmpty(code))
        {
            _lastError = error == "access_denied" ? "Sign-in was cancelled." : $"Spotify refused sign-in ({error ?? "no code"}).";
            flow.Done.TrySetResult(false);
            return (false, _lastError);
        }

        try
        {
            using var form = new FormUrlEncodedContent(new Dictionary<string, string>
            {
                ["client_id"] = flow.ClientId,
                ["grant_type"] = "authorization_code",
                ["code"] = code,
                ["redirect_uri"] = flow.RedirectUri,
                ["code_verifier"] = flow.Verifier,
            });
            using var res = await Http.PostAsync("https://accounts.spotify.com/api/token", form);
            var json = JsonNode.Parse(await res.Content.ReadAsStringAsync()) as JsonObject;
            if (!res.IsSuccessStatusCode || json == null)
            {
                var desc = Text(json?["error_description"]) ?? Text(json?["error"]) ?? $"HTTP {(int)res.StatusCode}";
                _lastError = $"Spotify token exchange failed: {desc}";
                flow.Done.TrySetResult(false);
                return (false, _lastError);
            }

            var access = Text(json["access_token"]);
            var refresh = Text(json["refresh_token"]);
            int expiresIn = json["expires_in"] is JsonValue v && v.TryGetValue<int>(out var secs) ? secs : 3600;
            if (string.IsNullOrEmpty(access) || string.IsNullOrEmpty(refresh))
            {
                _lastError = "Spotify didn't return a sign-in token.";
                flow.Done.TrySetResult(false);
                return (false, _lastError);
            }

            await _tokenGate.WaitAsync();
            try
            {
                _accessToken = access;
                _expiresAt = DateTimeOffset.UtcNow.AddSeconds(Math.Max(60, expiresIn));
                _userName = null;
                _premium = null;
                _lastError = null;
                _settings.SpotifyRefreshTokenProtected = Settings.Protect(refresh);
                _settings.SpotifyEnabled = true;
                _settings.Save();
            }
            finally
            {
                _tokenGate.Release();
            }

            await FetchProfile(access);
            flow.Done.TrySetResult(true);
            return (true, "Signed in to Spotify! You can close this window.");
        }
        catch (Exception ex)
        {
            _lastError = "Couldn't finish Spotify sign-in: " + ex.Message;
            flow.Done.TrySetResult(false);
            return (false, _lastError);
        }
    }

    public async Task<(string? Token, string? Error)> AccessToken(bool fresh = false)
    {
        await _tokenGate.WaitAsync();
        try
        {
            if (!fresh && !string.IsNullOrEmpty(_accessToken) && DateTimeOffset.UtcNow < _expiresAt.AddSeconds(-60))
                return (_accessToken, null);

            var clientId = _settings.SpotifyClientId?.Trim();
            var refresh = Settings.Unprotect(_settings.SpotifyRefreshTokenProtected);
            if (string.IsNullOrEmpty(clientId) || string.IsNullOrEmpty(refresh))
                return (null, "Not signed in to Spotify.");

            using var form = new FormUrlEncodedContent(new Dictionary<string, string>
            {
                ["client_id"] = clientId,
                ["grant_type"] = "refresh_token",
                ["refresh_token"] = refresh,
            });
            using var res = await Http.PostAsync("https://accounts.spotify.com/api/token", form);
            var json = JsonNode.Parse(await res.Content.ReadAsStringAsync()) as JsonObject;
            if (!res.IsSuccessStatusCode || json == null)
            {
                var err = Text(json?["error"]);
                var desc = Text(json?["error_description"]) ?? err ?? $"HTTP {(int)res.StatusCode}";
                if (err == "invalid_grant")
                {
                    _accessToken = null;
                    _settings.SpotifyRefreshTokenProtected = null;
                    _settings.Save();
                    _lastError = "Spotify session expired. Sign in again in Settings.";
                }
                else
                {
                    _lastError = $"Spotify didn't renew sign-in: {desc}";
                }
                return (null, _lastError);
            }

            var access = Text(json["access_token"]);
            var nextRefresh = Text(json["refresh_token"]);
            int expiresIn = json["expires_in"] is JsonValue v && v.TryGetValue<int>(out var secs) ? secs : 3600;
            if (string.IsNullOrEmpty(access)) return (null, "Spotify returned an empty token.");

            _accessToken = access;
            _expiresAt = DateTimeOffset.UtcNow.AddSeconds(Math.Max(60, expiresIn));
            _lastError = null;
            if (!string.IsNullOrEmpty(nextRefresh))
            {
                _settings.SpotifyRefreshTokenProtected = Settings.Protect(nextRefresh);
                _settings.Save();
            }
            return (_accessToken, null);
        }
        catch (Exception ex)
        {
            _lastError = ex.Message;
            return (null, ex.Message);
        }
        finally
        {
            _tokenGate.Release();
        }
    }

    async Task FetchProfile(string accessToken)
    {
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, "https://api.spotify.com/v1/me");
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
            using var res = await Http.SendAsync(req);
            if (!res.IsSuccessStatusCode) return;
            var json = JsonNode.Parse(await res.Content.ReadAsStringAsync()) as JsonObject;
            if (json == null) return;
            _userId = Text(json["id"]);
            _userName = Text(json["display_name"]) ?? _userId;
            _premium = string.Equals(Text(json["product"]), "premium", StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            // Non-fatal: playback and API calls still work without the display name cached.
        }
    }

    public async Task<object> Status(string redirectUri)
    {
        bool signedIn = IsSignedIn;
        if (signedIn && _userName == null)
        {
            var (token, _) = await AccessToken();
            if (token != null) await FetchProfile(token);
            signedIn = IsSignedIn;
        }
        return new
        {
            configured = HasClientId,
            signedIn,
            enabled = _settings.SpotifyEnabled,
            clientId = _settings.SpotifyClientId ?? "",
            redirectUri,
            user = signedIn ? _userName : null,
            userId = signedIn ? _userId : null,
            premium = signedIn ? _premium : null,
            error = _lastError,
        };
    }

    public void SignOut()
    {
        _accessToken = null;
        _expiresAt = default;
        _userName = null;
        _userId = null;
        _premium = null;
        _lastError = null;
        _settings.SpotifyRefreshTokenProtected = null;
        _settings.Save();
    }

    public void Forget()
    {
        SignOut();
        _settings.SpotifyClientId = null;
        _settings.SpotifyEnabled = false;
        _settings.Save();
    }

    static string Base64Url(byte[] bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    // ---- public embed reader (signed-out links & non-owned playlist fallback) --------------------

    [GeneratedRegex("^(track|album|playlist)$")]
    private static partial Regex KindPattern();

    [GeneratedRegex("^[A-Za-z0-9]{22}$")]
    private static partial Regex IdPattern();

    [GeneratedRegex("""<script id="__NEXT_DATA__"[^>]*>(.*?)</script>""", RegexOptions.Singleline)]
    private static partial Regex DataPattern();

    /// <summary>Null when there is nothing at that link. <paramref name="fresh"/> reads it again, for songs added since.</summary>
    public Task<Found?> Find(string kind, string id, bool fresh = false)
    {
        if (!KindPattern().IsMatch(kind) || !IdPattern().IsMatch(id)) return Task.FromResult<Found?>(null);
        var key = kind + ':' + id;
        if (fresh) _found.TryRemove(key, out _);
        var lookup = _found.GetOrAdd(key, _ => Look(kind, id));
        lookup.ContinueWith(_ => _found.TryRemove(key, out var _), TaskContinuationOptions.NotOnRanToCompletion);
        return lookup;
    }

    static async Task<Found?> Look(string kind, string id)
    {
        using var answer = await Http.GetAsync($"https://open.spotify.com/embed/{kind}/{id}");
        if (answer.StatusCode == System.Net.HttpStatusCode.NotFound) return null;
        answer.EnsureSuccessStatusCode();
        var page = await answer.Content.ReadAsStringAsync();
        var data = DataPattern().Match(page);
        if (!data.Success) return null;
        // A link to nothing still gets a page, only without the entity.
        if (JsonNode.Parse(data.Groups[1].Value)?["props"]?["pageProps"]?["state"]?["data"]?["entity"] is not JsonObject entity) return null;

        string title = Text(entity["title"]) ?? Text(entity["name"]) ?? "";
        var songs = new List<Song>();
        string artist;
        if (kind == "track")
        {
            artist = string.Join(", ", (entity["artists"] as JsonArray ?? []).Select(a => Text(a?["name"])).OfType<string>());
            songs.Add(new Song(title, artist, Seconds(entity["duration"]), Explicit(entity), IdOf(entity) ?? id));
        }
        else
        {
            artist = Text(entity["subtitle"]) ?? "";
            foreach (var item in entity["trackList"] as JsonArray ?? [])
            {
                if (item is not JsonObject track || Text(track["title"]) is not { Length: > 0 } name) continue;
                // A playlist can hold podcast episodes too; only songs can be found elsewhere.
                if (Text(track["entityType"]) is { } type && type != "track") continue;
                songs.Add(new Song(name, Text(track["subtitle"]) ?? "", Seconds(track["duration"]), Explicit(track), IdOf(track)));
            }
        }
        return new Found(kind, title, artist, ArtOf(entity), songs);
    }

    /// <summary>"spotify:track:<id>" → the id. Kept with a saved list, so songs added to it later can be told apart.</summary>
    static string? IdOf(JsonObject item) =>
        Text(item["uri"]) is { } uri && uri.StartsWith("spotify:track:", StringComparison.Ordinal) ? uri["spotify:track:".Length..] : null;

    static string? Text(JsonNode? node) => node is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;

    static double Seconds(JsonNode? node) => node is JsonValue value && value.TryGetValue<double>(out var ms) ? ms / 1000 : 0;

    static bool Explicit(JsonObject item) =>
        item["isExplicit"] is JsonValue value && value.TryGetValue<bool>(out var on) && on;

    /// <summary>The largest picture offered: a track's and an album's sit under visualIdentity, a playlist's under coverArt.</summary>
    static string? ArtOf(JsonObject entity)
    {
        var images = (entity["visualIdentity"]?["image"] as JsonArray ?? entity["coverArt"]?["sources"] as JsonArray ?? [])
            .OfType<JsonObject>();
        return images.OrderByDescending(i => i["maxWidth"] is JsonValue w && w.TryGetValue<int>(out var px) ? px : 0)
            .Select(i => Text(i["url"])).FirstOrDefault(url => url != null);
    }
}
