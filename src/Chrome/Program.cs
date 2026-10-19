using System.Runtime.InteropServices;

namespace Tint;

/// <summary>The Chrome-hosted build: Linux first, though it starts on Windows too, for trying it out.</summary>
static class Program
{
    static async Task<int> Main(string[] args)
    {
        bool dev = args.Contains("--dev");

        using var instance = SingleInstance.Claim();
        if (instance == null) return 0; // another Tint is running, and has been brought forward

        var settings = Settings.Load();
        var library = new Library(settings);
        var youtube = new YouTube();
        var discord = new DiscordPresence(settings, new CoverLookup());
        var host = new ChromeHost(dev, settings, library, youtube);
        var server = new LocalServer(host, settings, library, new AppleToken(settings), discord, youtube, Paths.WebRoot(dev));
        host.Server = server;
        library.Thumbnailer = host.Thumbnail;
        instance.Woken += host.BringForward;

        // Closed from a terminal or by the session ending: close the browser too, and keep the window's place.
        using var interrupt = PosixSignalRegistration.Create(PosixSignal.SIGINT, Quit);
        using var terminate = PosixSignalRegistration.Create(PosixSignal.SIGTERM, Quit);
        void Quit(PosixSignalContext context)
        {
            context.Cancel = true;
            _ = host.Stop();
        }

        try
        {
            server.Start();
            library.Start();
            await host.Run();
            return 0;
        }
        catch (Exception ex)
        {
            Dialogs.Error("Tint couldn't start its player window.\n\n" + ex.Message);
            return 1;
        }
        finally
        {
            await host.Stop();
            youtube.Dispose();
            discord.Dispose();
            server.Dispose();
            library.Dispose();
        }
    }
}
