using System.Net.Sockets;
using System.Text;

namespace Tint;

/// <summary>
/// One Tint per person: the first to start listens on a socket file in Tint's data folder, and a
/// second start only knocks there (optionally passing an incoming link), which brings the first
/// one's window forward, and then quits.
/// </summary>
sealed class SingleInstance : IDisposable
{
    readonly Socket _listener;
    readonly string _path;

    public event Action? Woken;
    public event Action<string>? LinkReceived;

    SingleInstance(Socket listener, string path)
    {
        _listener = listener;
        _path = path;
        _ = Task.Run(Listen);
    }

    /// <summary>This process's claim to be the one Tint, or null when another holds it (and has been woken).</summary>
    public static SingleInstance? Claim(string? link = null)
    {
        var path = Path.Combine(Paths.Data, "instance.sock");
        var address = new UnixDomainSocketEndPoint(path);

        try
        {
            using var knock = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
            knock.Connect(address);
            var payload = string.IsNullOrEmpty(link) ? "wake" : "link:" + link;
            knock.Send(Encoding.UTF8.GetBytes(payload));
            return null;
        }
        catch (SocketException)
        {
            // Nobody there: the file, if any, was left by a Tint that didn't get to clean up.
        }

        try { File.Delete(path); } catch { }
        var listener = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
        listener.Bind(address);
        listener.Listen(4);
        return new SingleInstance(listener, path);
    }

    async Task Listen()
    {
        var buf = new byte[4096];
        while (true)
        {
            try
            {
                using var visitor = await _listener.AcceptAsync();
                int n = 0;
                try { n = await visitor.ReceiveAsync(buf); } catch { }
                if (n > 5)
                {
                    var msg = Encoding.UTF8.GetString(buf, 0, n);
                    if (msg.StartsWith("link:", StringComparison.Ordinal))
                    {
                        var url = msg[5..].Trim();
                        if (url.Length > 0) LinkReceived?.Invoke(url);
                    }
                }
                Woken?.Invoke();
            }
            catch (ObjectDisposedException) { return; }
            catch (SocketException) { return; }
        }
    }

    public void Dispose()
    {
        _listener.Dispose();
        try { File.Delete(_path); } catch { }
    }
}
