using System.Runtime.InteropServices;

namespace Tint;

/// <summary>
/// Puts the current song in Windows' own media controls (the panel in Quick Settings and on the
/// lock screen) and hears the keyboard's play, pause, next and previous keys, whichever app is in
/// front. Windows offers this through WinRT. The few interfaces it takes are declared at the foot
/// of this file by hand, in the order the Windows SDK headers give them, because the ready-made
/// .NET bindings would add about 24 MB to an app of 2.
/// </summary>
sealed class SystemMedia : IDisposable
{
    const int StatusClosed = 0, StatusPlaying = 3, StatusPaused = 4;
    const int TypeMusic = 1;
    const int ButtonPlay = 0, ButtonPause = 1, ButtonStop = 2, ButtonNext = 6, ButtonPrevious = 7;

    readonly IControls? _controls;
    readonly Handler? _handler;
    readonly long _token;
    SystemTrack? _shown;

    /// <summary>`command` is called with play, pause, next or previous, on a thread of Windows' choosing.</summary>
    public SystemMedia(IntPtr window, Action<string> command)
    {
        try
        {
            var interop = (IControlsInterop)Factory("Windows.Media.SystemMediaTransportControls", typeof(IControlsInterop).GUID);
            _controls = interop.GetForWindow(window, typeof(IControls).GUID);
            _controls.put_IsPlayEnabled(true);
            _controls.put_IsPauseEnabled(true);
            _controls.put_IsNextEnabled(true);
            _controls.put_IsPreviousEnabled(true);
            _handler = new Handler(command);
            _token = _controls.add_ButtonPressed(_handler);
        }
        catch
        {
            // No media controls on this system. The player works the same without them.
            _controls = null;
        }
    }

    /// <summary>Shows a song as playing or paused. Null means there is nothing to show.</summary>
    public void Show(SystemTrack? track, bool playing)
    {
        if (_controls == null) return;
        try
        {
            if (track == null)
            {
                _controls.put_PlaybackStatus(StatusClosed);
                _controls.put_IsEnabled(false);
                _shown = null;
                return;
            }

            _controls.put_IsEnabled(true);
            _controls.put_PlaybackStatus(playing ? StatusPlaying : StatusPaused);
            if (track == _shown) return;
            _shown = track;

            var display = _controls.get_DisplayUpdater();
            display.put_Type(TypeMusic);
            var music = display.get_MusicProperties();
            WithText(track.Title, music.put_Title);
            WithText(track.Artist, music.put_Artist);
            WithText(track.Album, ((IMusicProperties2)music).put_AlbumTitle);
            SetCover(display, track);
            display.Update();
        }
        catch
        {
            // Windows turned an update down. The next song gets another go.
        }
    }

    static void SetCover(IDisplayUpdater display, SystemTrack track)
    {
        IntPtr source = IntPtr.Zero, reference = IntPtr.Zero;
        try
        {
            var references = (IStreamReferenceStatics)Factory("Windows.Storage.Streams.RandomAccessStreamReference", typeof(IStreamReferenceStatics).GUID);
            if (track.ArtFile != null)
            {
                // Handed over from memory, so the cover cache is never held open.
                var bytes = File.ReadAllBytes(track.ArtFile);
                var plain = SHCreateMemStream(bytes, bytes.Length);
                try { Marshal.ThrowExceptionForHR(CreateRandomAccessStreamOverStream(plain, 0, RandomAccessStream, out source)); }
                finally { Marshal.Release(plain); }
                reference = references.CreateFromStream(source);
            }
            else if (track.ArtUrl != null)
            {
                var uris = (IUriFactory)Factory("Windows.Foundation.Uri", typeof(IUriFactory).GUID);
                WithText(track.ArtUrl, text => source = uris.CreateUri(text));
                reference = references.CreateFromUri(source);
            }
            display.put_Thumbnail(reference);
        }
        catch
        {
            // A song without its cover is still worth showing.
            try { display.put_Thumbnail(IntPtr.Zero); } catch { }
        }
        finally
        {
            if (source != IntPtr.Zero) Marshal.Release(source);
            if (reference != IntPtr.Zero) Marshal.Release(reference);
        }
    }

    public void Dispose()
    {
        if (_controls == null) return;
        try
        {
            _controls.remove_ButtonPressed(_token);
            _controls.put_IsEnabled(false);
        }
        catch { }
    }

    sealed class Handler(Action<string> command) : IButtonPressedHandler
    {
        public int Invoke(IntPtr sender, IButtonPressedArgs args)
        {
            try
            {
                var name = args.get_Button() switch
                {
                    ButtonPlay => "play",
                    ButtonPause or ButtonStop => "pause",
                    ButtonNext => "next",
                    ButtonPrevious => "previous",
                    _ => null,
                };
                if (name != null) command(name);
            }
            catch { }
            return 0;
        }
    }

    // ---- WinRT plumbing --------------------------------------------------------------------------

    static readonly Guid RandomAccessStream = new("905a0fe1-bc53-11df-8c49-001e4fc686da");

    static object Factory(string className, Guid iid)
    {
        object? factory = null;
        WithText(className, name => Marshal.ThrowExceptionForHR(RoGetActivationFactory(name, iid, out factory)));
        return factory!;
    }

    /// <summary>WinRT takes its strings as HSTRINGs, which have to be made and freed by hand here.</summary>
    static void WithText(string text, Action<IntPtr> use)
    {
        Marshal.ThrowExceptionForHR(WindowsCreateString(text, text.Length, out var hstring));
        try { use(hstring); }
        finally { WindowsDeleteString(hstring); }
    }

    [DllImport("combase.dll")]
    static extern int RoGetActivationFactory(IntPtr classId, in Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object factory);

    [DllImport("combase.dll", CharSet = CharSet.Unicode)]
    static extern int WindowsCreateString(string source, int length, out IntPtr hstring);

    [DllImport("combase.dll")]
    static extern int WindowsDeleteString(IntPtr hstring);

    [DllImport("shlwapi.dll")]
    static extern IntPtr SHCreateMemStream(byte[] data, int length);

    [DllImport("shcore.dll")]
    static extern int CreateRandomAccessStreamOverStream(IntPtr stream, int options, in Guid iid, out IntPtr randomAccessStream);

    // Every WinRT interface starts with IInspectable's three methods, which nothing here calls.
    // After them the methods must stay in header order: COM finds them by position, not by name.

    [ComImport, Guid("ddb0472d-c911-4a1f-86d9-dc3d71a95f5a"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IControlsInterop
    {
        void GetIids(); void GetRuntimeClassName(); void GetTrustLevel();
        IControls GetForWindow(IntPtr window, in Guid iid);
    }

    [ComImport, Guid("99fa3ff4-1742-42a6-902e-087d41f965ec"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IControls
    {
        void GetIids(); void GetRuntimeClassName(); void GetTrustLevel();
        int get_PlaybackStatus();
        void put_PlaybackStatus(int value);
        IDisplayUpdater get_DisplayUpdater();
        int get_SoundLevel();
        [return: MarshalAs(UnmanagedType.U1)] bool get_IsEnabled();
        void put_IsEnabled([MarshalAs(UnmanagedType.U1)] bool value);
        [return: MarshalAs(UnmanagedType.U1)] bool get_IsPlayEnabled();
        void put_IsPlayEnabled([MarshalAs(UnmanagedType.U1)] bool value);
        [return: MarshalAs(UnmanagedType.U1)] bool get_IsStopEnabled();
        void put_IsStopEnabled([MarshalAs(UnmanagedType.U1)] bool value);
        [return: MarshalAs(UnmanagedType.U1)] bool get_IsPauseEnabled();
        void put_IsPauseEnabled([MarshalAs(UnmanagedType.U1)] bool value);
        [return: MarshalAs(UnmanagedType.U1)] bool get_IsRecordEnabled();
        void put_IsRecordEnabled([MarshalAs(UnmanagedType.U1)] bool value);
        [return: MarshalAs(UnmanagedType.U1)] bool get_IsFastForwardEnabled();
        void put_IsFastForwardEnabled([MarshalAs(UnmanagedType.U1)] bool value);
        [return: MarshalAs(UnmanagedType.U1)] bool get_IsRewindEnabled();
        void put_IsRewindEnabled([MarshalAs(UnmanagedType.U1)] bool value);
        [return: MarshalAs(UnmanagedType.U1)] bool get_IsPreviousEnabled();
        void put_IsPreviousEnabled([MarshalAs(UnmanagedType.U1)] bool value);
        [return: MarshalAs(UnmanagedType.U1)] bool get_IsNextEnabled();
        void put_IsNextEnabled([MarshalAs(UnmanagedType.U1)] bool value);
        [return: MarshalAs(UnmanagedType.U1)] bool get_IsChannelUpEnabled();
        void put_IsChannelUpEnabled([MarshalAs(UnmanagedType.U1)] bool value);
        [return: MarshalAs(UnmanagedType.U1)] bool get_IsChannelDownEnabled();
        void put_IsChannelDownEnabled([MarshalAs(UnmanagedType.U1)] bool value);
        long add_ButtonPressed(IButtonPressedHandler handler);
        void remove_ButtonPressed(long token);
    }

    [ComImport, Guid("8abbc53e-fa55-4ecf-ad8e-c984e5dd1550"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IDisplayUpdater
    {
        void GetIids(); void GetRuntimeClassName(); void GetTrustLevel();
        int get_Type();
        void put_Type(int value);
        IntPtr get_AppMediaId();
        void put_AppMediaId(IntPtr value);
        IntPtr get_Thumbnail();
        void put_Thumbnail(IntPtr streamReference);
        IMusicProperties get_MusicProperties();
        IntPtr get_VideoProperties();
        IntPtr get_ImageProperties();
        IntPtr CopyFromFileAsync(int type, IntPtr file);
        void ClearAll();
        void Update();
    }

    [ComImport, Guid("6bbf0c59-d0a0-4d26-92a0-f978e1d18e7b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMusicProperties
    {
        void GetIids(); void GetRuntimeClassName(); void GetTrustLevel();
        IntPtr get_Title();
        void put_Title(IntPtr value);
        IntPtr get_AlbumArtist();
        void put_AlbumArtist(IntPtr value);
        IntPtr get_Artist();
        void put_Artist(IntPtr value);
    }

    [ComImport, Guid("00368462-97d3-44b9-b00f-008afcefaf18"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMusicProperties2
    {
        void GetIids(); void GetRuntimeClassName(); void GetTrustLevel();
        IntPtr get_AlbumTitle();
        void put_AlbumTitle(IntPtr value);
    }

    [ComImport, Guid("b7f47116-a56f-4dc8-9e11-92031f4a87c2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IButtonPressedArgs
    {
        void GetIids(); void GetRuntimeClassName(); void GetTrustLevel();
        int get_Button();
    }

    /// <summary>TypedEventHandler&lt;SystemMediaTransportControls, SystemMediaTransportControlsButtonPressedEventArgs&gt;.</summary>
    [ComImport, Guid("0557e996-7b23-5bae-aa81-ea0d671143a4"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IButtonPressedHandler
    {
        [PreserveSig] int Invoke(IntPtr sender, IButtonPressedArgs args);
    }

    [ComImport, Guid("857309dc-3fbf-4e7d-986f-ef3b1a07a964"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IStreamReferenceStatics
    {
        void GetIids(); void GetRuntimeClassName(); void GetTrustLevel();
        IntPtr CreateFromFile(IntPtr file);
        IntPtr CreateFromUri(IntPtr uri);
        IntPtr CreateFromStream(IntPtr stream);
    }

    [ComImport, Guid("44a9796f-723e-4fdf-a218-033e75b0c084"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IUriFactory
    {
        void GetIids(); void GetRuntimeClassName(); void GetTrustLevel();
        IntPtr CreateUri(IntPtr text);
    }
}
