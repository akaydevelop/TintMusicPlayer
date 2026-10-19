using System.Diagnostics;
using System.Formats.Tar;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json.Nodes;

namespace Tint;

/// <summary>
/// Keeps Tint current from its releases on GitHub. It looks for a newer release now and then, and
/// on the person's say-so downloads that release's package for this system, checks it against the
/// SHA-256 GitHub publishes for it, and unpacks it next to the program. Restarting swaps it in: the
/// files in use are renamed aside (Windows allows that even for a running program) and the new ones
/// moved into their place, then the new Tint starts and the old one's leftovers go on its next start.
/// Settings, library and sign-ins live in the data folder, which none of this touches.
/// </summary>
sealed class Updater
{
    const string Repo = "akaydevelop/TintMusicPlayer";
    // Only for trying the updater out against releases served from somewhere else.
    static readonly string Api = Environment.GetEnvironmentVariable("TINT_UPDATE_API") is { Length: > 0 } api ? api.TrimEnd('/') : "https://api.github.com";
    static readonly TimeSpan CheckEvery = TimeSpan.FromHours(6);
    const string Staging = ".update";

    static readonly HttpClient Http = new() { Timeout = TimeSpan.FromMinutes(15) };

    public static readonly Version Current = Short(typeof(Updater).Assembly.GetName().Version ?? new Version(0, 0, 0));

    /// <summary>The release file meant for this build. The Chrome-hosted build on Windows is only for trying out, so it has none.</summary>
    static readonly string? Package =
#if WINDOWS
        "win-x64.zip";
#else
        !OperatingSystem.IsLinux() ? null
        : RuntimeInformation.OSArchitecture == Architecture.Arm64 ? "linux-arm64.tar.gz"
        : RuntimeInformation.OSArchitecture == Architecture.X64 ? "linux-x64.tar.gz"
        : null;
#endif

    static readonly string Program = AppContext.BaseDirectory;
    static string StagingFolder => Path.Combine(Program, Staging);

    readonly object _lock = new();
    DateTime _checked;
    Task? _checking;
    Release? _latest;
    string _state = "idle"; // idle, downloading, ready, failed
    long _received, _total;
    string? _error;

    sealed record Release(Version Version, string Tag, string Page, string Url, string Sha256, long Size);

    // A build straight out of the project (bin\Debug and the like) keeps Tint.dll beside the program;
    // only a published, single-file Tint is what a release holds, so only that is replaced by one.
    public Updater(bool dev) => _possible = new(() => !dev && Package != null && SingleFile && Writable(Program));

#pragma warning disable IL3000 // empty in a single-file program, which is the point
    static bool SingleFile => string.IsNullOrEmpty(typeof(Updater).Assembly.Location);
#pragma warning restore IL3000

    readonly Lazy<bool> _possible;

    /// <summary>Whether this copy can update itself: a published build, for this system, in a folder it may write to.</summary>
    public bool Possible => _possible.Value;

    /// <summary>Set once the new files are in place; the program starts the new Tint as it closes.</summary>
    public bool RestartPending { get; private set; }

    public async Task<object> Status(bool check, bool force = false)
    {
        if (check && Possible)
        {
            Task? checking;
            lock (_lock)
            {
                if (_checking == null && (force || DateTime.UtcNow - _checked > CheckEvery)) _checking = Check();
                checking = _checking;
            }
            if (checking != null) await checking;
        }
        lock (_lock)
        {
            return new
            {
                current = Current.ToString(),
                possible = Possible,
                latest = _latest?.Version.ToString(),
                page = _latest?.Page,
                state = _latest == null && _state == "idle" ? "current" : _state,
                received = _received,
                total = _total,
                error = _error,
            };
        }
    }

    async Task Check()
    {
        try
        {
            using var ask = new HttpRequestMessage(HttpMethod.Get, $"{Api}/repos/{Repo}/releases?per_page=20");
            ask.Headers.TryAddWithoutValidation("User-Agent", "Tint/" + Current);
            ask.Headers.TryAddWithoutValidation("Accept", "application/vnd.github+json");
            using var cancel = new CancellationTokenSource(TimeSpan.FromSeconds(20));
            using var reply = await Http.SendAsync(ask, cancel.Token);
            reply.EnsureSuccessStatusCode();
            var releases = JsonNode.Parse(await reply.Content.ReadAsStringAsync(cancel.Token)) as JsonArray ?? [];

            Release? best = null;
            foreach (var release in releases)
            {
                if (release?["draft"]?.GetValue<bool>() == true) continue;
                var tag = release?["tag_name"]?.GetValue<string>() ?? "";
                if (!Version.TryParse(tag.TrimStart('v', 'V'), out var parsed)) continue;
                var version = Short(parsed);
                if (version <= Current || (best != null && version <= best.Version)) continue;

                var asset = (release?["assets"] as JsonArray ?? []).FirstOrDefault(a => a?["name"]?.GetValue<string>()?.EndsWith("-" + Package, StringComparison.Ordinal) == true);
                var digest = asset?["digest"]?.GetValue<string>();
                if (asset == null || digest == null || !digest.StartsWith("sha256:", StringComparison.Ordinal)) continue;

                best = new Release(version, tag, release!["html_url"]?.GetValue<string>() ?? "",
                    asset["browser_download_url"]!.GetValue<string>(), digest["sha256:".Length..], asset["size"]?.GetValue<long>() ?? 0);
            }

            lock (_lock)
            {
                // A download already under way or waiting for the restart stays what it is.
                if (_state is "idle" or "failed" && best?.Version != _latest?.Version)
                {
                    _latest = best;
                    _state = "idle";
                    _error = null;
                }
                _checked = DateTime.UtcNow;
            }
        }
        catch
        {
            // Offline, or GitHub busy: the next look is soon enough.
            lock (_lock) _checked = DateTime.UtcNow - CheckEvery + TimeSpan.FromMinutes(30);
        }
        finally
        {
            lock (_lock) _checking = null;
        }
    }

    /// <summary>Starts downloading the newer release, unless that is already under way or done.</summary>
    public void Download()
    {
        Release release;
        lock (_lock)
        {
            if (_latest == null || !Possible || _state is "downloading" or "ready") return;
            release = _latest;
            _state = "downloading";
            _received = 0;
            _total = release.Size;
            _error = null;
        }
        _ = Task.Run(async () =>
        {
            try
            {
                await Fetch(release);
                lock (_lock) _state = "ready";
            }
            catch (Exception ex)
            {
                try { Delete(StagingFolder); } catch { }
                lock (_lock)
                {
                    _state = "failed";
                    _error = ex is InvalidDataException ? ex.Message : "The update couldn't be downloaded. " + ex.Message;
                }
            }
        });
    }

    async Task Fetch(Release release)
    {
        Delete(StagingFolder);
        var unpacked = Directory.CreateDirectory(Path.Combine(StagingFolder, "new")).FullName;
        var file = Path.Combine(StagingFolder, Path.GetFileName(new Uri(release.Url).LocalPath));

        using (var reply = await Http.GetAsync(release.Url, HttpCompletionOption.ResponseHeadersRead))
        {
            reply.EnsureSuccessStatusCode();
            if (reply.Content.Headers.ContentLength is long length) lock (_lock) _total = length;
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            await using var from = await reply.Content.ReadAsStreamAsync();
            await using var to = File.Create(file);
            var buffer = new byte[128 * 1024];
            int read;
            while ((read = await from.ReadAsync(buffer)) > 0)
            {
                hash.AppendData(buffer, 0, read);
                await to.WriteAsync(buffer.AsMemory(0, read));
                lock (_lock) _received += read;
            }
            if (!Convert.ToHexString(hash.GetHashAndReset()).Equals(release.Sha256, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("The update didn't match the checksum GitHub lists for it, so it wasn't kept.");
        }

        if (file.EndsWith(".zip", StringComparison.OrdinalIgnoreCase))
        {
            ZipFile.ExtractToDirectory(file, unpacked);
        }
        else
        {
            await using var stream = File.OpenRead(file);
            await using var gzip = new GZipStream(stream, CompressionMode.Decompress);
            await TarFile.ExtractToDirectoryAsync(gzip, unpacked, overwriteFiles: true);
        }
        File.Delete(file);

        // The packages hold one folder named after the release; what is in it is the program.
        var top = new DirectoryInfo(unpacked);
        if (top.GetFiles().Length == 0 && top.GetDirectories() is [var only]) top = only;
        var program = Path.Combine(top.FullName, Executable);
        if (!File.Exists(program)) throw new InvalidDataException("The update's package doesn't hold Tint, so it wasn't used.");
        if (!OperatingSystem.IsWindows())
            File.SetUnixFileMode(program, File.GetUnixFileMode(program) | UnixFileMode.UserExecute | UnixFileMode.UserRead);
        if (top.FullName != unpacked) Directory.Move(top.FullName, unpacked + ".ready");
        else Directory.Move(unpacked, unpacked + ".ready");
    }

    static string Executable => OperatingSystem.IsWindows() ? "Tint.exe" : "Tint";

    // What the packages carry for installing, which the installed program has no use for.
    static readonly string[] InstallerOnly = ["install.sh", "tint.png"];

    /// <summary>
    /// Moves the downloaded files into the program's folder. Each file it replaces is renamed aside
    /// first, so if any step fails everything is put back as it was.
    /// </summary>
    public bool Apply()
    {
        lock (_lock) if (_state != "ready") return false;
        var ready = Path.Combine(StagingFolder, "new.ready");
        var moved = new List<(string Target, string? Aside)>();
        try
        {
            foreach (var item in new DirectoryInfo(ready).GetFileSystemInfos())
            {
                if (InstallerOnly.Contains(item.Name)) continue;
                var target = Path.Combine(Program, item.Name);
                string? aside = null;
                if (Path.Exists(target))
                {
                    aside = target + ".old";
                    Delete(aside);
                    Move(target, aside);
                }
                moved.Add((target, aside));
                Move(item.FullName, target);
            }
        }
        catch (Exception ex)
        {
            for (int i = moved.Count - 1; i >= 0; i--)
            {
                var (target, aside) = moved[i];
                try
                {
                    if (Path.Exists(target)) Delete(target);
                    if (aside != null) Move(aside, target);
                }
                catch { }
            }
            lock (_lock)
            {
                _state = "failed";
                _error = "The update couldn't be put in place. " + ex.Message;
            }
            return false;
        }
        RestartPending = true;
        return true;
    }

    /// <summary>Starts the new Tint once this one is closing. It waits for this process to be gone before it carries on.</summary>
    public void Relaunch()
    {
        if (!RestartPending) return;
        try
        {
            var start = new ProcessStartInfo(Path.Combine(Program, Executable)) { UseShellExecute = false, WorkingDirectory = Program };
            start.ArgumentList.Add("--after");
            start.ArgumentList.Add(Environment.ProcessId.ToString());
            Process.Start(start)?.Dispose();
        }
        catch { /* it is in place all the same, and starts the next time Tint is opened */ }
    }

    /// <summary>
    /// For a Tint started by <see cref="Relaunch"/>: waits for the one before to close, then clears
    /// away what that one renamed aside. Called first thing, before the claim to be the only Tint.
    /// </summary>
    public static void AfterRestart(string[] args)
    {
        int at = Array.IndexOf(args, "--after");
        if (at >= 0 && at + 1 < args.Length && int.TryParse(args[at + 1], out var pid))
        {
            try
            {
                using var before = Process.GetProcessById(pid);
                before.WaitForExit(TimeSpan.FromSeconds(20));
            }
            catch { /* already gone */ }
        }

        try
        {
            foreach (var old in new DirectoryInfo(Program).GetFileSystemInfos("*.old"))
            {
                try { Delete(old.FullName); } catch { }
            }
            Delete(StagingFolder);
        }
        catch { }
    }

    static Version Short(Version v) => new(v.Major, v.Minor, Math.Max(v.Build, 0));

    static bool Writable(string folder)
    {
        try
        {
            var probe = Path.Combine(folder, ".write-test-" + Environment.ProcessId);
            File.WriteAllBytes(probe, []);
            File.Delete(probe);
            return true;
        }
        catch { return false; }
    }

    static void Move(string from, string to)
    {
        if (Directory.Exists(from)) Directory.Move(from, to);
        else File.Move(from, to);
    }

    static void Delete(string path)
    {
        if (Directory.Exists(path)) Directory.Delete(path, recursive: true);
        else if (File.Exists(path)) File.Delete(path);
    }
}
