namespace Tint;

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
