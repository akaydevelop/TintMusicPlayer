using System.Runtime.InteropServices;

namespace Tint;

/// <summary>
/// Puts Tint's name and icon on its line in Windows' volume mixer. The sound is played by one of
/// WebView2's own processes, so Windows would otherwise list it as "Microsoft Edge WebView2".
/// The mixer's slider for that line sets Tint's volume either way; this only changes what it is called.
/// </summary>
static class MixerName
{
    const string Name = "Tint";
    const int Render = 0, DeviceActive = 1, ClsctxAll = 0x17;

    /// <summary>
    /// Names the sound sessions that belong to the given processes, on every output device. A session
    /// only exists once sound starts, so this looks a few times over the next seconds. Any thread.
    /// </summary>
    public static void Claim(IReadOnlyCollection<int> processes)
    {
        if (processes.Count == 0) return;
        _ = Task.Run(async () =>
        {
            foreach (int wait in new[] { 300, 1500, 4000 })
            {
                await Task.Delay(wait);
                try { if (Rename(processes)) return; } catch { }
            }
        });
    }

    /// <summary>True when a session was found, named or not before.</summary>
    static bool Rename(IReadOnlyCollection<int> processes)
    {
        string icon = Environment.ProcessPath + ",0";
        bool found = false;
        var devices = (IMMDeviceEnumerator)new MMDeviceEnumerator();
        devices.EnumAudioEndpoints(Render, DeviceActive, out var all);
        all.GetCount(out int count);
        for (int d = 0; d < count; d++)
        {
            all.Item(d, out var device);
            var iid = typeof(IAudioSessionManager2).GUID;
            device.Activate(ref iid, ClsctxAll, IntPtr.Zero, out var activated);
            var manager = (IAudioSessionManager2)activated;
            manager.GetSessionEnumerator(out var sessions);
            sessions.GetCount(out int n);
            for (int s = 0; s < n; s++)
            {
                sessions.GetSession(s, out var session);
                if (session.GetProcessId(out int pid) != 0 || !processes.Contains(pid)) continue;
                found = true;
                var context = Guid.Empty;
                session.GetDisplayName(out var shown);
                if (shown != Name) session.SetDisplayName(Name, ref context);
                session.GetIconPath(out var path);
                if (path != icon) session.SetIconPath(icon, ref context);
            }
        }
        return found;
    }

    // Core Audio's interfaces. Methods stay in header order: COM finds them by position, not by name.

    [ComImport, Guid("bcde0395-e52f-467c-8e3d-c4579291692e")]
    class MMDeviceEnumerator { }

    [ComImport, Guid("a95664d2-9614-4f35-a746-de8db63617e6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        void EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
    }

    [ComImport, Guid("0bd7a1be-7a1a-44db-8397-cc5392387b5e"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceCollection
    {
        void GetCount(out int count);
        void Item(int index, out IMMDevice device);
    }

    [ComImport, Guid("d666063f-1587-4e43-81f1-b948e807363f"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        void Activate(ref Guid iid, int context, IntPtr parameters, [MarshalAs(UnmanagedType.IUnknown)] out object activated);
    }

    [ComImport, Guid("77aa99a0-1bd6-484f-8bc7-2c654c9a9b6f"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionManager2
    {
        void GetAudioSessionControl(); void GetSimpleAudioVolume();
        void GetSessionEnumerator(out IAudioSessionEnumerator sessions);
    }

    [ComImport, Guid("e2f5bb11-0570-40ca-acdd-3aa01277dee8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionEnumerator
    {
        void GetCount(out int count);
        void GetSession(int index, out IAudioSessionControl2 session);
    }

    [ComImport, Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionControl2
    {
        void GetState(out int state);
        void GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
        void SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, ref Guid context);
        void GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
        void SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid context);
        void GetGroupingParam(); void SetGroupingParam(); void RegisterAudioSessionNotification(); void UnregisterAudioSessionNotification();
        void GetSessionIdentifier(); void GetSessionInstanceIdentifier();
        // Fails for a session that spans processes, which none of Tint's do.
        [PreserveSig] int GetProcessId(out int pid);
    }
}
