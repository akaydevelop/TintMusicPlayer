using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Tint;

/// <summary>
/// Supplies the developer token MusicKit needs. In order of preference: a token the person pasted,
/// one signed with their own MusicKit key (.p8, from the Apple Developer Program), or, if they
/// chose it, the token Apple's web player uses.
/// </summary>
sealed class AppleToken
{
    readonly Settings _settings;
    readonly WebPlayerToken _web = new();
    readonly object _gate = new();
    string? _cached;
    string? _cachedFor;
    DateTimeOffset _cachedUntil;

    public AppleToken(Settings settings) => _settings = settings;

    /// <summary>Source is "pasted", "key" or "web". `fresh` skips the saved web player token.</summary>
    public async Task<(string? Token, string? Error, string? Source)> Get(bool fresh = false)
    {
        var raw = Settings.Unprotect(_settings.AppleRawTokenProtected);
        if (!string.IsNullOrWhiteSpace(raw)) return (raw.Trim(), null, "pasted");

        var key = Settings.Unprotect(_settings.ApplePrivateKeyProtected);
        var team = _settings.AppleTeamId?.Trim();
        var keyId = _settings.AppleKeyId?.Trim();
        if (!string.IsNullOrEmpty(key) && !string.IsNullOrEmpty(team) && !string.IsNullOrEmpty(keyId))
        {
            var (token, error) = Sign(team, keyId, key);
            return (token, error, "key");
        }

        if (_settings.AppleUseWebToken)
        {
            var (token, error) = await _web.Get(fresh);
            return (token, error, "web");
        }
        return (null, null, null);
    }

    (string? Token, string? Error) Sign(string team, string keyId, string key)
    {
        lock (_gate)
        {
            var fingerprint = $"{team}|{keyId}|{key.Length}";
            if (_cached != null && _cachedFor == fingerprint && DateTimeOffset.UtcNow < _cachedUntil)
                return (_cached, null);

            try
            {
                var life = TimeSpan.FromDays(30);
                _cached = Mint(team, keyId, key, life);
                _cachedFor = fingerprint;
                _cachedUntil = DateTimeOffset.UtcNow + life - TimeSpan.FromDays(1);
                return (_cached, null);
            }
            catch (Exception ex)
            {
                return (null, "That key couldn't sign a token: " + ex.Message);
            }
        }
    }

    public static void Validate(string pem)
    {
        using var ec = ECDsa.Create();
        ec.ImportFromPem(pem);
    }

    static string Mint(string teamId, string keyId, string pem, TimeSpan life)
    {
        using var ec = ECDsa.Create();
        ec.ImportFromPem(pem);

        var now = DateTimeOffset.UtcNow;
        var header = JsonSerializer.Serialize(new Dictionary<string, object> { ["alg"] = "ES256", ["kid"] = keyId });
        var payload = JsonSerializer.Serialize(new Dictionary<string, object>
        {
            ["iss"] = teamId,
            ["iat"] = now.ToUnixTimeSeconds(),
            ["exp"] = (now + life).ToUnixTimeSeconds(),
        });

        var signingInput = B64(Encoding.UTF8.GetBytes(header)) + "." + B64(Encoding.UTF8.GetBytes(payload));
        // SignData yields the fixed-size r||s form that JWS expects.
        var signature = ec.SignData(Encoding.ASCII.GetBytes(signingInput), HashAlgorithmName.SHA256);
        return signingInput + "." + B64(signature);
    }

    static string B64(byte[] bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}

/// <summary>
/// Reads the developer token that music.apple.com hands to every visitor: it sits in the site's
/// main script. Apple rotates it every couple of months, so it is fetched again when it nears its
/// expiry or when Apple stops accepting it. This is not a use Apple's terms provide for; the
/// person opted into it knowing that.
/// </summary>
sealed partial class WebPlayerToken
{
    static readonly string CacheFile = Path.Combine(Paths.Data, "webtoken.json");
    static readonly HttpClient Http = CreateClient();

    readonly SemaphoreSlim _gate = new(1);
    Saved? _saved;

    sealed record Saved(string Token, long Expires);

    [GeneratedRegex(@"(?:src|href)=""(/assets/[^""]+\.js)""")]
    private static partial Regex ScriptPattern();

    [GeneratedRegex(@"eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}")]
    private static partial Regex TokenPattern();

    static HttpClient CreateClient()
    {
        var client = new HttpClient { Timeout = TimeSpan.FromSeconds(25) };
        client.DefaultRequestHeaders.UserAgent.ParseAdd("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36");
        return client;
    }

    public async Task<(string? Token, string? Error)> Get(bool fresh)
    {
        await _gate.WaitAsync();
        try
        {
            if (!fresh)
            {
                _saved ??= Load();
                // Stop relying on a saved token a day before it runs out.
                if (_saved != null && DateTimeOffset.UtcNow.ToUnixTimeSeconds() < _saved.Expires - 86400)
                    return (_saved.Token, null);
            }

            try
            {
                var found = await Fetch();
                if (found == null) return (null, "Tint couldn't find the web player's token. Apple may have changed their site.");
                _saved = found;
                try { File.WriteAllText(CacheFile, JsonSerializer.Serialize(found)); } catch { }
                return (found.Token, null);
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
            {
                return (null, "Can't reach music.apple.com. Check your internet connection.");
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    static Saved? Load()
    {
        try { return JsonSerializer.Deserialize<Saved>(File.ReadAllText(CacheFile)); }
        catch { return null; }
    }

    static async Task<Saved?> Fetch()
    {
        var page = await Http.GetStringAsync("https://music.apple.com/us/browse");
        if (Pick(page) is { } inPage) return inPage;

        var scripts = ScriptPattern().Matches(page).Select(m => m.Groups[1].Value).Distinct()
            .OrderByDescending(s => s.Contains("index", StringComparison.OrdinalIgnoreCase)).Take(8);
        foreach (var script in scripts)
        {
            if (Pick(await Http.GetStringAsync("https://music.apple.com" + script)) is { } found) return found;
        }
        return null;
    }

    /// <summary>The first thing in the text that really is an unexpired ES256 token.</summary>
    static Saved? Pick(string text)
    {
        foreach (Match match in TokenPattern().Matches(text))
        {
            try
            {
                var parts = match.Value.Split('.');
                using var header = JsonDocument.Parse(Decode(parts[0]));
                using var claims = JsonDocument.Parse(Decode(parts[1]));
                if (header.RootElement.GetProperty("alg").GetString() != "ES256") continue;
                long expires = claims.RootElement.GetProperty("exp").GetInt64();
                if (expires > DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 3600) return new Saved(match.Value, expires);
            }
            catch
            {
                // Looked like a token but isn't one. Keep looking.
            }
        }
        return null;
    }

    static byte[] Decode(string part)
    {
        var s = part.Replace('-', '+').Replace('_', '/');
        return Convert.FromBase64String(s.PadRight(s.Length + (4 - s.Length % 4) % 4, '='));
    }
}
