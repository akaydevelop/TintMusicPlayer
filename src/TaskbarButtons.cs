using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace Tint;

/// <summary>
/// The previous, play/pause and next buttons under the window's preview on the taskbar.
/// Windows draws the buttons; this supplies the icons and reports which one was clicked.
/// </summary>
sealed class TaskbarButtons : IDisposable
{
    /// <summary>Windows posts this to a window once its taskbar button exists (and again if Explorer restarts).</summary>
    public static readonly int Created = RegisterWindowMessage("TaskbarButtonCreated");

    const int Previous = 1, PlayPause = 2, Next = 3;
    const int Clicked = 0x1800;
    const int MaskIcon = 2, MaskTooltip = 4, MaskFlags = 8;
    const int FlagDisabled = 1;

    ITaskbarList3? _taskbar;
    IntPtr _window;
    bool _enabled, _playing, _light;
    IntPtr _iconPrevious, _iconPlay, _iconPause, _iconNext;

    /// <summary>Whether Windows accepted the buttons.</summary>
    public bool Attached => _taskbar != null && _window != IntPtr.Zero;

    /// <summary>Adds the buttons. Call when the <see cref="Created"/> message arrives.</summary>
    public void Attach(IntPtr window, int dpi)
    {
        try
        {
            _taskbar ??= (ITaskbarList3)new TaskbarList();
            _taskbar.HrInit();
            _window = window;
            DrawIcons(dpi);
            _taskbar.ThumbBarAddButtons(_window, 3, Buttons());
        }
        catch
        {
            // No taskbar to talk to (a different shell, say). The buttons are an extra.
            _taskbar = null;
        }
    }

    public void Show(bool enabled, bool playing)
    {
        if (enabled == _enabled && playing == _playing) return;
        _enabled = enabled;
        _playing = playing;
        Update();
    }

    /// <summary>The taskbar's own colours changed, so the icons may need to swap between white and black.</summary>
    public void Restyle(int dpi)
    {
        if (_window == IntPtr.Zero || TaskbarIsLight() == _light) return;
        DrawIcons(dpi);
        Update();
    }

    /// <summary>The command a WM_COMMAND message stands for, when it is a click on one of the buttons.</summary>
    public static string? CommandFor(IntPtr wParam)
    {
        long value = wParam.ToInt64();
        if (((value >> 16) & 0xFFFF) != Clicked) return null;
        return (value & 0xFFFF) switch { Previous => "previous", PlayPause => "toggle", Next => "next", _ => null };
    }

    void Update()
    {
        if (_taskbar == null || _window == IntPtr.Zero) return;
        try { _taskbar.ThumbBarUpdateButtons(_window, 3, Buttons()); } catch { }
    }

    THUMBBUTTON[] Buttons()
    {
        THUMBBUTTON Button(int id, IntPtr icon, string tip) => new()
        {
            dwMask = MaskIcon | MaskTooltip | MaskFlags,
            iId = (uint)id,
            hIcon = icon,
            szTip = tip,
            dwFlags = _enabled ? 0 : FlagDisabled,
        };
        return new[]
        {
            Button(Previous, _iconPrevious, "Previous"),
            _playing ? Button(PlayPause, _iconPause, "Pause") : Button(PlayPause, _iconPlay, "Play"),
            Button(Next, _iconNext, "Next"),
        };
    }

    // ---- icons -------------------------------------------------------------------------------------

    static bool TaskbarIsLight()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
            return key?.GetValue("SystemUsesLightTheme") is int value && value != 0;
        }
        catch
        {
            return false;
        }
    }

    void DrawIcons(int dpi)
    {
        DestroyIcons();
        _light = TaskbarIsLight();
        var color = _light ? Color.FromArgb(0x1B, 0x1B, 0x1B) : Color.White;
        int size = GetSystemMetricsForDpi(SM_CXSMICON, dpi);

        // The same shapes as the buttons in the window, on the same 24-unit grid.
        _iconPlay = Draw(size, color, path => path.AddPolygon(new PointF[] { new(8, 5), new(19.5f, 12), new(8, 19) }));
        _iconPause = Draw(size, color, path =>
        {
            path.AddRectangle(new RectangleF(6.2f, 5, 4.3f, 14));
            path.AddRectangle(new RectangleF(13.5f, 5, 4.3f, 14));
        });
        _iconNext = Draw(size, color, path =>
        {
            path.AddPolygon(new PointF[] { new(5, 5.5f), new(15.6f, 12), new(5, 18.5f) });
            path.AddRectangle(new RectangleF(16.6f, 5.5f, 2.6f, 13));
        });
        _iconPrevious = Draw(size, color, path =>
        {
            path.AddPolygon(new PointF[] { new(19, 5.5f), new(8.4f, 12), new(19, 18.5f) });
            path.AddRectangle(new RectangleF(4.8f, 5.5f, 2.6f, 13));
        });
    }

    static IntPtr Draw(int size, Color color, Action<GraphicsPath> shape)
    {
        using var bitmap = new Bitmap(size, size, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(bitmap))
        using (var path = new GraphicsPath(FillMode.Winding))
        using (var brush = new SolidBrush(color))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            // The taskbar shows these small, so each shape is drawn larger in its square than in the window.
            g.ScaleTransform(size / 24f, size / 24f);
            g.TranslateTransform(12, 12);
            g.ScaleTransform(1.3f, 1.3f);
            g.TranslateTransform(-12, -12);
            shape(path);
            g.FillPath(brush, path);
        }
        return bitmap.GetHicon();
    }

    void DestroyIcons()
    {
        foreach (var icon in new[] { _iconPrevious, _iconPlay, _iconPause, _iconNext })
            if (icon != IntPtr.Zero) DestroyIcon(icon);
        _iconPrevious = _iconPlay = _iconPause = _iconNext = IntPtr.Zero;
    }

    public void Dispose() => DestroyIcons();

    // ---- Windows -----------------------------------------------------------------------------------

    const int SM_CXSMICON = 49;

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int RegisterWindowMessage(string name);

    [DllImport("user32.dll")]
    static extern int GetSystemMetricsForDpi(int index, int dpi);

    [DllImport("user32.dll")]
    static extern bool DestroyIcon(IntPtr icon);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct THUMBBUTTON
    {
        public int dwMask;
        public uint iId;
        public uint iBitmap;
        public IntPtr hIcon;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szTip;
        public int dwFlags;
    }

    [ComImport, Guid("56fdf344-fd6d-11d0-958a-006097c9a090"), ClassInterface(ClassInterfaceType.None)]
    class TaskbarList { }

    // Only the two button methods are used. The ones before them hold their places in the interface.
    [ComImport, Guid("ea1afb91-9e28-4b86-90e9-9e9f8a5eefaf"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface ITaskbarList3
    {
        void HrInit();
        void AddTab(IntPtr window);
        void DeleteTab(IntPtr window);
        void ActivateTab(IntPtr window);
        void SetActiveAlt(IntPtr window);
        void MarkFullscreenWindow(IntPtr window, [MarshalAs(UnmanagedType.Bool)] bool fullscreen);
        void SetProgressValue(IntPtr window, ulong completed, ulong total);
        void SetProgressState(IntPtr window, int state);
        void RegisterTab(IntPtr tab, IntPtr window);
        void UnregisterTab(IntPtr tab);
        void SetTabOrder(IntPtr tab, IntPtr insertBefore);
        void SetTabActive(IntPtr tab, IntPtr window, int reserved);
        void ThumbBarAddButtons(IntPtr window, uint count, [MarshalAs(UnmanagedType.LPArray)] THUMBBUTTON[] buttons);
        void ThumbBarUpdateButtons(IntPtr window, uint count, [MarshalAs(UnmanagedType.LPArray)] THUMBBUTTON[] buttons);
    }
}
