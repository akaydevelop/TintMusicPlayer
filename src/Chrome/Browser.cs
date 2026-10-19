using System.Diagnostics;
using System.Text.Json.Nodes;

namespace Tint;

/// <summary>
/// Finds an installed Chrome-family browser and starts it for Tint: its own profile, one app window
/// with no tabs or address bar, and the DevTools protocol open to Tint alone.
///
/// The browser matters for one reason above all: Apple Music's full songs are protected, and only a
/// browser that carries Google's Widevine module can play them. Google Chrome, Microsoft Edge and
/// Brave carry it. Chromium as most distributions package it doesn't, so it is tried last and only
/// plays Apple Music's previews (and everything else).
/// </summary>
static class Browser
{
    /// <summary>The order browsers are looked for in. TINT_BROWSER, a program name or path, comes before all of them.</summary>
    static readonly string[] LinuxNames =
    [
        "google-chrome-stable", "google-chrome", "microsoft-edge-stable", "microsoft-edge",
        "brave-browser", "brave", "vivaldi-stable", "vivaldi", "chromium", "chromium-browser",
    ];

    static IEnumerable<string> WindowsPaths()
    {
        foreach (var root in new[] { Environment.SpecialFolder.ProgramFiles, Environment.SpecialFolder.ProgramFilesX86, Environment.SpecialFolder.LocalApplicationData })
        {
            var folder = Environment.GetFolderPath(root);
            if (folder.Length == 0) continue;
            yield return Path.Combine(folder, @"Google\Chrome\Application\chrome.exe");
            yield return Path.Combine(folder, @"Microsoft\Edge\Application\msedge.exe");
            yield return Path.Combine(folder, @"BraveSoftware\Brave-Browser\Application\brave.exe");
        }
    }

    public static string? Find()
    {
        if (Environment.GetEnvironmentVariable("TINT_BROWSER") is { Length: > 0 } chosen)
            return File.Exists(chosen) ? Path.GetFullPath(chosen) : OnPath(chosen);
        if (OperatingSystem.IsWindows()) return WindowsPaths().FirstOrDefault(File.Exists);
        return LinuxNames.Select(OnPath).FirstOrDefault(found => found != null);
    }

    /// <summary>Whether this browser is one known to lack Widevine as usually packaged.</summary>
    public static bool MayLackWidevine(string browser) =>
        Path.GetFileName(browser).StartsWith("chromium", StringComparison.OrdinalIgnoreCase);

    static string? OnPath(string file) =>
        (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(folder => { try { return Path.Combine(folder, file); } catch { return ""; } })
            .FirstOrDefault(File.Exists);

    /// <summary>Where the window should open, and how big; null lets the browser choose.</summary>
    public sealed record Placement(int Left, int Top, int Width, int Height);

    /// <summary>
    /// Starts the browser and connects to it. On Linux the protocol runs over a private pipe (no
    /// network port any other program could reach). Windows can't hand a child those extra pipes
    /// from .NET, so there, where this build is only ever tried out, a loopback port is used.
    /// </summary>
    public static async Task<(Process Process, Cdp Cdp)> Start(string browser, string firstPage, Placement? placement, bool dev)
    {
        Directory.CreateDirectory(Paths.BrowserData);
        var arguments = new List<string>
        {
            "--user-data-dir=" + Paths.BrowserData,
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-default-apps",
            "--disable-sync",
            // Songs follow one another without a click in between, so playback can't wait for a user gesture.
            "--autoplay-policy=no-user-gesture-required",
            // The hidden YouTube Music page keeps time with timers, and must keep doing so out of sight.
            "--disable-background-timer-throttling",
            "--disable-renderer-backgrounding",
            "--disable-features=Translate,TranslateUI",
            // The name X11 window managers group the window under.
            "--class=Tint",
            "--app=" + firstPage,
        };
        if (placement != null)
        {
            arguments.Add($"--window-size={placement.Width},{placement.Height}");
            arguments.Add($"--window-position={placement.Left},{placement.Top}");
        }
        return await Connect(browser, arguments, dev);
    }

    /// <summary>
    /// Opens a page in an app window of a browser of its own, with no DevTools connection at all.
    /// Google refuses to sign in to a browser that another program drives ("This browser or app
    /// may not be secure"), so its sign-in happens here, in a profile kept for that alone, and
    /// <see cref="ReadCookies"/> collects the result once the window is closed.
    /// </summary>
    public static Process StartUnwatched(string browser, string profile, string page, int width, int height)
    {
        Directory.CreateDirectory(profile);
        var start = new ProcessStartInfo(browser) { UseShellExecute = false };
        foreach (var argument in new[]
        {
            "--user-data-dir=" + profile,
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-default-apps",
            "--disable-sync",
            SignInPasswords,
            "--class=Tint",
            $"--window-size={width},{height}",
            "--app=" + page,
        }) start.ArgumentList.Add(argument);
        if (!OperatingSystem.IsWindows())
        {
            start.RedirectStandardError = true;
            start.RedirectStandardOutput = true;
        }
        var process = Process.Start(start) ?? throw new InvalidOperationException("The browser wouldn't start.");
        if (!OperatingSystem.IsWindows())
        {
            // Its chatter goes nowhere.
            _ = process.StandardError.BaseStream.CopyToAsync(Stream.Null);
            _ = process.StandardOutput.BaseStream.CopyToAsync(Stream.Null);
        }
        return process;
    }

    /// <summary>
    /// On Linux a profile's cookies are encrypted with a key from the desktop's keyring, which a
    /// browser started without a window may not reach. The sign-in profile does without the
    /// keyring both times, so the copy that reads its cookies can decrypt them. It lives only as
    /// long as the sign-in does.
    /// </summary>
    const string SignInPasswords = "--password-store=basic";

    /// <summary>Every cookie of a profile no browser has open, read by a windowless browser started for the purpose.</summary>
    public static async Task<List<JsonObject>> ReadCookies(string browser, string profile)
    {
        var (process, cdp) = await Connect(browser,
        [
            "--user-data-dir=" + profile,
            "--headless=new",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-sync",
            SignInPasswords,
            "about:blank",
        ], dev: false);
        try
        {
            var all = await cdp.Send("Storage.getCookies");
            return (all["cookies"] as JsonArray ?? []).OfType<JsonObject>().ToList();
        }
        finally
        {
            try { await cdp.Send("Browser.close", null, null, TimeSpan.FromSeconds(3)); } catch { }
            await cdp.DisposeAsync();
            try
            {
                using var patience = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                await process.WaitForExitAsync(patience.Token);
            }
            catch
            {
                try { process.Kill(entireProcessTree: true); } catch { }
            }
            process.Dispose();
        }
    }

    static async Task<(Process Process, Cdp Cdp)> Connect(string browser, List<string> arguments, bool dev)
    {
        if (OperatingSystem.IsWindows())
        {
            // A port of the system's choosing, unless dev mode wants the fixed one tools\eval.mjs knows.
            arguments.Add("--remote-debugging-port=" + (dev ? "9229" : "0"));

            var start = new ProcessStartInfo(browser) { UseShellExecute = false, RedirectStandardError = true };
            foreach (var argument in arguments) start.ArgumentList.Add(argument);
            var process = Process.Start(start) ?? throw new InvalidOperationException("The browser wouldn't start.");

            // The browser's first words say where its DevTools WebSocket is. The rest is only noise,
            // passed through in dev mode.
            var found = new TaskCompletionSource<Uri?>(TaskCreationOptions.RunContinuationsAsynchronously);
            _ = Task.Run(async () =>
            {
                while (await process.StandardError.ReadLineAsync() is { } line)
                {
                    const string Listening = "DevTools listening on ";
                    if (line.StartsWith(Listening, StringComparison.Ordinal) && Uri.TryCreate(line[Listening.Length..].Trim(), UriKind.Absolute, out var address))
                        found.TrySetResult(address);
                    else if (dev)
                        Console.Error.WriteLine(line);
                }
                found.TrySetResult(null);
            });

            var first = await Task.WhenAny(found.Task, Task.Delay(TimeSpan.FromSeconds(20)));
            if (first == found.Task && await found.Task is { } socket)
            {
                using var patience = new CancellationTokenSource(TimeSpan.FromSeconds(10));
                return (process, await Cdp.OverWebSocket(socket, patience.Token));
            }
            try { process.Kill(); } catch { }
            throw new InvalidOperationException(process.HasExited ? AlreadyRunning : "The browser started but never opened its DevTools connection.");
        }
        else
        {
            arguments.Add("--remote-debugging-pipe");
            // Dev mode also opens the usual port, for DevTools and scripted checks against the page.
            if (dev) arguments.Add("--remote-debugging-port=9229");

            // The browser reads commands from its fd 3 and writes answers to fd 4. The shell sets
            // those up from the pipes .NET gives a child (its stdin and stdout), then becomes the browser.
            var start = new ProcessStartInfo("/bin/sh")
            {
                UseShellExecute = false,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
            };
            start.ArgumentList.Add("-c");
            start.ArgumentList.Add(dev
                ? "exec \"$0\" \"$@\" 3<&0 4>&1 0</dev/null 1>/dev/null"
                : "exec \"$0\" \"$@\" 3<&0 4>&1 0</dev/null 1>/dev/null 2>/dev/null");
            start.ArgumentList.Add(browser);
            foreach (var argument in arguments) start.ArgumentList.Add(argument);
            var process = Process.Start(start) ?? throw new InvalidOperationException("The browser wouldn't start.");
            var cdp = Cdp.OverPipe(process.StandardInput.BaseStream, process.StandardOutput.BaseStream);
            try
            {
                await cdp.Send("Browser.getVersion", null, null, TimeSpan.FromSeconds(20));
            }
            catch
            {
                await cdp.DisposeAsync();
                try { process.Kill(); } catch { }
                throw new InvalidOperationException(process.HasExited ? AlreadyRunning : "The browser started but didn't answer on its DevTools pipe.");
            }
            return (process, cdp);
        }
    }

    const string AlreadyRunning =
        "The browser closed straight after starting. If another Tint is still shutting down, give it a moment and try again.";
}
