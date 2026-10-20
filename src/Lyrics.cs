using System.Collections.Concurrent;
using System.Globalization;
using System.Net;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Tint;

/// <summary>
/// Finds a song's lyrics, timed line by line where possible, for the Lyrics page. YouTube Music is
/// asked first when the page knows the song's video there (its own, or the same recording found by
/// name); then LRCLIB, a free public collection of timed lyrics that any song can be looked up in
/// by title, artist and length. Apple Music's own lyrics are read by the page through MusicKit.
/// </summary>
sealed partial class Lyrics(YouTube youtube)
{
    public sealed record Line(double Time, string Text);

    /// <summary>Timed `Lines`, or failing those the plain `Text`; `Source` is who wrote them down.</summary>
    public sealed record Found(List<Line>? Lines, string? Text, string Source);

    static readonly HttpClient Http = CreateHttp();

    // A song's lyrics don't change while Tint runs. Failures are forgotten, so they're asked again.
    readonly ConcurrentDictionary<string, Task<Found?>> _found = new();

    static HttpClient CreateHttp()
    {
        var http = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
        // LRCLIB asks programs to name themselves.
        http.DefaultRequestHeaders.UserAgent.ParseAdd("Tint (https://github.com/akaydevelop/TintMusicPlayer)");
        return http;
    }

    public Task<Found?> Find(string? videoId, string title, string artist, string album, double duration)
    {
        var key = string.Join('\n', videoId, title, artist, album, Math.Round(duration));
        var lookup = _found.GetOrAdd(key, _ => Look(videoId, title, artist, album, duration));
        lookup.ContinueWith(_ => _found.TryRemove(key, out var _), TaskContinuationOptions.NotOnRanToCompletion);
        return lookup;
    }

    async Task<Found?> Look(string? videoId, string title, string artist, string album, double duration)
    {
        Found? plain = null;
        Exception? failure = null;

        if (!string.IsNullOrEmpty(videoId))
        {
            try
            {
                var tube = await youtube.FindLyrics(videoId);
                if (tube?.Lines != null) return tube;
                plain = tube;
            }
            catch (Exception e) { failure = e; }
        }

        if (title.Length > 0)
        {
            try
            {
                var free = await FromLrclib(title, artist, album, duration);
                if (free?.Lines != null) return free;
                plain ??= free;
            }
            catch (Exception e) { failure ??= e; }
        }

        // Nothing found anywhere is an answer; nothing found because nobody answered isn't.
        if (plain == null && failure != null) throw failure;
        return plain;
    }

    // ---- LRCLIB -------------------------------------------------------------------------------

    const string Lrclib = "https://lrclib.net/api";

    static async Task<Found?> FromLrclib(string title, string artist, string album, double duration)
    {
        string Q(string text) => Uri.EscapeDataString(text);

        // The exact song first: LRCLIB only answers when the length is within a couple of seconds.
        if (duration > 0)
        {
            var exact = await Ask($"{Lrclib}/get?track_name={Q(title)}&artist_name={Q(artist)}&album_name={Q(album)}&duration={Math.Round(duration)}");
            if (exact is { ValueKind: JsonValueKind.Object } song && ToFound(song) is { } found) return found;
        }

        // Then a search, keeping to songs of the same length (a live take or an edit runs longer or shorter).
        var list = await Ask($"{Lrclib}/search?track_name={Q(title)}&artist_name={Q(artist)}");
        if (list is not { ValueKind: JsonValueKind.Array } results) return null;
        var near = results.EnumerateArray()
            .Where(r => duration <= 0 || !r.TryGetProperty("duration", out var d) || d.ValueKind != JsonValueKind.Number || Math.Abs(d.GetDouble() - duration) <= 4)
            .ToList();
        var best = near.FirstOrDefault(r => r.TryGetProperty("syncedLyrics", out var s) && s.ValueKind == JsonValueKind.String);
        if (best.ValueKind == JsonValueKind.Undefined) best = near.FirstOrDefault();
        return best.ValueKind == JsonValueKind.Object ? ToFound(best) : null;
    }

    /// <summary>LRCLIB's answer, or null for "not there". LRCLIB is often busy, so a busy answer is tried again.</summary>
    static async Task<JsonElement?> Ask(string address)
    {
        for (int attempt = 0; ; attempt++)
        {
            using var reply = await Http.GetAsync(address);
            if (reply.StatusCode == HttpStatusCode.NotFound) return null;
            if ((int)reply.StatusCode >= 500 && attempt < 2)
            {
                await Task.Delay(1200 * (attempt + 1));
                continue;
            }
            reply.EnsureSuccessStatusCode();
            using var doc = JsonDocument.Parse(await reply.Content.ReadAsStringAsync());
            return doc.RootElement.Clone();
        }
    }

    static Found? ToFound(JsonElement song)
    {
        if (song.TryGetProperty("instrumental", out var instrumental) && instrumental.ValueKind == JsonValueKind.True) return null;
        if (song.TryGetProperty("syncedLyrics", out var synced) && synced.GetString() is { Length: > 0 } lrc && ReadLrc(lrc) is { Count: > 0 } lines)
            return new Found(lines, null, "LRCLIB");
        if (song.TryGetProperty("plainLyrics", out var plain) && plain.GetString() is { Length: > 0 } text)
            return new Found(null, text, "LRCLIB");
        return null;
    }

    [GeneratedRegex(@"\[(\d+):(\d+(?:[.:]\d+)?)\]")]
    private static partial Regex Stamp();

    /// <summary>The lines of an LRC file: "[01:02.34]words", where a line may carry several times.</summary>
    static List<Line> ReadLrc(string lrc)
    {
        var lines = new List<Line>();
        foreach (var row in lrc.Split('\n'))
        {
            var stamps = Stamp().Matches(row);
            if (stamps.Count == 0) continue;
            var text = row[(stamps[^1].Index + stamps[^1].Length)..].Trim();
            foreach (Match stamp in stamps)
            {
                var seconds = double.Parse(stamp.Groups[2].Value.Replace(':', '.'), CultureInfo.InvariantCulture);
                lines.Add(new Line(int.Parse(stamp.Groups[1].Value) * 60 + seconds, text));
            }
        }
        lines.Sort((a, b) => a.Time.CompareTo(b.Time));
        return lines;
    }
}
