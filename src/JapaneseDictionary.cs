using System.Collections.Concurrent;
using System.Security.Cryptography;

namespace Tint;

/// <summary>
/// The dictionary kuromoji (wwwroot\vendor\kuromoji) reads Japanese with, for the romaji of
/// lyrics. It is 17 MB, too much to carry in every download and update for something not everyone
/// uses, so it is fetched the first time romaji is asked for, checked against the SHA-256 of each
/// file as kuromoji 0.1.2 published it, and kept in the data folder.
/// </summary>
static class JapaneseDictionary
{
    const string Source = "https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict/";

    static readonly Dictionary<string, string> Files = new()
    {
        ["base.dat.gz"] = "0803327762e1c93ca731e4319ab8343340f2806bb84941207782cde9d2d5a8eb",
        ["cc.dat.gz"] = "02b7631be0d4de3a1a75cd9f9cc51536e4f94c9e6b389b813e06ba0f6e7de765",
        ["check.dat.gz"] = "193ae0035fff6fe812b58d9ee730e7a7d7ee601d918481ce51075c58114f6cc9",
        ["tid.dat.gz"] = "d43d831cb6fb0f0a411739cd287a6d5e998e121a8daca614df14a81a0dcac586",
        ["tid_map.dat.gz"] = "33efd5ffd87a70f669add093fa39dee44341d58f940844ef107c8fd98bb795b2",
        ["tid_pos.dat.gz"] = "60dbfc99a6ab993f30c5dab648bec6ad7f9aaefa5c14e1843837d95e509f8895",
        ["unk.dat.gz"] = "f7f991cdeb9bfd3e9c0e4577cc50ee0815a11c508cccd444a9d3ab3c81521100",
        ["unk_char.dat.gz"] = "9a8e86fd9aff32d323fbb59f5a7006f05927a11f8173c90712cc56293aeb3225",
        ["unk_compat.dat.gz"] = "50f60aa29bc2e86c2903ab8c825bb6fa604d2b294d96941c1d3924259791899d",
        ["unk_invoke.dat.gz"] = "6b210889548457c3006913afd12c8b525562255f2709e404604be9614a25e94c",
        ["unk_map.dat.gz"] = "6df12460e5477230bb6fd9641def918b699fc0a8868016b6c9f794488630509b",
        ["unk_pos.dat.gz"] = "5b183a29f281acc7e0542beca47b83f7985047c0a2d27e78a66f32276be5ad11",
    };

    static readonly string Folder = Path.Combine(Paths.Data, "japanese");
    static readonly HttpClient Http = new() { Timeout = TimeSpan.FromMinutes(2) };
    static readonly ConcurrentDictionary<string, Task<string>> Fetching = new();

    public static bool Known(string name) => Files.ContainsKey(name);

    /// <summary>Where the file is on disk, once it is there and is what it should be.</summary>
    public static Task<string> File(string name)
    {
        var path = Path.Combine(Folder, name);
        if (System.IO.File.Exists(path)) return Task.FromResult(path);
        var fetch = Fetching.GetOrAdd(name, _ => Fetch(name, path));
        fetch.ContinueWith(_ => Fetching.TryRemove(name, out var _), TaskContinuationOptions.NotOnRanToCompletion);
        return fetch;
    }

    static async Task<string> Fetch(string name, string path)
    {
        var bytes = await Http.GetByteArrayAsync(Source + name);
        if (!Convert.ToHexStringLower(SHA256.HashData(bytes)).Equals(Files[name], StringComparison.Ordinal))
            throw new InvalidDataException($"The Japanese dictionary's {name} isn't the file it should be.");
        Directory.CreateDirectory(Folder);
        var part = path + ".part";
        await System.IO.File.WriteAllBytesAsync(part, bytes);
        System.IO.File.Move(part, path, overwrite: true);
        return path;
    }
}
