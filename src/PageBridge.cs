using System.Text;
using Microsoft.Web.WebView2.Core;

namespace Tint;

/// <summary>
/// Shows the app's own page under an address on music.apple.com. Nothing is loaded from Apple for
/// it: every request below that address is answered here, from the local server and the music
/// files. The address matters because Apple's web player token is only honoured for pages on
/// apple.com, and Apple's sign-in window only reports back to such a page.
/// </summary>
sealed class PageBridge
{
    public const string Origin = "https://music.apple.com";
    const string Prefix = "/tint/";
    public const string Base = Origin + Prefix;

    static readonly HttpClient Http = new(new SocketsHttpHandler { UseProxy = false }) { Timeout = TimeSpan.FromSeconds(60) };

    readonly CoreWebView2Environment _environment;
    readonly LocalServer _server;
    readonly Library _library;

    public PageBridge(CoreWebView2 core, CoreWebView2Environment environment, LocalServer server, Library library)
    {
        _environment = environment;
        _server = server;
        _library = library;
        core.AddWebResourceRequestedFilter(Base + "*", CoreWebView2WebResourceContext.All);
        core.WebResourceRequested += OnRequest;
    }

    async void OnRequest(object? sender, CoreWebView2WebResourceRequestedEventArgs e)
    {
        var deferral = e.GetDeferral();
        try
        {
            e.Response = await Answer(e.Request);
        }
        catch (Exception ex)
        {
            e.Response = Respond(null, 502, "Bad Gateway", $"X-Tint-Error: {ex.GetType().Name}\r\n");
        }
        finally
        {
            deferral.Complete();
        }
    }

    async Task<CoreWebView2WebResourceResponse> Answer(CoreWebView2WebResourceRequest request)
    {
        var uri = new Uri(request.Uri);
        var path = uri.AbsolutePath.Length > Prefix.Length ? uri.AbsolutePath[Prefix.Length..] : "";

        // Songs are streamed straight from disk so that seeking never copies a whole file around.
        if (path.StartsWith("media/", StringComparison.Ordinal))
            return Media(request, Uri.UnescapeDataString(path[6..]));

        // Everything else is small (the UI, JSON, cover thumbnails): ask the local server and pass it on.
        using var message = new HttpRequestMessage(new HttpMethod(request.Method), _server.Origin + "/" + path + uri.Query);
        if (request.Headers.Contains("X-Tint")) message.Headers.TryAddWithoutValidation("X-Tint", request.Headers.GetHeader("X-Tint"));
        if (request.Content != null)
        {
            using var body = new MemoryStream();
            request.Content.CopyTo(body);
            message.Content = new ByteArrayContent(body.ToArray());
            message.Content.Headers.TryAddWithoutValidation("Content-Type", "application/json");
        }

        using var reply = await Http.SendAsync(message);
        var bytes = await reply.Content.ReadAsByteArrayAsync();
        var headers = new StringBuilder();
        if (reply.Content.Headers.ContentType is { } type) headers.Append($"Content-Type: {type}\r\n");
        if (reply.Headers.CacheControl is { } cache) headers.Append($"Cache-Control: {cache}\r\n");
        return Respond(new MemoryStream(bytes), (int)reply.StatusCode, reply.ReasonPhrase ?? "OK", headers.ToString());
    }

    CoreWebView2WebResourceResponse Media(CoreWebView2WebResourceRequest request, string id)
    {
        var track = _library.Find(id);
        if (track == null || !track.Playable || !File.Exists(track.Path))
            return Respond(null, 404, "Not Found", "");

        var file = new FileStream(track.Path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 64 * 1024, FileOptions.SequentialScan);
        long length = file.Length;
        var common = $"Content-Type: {LocalServer.MimeFor(track.Path)}\r\nAccept-Ranges: bytes\r\nCache-Control: no-store\r\n";
        var range = request.Headers.Contains("Range") ? request.Headers.GetHeader("Range") : null;

        switch (HttpRange.Parse(range, length, out long start, out long end))
        {
            case HttpRange.Result.Invalid:
                file.Dispose();
                return Respond(null, 416, "Range Not Satisfiable", $"Content-Range: bytes */{length}\r\n");

            case HttpRange.Result.Partial:
                return Respond(new WindowStream(file, start, end - start + 1), 206, "Partial Content",
                    common + $"Content-Range: bytes {start}-{end}/{length}\r\nContent-Length: {end - start + 1}\r\n");

            default:
                return Respond(file, 200, "OK", common + $"Content-Length: {length}\r\n");
        }
    }

    CoreWebView2WebResourceResponse Respond(Stream? content, int status, string reason, string headers) =>
        _environment.CreateWebResourceResponse(content, status, reason, headers);
}

/// <summary>Reads the Range header of a request for a file of a known length.</summary>
static class HttpRange
{
    public enum Result { Whole, Partial, Invalid }

    public static Result Parse(string? header, long length, out long start, out long end)
    {
        start = 0;
        end = length - 1;
        if (header == null || !header.StartsWith("bytes=", StringComparison.OrdinalIgnoreCase)) return Result.Whole;

        var spec = header[6..].Split(',')[0].Trim();
        var dash = spec.IndexOf('-');
        if (dash < 0) return Result.Invalid;

        var from = spec[..dash];
        var to = spec[(dash + 1)..];
        if (from.Length == 0)
        {
            // "bytes=-500": the last 500 bytes.
            if (!long.TryParse(to, out var suffix) || suffix <= 0) return Result.Invalid;
            start = Math.Max(0, length - suffix);
        }
        else
        {
            if (!long.TryParse(from, out start)) return Result.Invalid;
            if (to.Length > 0 && !long.TryParse(to, out end)) return Result.Invalid;
            end = Math.Min(end, length - 1);
        }
        return start > end || start >= length ? Result.Invalid : Result.Partial;
    }
}

/// <summary>A read-only view of one stretch of a file, for answering range requests.</summary>
sealed class WindowStream : Stream
{
    readonly Stream _inner;
    readonly long _start, _length;
    long _position;

    public WindowStream(Stream inner, long start, long length)
    {
        _inner = inner;
        _start = start;
        _length = length;
        _inner.Position = start;
    }

    public override bool CanRead => true;
    public override bool CanSeek => true;
    public override bool CanWrite => false;
    public override long Length => _length;

    public override long Position
    {
        get => _position;
        set
        {
            _position = Math.Clamp(value, 0, _length);
            _inner.Position = _start + _position;
        }
    }

    public override int Read(byte[] buffer, int offset, int count)
    {
        count = (int)Math.Min(count, _length - _position);
        if (count <= 0) return 0;
        int read = _inner.Read(buffer, offset, count);
        _position += read;
        return read;
    }

    public override long Seek(long offset, SeekOrigin origin)
    {
        Position = origin switch
        {
            SeekOrigin.Begin => offset,
            SeekOrigin.Current => _position + offset,
            _ => _length + offset,
        };
        return _position;
    }

    public override void Flush() { }
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

    protected override void Dispose(bool disposing)
    {
        if (disposing) _inner.Dispose();
        base.Dispose(disposing);
    }
}
