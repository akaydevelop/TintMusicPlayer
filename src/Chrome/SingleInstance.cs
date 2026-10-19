using System.Net.Sockets;

namespace Tint;

/// <summary>
/// One Tint per person: the first to start listens on a socket file in Tint's data folder, and a
/// second start only knocks there, which brings the first one's window forward, and then quits.
/// </summary>
sealed class SingleInstance : IDisposable
{
    readonly Socket _listener;
    readonly string _path;

    public event Action? Woken;

    SingleInstance(Socket listener, string path)
    {
        _listener = listener;
        _path = path;
        _ = Task.Run(Listen);
    }

    /// <summary>This process's claim to be the one Tint, or null when another holds it (and has been woken).</summary>
    public static SingleInstance? Claim()
    {
        var path = Path.Combine(Paths.Data, "instance.sock");
        var address = new UnixDomainSocketEndPoint(path);

        try
        {
            using var knock = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
            knock.Connect(address);
            knock.Send("wake"u8);
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
        while (true)
        {
            try
            {
                using var visitor = await _listener.AcceptAsync();
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
