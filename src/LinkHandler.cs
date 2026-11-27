using System.Diagnostics;
using System.Text;

namespace Tint;

/// <summary>
/// Opt-in test feature: registers Tint as a per-user URI handler so other apps can send
/// tint:// links (and optionally spotify:, music:, itmss: links) straight into Tint, and
/// passes incoming links across single-instance launches.
/// </summary>
static class LinkHandler
{
    static readonly string[] AppSchemes = ["spotify", "music", "itmss"];

    static string PendingFile => Path.Combine(Paths.Data, "pending-link.txt");

    /// <summary>
    /// Strict music-link allowlist: only Spotify, Apple Music, YouTube Music (or YouTube watch/playlist/youtu.be),
    /// or a tint:// link wrapping one of those. Rejects all other URLs, files, and schemes.
    /// </summary>
    public static bool IsMusicLink(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return false;
        var s = raw.Trim();

        // Unwrap tint://open?url=... or tint://<music-url>
        if (s.StartsWith("tint:", StringComparison.OrdinalIgnoreCase))
        {
            s = UnwrapTint(s);
            if (string.IsNullOrWhiteSpace(s) || s.StartsWith("tint:", StringComparison.OrdinalIgnoreCase))
                return false;
        }

        // Spotify URI: spotify:track|album|playlist|artist:<22-char id>
        if (s.StartsWith("spotify:", StringComparison.OrdinalIgnoreCase))
        {
            var parts = s.Split(':');
            return parts.Length == 3
                && parts[1].ToLowerInvariant() is "track" or "album" or "playlist" or "artist"
                && parts[2].Length == 22
                && parts[2].All(char.IsAsciiLetterOrDigit);
        }

        // Apple Music app URI: music://music.apple.com/... or itmss://music.apple.com/...
        if (s.StartsWith("music://", StringComparison.OrdinalIgnoreCase))
            s = "https://" + s["music://".Length..];
        else if (s.StartsWith("itmss://", StringComparison.OrdinalIgnoreCase))
            s = "https://" + s["itmss://".Length..];

        if (!Uri.TryCreate(s, UriKind.Absolute, out var uri)) return false;
        if (uri.Scheme is not ("https" or "http")) return false;

        var host = uri.Host.ToLowerInvariant();
        if (host is "open.spotify.com" or "play.spotify.com" or "spotify.link") return true;
        if (host == "music.apple.com" || host.EndsWith(".music.apple.com", StringComparison.Ordinal)) return true;
        if (host == "music.youtube.com" || host == "youtu.be") return true;
        if (host is "youtube.com" or "www.youtube.com" or "m.youtube.com")
        {
            var path = uri.AbsolutePath.ToLowerInvariant();
            return path == "/watch" || path == "/playlist";
        }
        return false;
    }

    static string UnwrapTint(string raw)
    {
        if (Uri.TryCreate(raw, UriKind.Absolute, out var uri))
        {
            var query = uri.Query.TrimStart('?');
            foreach (var pair in query.Split('&', StringSplitOptions.RemoveEmptyEntries))
            {
                var eq = pair.IndexOf('=');
                if (eq <= 0) continue;
                var key = Uri.UnescapeDataString(pair[..eq]);
                if (key.Equals("url", StringComparison.OrdinalIgnoreCase))
                    return Uri.UnescapeDataString(pair[(eq + 1)..]).Trim();
            }
        }
        var rest = raw["tint:".Length..].TrimStart('/');
        if (rest.StartsWith("open/", StringComparison.OrdinalIgnoreCase)) rest = rest["open/".Length..];
        try { return Uri.UnescapeDataString(rest).Trim(); } catch { return rest.Trim(); }
    }

    /// <summary>Returns the first verified music link passed on the command line, if any.</summary>
    public static string? LinkFromArgs(string[] args)
    {
        foreach (var raw in args)
        {
            if (string.IsNullOrWhiteSpace(raw) || raw.StartsWith("--", StringComparison.Ordinal)) continue;
            var s = raw.Trim();
            if (IsMusicLink(s)) return s;
        }
        return null;
    }

    public static void WritePending(string url)
    {
        if (!IsMusicLink(url)) return;
        try
        {
            Directory.CreateDirectory(Paths.Data);
            var tmp = PendingFile + ".tmp";
            File.WriteAllText(tmp, url, Encoding.UTF8);
            File.Move(tmp, PendingFile, overwrite: true);
        }
        catch { }
    }

    public static string? TakePending()
    {
        try
        {
            if (!File.Exists(PendingFile)) return null;
            var text = File.ReadAllText(PendingFile, Encoding.UTF8).Trim();
            try { File.Delete(PendingFile); } catch { }
            return IsMusicLink(text) ? text : null;
        }
        catch { return null; }
    }

    /// <summary>Launches a verified music link through the OS shell so the user can test the protocol round-trip.</summary>
    public static bool OpenViaShell(string url)
    {
        if (!IsMusicLink(url)) return false;
        try
        {
            Process.Start(new ProcessStartInfo(url.Trim()) { UseShellExecute = true });
            return true;
        }
        catch { return false; }
    }

    /// <summary>Registers or removes per-user protocol handlers according to settings. Never needs admin rights.</summary>
    public static (bool ok, string? error) Sync(bool enableTint, bool enableMusicApps)
    {
        try
        {
#if WINDOWS
            SyncWindows(enableTint, enableTint && enableMusicApps);
#else
            if (OperatingSystem.IsLinux()) SyncLinux(enableTint, enableTint && enableMusicApps);
#endif
            return (true, null);
        }
        catch (Exception ex)
        {
            return (false, ex.Message);
        }
    }

#if WINDOWS
    const string BackupRoot = @"Software\Tint\PreviousHandlers";

    static void SyncWindows(bool enableTint, bool enableMusicApps)
    {
        var exe = Environment.ProcessPath;
        if (string.IsNullOrEmpty(exe)) return;
        var command = $"\"{exe}\" \"%1\"";

        if (enableTint)
            RegisterWindowsScheme("tint", "URL:Tint Protocol", exe, command, backupExisting: false);
        else
            UnregisterWindowsScheme("tint");

        foreach (var scheme in AppSchemes)
        {
            if (enableMusicApps)
                RegisterWindowsScheme(scheme, $"URL:{scheme} (Tint)", exe, command, backupExisting: true);
            else
                UnregisterWindowsScheme(scheme);
        }
    }

    static void RegisterWindowsScheme(string scheme, string description, string exe, string command, bool backupExisting)
    {
        var classesPath = $@"Software\Classes\{scheme}";
        using var existing = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(classesPath, writable: false);
        bool alreadyOwned = existing?.GetValue("TintOwned") is int owned && owned == 1;

        if (backupExisting && existing != null && !alreadyOwned)
        {
            // Remember any existing per-user command so turning the toggle off puts it back.
            using var prevCmdKey = existing.OpenSubKey(@"shell\open\command");
            var prevCmd = prevCmdKey?.GetValue(null) as string;
            var prevDesc = existing.GetValue(null) as string;
            using var backup = Microsoft.Win32.Registry.CurrentUser.CreateSubKey($@"{BackupRoot}\{scheme}");
            backup.SetValue("HadKey", 1, Microsoft.Win32.RegistryValueKind.DWord);
            if (prevCmd != null) backup.SetValue("Command", prevCmd);
            if (prevDesc != null) backup.SetValue("Description", prevDesc);
        }

        using var key = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(classesPath);
        key.SetValue(null, description);
        key.SetValue("URL Protocol", "");
        key.SetValue("TintOwned", 1, Microsoft.Win32.RegistryValueKind.DWord);
        using (var iconKey = key.CreateSubKey("DefaultIcon"))
            iconKey.SetValue(null, $"\"{exe}\",0");
        using (var cmdKey = key.CreateSubKey(@"shell\open\command"))
            cmdKey.SetValue(null, command);
    }

    static void UnregisterWindowsScheme(string scheme)
    {
        var classesPath = $@"Software\Classes\{scheme}";
        using var existing = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(classesPath, writable: false);
        bool owned = existing?.GetValue("TintOwned") is int o && o == 1;
        if (!owned) return;

        using var backup = Microsoft.Win32.Registry.CurrentUser.OpenSubKey($@"{BackupRoot}\{scheme}", writable: false);
        var prevCmd = backup?.GetValue("Command") as string;
        var prevDesc = backup?.GetValue("Description") as string;
        bool hadKey = backup?.GetValue("HadKey") is int h && h == 1;

        if (hadKey && !string.IsNullOrEmpty(prevCmd))
        {
            using var key = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(classesPath);
            if (prevDesc != null) key.SetValue(null, prevDesc);
            key.DeleteValue("TintOwned", throwOnMissingValue: false);
            using var cmdKey = key.CreateSubKey(@"shell\open\command");
            cmdKey.SetValue(null, prevCmd);
        }
        else
        {
            Microsoft.Win32.Registry.CurrentUser.DeleteSubKeyTree(classesPath, throwOnMissingSubKey: false);
        }
        Microsoft.Win32.Registry.CurrentUser.DeleteSubKeyTree($@"{BackupRoot}\{scheme}", throwOnMissingSubKey: false);
    }
#else
    static void SyncLinux(bool enableTint, bool enableMusicApps)
    {
        var appsDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".local", "share", "applications");
        var desktopFile = Path.Combine(appsDir, "tint-links.desktop");
        if (!enableTint)
        {
            try { if (File.Exists(desktopFile)) File.Delete(desktopFile); } catch { }
            return;
        }

        Directory.CreateDirectory(appsDir);
        var exe = Environment.ProcessPath ?? Path.Combine(AppContext.BaseDirectory, "Tint");
        var schemes = enableMusicApps
            ? new[] { "tint", "spotify", "music", "itmss" }
            : new[] { "tint" };
        var mime = string.Join(";", schemes.Select(s => $"x-scheme-handler/{s}")) + ";";
        var text = $"""
            [Desktop Entry]
            Type=Application
            Name=Tint (Links)
            Exec="{exe}" %u
            Icon=tint
            NoDisplay=true
            MimeType={mime}

            """;
        File.WriteAllText(desktopFile, text);
        foreach (var s in schemes)
        {
            try
            {
                using var p = Process.Start(new ProcessStartInfo("xdg-mime", $"default tint-links.desktop x-scheme-handler/{s}")
                { UseShellExecute = false, CreateNoWindow = true });
                p?.WaitForExit(2000);
            }
            catch { }
        }
    }
#endif
}
