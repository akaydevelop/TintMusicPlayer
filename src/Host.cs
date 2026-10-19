using System.Drawing;

namespace Tint;

/// <summary>
/// What the local server needs from whatever shows the page: the WebView2 window on Windows
/// (Windows\MainForm.cs), or a Chrome app window driven over the DevTools protocol elsewhere
/// (Chrome\ChromeHost.cs). Every member may be called from any thread.
/// </summary>
interface IHost
{
    /// <summary>Asks for a folder of music. Null when the person cancelled, or no picker could be shown.</summary>
    Task<string?> PickFolder();

    /// <summary>Asks for a MusicKit private key file (.p8).</summary>
    Task<string?> PickKeyFile();

    /// <summary>The page's colours, for a window frame that can follow them.</summary>
    void TintChrome(Color background, Color text, bool instant);

    /// <summary>Switches between the full window and the small player.</summary>
    void SetMini(bool on);

    /// <summary>Has the person sign in to Google; true once YouTube's cookies were captured.</summary>
    Task<bool> YouTubeSignIn();

    Task YouTubeSignOut();

    /// <summary>Opens the hidden YouTube Music page that plays songs with the site's own player.</summary>
    Task<bool> OpenYouTubePage(bool again);

    /// <summary>Closes Tint as if the person had closed its window.</summary>
    void Quit();

    /// <summary>What the page says is playing, for the system's media controls.</summary>
    void ShowNowPlaying(SystemTrack? track, bool playing, long at);
}

/// <summary>The current song as the system's media controls show it.</summary>
sealed record SystemTrack(string Title, string Artist, string Album, string? ArtFile, string? ArtUrl);
