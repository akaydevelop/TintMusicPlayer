using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace Tint;

/// <summary>
/// Finds a public cover image for an album by name, using Apple's open iTunes Search service.
/// It gives albums on this PC that carry no cover of their own one to show (Library.ArtFile), and
/// since Discord can't reach files on this PC, it is how local songs get artwork on a profile.
/// </summary>
sealed class CoverLookup
{
    static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(6) };
    static readonly string CacheFile = Path.Combine(Paths.Data, "covers.json");

    readonly ConcurrentDictionary<string, Task<string?>> _lookups = new();
    readonly Dictionary<string, string> _found;
    readonly object _gate = new();

    public CoverLookup()
    {
        try { _found = JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(CacheFile)) ?? new(); }
        catch { _found = new(); }
    }

    public Task<string?> Find(string artist, string album)
    {
        var key = Simplify(artist) + "|" + Simplify(album);
        lock (_gate)
        {
            if (_found.TryGetValue(key, out var known)) return Task.FromResult<string?>(known);
        }
        // Misses are remembered only until the app closes, so a cover that appears later is still found.
        return _lookups.GetOrAdd(key, _ => Search(key, artist, album));
    }

    /// <summary>
    /// The Apple Music developer token, when Apple Music is set up. iTunes Search leaves out many
    /// albums, new ones especially; Apple Music's own catalog has them, but only answers with a token.
    /// </summary>
    public Func<Task<string?>>? AppleToken { get; set; }

    async Task<string?> Search(string key, string artist, string album)
    {
        var term = Uri.EscapeDataString($"{artist} {album}".Trim());
        try
        {
            foreach (var country in Countries())
            {
                using var doc = JsonDocument.Parse(await Http.GetStringAsync(
                    $"https://itunes.apple.com/search?term={term}&media=music&entity=album&limit=10&country={country}"));
                var url = Pick(artist, album, doc.RootElement.GetProperty("results").EnumerateArray().Select(result => (
                    result.TryGetProperty("artistName", out var by) ? by.GetString() : null,
                    result.TryGetProperty("collectionName", out var name) ? name.GetString() : null,
                    result.TryGetProperty("artworkUrl100", out var art) ? art.GetString()?.Replace("100x100", "512x512") : null)));
                if (url != null) return Keep(key, url);
            }

            if (AppleToken != null && await AppleToken() is { Length: > 0 } token)
            {
                foreach (var country in Countries())
                {
                    using var request = new HttpRequestMessage(HttpMethod.Get,
                        $"https://api.music.apple.com/v1/catalog/{country.ToLowerInvariant()}/search?types=albums&limit=10&term={term}");
                    request.Headers.Authorization = new("Bearer", token);
                    // The web player's token is only honoured for music.apple.com.
                    request.Headers.Add("Origin", "https://music.apple.com");
                    using var response = await Http.SendAsync(request);
                    if (!response.IsSuccessStatusCode) break;
                    using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
                    if (!(doc.RootElement.TryGetProperty("results", out var results) && results.TryGetProperty("albums", out var albums))) continue;
                    var url = Pick(artist, album, albums.GetProperty("data").EnumerateArray().Select(result =>
                    {
                        var a = result.GetProperty("attributes");
                        return (
                            a.TryGetProperty("artistName", out var by) ? by.GetString() : null,
                            a.TryGetProperty("name", out var name) ? name.GetString() : null,
                            a.TryGetProperty("artwork", out var art) && art.TryGetProperty("url", out var u) ? u.GetString()?.Replace("{w}x{h}", "512x512") : null);
                    }));
                    if (url != null) return Keep(key, url);
                }
            }
        }
        catch
        {
            // Offline, or the service is busy. Asked again next time.
            _lookups.TryRemove(key, out _);
        }
        return null;
    }

    /// <summary>
    /// A near miss would put the wrong cover on an album, so a result has to be by the same artist and
    /// be the same album. An exact name wins outright; failing that, the best ranked result that is the
    /// same album under its original-language title.
    /// </summary>
    static string? Pick(string artist, string album, IEnumerable<(string? By, string? Name, string? Art)> results)
    {
        string? translated = null;
        foreach (var (by, found, candidate) in results)
        {
            if (found == null || string.IsNullOrEmpty(candidate)) continue;
            if (artist.Length > 0 && !Overlaps(Simplify(by), Simplify(artist))) continue;
            if (Simplify(found) == Simplify(album)) return candidate;
            if (translated == null && SameAlbumOtherLanguage(album, found)) translated = candidate;
        }
        return translated;
    }

    string Keep(string key, string url)
    {
        lock (_gate)
        {
            _found[key] = url;
            try { File.WriteAllText(CacheFile, JsonSerializer.Serialize(_found)); } catch { }
        }
        return url;
    }

    static bool Overlaps(string a, string b) => a.Length > 0 && b.Length > 0 && (a.Contains(b) || b.Contains(a));

    /// <summary>
    /// Apple shows many albums under a translated title ("Theater") but its search service answers
    /// with the original one ("劇場"). The two can't be compared letter by letter, so this accepts a
    /// result written in another script when its release kind (album, EP or single) is the same.
    /// The caller has already checked the artist, and the search itself matched on the title.
    /// </summary>
    static bool SameAlbumOtherLanguage(string mine, string found)
    {
        var (myTitle, myKind) = SplitKind(mine);
        var (foundTitle, foundKind) = SplitKind(found);
        return myKind == foundKind && myTitle.Any(char.IsAsciiLetter) && !foundTitle.Any(char.IsAsciiLetter);
    }

    static (string Title, string Kind) SplitKind(string album)
    {
        foreach (var kind in new[] { " - EP", " - Single" })
        {
            if (album.EndsWith(kind, StringComparison.OrdinalIgnoreCase)) return (album[..^kind.Length], kind);
        }
        return (album, "");
    }

    /// <summary>Lower-case letters and digits only, so punctuation and spacing differences don't matter.</summary>
    static string Simplify(string? text)
    {
        var sb = new StringBuilder();
        foreach (var c in (text ?? "").Normalize(NormalizationForm.FormKC))
        {
            if (char.IsLetterOrDigit(c)) sb.Append(char.ToLowerInvariant(c));
        }
        return sb.ToString();
    }

    /// <summary>The store for the person's own region first (catalogs differ by country), then the US one.</summary>
    static IEnumerable<string> Countries()
    {
        var buffer = new char[16];
        string? home = null;
        try
        {
            if (OperatingSystem.IsWindows())
            {
                int length = GetUserDefaultGeoName(buffer, buffer.Length);
                if (length == 3) home = new string(buffer, 0, 2).ToUpperInvariant();
            }
            else
            {
                // Linux has no separate home-region setting; the locale's country (en_GB → GB) stands in for it.
                home = System.Globalization.RegionInfo.CurrentRegion.TwoLetterISORegionName.ToUpperInvariant();
                if (home.Length != 2) home = null;
            }
        }
        catch { }
        if (home != null && home.All(char.IsAsciiLetter)) yield return home;
        if (home != "US") yield return "US";
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern int GetUserDefaultGeoName(char[] geoName, int geoNameCount);
}
