namespace Tint;

static class Paths
{
    /// <summary>
    /// Where Tint keeps its settings, library and caches: %LOCALAPPDATA%\Tint on Windows,
    /// ~/.local/share/Tint on Linux. TINT_DATA points it elsewhere, for trying a build out
    /// without touching the settings of the copy in daily use.
    /// </summary>
    public static readonly string Data = Private(Directory.CreateDirectory(
        Environment.GetEnvironmentVariable("TINT_DATA") is { Length: > 0 } custom
            ? custom
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData, Environment.SpecialFolderOption.Create), "Tint")).FullName);

    /// <summary>
    /// The folder holds sign-ins (YouTube's cookies, Apple's tokens). On Windows the profile folder
    /// is the person's own already; elsewhere it is made so here.
    /// </summary>
    static string Private(string folder)
    {
        if (!OperatingSystem.IsWindows())
        {
            try { File.SetUnixFileMode(folder, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute); }
            catch { /* a folder Tint doesn't own (TINT_DATA): leave it be */ }
        }
        return folder;
    }

    public static readonly string Art = Directory.CreateDirectory(Path.Combine(Data, "art")).FullName;
    public static readonly string WebViewData = Path.Combine(Data, "WebView2");
    /// <summary>The browser profile of the Chrome-hosted build: its own, never the person's everyday one.</summary>
    public static readonly string BrowserData = Path.Combine(Data, "browser");
    public static readonly string SettingsFile = Path.Combine(Data, "settings.json");
    public static readonly string LibraryFile = Path.Combine(Data, "library.json");

    /// <summary>The folder the UI is served from. In dev mode this is the source tree, so edits show up on reload.</summary>
    public static string WebRoot(bool dev)
    {
        if (dev)
        {
            for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir != null; dir = dir.Parent)
            {
                if (File.Exists(Path.Combine(dir.FullName, "Tint.csproj")))
                    return Path.Combine(dir.FullName, "wwwroot");
            }
        }
        return Path.Combine(AppContext.BaseDirectory, "wwwroot");
    }
}
