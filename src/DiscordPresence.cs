using System.IO.Pipes;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Tint;

sealed record NowPlaying(string Title, string Artist, string Album, double Duration, double Position, string? ArtUrl, DateTimeOffset At);

/// <summary>
/// Shows the current song on the person's Discord profile ("Listening to ..."). Discord's desktop
/// app listens on a local named pipe (a socket file on Linux); each message is an opcode, a length and a JSON body.
/// </summary>
sealed class DiscordPresence : IDisposable
{
    const int OpHandshake = 0, OpFrame = 1, OpClose = 2, OpPing = 3, OpPong = 4;
    static readonly TimeSpan RetryEvery = TimeSpan.FromSeconds(15);
    // A song change arrives as pause-then-play. Waiting a moment sends Discord only the outcome,
    // and keeps well inside its limit of five updates per twenty seconds.
    static readonly TimeSpan Settle = TimeSpan.FromMilliseconds(1200);

    readonly Settings _settings;
    readonly CoverLookup _covers;
    readonly object _gate = new();
    readonly SemaphoreSlim _signal = new(0);
    readonly SemaphoreSlim _writeGate = new(1);
    readonly CancellationTokenSource _stop = new();

    NowPlaying? _wanted;
    Stream? _pipe;
    string? _pipeAppId;

    /// <summary>off | waiting | connected | rejected</summary>
    public string Status { get; private set; } = "off";
    /// <summary>The Discord account the status is showing on, once connected.</summary>
    public string? User { get; private set; }
    /// <summary>Why it isn't working, or what Discord objected to, in plain words.</summary>
    public string? Problem { get; private set; }

    public DiscordPresence(Settings settings, CoverLookup covers)
    {
        _settings = settings;
        _covers = covers;
        _ = Task.Run(Run);
    }

    /// <summary>Sets what should be shown. Null clears it (nothing playing, or paused).</summary>
    public void Update(NowPlaying? now)
    {
        lock (_gate) _wanted = now;
        _signal.Release();
    }

#if DEBUG
    /// <summary>Dev builds only: lets a script check which cover a local album would get.</summary>
    public Task<string?> FindCover(string artist, string album) => _covers.Find(artist, album);
#endif

    /// <summary>The switch or the application ID changed.</summary>
    public void Reconfigure() => _signal.Release();

    async Task Run()
    {
        var token = _stop.Token;
        _signal.Release(); // connect at launch if it is switched on, so Settings can show the state
        try
        {
            while (!token.IsCancellationRequested)
            {
                bool wantsConnection = _settings.DiscordEnabled && !string.IsNullOrEmpty(_settings.DiscordAppId);
                bool woken = await _signal.WaitAsync(wantsConnection && _pipe == null ? RetryEvery : Timeout.InfiniteTimeSpan, token);
                if (woken)
                {
                    await Task.Delay(Settle, token);
                    while (_signal.CurrentCount > 0) await _signal.WaitAsync(token);
                }

                var appId = _settings.DiscordAppId;
                if (!_settings.DiscordEnabled || string.IsNullOrEmpty(appId))
                {
                    Disconnect();
                    Status = "off";
                    User = Problem = null;
                    continue;
                }

                if (_pipe != null && (_pipeAppId != appId || !IsOpen(_pipe))) Disconnect();
                if (_pipe == null && !await Connect(appId, token)) continue;

                NowPlaying? now;
                lock (_gate) now = _wanted;
                try
                {
                    await Send(OpFrame, new JsonObject
                    {
                        ["cmd"] = "SET_ACTIVITY",
                        ["nonce"] = Guid.NewGuid().ToString(),
                        ["args"] = new JsonObject
                        {
                            ["pid"] = Environment.ProcessId,
                            ["activity"] = now == null ? null : await Describe(now),
                        },
                    }, token);
                }
                catch (IOException)
                {
                    Disconnect();
                    Status = "waiting";
                    Problem = "Discord closed the connection. Trying again shortly.";
                    _signal.Release();
                }
            }
        }
        catch (OperationCanceledException) { }
        catch (ObjectDisposedException) { }
    }

    async Task<JsonObject> Describe(NowPlaying now)
    {
        var activity = new JsonObject
        {
            ["type"] = 2, // Listening
            ["details"] = Fit(now.Title),
        };

        if (!string.IsNullOrWhiteSpace(now.Artist))
        {
            activity["state"] = Fit(now.Artist);
            activity["status_display_type"] = 1; // the short status line reads "Listening to <artist>"
        }
        else
        {
            activity["status_display_type"] = 2; // ...or "Listening to <song>" when the artist is unknown
        }

        if (now.Duration > 0)
        {
            var start = now.At.ToUnixTimeMilliseconds() - (long)(now.Position * 1000);
            activity["timestamps"] = new JsonObject { ["start"] = start, ["end"] = start + (long)(now.Duration * 1000) };
        }

        // Discord can only show covers it can download, so files on this PC get theirs looked up by name.
        var art = now.ArtUrl;
        if (art == null && !string.IsNullOrWhiteSpace(now.Album))
        {
            try { art = await _covers.Find(now.Artist, now.Album).WaitAsync(TimeSpan.FromSeconds(3)); }
            catch { /* no cover this time */ }
        }
        if (art != null)
        {
            var assets = new JsonObject { ["large_image"] = art };
            if (!string.IsNullOrWhiteSpace(now.Album)) assets["large_text"] = Fit(now.Album);
            activity["assets"] = assets;
        }
        return activity;
    }

    /// <summary>Discord wants these strings to be 2 to 128 characters long.</summary>
    static string Fit(string text)
    {
        text = text.Trim();
        if (text.Length > 128) text = text[..127] + "…";
        // U+3164 is an invisible letter: it pads a one-character title without showing anything.
        while (text.Length < 2) text += "ㅤ";
        return text;
    }

    // ---- connection ------------------------------------------------------------------------------

    async Task<bool> Connect(string appId, CancellationToken token)
    {
        for (int i = 0; i < 10; i++)
        {
            Stream? pipe = null;
            try
            {
                pipe = await Open(i, token);
                if (pipe == null) continue;
                _pipe = pipe;
                await Send(OpHandshake, new JsonObject { ["v"] = 1, ["client_id"] = appId }, token);

                using var patience = CancellationTokenSource.CreateLinkedTokenSource(token);
                patience.CancelAfter(TimeSpan.FromSeconds(5));
                var (op, reply) = await Read(pipe, patience.Token);

                if (op == OpFrame && reply?["evt"]?.GetValue<string>() == "READY")
                {
                    _pipeAppId = appId;
                    Status = "connected";
                    var user = reply["data"]?["user"];
                    User = user?["global_name"]?.GetValue<string>() ?? user?["username"]?.GetValue<string>();
                    Problem = null;
                    _ = Task.Run(() => Listen(pipe, token));
                    return true;
                }

                // Discord answers a bad application ID by closing the pipe with a reason.
                pipe.Dispose();
                _pipe = null;
                Status = "rejected";
                Problem = "Discord doesn't recognize this application ID. Copy it again from the Developer Portal.";
                return false;
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested)
            {
                pipe?.Dispose();
                throw;
            }
            catch (Exception)
            {
                // No Discord on this pipe number (or it stopped answering). Try the next one.
                pipe?.Dispose();
                _pipe = null;
            }
        }
        Status = "waiting";
        Problem = "Discord isn't running. Tint will connect when it starts.";
        return false;
    }

    /// <summary>
    /// Discord's door number `i`, or null when nothing is behind it. On Windows that is a named pipe;
    /// on Linux a socket file in the runtime folder, or in the folder of a Flatpak or Snap Discord.
    /// </summary>
    static async Task<Stream?> Open(int i, CancellationToken token)
    {
        var name = $"discord-ipc-{i}";
        if (OperatingSystem.IsWindows())
        {
            var pipe = new NamedPipeClientStream(".", name, PipeDirection.InOut, PipeOptions.Asynchronous);
            try
            {
                await pipe.ConnectAsync(200, token);
                return pipe;
            }
            catch
            {
                pipe.Dispose();
                throw;
            }
        }

        var runtime = Environment.GetEnvironmentVariable("XDG_RUNTIME_DIR") is { Length: > 0 } dir ? dir : Path.GetTempPath();
        foreach (var folder in new[] { runtime, Path.Combine(runtime, "app", "com.discordapp.Discord"), Path.Combine(runtime, "snap.discord"), Path.GetTempPath() })
        {
            var file = Path.Combine(folder, name);
            if (!File.Exists(file)) continue;
            var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
            try
            {
                using var patience = CancellationTokenSource.CreateLinkedTokenSource(token);
                patience.CancelAfter(TimeSpan.FromMilliseconds(500));
                await socket.ConnectAsync(new UnixDomainSocketEndPoint(file), patience.Token);
                return new NetworkStream(socket, ownsSocket: true);
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested)
            {
                socket.Dispose();
                throw;
            }
            catch
            {
                // A file left behind by a Discord that has quit. Another folder may hold the live one.
                socket.Dispose();
            }
        }
        return null;
    }

    static bool IsOpen(Stream pipe) => pipe switch
    {
        PipeStream p => p.IsConnected,
        NetworkStream n => n.Socket.Connected,
        _ => false,
    };

    /// <summary>Answers Discord's pings and notices when it goes away.</summary>
    async Task Listen(Stream pipe, CancellationToken token)
    {
        try
        {
            while (!token.IsCancellationRequested)
            {
                var (op, message) = await Read(pipe, token);
                if (op == OpPing) await Send(OpPong, message ?? new JsonObject(), token);
                else if (op == OpClose) break;
                else if (op == OpFrame && message?["evt"]?.GetValue<string>() == "ERROR")
                    Problem = message["data"]?["message"]?.GetValue<string>();
            }
        }
        catch { /* the pipe broke: handled below */ }

        if (ReferenceEquals(_pipe, pipe) && !token.IsCancellationRequested)
        {
            Disconnect();
            Status = "waiting";
            Problem = "Discord isn't running. Tint will connect when it starts.";
            _signal.Release();
        }
    }

    async Task Send(int op, JsonNode body, CancellationToken token)
    {
        var pipe = _pipe ?? throw new IOException("Not connected to Discord.");
        var json = Encoding.UTF8.GetBytes(body.ToJsonString());
        var frame = new byte[8 + json.Length];
        BitConverter.TryWriteBytes(frame.AsSpan(0, 4), op);
        BitConverter.TryWriteBytes(frame.AsSpan(4, 4), json.Length);
        json.CopyTo(frame, 8);

        await _writeGate.WaitAsync(token);
        try
        {
            await pipe.WriteAsync(frame, token);
            await pipe.FlushAsync(token);
        }
        catch (ObjectDisposedException)
        {
            throw new IOException("The connection to Discord was closed.");
        }
        finally
        {
            _writeGate.Release();
        }
    }

    static async Task<(int Op, JsonNode? Body)> Read(Stream pipe, CancellationToken token)
    {
        var header = new byte[8];
        await pipe.ReadExactlyAsync(header, token);
        int op = BitConverter.ToInt32(header, 0), length = BitConverter.ToInt32(header, 4);
        if (length < 0 || length > 256 * 1024) throw new IOException("Discord sent a malformed message.");
        var body = new byte[length];
        await pipe.ReadExactlyAsync(body, token);
        try { return (op, JsonNode.Parse(body)); }
        catch (JsonException) { return (op, null); }
    }

    void Disconnect()
    {
        var pipe = _pipe;
        _pipe = null;
        _pipeAppId = null;
        try { pipe?.Dispose(); } catch { }
    }

    public void Dispose()
    {
        // Closing the pipe is what clears the status on Discord's side.
        _stop.Cancel();
        Disconnect();
    }
}
