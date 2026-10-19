using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace Tint;

/// <summary>
/// Finds a public cover image for an album by name, using Apple's open iTunes Search service.
/// Discord can't reach files on this PC, so this is how local songs get artwork on a profile.
/// Only used while the Discord status is switched on.
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

    async Task<string?> Search(string key, string artist, string album)
    {
        foreach (var country in Countries())
        {
            try
            {
                var term = Uri.EscapeDataString($"{artist} {album}".Trim());
                using var doc = JsonDocument.Parse(await Http.GetStringAsync(
                    $"https://itunes.apple.com/search?term={term}&media=music&entity=album&limit=10&country={country}"));

                // A near miss would put the wrong cover on someone's profile, so a result has to be by the
                // same artist and be the same album. An exact name wins outright; failing that, the best
                // ranked result that is the same album under its original-language title.
                string? exact = null, translated = null;
                foreach (var result in doc.RootElement.GetProperty("results").EnumerateArray())
                {
                    if (!result.TryGetProperty("collectionName", out var name) || name.GetString() is not { } found) continue;
                    if (!result.TryGetProperty("artworkUrl100", out var art) || art.GetString() is not { Length: > 0 } candidate) continue;
                    if (artist.Length > 0 && !(result.TryGetProperty("artistName", out var by) &&
                        Overlaps(Simplify(by.GetString()), Simplify(artist)))) continue;

                    if (Simplify(found) == Simplify(album)) { exact = candidate; break; }
                    if (translated == null && SameAlbumOtherLanguage(album, found)) translated = candidate;
                }

                if ((exact ?? translated) is { } url)
                {
                    url = url.Replace("100x100", "512x512");
                    lock (_gate)
                    {
                        _found[key] = url;
                        try { File.WriteAllText(CacheFile, JsonSerializer.Serialize(_found)); } catch { }
                    }
                    return url;
                }
            }
            catch
            {
                // Offline, or the service is busy. The status simply goes out without a cover.
                _lookups.TryRemove(key, out _);
                return null;
            }
        }
        return null;
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
            int length = GetUserDefaultGeoName(buffer, buffer.Length);
            if (length == 3) home = new string(buffer, 0, 2).ToUpperInvariant();
        }
        catch { }
        if (home != null && home.All(char.IsAsciiLetter)) yield return home;
        if (home != "US") yield return "US";
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern int GetUserDefaultGeoName(char[] geoName, int geoNameCount);
}
