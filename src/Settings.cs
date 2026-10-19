using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Tint;

sealed class Settings
{
    public List<string> Folders { get; set; } = new();
    public bool FoldersInitialized { get; set; }
    public bool KeepDark { get; set; }

    public string? AppleTeamId { get; set; }
    public string? AppleKeyId { get; set; }
    /// <summary>The MusicKit .p8 private key, kept with Protect.</summary>
    public string? ApplePrivateKeyProtected { get; set; }
    /// <summary>A ready-made developer token pasted by the user, kept with Protect.</summary>
    public string? AppleRawTokenProtected { get; set; }

    /// <summary>Use the token Apple's own web player ships with, for people without a developer key.</summary>
    public bool AppleUseWebToken { get; set; }

    public bool DiscordEnabled { get; set; }
    /// <summary>The ID of the Discord application whose name appears after "Listening to".</summary>
    public string? DiscordAppId { get; set; }

    /// <summary>Search YouTube Music's catalog and play from it (through yt-dlp).</summary>
    public bool YouTubeEnabled { get; set; }
    /// <summary>"page" plays YouTube songs in the site's own player, kept open out of sight; "ytdlp" always fetches them with yt-dlp.</summary>
    public string YouTubePlayer { get; set; } = "page";

    public int[]? Bounds { get; set; }
    public bool Maximized { get; set; }

    static readonly JsonSerializerOptions Json = new() { WriteIndented = true };
    readonly object _gate = new();

    public static Settings Load()
    {
        Settings s;
        try
        {
            s = JsonSerializer.Deserialize<Settings>(File.ReadAllText(Paths.SettingsFile), Json) ?? new Settings();
        }
        catch
        {
            s = new Settings();
        }

        if (!s.FoldersInitialized)
        {
            var music = Environment.GetFolderPath(Environment.SpecialFolder.MyMusic);
            // Windows: where iTunes and Apple Music keep their files. Elsewhere: the Music folder itself.
            var candidates = OperatingSystem.IsWindows() ? new[] { @"iTunes\iTunes Media", @"Apple Music\Media" } : new[] { "" };
            foreach (var candidate in candidates)
            {
                var path = Path.Combine(music, candidate).TrimEnd(Path.DirectorySeparatorChar);
                if (music.Length > 0 && Directory.Exists(path) && !s.Folders.Contains(path, StringComparer.OrdinalIgnoreCase))
                    s.Folders.Add(path);
            }
            s.FoldersInitialized = true;
            s.Save();
        }
        return s;
    }

    public void Save()
    {
        lock (_gate)
        {
            try
            {
                var tmp = Paths.SettingsFile + ".tmp";
                File.WriteAllText(tmp, JsonSerializer.Serialize(this, Json));
                File.Move(tmp, Paths.SettingsFile, overwrite: true);
            }
            catch
            {
                // Settings are a convenience; never take the player down over them.
            }
        }
    }

    // Kept stored values readable as what they are: "plain:" marks one that only file permissions guard.
    const string Plain = "plain:";

    /// <summary>
    /// On Windows, encrypted for the current Windows user (DPAPI). Linux has nothing built in to match
    /// it, so there the value is only encoded, and guarded by Tint's data folder being readable by
    /// its owner alone (see Paths).
    /// </summary>
    public static string Protect(string plain)
    {
#if WINDOWS
        return Convert.ToBase64String(ProtectedData.Protect(Encoding.UTF8.GetBytes(plain), null, DataProtectionScope.CurrentUser));
#else
        return Plain + Convert.ToBase64String(Encoding.UTF8.GetBytes(plain));
#endif
    }

    public static string? Unprotect(string? stored)
    {
        if (string.IsNullOrEmpty(stored)) return null;
        try
        {
            if (stored.StartsWith(Plain, StringComparison.Ordinal))
                return Encoding.UTF8.GetString(Convert.FromBase64String(stored[Plain.Length..]));
#if WINDOWS
            return Encoding.UTF8.GetString(ProtectedData.Unprotect(Convert.FromBase64String(stored), null, DataProtectionScope.CurrentUser));
#else
            return null;
#endif
        }
        catch
        {
            return null;
        }
    }
}
