using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace Tint;

/// <summary>
/// Copies of the playlist and album pages opened lately, so opening one again shows it at once while
/// the service is asked for anything new. One file per page; its write time is when it was last
/// opened or played from, which is how pages left alone long enough are forgotten.
/// </summary>
static class PageCache
{
    static readonly object Gate = new();
    static string Folder => Directory.CreateDirectory(Path.Combine(Paths.Data, "cache", "pages")).FullName;

    static string FileOf(string key) =>
        Path.Combine(Folder, Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key)))[..32].ToLowerInvariant() + ".json");

    /// <summary>The copy kept for a page, marking it used; null when there is none.</summary>
    public static JsonNode? Read(string key)
    {
        lock (Gate)
        {
            var file = FileOf(key);
            if (!File.Exists(file)) return null;
            try
            {
                var node = JsonNode.Parse(File.ReadAllText(file));
                File.SetLastWriteTimeUtc(file, DateTime.UtcNow);
                return node;
            }
            catch
            {
                return null;
            }
        }
    }

    public static void Write(string key, JsonNode data)
    {
        lock (Gate)
        {
            try
            {
                var file = FileOf(key);
                File.WriteAllText(file + ".tmp", data.ToJsonString());
                File.Move(file + ".tmp", file, overwrite: true);
            }
            catch
            {
                // A copy that can't be kept only costs the next visit its head start.
            }
        }
    }

    /// <summary>Marks a page used (something was played from it) without reading it.</summary>
    public static void Touch(string key)
    {
        lock (Gate)
        {
            try
            {
                var file = FileOf(key);
                if (File.Exists(file)) File.SetLastWriteTimeUtc(file, DateTime.UtcNow);
            }
            catch { }
        }
    }

    public static (int Count, long Bytes) Size()
    {
        lock (Gate)
        {
            var files = new DirectoryInfo(Folder).GetFiles("*.json");
            return (files.Length, files.Sum(f => f.Length));
        }
    }

    /// <summary>Forgets every page, or (with <paramref name="unusedForDays"/>) those left alone that long. Returns how many went.</summary>
    public static int Clear(int? unusedForDays = null)
    {
        lock (Gate)
        {
            var before = unusedForDays is { } days ? DateTime.UtcNow.AddDays(-days) : DateTime.MaxValue;
            int gone = 0;
            foreach (var file in new DirectoryInfo(Folder).GetFiles())
            {
                if (file.LastWriteTimeUtc >= before) continue;
                try { file.Delete(); gone++; } catch { }
            }
            return gone;
        }
    }
}
