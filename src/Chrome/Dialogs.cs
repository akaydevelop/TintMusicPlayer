using System.Diagnostics;
using System.Text;

namespace Tint;

/// <summary>
/// The desktop's own file dialogs and error boxes, through the small programs desktops ship for
/// scripts: kdialog on KDE Plasma, zenity on GNOME and most others. When neither is installed
/// Tint asks in its page instead (see ChromeHost), and reports errors on the terminal only.
/// </summary>
static class Dialogs
{
    static readonly bool OnKde = (Environment.GetEnvironmentVariable("XDG_CURRENT_DESKTOP") ?? "").Contains("KDE", StringComparison.OrdinalIgnoreCase);
    static readonly string? Zenity = OperatingSystem.IsWindows() ? null : OnPath("zenity");
    static readonly string? Kdialog = OperatingSystem.IsWindows() ? null : OnPath("kdialog");

    /// <summary>The program to use: the desktop's own first.</summary>
    static string? Tool => OnKde ? Kdialog ?? Zenity : Zenity ?? Kdialog;

    public static bool Available => Tool != null;

    public static Task<string?> PickFolder(string title, string start) =>
        Tool == Kdialog
            ? Ask(Kdialog!, "--title", title, "--getexistingdirectory", start)
            : Ask(Zenity!, "--file-selection", "--directory", "--title=" + title, "--filename=" + start.TrimEnd('/') + "/");

    public static Task<string?> PickFile(string title, string kind, string pattern)
    {
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        return Tool == Kdialog
            ? Ask(Kdialog!, "--title", title, "--getopenfilename", home, $"{pattern}|{kind}")
            : Ask(Zenity!, "--file-selection", "--title=" + title, "--filename=" + home + "/", $"--file-filter={kind} | {pattern}", "--file-filter=All files | *");
    }

    /// <summary>Shows a message that Tint couldn't start, where someone who started it from a menu will see it.</summary>
    public static void Error(string message)
    {
        Console.Error.WriteLine("Tint: " + message);
        try
        {
            if (Tool == Kdialog && Kdialog != null) Run(Kdialog, "--title", "Tint", "--error", message).Wait();
            else if (Zenity != null) Run(Zenity, "--error", "--title=Tint", "--width=420", "--text=" + message).Wait();
        }
        catch { }
    }

    static async Task<string?> Ask(string program, params string[] arguments)
    {
        var (code, output) = await Run(program, arguments);
        var answer = output.Trim();
        return code == 0 && answer.Length > 0 ? answer : null;
    }

    static async Task<(int Code, string Output)> Run(string program, params string[] arguments)
    {
        var start = new ProcessStartInfo(program) { UseShellExecute = false, RedirectStandardOutput = true, StandardOutputEncoding = Encoding.UTF8 };
        foreach (var argument in arguments) start.ArgumentList.Add(argument);
        using var process = Process.Start(start) ?? throw new InvalidOperationException(program + " wouldn't start.");
        var output = await process.StandardOutput.ReadToEndAsync();
        await process.WaitForExitAsync();
        return (process.ExitCode, output);
    }

    static string? OnPath(string file) =>
        (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
            .Select(folder => Path.Combine(folder, file))
            .FirstOrDefault(File.Exists);
}
