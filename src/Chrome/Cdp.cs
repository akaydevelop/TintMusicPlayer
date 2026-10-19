using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Tint;

/// <summary>
/// One connection to a browser over the Chrome DevTools Protocol: commands out, answers and events
/// back. Pages are reached through flat sessions (Target.attachToTarget with flatten), so every
/// command and event names the session it belongs to, or none for the browser itself.
/// </summary>
sealed class Cdp : IAsyncDisposable
{
    readonly Transport _transport;
    readonly ConcurrentDictionary<int, TaskCompletionSource<JsonObject>> _waiting = new();
    readonly SemaphoreSlim _writeGate = new(1);
    readonly TaskCompletionSource _closed = new(TaskCreationOptions.RunContinuationsAsynchronously);
    int _nextId;

    /// <summary>
    /// An event: its method, its parameters, and the session it came from (null: the browser's own).
    /// Raised on the connection's reading thread, in order; handlers must not wait on commands there.
    /// </summary>
    public event Action<string, JsonObject, string?>? Event;

    /// <summary>Done when the browser has gone, whether it closed or crashed.</summary>
    public Task Closed => _closed.Task;

    Cdp(Transport transport)
    {
        _transport = transport;
        _ = Task.Run(ReadLoop);
    }

    /// <summary>Over the pipe Chrome opens with --remote-debugging-pipe: its fd 3 (our writer) and fd 4 (our reader).</summary>
    public static Cdp OverPipe(Stream toBrowser, Stream fromBrowser) => new(new PipeTransport(toBrowser, fromBrowser));

    /// <summary>Over the browser's DevTools WebSocket, as --remote-debugging-port offers it.</summary>
    public static async Task<Cdp> OverWebSocket(Uri address, CancellationToken token)
    {
        var socket = new ClientWebSocket();
        socket.Options.KeepAliveInterval = TimeSpan.Zero;
        await socket.ConnectAsync(address, token);
        return new Cdp(new SocketTransport(socket));
    }

    public Task<JsonObject> Send(string method, JsonObject? parameters = null, string? session = null) =>
        Send(method, parameters, session, TimeSpan.FromSeconds(30));

    public async Task<JsonObject> Send(string method, JsonObject? parameters, string? session, TimeSpan patience)
    {
        int id = Interlocked.Increment(ref _nextId);
        var message = new JsonObject { ["id"] = id, ["method"] = method, ["params"] = parameters ?? new JsonObject() };
        if (session != null) message["sessionId"] = session;

        var answer = new TaskCompletionSource<JsonObject>(TaskCreationOptions.RunContinuationsAsynchronously);
        _waiting[id] = answer;
        try
        {
            if (_closed.Task.IsCompleted) throw new CdpException(method, "the browser has closed");
            var bytes = Encoding.UTF8.GetBytes(message.ToJsonString());
            await _writeGate.WaitAsync();
            try { await _transport.Write(bytes); }
            finally { _writeGate.Release(); }

            var first = await Task.WhenAny(answer.Task, _closed.Task, Task.Delay(patience));
            if (first == answer.Task) return await answer.Task;
            throw new CdpException(method, first == _closed.Task ? "the browser has closed" : "no answer in time");
        }
        finally
        {
            _waiting.TryRemove(id, out _);
        }
    }

    async Task ReadLoop()
    {
        try
        {
            await foreach (var text in _transport.Read())
            {
                JsonObject? message;
                try { message = JsonNode.Parse(text) as JsonObject; }
                catch (JsonException) { continue; }
                if (message == null) continue;

                if (message["id"] is JsonValue idValue && idValue.TryGetValue<int>(out var id))
                {
                    if (!_waiting.TryGetValue(id, out var waiter)) continue;
                    if (message["error"] is JsonObject error)
                        waiter.TrySetException(new CdpException("", error["message"]?.GetValue<string>() ?? "failed"));
                    else
                        waiter.TrySetResult(message["result"] as JsonObject ?? new JsonObject());
                }
                else if (message["method"]?.GetValue<string>() is { } method)
                {
                    try
                    {
                        Event?.Invoke(method, message["params"] as JsonObject ?? new JsonObject(), message["sessionId"]?.GetValue<string>());
                    }
                    catch
                    {
                        // One handler's slip must not end the connection.
                    }
                }
            }
        }
        catch
        {
            // The browser went away mid-message.
        }
        finally
        {
            _closed.TrySetResult();
            foreach (var waiter in _waiting.Values) waiter.TrySetException(new CdpException("", "the browser has closed"));
        }
    }

    public async ValueTask DisposeAsync()
    {
        await _transport.DisposeAsync();
        _closed.TrySetResult();
    }

    abstract class Transport : IAsyncDisposable
    {
        public abstract Task Write(byte[] message);
        public abstract IAsyncEnumerable<string> Read();
        public abstract ValueTask DisposeAsync();
    }

    /// <summary>Messages are JSON texts, each ended by a zero byte.</summary>
    sealed class PipeTransport(Stream toBrowser, Stream fromBrowser) : Transport
    {
        public override async Task Write(byte[] message)
        {
            await toBrowser.WriteAsync(message);
            toBrowser.WriteByte(0);
            await toBrowser.FlushAsync();
        }

        public override async IAsyncEnumerable<string> Read()
        {
            var buffer = new byte[64 * 1024];
            var pending = new MemoryStream();
            while (true)
            {
                int read = await fromBrowser.ReadAsync(buffer);
                if (read == 0) yield break;
                int start = 0;
                for (int i = 0; i < read; i++)
                {
                    if (buffer[i] != 0) continue;
                    pending.Write(buffer, start, i - start);
                    yield return Encoding.UTF8.GetString(pending.GetBuffer(), 0, (int)pending.Length);
                    pending.SetLength(0);
                    start = i + 1;
                }
                pending.Write(buffer, start, read - start);
            }
        }

        public override ValueTask DisposeAsync()
        {
            try { toBrowser.Dispose(); } catch { }
            try { fromBrowser.Dispose(); } catch { }
            return ValueTask.CompletedTask;
        }
    }

    sealed class SocketTransport(ClientWebSocket socket) : Transport
    {
        public override Task Write(byte[] message) =>
            socket.SendAsync(message, WebSocketMessageType.Text, true, CancellationToken.None);

        public override async IAsyncEnumerable<string> Read()
        {
            var buffer = new byte[64 * 1024];
            var pending = new MemoryStream();
            while (socket.State == WebSocketState.Open)
            {
                var result = await socket.ReceiveAsync(buffer, CancellationToken.None);
                if (result.MessageType == WebSocketMessageType.Close) yield break;
                pending.Write(buffer, 0, result.Count);
                if (!result.EndOfMessage) continue;
                yield return Encoding.UTF8.GetString(pending.GetBuffer(), 0, (int)pending.Length);
                pending.SetLength(0);
            }
        }

        public override ValueTask DisposeAsync()
        {
            socket.Dispose();
            return ValueTask.CompletedTask;
        }
    }
}

sealed class CdpException(string method, string reason) : Exception(method.Length > 0 ? $"{method}: {reason}" : reason);
