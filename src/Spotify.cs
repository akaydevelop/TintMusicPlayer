using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Tint;

/// <summary>
/// Reads what a Spotify link points at, so the page can find the same songs on Apple Music and
/// YouTube Music. Spotify's own catalog service needs an account; the small player Spotify lets
/// other sites embed doesn't, and its page carries the track, album or playlist as data: titles,
/// artists and lengths, up to the first 100 songs of a playlist.
/// </summary>
sealed partial class Spotify
{
    public sealed record Song(string Title, string Artist, double Duration, bool Explicit);

    /// <summary>`Kind` is track, album or playlist; a track's own song is the only one in `Songs`.</summary>
    public sealed record Found(string Kind, string Title, string Artist, string? Art, List<Song> Songs);

    static readonly HttpClient Http = CreateHttp();

    // What a link points at doesn't change while Tint runs. Failures are forgotten, so they're asked again.
    readonly ConcurrentDictionary<string, Task<Found?>> _found = new();

    static HttpClient CreateHttp()
    {
        var http = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
        // The embed page is served whole only to something that looks like a browser.
        http.DefaultRequestHeaders.UserAgent.ParseAdd("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36");
        return http;
    }

    [GeneratedRegex("^(track|album|playlist)$")]
    private static partial Regex KindPattern();

    [GeneratedRegex("^[A-Za-z0-9]{22}$")]
    private static partial Regex IdPattern();

    [GeneratedRegex("""<script id="__NEXT_DATA__"[^>]*>(.*?)</script>""", RegexOptions.Singleline)]
    private static partial Regex DataPattern();

    /// <summary>Null when there is nothing at that link.</summary>
    public Task<Found?> Find(string kind, string id)
    {
        if (!KindPattern().IsMatch(kind) || !IdPattern().IsMatch(id)) return Task.FromResult<Found?>(null);
        var key = kind + ':' + id;
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
            songs.Add(new Song(title, artist, Seconds(entity["duration"]), Explicit(entity)));
        }
        else
        {
            artist = Text(entity["subtitle"]) ?? "";
            foreach (var item in entity["trackList"] as JsonArray ?? [])
            {
                if (item is not JsonObject track || Text(track["title"]) is not { Length: > 0 } name) continue;
                // A playlist can hold podcast episodes too; only songs can be found elsewhere.
                if (Text(track["entityType"]) is { } type && type != "track") continue;
                songs.Add(new Song(name, Text(track["subtitle"]) ?? "", Seconds(track["duration"]), Explicit(track)));
            }
        }
        return new Found(kind, title, artist, ArtOf(entity), songs);
    }

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
