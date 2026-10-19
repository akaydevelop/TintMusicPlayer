using System.Collections.Concurrent;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Tint;

sealed class Track
{
    public string Id { get; set; } = "";
    public string Path { get; set; } = "";
    public long Size { get; set; }
    public long MTime { get; set; }
    public long Added { get; set; }
    public string Title { get; set; } = "";
    public string Artist { get; set; } = "";
    public string? AlbumArtist { get; set; }
    public string? Album { get; set; }
    public string? Genre { get; set; }
    public int TrackNo { get; set; }
    public int DiscNo { get; set; }
    public int Year { get; set; }
    public double Duration { get; set; }
    public bool HasArt { get; set; }
    public string? ArtKey { get; set; }
    public string? ArtSource { get; set; }
    public bool Playable { get; set; } = true;
    public string? Reason { get; set; }
}

/// <summary>The music files on this PC: scanned once, cached, and kept fresh by folder watchers.</summary>
sealed class Library : IDisposable
{
    static readonly HashSet<string> AudioExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".mp3", ".m4a", ".m4b", ".aac", ".flac", ".wav", ".ogg", ".oga", ".opus", ".m4p",
    };

    static readonly string[] FolderArtNames = { "cover", "folder", "front", "album", "artwork" };
    static readonly string[] ImageExtensions = { ".jpg", ".jpeg", ".png" };

    readonly Settings _settings;
    readonly object _gate = new();
    readonly List<FileSystemWatcher> _watchers = new();
    readonly System.Threading.Timer _debounce;
    readonly SemaphoreSlim _artGate = new(3);

    volatile Track[] _tracks = Array.Empty<Track>();
    Dictionary<string, Track> _byId = new();
    Dictionary<string, string> _artSources = new();
    bool _scanning, _rescanQueued;

    public int Version { get; private set; }
    public int Protected { get; private set; }
    public int Done { get; private set; }
    public int Total { get; private set; }
    public bool Scanning { get { lock (_gate) return _scanning; } }
    public Track[] Tracks => _tracks;

    public Library(Settings settings)
    {
        _settings = settings;
        _debounce = new System.Threading.Timer(_ => Rescan(), null, Timeout.Infinite, Timeout.Infinite);
    }

    public void Start()
    {
        try
        {
            var cached = JsonSerializer.Deserialize<Track[]>(File.ReadAllText(Paths.LibraryFile));
            if (cached != null) Publish(cached);
        }
        catch
        {
            // No cache yet, or it's from an older version. The scan below rebuilds it.
        }
        Rescan();
    }

    public Track? Find(string id)
    {
        lock (_gate) return _byId.GetValueOrDefault(id);
    }

    public void Rescan()
    {
        lock (_gate)
        {
            if (_scanning) { _rescanQueued = true; return; }
            _scanning = true;
        }
        Task.Run(ScanLoop);
    }

    void ScanLoop()
    {
        while (true)
        {
            try { Scan(); }
            catch { /* a failed scan leaves the previous library in place */ }

            lock (_gate)
            {
                if (_rescanQueued) { _rescanQueued = false; continue; }
                _scanning = false;
                Version++;
                return;
            }
        }
    }

    void Scan()
    {
        var folders = _settings.Folders.ToArray();
        ResetWatchers(folders);

        var known = _tracks.ToDictionary(t => t.Path, StringComparer.OrdinalIgnoreCase);
        var files = new List<FileInfo>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var options = new EnumerationOptions { RecurseSubdirectories = true, IgnoreInaccessible = true, AttributesToSkip = FileAttributes.System };
        foreach (var folder in folders)
        {
            if (!Directory.Exists(folder)) continue;
            foreach (var file in new DirectoryInfo(folder).EnumerateFiles("*", options))
            {
                if (AudioExtensions.Contains(file.Extension) && seen.Add(file.FullName))
                    files.Add(file);
            }
        }

        Total = files.Count;
        Done = 0;
        var bag = new ConcurrentBag<Track>();
        int protectedCount = 0, done = 0;

        Parallel.ForEach(files, new ParallelOptions { MaxDegreeOfParallelism = Math.Clamp(Environment.ProcessorCount / 2, 1, 4) }, file =>
        {
            try
            {
                if (file.Extension.Equals(".m4p", StringComparison.OrdinalIgnoreCase))
                {
                    // Subscription downloads are locked to Apple's own apps. They play through the Apple Music side instead.
                    Interlocked.Increment(ref protectedCount);
                    return;
                }

                var mtime = file.LastWriteTimeUtc.Ticks;
                if (known.TryGetValue(file.FullName, out var cached) && cached.Size == file.Length && cached.MTime == mtime)
                {
                    bag.Add(cached);
                    return;
                }
                bag.Add(Read(file, mtime));
            }
            catch
            {
                // Unreadable file: skip it rather than fail the scan.
            }
            finally
            {
                Done = Interlocked.Increment(ref done);
            }
        });

        var tracks = bag.ToArray();
        AssignArt(tracks);
        Protected = protectedCount;
        Publish(tracks);

        try
        {
            var tmp = Paths.LibraryFile + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(tracks));
            File.Move(tmp, Paths.LibraryFile, overwrite: true);
        }
        catch
        {
            // The cache only speeds up the next launch.
        }
    }

    static Track Read(FileInfo file, long mtime)
    {
        var track = new Track
        {
            Id = Hash(file.FullName.ToLowerInvariant()),
            Path = file.FullName,
            Size = file.Length,
            MTime = mtime,
            Added = new DateTimeOffset(file.CreationTimeUtc).ToUnixTimeSeconds(),
            Title = CleanFileTitle(System.IO.Path.GetFileNameWithoutExtension(file.Name)),
            Artist = "Unknown artist",
        };

        try
        {
            using var tagged = TagLib.File.Create(file.FullName, TagLib.ReadStyle.Average | TagLib.ReadStyle.PictureLazy);
            var tag = tagged.Tag;
            if (!string.IsNullOrWhiteSpace(tag.Title)) track.Title = tag.Title.Trim();
            track.Artist = FirstNonEmpty(tag.FirstPerformer, tag.FirstAlbumArtist) ?? "Unknown artist";
            track.AlbumArtist = FirstNonEmpty(tag.FirstAlbumArtist);
            track.Album = FirstNonEmpty(tag.Album);
            track.Genre = FirstNonEmpty(tag.FirstGenre);
            track.TrackNo = (int)tag.Track;
            track.DiscNo = (int)tag.Disc;
            track.Year = (int)tag.Year;
            track.HasArt = tag.Pictures.Length > 0;

            var props = tagged.Properties;
            if (props != null)
            {
                track.Duration = props.Duration.TotalSeconds;
                var codecs = string.Join(" ", props.Codecs.Where(c => c != null).Select(c => c.Description)).ToLowerInvariant();
                if (codecs.Contains("(drms)"))
                {
                    track.Playable = false;
                    track.Reason = "Protected by Apple. Play it from Apple Music instead.";
                }
                else if (codecs.Contains("(alac)"))
                {
                    track.Playable = false;
                    track.Reason = "Apple Lossless files can't be played yet.";
                }
            }
        }
        catch
        {
            // Tags are optional. The file name stands in for the title.
        }
        return track;
    }

    /// <summary>Gives every track in an album folder the same artwork, from embedded pictures or a cover image beside the files.</summary>
    static void AssignArt(Track[] tracks)
    {
        foreach (var group in tracks.GroupBy(t => (Dir: System.IO.Path.GetDirectoryName(t.Path) ?? "", Album: t.Album ?? ""), new DirAlbumComparer()))
        {
            string? source = group.OrderBy(t => t.DiscNo).ThenBy(t => t.TrackNo).FirstOrDefault(t => t.HasArt)?.Path;
            if (source == null && group.Key.Dir.Length > 0)
            {
                try
                {
                    source = Directory.EnumerateFiles(group.Key.Dir)
                        .Where(f => ImageExtensions.Contains(System.IO.Path.GetExtension(f).ToLowerInvariant()))
                        .OrderBy(f => Array.IndexOf(FolderArtNames, System.IO.Path.GetFileNameWithoutExtension(f).ToLowerInvariant()) is var i && i >= 0 ? i : 99)
                        .FirstOrDefault();
                }
                catch { }
            }

            string? key = null;
            if (source != null)
            {
                long stamp = 0;
                try { stamp = File.GetLastWriteTimeUtc(source).Ticks; } catch { }
                key = Hash(source.ToLowerInvariant() + "|" + stamp);
            }
            foreach (var t in group)
            {
                t.ArtKey = key;
                t.ArtSource = source;
            }
        }
    }

    sealed class DirAlbumComparer : IEqualityComparer<(string Dir, string Album)>
    {
        public bool Equals((string Dir, string Album) a, (string Dir, string Album) b) =>
            string.Equals(a.Dir, b.Dir, StringComparison.OrdinalIgnoreCase) && string.Equals(a.Album, b.Album, StringComparison.Ordinal);
        public int GetHashCode((string Dir, string Album) v) =>
            HashCode.Combine(StringComparer.OrdinalIgnoreCase.GetHashCode(v.Dir), v.Album);
    }

    void Publish(Track[] tracks)
    {
        var byId = new Dictionary<string, Track>(tracks.Length);
        var art = new Dictionary<string, string>();
        foreach (var t in tracks)
        {
            byId[t.Id] = t;
            if (t.ArtKey != null && t.ArtSource != null) art[t.ArtKey] = t.ArtSource;
        }
        lock (_gate)
        {
            _tracks = tracks;
            _byId = byId;
            _artSources = art;
            Version++;
        }
    }

    // ---- artwork -------------------------------------------------------------------------------

    public static int SnapArtSize(int requested) => requested <= 128 ? 96 : requested <= 400 ? 320 : 640;

    /// <summary>Returns the path of a cached JPEG thumbnail for an album cover, creating it on first use.</summary>
    public async Task<string?> ArtFile(string key, int size)
    {
        if (key.Length != 16 || !key.All(Uri.IsHexDigit)) return null;
        size = SnapArtSize(size);
        var file = System.IO.Path.Combine(Paths.Art, $"{key}_{size}.jpg");
        if (File.Exists(file)) return file;

        string? source;
        lock (_gate) source = _artSources.GetValueOrDefault(key);
        if (source == null) return null;

        await _artGate.WaitAsync();
        try
        {
            if (File.Exists(file)) return file;
            byte[]? data = null;
            if (ImageExtensions.Contains(System.IO.Path.GetExtension(source).ToLowerInvariant()))
            {
                data = await File.ReadAllBytesAsync(source);
            }
            else
            {
                using var tagged = TagLib.File.Create(source, TagLib.ReadStyle.Average);
                var picture = tagged.Tag.Pictures.FirstOrDefault(p => p.Type == TagLib.PictureType.FrontCover) ?? tagged.Tag.Pictures.FirstOrDefault();
                data = picture?.Data?.Data;
            }
            if (data == null || data.Length == 0) return null;

            var tmp = file + "." + Environment.CurrentManagedThreadId + ".tmp";
            WriteThumbnail(data, size, tmp);
            File.Move(tmp, file, overwrite: true);
            return file;
        }
        catch
        {
            return null;
        }
        finally
        {
            _artGate.Release();
        }
    }

    static void WriteThumbnail(byte[] data, int size, string destination)
    {
        using var input = new MemoryStream(data);
        using var source = Image.FromStream(input);
        var scale = Math.Min(1.0, (double)size / Math.Min(source.Width, source.Height));
        int w = Math.Max(1, (int)Math.Round(source.Width * scale)), h = Math.Max(1, (int)Math.Round(source.Height * scale));

        using var bitmap = new Bitmap(w, h, PixelFormat.Format24bppRgb);
        using (var g = Graphics.FromImage(bitmap))
        {
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.CompositingQuality = CompositingQuality.HighQuality;
            using var wrap = new ImageAttributes();
            wrap.SetWrapMode(WrapMode.TileFlipXY);
            g.DrawImage(source, new Rectangle(0, 0, w, h), 0, 0, source.Width, source.Height, GraphicsUnit.Pixel, wrap);
        }

        var jpeg = ImageCodecInfo.GetImageEncoders().First(c => c.FormatID == ImageFormat.Jpeg.Guid);
        using var parameters = new EncoderParameters(1);
        parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 88L);
        bitmap.Save(destination, jpeg, parameters);
    }

    // ---- watching ------------------------------------------------------------------------------

    void ResetWatchers(string[] folders)
    {
        lock (_watchers)
        {
            foreach (var w in _watchers) w.Dispose();
            _watchers.Clear();
            foreach (var folder in folders)
            {
                if (!Directory.Exists(folder)) continue;
                try
                {
                    var w = new FileSystemWatcher(folder)
                    {
                        IncludeSubdirectories = true,
                        NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName | NotifyFilters.LastWrite | NotifyFilters.Size,
                    };
                    FileSystemEventHandler changed = (_, e) =>
                    {
                        if (e.FullPath.EndsWith(".tmp", StringComparison.OrdinalIgnoreCase)) return;
                        _debounce.Change(4000, Timeout.Infinite);
                    };
                    w.Created += changed;
                    w.Deleted += changed;
                    w.Changed += changed;
                    w.Renamed += (_, _) => _debounce.Change(4000, Timeout.Infinite);
                    w.EnableRaisingEvents = true;
                    _watchers.Add(w);
                }
                catch
                {
                    // Some drives can't be watched. "Scan again" in Settings still works.
                }
            }
        }
    }

    // ---- helpers -------------------------------------------------------------------------------

    static string? FirstNonEmpty(params string?[] values) =>
        values.FirstOrDefault(v => !string.IsNullOrWhiteSpace(v))?.Trim();

    /// <summary>"03 Song name" → "Song name", for files without tags.</summary>
    static string CleanFileTitle(string name)
    {
        int i = 0;
        while (i < name.Length && char.IsDigit(name[i])) i++;
        if (i is > 0 and <= 3 && i < name.Length && (name[i] is ' ' or '.' or '-' or '_'))
        {
            var rest = name[i..].TrimStart(' ', '.', '-', '_');
            if (rest.Length > 0) return rest;
        }
        return name;
    }

    static string Hash(string value) =>
        Convert.ToHexString(SHA1.HashData(Encoding.UTF8.GetBytes(value)), 0, 8).ToLowerInvariant();

    public void Dispose()
    {
        _debounce.Dispose();
        lock (_watchers)
        {
            foreach (var w in _watchers) w.Dispose();
            _watchers.Clear();
        }
    }
}
