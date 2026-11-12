using System.Diagnostics;
using System.Text.Json.Nodes;

namespace Tint;

/// <summary>
/// Writes the backup the Settings page puts together (saved playlists, tags, play history and
/// choices; never sign-ins or keys) into the Downloads folder, and shows it there.
/// Reading a backup back in happens in the page itself.
/// </summary>
static class Backup
{
    const string Prefix = "Tint backup";

    static string Folder
    {
        get
        {
            var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            return Directory.CreateDirectory(Path.Combine(home, "Downloads")).FullName;
        }
    }

    /// <summary>Writes the backup and returns its path, or null when there was nothing to write or it failed.</summary>
    public static string? Write(JsonNode? body)
    {
        if (body is not JsonObject o) return null;
        try
        {
            var name = $"{Prefix} {DateTime.Now:yyyy-MM-dd}";
            var path = Path.Combine(Folder, name + ".json");
            for (int n = 2; File.Exists(path); n++) path = Path.Combine(Folder, $"{name} ({n}).json");
            File.WriteAllText(path, o.ToJsonString(new System.Text.Json.JsonSerializerOptions { WriteIndented = true }));
            return path;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>Shows a backup in its folder. Only Tint's own backups in Downloads are shown.</summary>
    public static void Show(string path)
    {
        try
        {
            var full = Path.GetFullPath(path);
            if (!string.Equals(Path.GetDirectoryName(full), Folder, StringComparison.OrdinalIgnoreCase)
                || !Path.GetFileName(full).StartsWith(Prefix, StringComparison.Ordinal)
                || !full.EndsWith(".json", StringComparison.OrdinalIgnoreCase)
                || !File.Exists(full)) return;
            if (OperatingSystem.IsWindows()) Process.Start("explorer.exe", $"/select,\"{full}\"");
            else Process.Start(new ProcessStartInfo(Folder) { UseShellExecute = true });
        }
        catch { /* no file manager to open it with */ }
    }
}
