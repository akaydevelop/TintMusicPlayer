namespace Tint;

/// <summary>
/// Gives Tint's windows Tint's icon in the desktop's task bar and window switcher.
///
/// On Wayland a window finds its icon through its app_id, which has to match the name of a desktop
/// entry. Chrome doesn't use --class for an app window's app_id: it makes one from the program's
/// name, the address the window was opened with (without the port) and the profile folder, as in
/// "chrome-127.0.0.1__start.html-Default". So next to install.sh's tint.desktop, hidden entries
/// by those names point at the same icon, for each browser Tint may run in and for both of its
/// windows (the player, and Google's sign-in). Under X11 the windows' class is "Tint" (--class),
/// which StartupWMClass matches.
///
/// They are written on every start rather than by install.sh alone, so a Tint updated in place
/// has them too. Only when install.sh's entry is there: a Tint that wasn't installed leaves the
/// desktop alone.
/// </summary>
static class DesktopEntry
{
    static readonly string[] Programs = ["chrome", "msedge", "brave"];
    static readonly string[] Pages = ["127.0.0.1__start.html", "accounts.google.com__ServiceLogin"];

    // Where install.sh puts tint.desktop.
    static string Folder => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".local", "share", "applications");

    public static void Ensure()
    {
        if (!OperatingSystem.IsLinux()) return;
        try
        {
            if (!File.Exists(Path.Combine(Folder, "tint.desktop"))) return;
            var program = Path.Combine(AppContext.BaseDirectory, "Tint");
            var text = $"""
                [Desktop Entry]
                Type=Application
                Name=Tint
                Exec={program}
                Icon=tint
                NoDisplay=true
                StartupWMClass=Tint

                """;
            foreach (var browser in Programs)
            {
                foreach (var window in Pages)
                {
                    var file = Path.Combine(Folder, $"{browser}-{window}-Default.desktop");
                    if (!File.Exists(file) || File.ReadAllText(file) != text) File.WriteAllText(file, text);
                }
            }
        }
        catch
        {
            // Only the icon is at stake.
        }
    }
}
