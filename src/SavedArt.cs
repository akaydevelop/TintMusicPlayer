using System.Diagnostics;

namespace Tint;

/// <summary>
/// Saves the cover of the song playing, at the best size its service offers, into Pictures\Tint.
/// Only artwork addresses of the services Tint plays from are fetched.
/// </summary>
static class SavedArt
{
    static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(30) };
    static readonly string[] ArtHosts = ["mzstatic.com", "googleusercontent.com", "ytimg.com", "ggpht.com"];

    public static string Folder
    {
        get
        {
            var pictures = Environment.GetFolderPath(Environment.SpecialFolder.MyPictures);
            if (string.IsNullOrEmpty(pictures))
                pictures = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Pictures");
            return Directory.CreateDirectory(Path.Combine(pictures, "Tint")).FullName;
        }
    }

    /// <summary>Saves the picture and returns where it went, or null when the address isn't artwork or didn't answer.</summary>
    public static async Task<string?> Save(string url, string name, Library library)
    {
        byte[]? bytes = null;
        string extension = ".jpg";
        if (url.StartsWith("art/", StringComparison.Ordinal))
        {
            // A cover from this PC's own files, at the largest size Tint keeps.
            var key = url[4..].Split('?')[0];
            if (await library.ArtFile(key, 640) is { } file) bytes = await File.ReadAllBytesAsync(file);
        }
        else if (Uri.TryCreate(url, UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps
                 && ArtHosts.Any(host => uri.Host == host || uri.Host.EndsWith("." + host, StringComparison.OrdinalIgnoreCase)))
        {
            try
            {
                using var answer = await Http.GetAsync(uri);
                var type = answer.Content.Headers.ContentType?.MediaType ?? "";
                if (answer.IsSuccessStatusCode && type.StartsWith("image/", StringComparison.Ordinal))
                {
                    bytes = await answer.Content.ReadAsByteArrayAsync();
                    extension = type switch { "image/png" => ".png", "image/webp" => ".webp", _ => ".jpg" };
                }
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException) { }
        }
        if (bytes is not { Length: > 0 }) return null;

        var clean = new string(name.Select(c => Path.GetInvalidFileNameChars().Contains(c) || c < ' ' ? ' ' : c).ToArray()).Trim();
        if (clean.Length == 0) clean = "Cover";
        if (clean.Length > 120) clean = clean[..120].Trim();
        var path = Path.Combine(Folder, clean + extension);
        for (int n = 2; File.Exists(path); n++) path = Path.Combine(Folder, $"{clean} ({n}){extension}");
        await File.WriteAllBytesAsync(path, bytes);
        return path;
    }

    /// <summary>Opens the folder the covers are saved in.</summary>
    public static void ShowFolder()
    {
        try { Process.Start(new ProcessStartInfo(Folder) { UseShellExecute = true }); }
        catch { /* no file manager to open it with */ }
    }
}
