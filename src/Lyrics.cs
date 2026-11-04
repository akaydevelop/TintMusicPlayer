using System.Collections.Concurrent;
using System.Globalization;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Tint;

/// <summary>
/// Finds a song's lyrics, timed line by line where possible, for the Lyrics page. YouTube Music is
/// asked first when the page knows the song's video there (its own, or the same recording found by
/// name); then LRCLIB, a free public collection of timed lyrics that any song can be looked up in
/// by title, artist and length; and last Genius, whose lyrics are written by its readers and never
/// timed. Apple Music's own lyrics are read by the page through MusicKit.
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
        // LRCLIB asks programs to name themselves. Genius gets the same name.
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

        // Genius has nothing timed, so it only matters when nobody has anything at all.
        if (plain == null && title.Length > 0)
        {
            try
            {
                plain = await FromGenius(title, artist);
            }
            catch (Exception e) { failure ??= e; }
        }

        // Nothing found anywhere is an answer; nothing found because nobody answered isn't.
        if (plain == null && failure != null) throw failure;
        return plain;
    }

    // ---- translating --------------------------------------------------------------------------

    // The free address Google's own translation widgets use; it needs no key.
    const string GoogleTranslate = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&dt=t&tl=";

    // Well under what it takes at once; longer lyrics go in several parts.
    const int TranslateAtOnce = 4000;

    /// <summary>Each line in another language, in the same order; blank lines stay blank.</summary>
    public static async Task<List<string>> Translate(List<string> lines, string language)
    {
        var translated = lines.Select(_ => "").ToList();
        var part = new List<int>();
        int size = 0;
        for (int i = 0; i < lines.Count; i++)
        {
            if (string.IsNullOrWhiteSpace(lines[i])) continue;
            if (size + lines[i].Length >= TranslateAtOnce)
            {
                await TranslatePart(part, lines, translated, language);
                part.Clear();
                size = 0;
            }
            part.Add(i);
            size += lines[i].Length + 1;
        }
        if (part.Count > 0) await TranslatePart(part, lines, translated, language);
        return translated;
    }

    /// <summary>Lines sent together read better, as each is the context of the next; they come back a line each.</summary>
    static async Task TranslatePart(List<int> part, List<string> lines, List<string> translated, string language)
    {
        var back = (await AskGoogle(string.Join('\n', part.Select(i => lines[i])), language)).Split('\n');
        if (back.Length == part.Count)
        {
            for (int i = 0; i < part.Count; i++) translated[part[i]] = back[i].Trim();
            return;
        }
        // Lines it ran together can't be told apart again, so these go one at a time.
        foreach (var i in part) translated[i] = (await AskGoogle(lines[i], language)).ReplaceLineEndings(" ").Trim();
    }

    static async Task<string> AskGoogle(string text, string language)
    {
        using var reply = await Http.PostAsync(GoogleTranslate + Uri.EscapeDataString(language), new FormUrlEncodedContent([new("q", text)]));
        reply.EnsureSuccessStatusCode();
        using var doc = JsonDocument.Parse(await reply.Content.ReadAsStringAsync());
        // [[["translated sentence", "original sentence", ...], ...], ...]
        return string.Concat(doc.RootElement[0].EnumerateArray().Select(sentence => sentence[0].GetString()));
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

    /// <summary>A service's answer, or null for "not there". LRCLIB is often busy, so a busy answer is tried again.</summary>
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

    // ---- Genius -------------------------------------------------------------------------------

    // The search and the song pages its own site uses: they need no key, but the words are only in the page.
    const string Genius = "https://genius.com";

    // Words that mark a version of a song with nobody singing, which still shares the song's title.
    [GeneratedRegex(@"\b(instrumental|inst\b\.?|off ?vocal|karaoke)", RegexOptions.IgnoreCase)]
    private static partial Regex NoSinging();

    static async Task<Found?> FromGenius(string title, string artist)
    {
        if (NoSinging().IsMatch(title)) return null;

        var titles = TitleSpellings(title);
        var artists = ArtistSpellings(artist);
        // "Song (feat. X)" and "Song - 2012 Remaster" are only found as "Song".
        var name = Brackets().Replace(title.Normalize(NormalizationForm.FormKC), " ").Split(" - ")[0].Trim();

        // Its search leans on popularity and can miss a song named alongside its artist, so the title alone is tried next.
        var path = await SearchGenius($"{name} {artist}", titles, artists) ?? await SearchGenius(name, titles, artists);
        if (path == null) return null;

        var text = ReadGeniusPage(await Http.GetStringAsync(Genius + path));
        return text.Length > 0 ? new Found(null, text, "Genius") : null;
    }

    /// <summary>
    /// The page of the song in a search's answer. The answer also holds covers, translations and pages
    /// of romaji under the names of whoever wrote them, so both the title and the artist have to agree.
    /// </summary>
    static async Task<string?> SearchGenius(string query, HashSet<string> titles, HashSet<string> artists)
    {
        var answer = await Ask($"{Genius}/api/search/song?per_page=20&q={Uri.EscapeDataString(query)}");
        if (answer is not { ValueKind: JsonValueKind.Object } found) return null;
        foreach (var section in ItemsOf(ValueOf(found, "response"), "sections"))
        {
            foreach (var hit in ItemsOf(section, "hits"))
            {
                var song = ValueOf(hit, "result");
                if (TextOf(song, "lyrics_state") != "complete" || ValueOf(song, "instrumental").ValueKind == JsonValueKind.True) continue;
                if (!Spellings(TextOf(song, "title")).Overlaps(titles)) continue;
                var names = ItemsOf(song, "primary_artists").Concat(ItemsOf(song, "featured_artists"));
                if (!names.Any(a => Spellings(TextOf(a, "name")).Overlaps(artists))) continue;
                if (TextOf(song, "path") is { Length: > 0 } path) return path;
            }
        }
        return null;
    }

    static JsonElement ValueOf(JsonElement item, string key) =>
        item.ValueKind == JsonValueKind.Object && item.TryGetProperty(key, out var value) ? value : default;

    static string TextOf(JsonElement item, string key) =>
        ValueOf(item, key) is { ValueKind: JsonValueKind.String } text ? text.GetString()! : "";

    static IEnumerable<JsonElement> ItemsOf(JsonElement item, string key) =>
        ValueOf(item, key) is { ValueKind: JsonValueKind.Array } list ? list.EnumerateArray() : [];

    [GeneratedRegex(@"[(\[{]([^)\]}]*)[)\]}]")]
    private static partial Regex Brackets();

    [GeneratedRegex(@",|&|、|×|/|\bfeat\b\.?|\bft\b\.?|\bwith\b|\bx\b", RegexOptions.IgnoreCase)]
    private static partial Regex BetweenArtists();

    /// <summary>Lower-case letters and digits with no accents, so punctuation and spacing differences don't matter.</summary>
    static string Plain(string text)
    {
        var sb = new StringBuilder();
        foreach (var c in text.Normalize(NormalizationForm.FormKD))
        {
            if (char.IsLetterOrDigit(c)) sb.Append(char.ToLowerInvariant(c));
        }
        return sb.ToString();
    }

    /// <summary>A name as written, without its brackets, and what's in them: "キタニタツヤ (Tatsuya Kitani)" goes by all three.</summary>
    static HashSet<string> Spellings(string name)
    {
        var text = name.Normalize(NormalizationForm.FormKC);
        var spellings = new HashSet<string> { Plain(text), Plain(Brackets().Replace(text, " ")) };
        foreach (Match bracket in Brackets().Matches(text)) spellings.Add(Plain(bracket.Groups[1].Value));
        spellings.Remove("");
        return spellings;
    }

    /// <summary>
    /// A title in the player as written, and each side of a dash once its brackets are gone. What's in
    /// the brackets doesn't count here: "Love (Remix)" is not a song called "Remix".
    /// </summary>
    static HashSet<string> TitleSpellings(string title)
    {
        var text = title.Normalize(NormalizationForm.FormKC);
        var spellings = new HashSet<string> { Plain(text) };
        foreach (var part in Brackets().Replace(text, " ").Split(" - ")) spellings.Add(Plain(part));
        spellings.Remove("");
        return spellings;
    }

    /// <summary>An artist in the player as written, and each of several ("A, B", "A feat. B").</summary>
    static HashSet<string> ArtistSpellings(string artist)
    {
        var spellings = Spellings(artist);
        foreach (var part in BetweenArtists().Split(artist)) spellings.UnionWith(Spellings(part));
        return spellings;
    }

    [GeneratedRegex(@"<div[^>]*\bdata-lyrics-container=""true""[^>]*>")]
    private static partial Regex GeniusLyricsBox();

    [GeneratedRegex(@"<!--.*?-->|<(/?)(\w+)([^>]*)>", RegexOptions.Singleline)]
    private static partial Regex HtmlTag();

    [GeneratedRegex(@"^\[.*\]$")]
    private static partial Regex GeniusHeading();

    /// <summary>The words of a Genius song page, which splits them over several boxes around its ads.</summary>
    static string ReadGeniusPage(string page)
    {
        var words = new StringBuilder();
        foreach (Match box in GeniusLyricsBox().Matches(page))
        {
            int at = box.Index + box.Length, depth = 1, hiddenAt = 0;
            for (var tag = HtmlTag().Match(page, at); tag.Success && depth > 0; tag = tag.NextMatch())
            {
                if (hiddenAt == 0) words.Append(WebUtility.HtmlDecode(page[at..tag.Index]));
                at = tag.Index + tag.Length;

                var name = tag.Groups[2].Value;
                if (name == "br" && hiddenAt == 0) words.Append('\n');
                if (name != "div") continue;
                if (tag.Groups[1].Length > 0)
                {
                    if (depth == hiddenAt) hiddenAt = 0;
                    depth--;
                }
                else
                {
                    depth++;
                    // The box's own header ("1 Contributor", "Song Lyrics") and anything else that isn't the song.
                    if (hiddenAt == 0 && tag.Groups[3].Value.Contains("data-exclude-from-selection")) hiddenAt = depth;
                }
            }
            words.Append('\n');
        }

        // Headings like "[Chorus]" aren't sung, and no other source has them; the gap between verses stays.
        // Some of its lines start with a zero-width space, which Trim leaves.
        var lines = words.ToString().Replace("​", "").Split('\n').Select(line => line.Trim()).Select(line => GeniusHeading().IsMatch(line) ? "" : line);
        return Regex.Replace(string.Join('\n', lines), @"\n{3,}", "\n\n").Trim();
    }
}
