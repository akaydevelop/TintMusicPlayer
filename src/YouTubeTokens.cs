using System.Diagnostics;
using System.IO.Compression;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Tint;

/// <summary>
/// YouTube Music only gives its streams, the Premium ones among them, to a player that shows a
/// "proof of origin" token. YouTube's own page makes one by running a check inside the browser;
/// yt-dlp can't. The add-on its guide points to (bgutil-ytdlp-pot-provider) can: a plug-in that
/// yt-dlp loads, and a small server, run by Deno, that the plug-in asks for tokens. This downloads
/// both into Tint's data folder and keeps the server going while YouTube songs are being fetched.
/// </summary>
sealed partial class YouTubeTokens : IDisposable
{
    const string Repo = "Brainicism/bgutil-ytdlp-pot-provider";
    // The server holds about 170 MB. It is let go once no song has needed it for a while.
    static readonly TimeSpan IdleFor = TimeSpan.FromMinutes(10);

    readonly HttpClient _http;
    readonly string _plugIn, _home, _server, _ready;
    readonly SemaphoreSlim _gate = new(1);
    readonly KillWithParent _job = new();
    readonly System.Threading.Timer _idle;
    Process? _process;
    string? _address;
    DateTime _lastUsed;

    [GeneratedRegex(@"^[0-9A-Za-z._-]{1,40}$")]
    private static partial Regex Tag();

    /// <summary>`folder` is where Tint's own yt-dlp lives; yt-dlp looks for plug-ins next to itself.</summary>
    public YouTubeTokens(HttpClient http, string folder)
    {
        _http = http;
        _plugIn = Path.Combine(folder, "yt-dlp-plugins", "bgutil-ytdlp-pot-provider.zip");
        _home = Path.Combine(folder, "pot");
        _server = Path.Combine(_home, "server");
        _ready = Path.Combine(_home, "ready.txt");
        _idle = new System.Threading.Timer(_ => { if (DateTime.UtcNow - _lastUsed > IdleFor) Stop(); }, null, TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(1));
    }

    /// <summary>The last step of setting up leaves a note behind, so a set-up that stopped halfway doesn't count.</summary>
    public bool Installed => File.Exists(_plugIn) && File.Exists(_ready);

    /// <summary>Downloads the current release of the add-on and has Deno fetch what its server depends on.</summary>
    public async Task Install(string deno)
    {
        await _gate.WaitAsync();
        try
        {
            StopNow();

            // The plug-in and the server only work as a matched pair, so both come from one release.
            using var ask = new HttpRequestMessage(HttpMethod.Get, $"https://api.github.com/repos/{Repo}/releases/latest");
            ask.Headers.TryAddWithoutValidation("User-Agent", "Tint");
            using var reply = await _http.SendAsync(ask);
            reply.EnsureSuccessStatusCode();
            var tag = JsonNode.Parse(await reply.Content.ReadAsStringAsync())?["tag_name"]?.GetValue<string>() ?? "";
            if (!Tag().IsMatch(tag)) throw new InvalidDataException("The add-on's latest release couldn't be read.");

            var plugIn = await _http.GetByteArrayAsync($"https://github.com/{Repo}/releases/download/{tag}/bgutil-ytdlp-pot-provider.zip");
            var source = await _http.GetByteArrayAsync($"https://github.com/{Repo}/archive/refs/tags/{tag}.zip");

            // Set up where it will run from: Deno ties what it fetches to the folder, and moving it afterwards breaks it.
            Remove(_home);
            Unpack(source, "/server/", _server);

            // Exactly the versions the release was tested with ("frozen"); only the one package that needs a build step may run one.
            var (code, errors) = await RunDeno(deno, _server, TimeSpan.FromMinutes(6), "install", "--allow-scripts=npm:canvas", "--frozen");
            if (code != 0) throw new InvalidOperationException("Deno couldn't fetch what the token helper needs. " + errors.Trim().Split('\n').LastOrDefault());

            Directory.CreateDirectory(Path.GetDirectoryName(_plugIn)!);
            await File.WriteAllBytesAsync(_plugIn, plugIn);
            await File.WriteAllTextAsync(_ready, tag);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>Deletes a folder that packages were fetched into. Some of their files are read-only, which a plain delete stops at.</summary>
    static void Remove(string folder)
    {
        if (!Directory.Exists(folder)) return;
        // Links between packages are removed as links; what they point at is reached by its own path.
        var inside = new EnumerationOptions { RecurseSubdirectories = true, AttributesToSkip = FileAttributes.ReparsePoint };
        foreach (var file in Directory.EnumerateFiles(folder, "*", inside))
        {
            var attributes = File.GetAttributes(file);
            if (attributes.HasFlag(FileAttributes.ReadOnly)) File.SetAttributes(file, attributes & ~FileAttributes.ReadOnly);
        }
        Directory.Delete(folder, recursive: true);
    }

    /// <summary>Unpacks the part of a GitHub source archive below `part` (its top folder is named after the release).</summary>
    static void Unpack(byte[] zip, string part, string into)
    {
        var root = Path.GetFullPath(into) + Path.DirectorySeparatorChar;
        using var archive = new ZipArchive(new MemoryStream(zip), ZipArchiveMode.Read);
        foreach (var entry in archive.Entries)
        {
            int at = entry.FullName.IndexOf(part, StringComparison.Ordinal);
            if (at < 0 || entry.FullName.EndsWith('/')) continue;
            var target = Path.GetFullPath(Path.Combine(root, entry.FullName[(at + part.Length)..]));
            // An archive must never be able to write outside the folder it was unpacked into.
            if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase)) continue;
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            entry.ExtractToFile(target, overwrite: true);
        }
        if (!File.Exists(Path.Combine(into, "src", "main.ts"))) throw new InvalidDataException("The add-on's download didn't hold what was expected.");
    }

    /// <summary>Where the plug-in can reach the server, starting it when it isn't running. Null when it can't be had.</summary>
    public async Task<string?> Address(string? deno)
    {
        await _gate.WaitAsync();
        try
        {
            _lastUsed = DateTime.UtcNow;
            if (_process is { HasExited: false }) return _address;
            if (deno == null || !Installed) return null;

            int port = FreePort();
            // The permissions are the add-on's own: the network, and reading and loading only from its own folder.
            var start = new ProcessStartInfo(deno) { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = Path.Combine(_server, "node_modules") };
            foreach (var argument in new[] { "run", "--allow-env", "--allow-net", "--allow-ffi=.", "--allow-read=.", "../src/main.ts", "--port", port.ToString() })
                start.ArgumentList.Add(argument);
            _process = Process.Start(start);
            if (_process == null) return null;
            _job.Add(_process);
            _address = $"http://127.0.0.1:{port}";

            for (int tries = 0; tries < 80 && !_process.HasExited; tries++)
            {
                try
                {
                    using var ping = await _http.GetAsync(_address + "/ping");
                    if (ping.IsSuccessStatusCode) return _address;
                }
                catch (HttpRequestException) { /* not listening yet */ }
                await Task.Delay(250);
            }
            StopNow();
            return null;
        }
        catch
        {
            StopNow();
            return null;
        }
        finally
        {
            _gate.Release();
        }
    }

    static int FreePort()
    {
        var probe = new TcpListener(IPAddress.Loopback, 0);
        probe.Start();
        int port = ((IPEndPoint)probe.LocalEndpoint).Port;
        probe.Stop();
        return port;
    }

    static async Task<(int Code, string Errors)> RunDeno(string deno, string folder, TimeSpan limit, params string[] arguments)
    {
        var start = new ProcessStartInfo(deno) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardError = true, WorkingDirectory = folder };
        foreach (var argument in arguments) start.ArgumentList.Add(argument);
        using var process = Process.Start(start) ?? throw new InvalidOperationException("Deno wouldn't start.");
        using var timeout = new CancellationTokenSource(limit);
        try
        {
            var errors = process.StandardError.ReadToEndAsync(timeout.Token);
            await process.WaitForExitAsync(timeout.Token);
            return (process.ExitCode, await errors);
        }
        catch (OperationCanceledException)
        {
            try { process.Kill(entireProcessTree: true); } catch { }
            throw new TimeoutException("Deno took too long to fetch what the token helper needs.");
        }
    }

    void Stop()
    {
        if (!_gate.Wait(0)) return; // in use right now, so not idle
        try { StopNow(); }
        finally { _gate.Release(); }
    }

    void StopNow()
    {
        try { if (_process is { HasExited: false }) _process.Kill(entireProcessTree: true); } catch { }
        _process?.Dispose();
        _process = null;
        _address = null;
    }

    public void Dispose()
    {
        _idle.Dispose();
        StopNow();
        _job.Dispose();
    }

    /// <summary>
    /// A Windows job that ends the processes in it when Tint goes away, however it goes away, so a
    /// crash can't leave the token server running with nobody to use it.
    /// </summary>
    sealed class KillWithParent : IDisposable
    {
        readonly IntPtr _job;

        public KillWithParent()
        {
            _job = CreateJobObject(IntPtr.Zero, null);
            var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(_job, JobObjectExtendedLimitInformation, ref limits, Marshal.SizeOf<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>());
        }

        public void Add(Process process)
        {
            try { AssignProcessToJobObject(_job, process.Handle); } catch { }
        }

        public void Dispose() => CloseHandle(_job);

        const int JobObjectExtendedLimitInformation = 9;
        const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

        [StructLayout(LayoutKind.Sequential)]
        struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass, SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct IO_COUNTERS
        {
            public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        static extern IntPtr CreateJobObject(IntPtr attributes, string? name);

        [DllImport("kernel32.dll")]
        static extern bool SetInformationJobObject(IntPtr job, int kind, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int size);

        [DllImport("kernel32.dll")]
        static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll")]
        static extern bool CloseHandle(IntPtr handle);
    }
}
