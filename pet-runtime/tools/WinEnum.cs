using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class WinEnum
{
    public delegate bool EnumProc(IntPtr h, IntPtr l);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);

    public struct RECT { public int L, T, R, B; }

    public class WinRec
    {
        public long hwnd;
        public string title;
        public string cls;      // 2026-11-21 审计：同名双窗口要靠 class 区分 UWP 空壳/真窗
        public int x, y, w, h;
        public bool iconic;
    }

    public static List<object> FindAll(string titleSub)
    {
        var list = new List<object>();
        var lower = (titleSub ?? "").ToLower();
        EnumWindows(delegate (IntPtr h, IntPtr l)
        {
            if (!IsWindowVisible(h)) return true;
            var sb = new StringBuilder(512);
            GetWindowTextW(h, sb, 512);
            var t = sb.ToString();
            if (string.IsNullOrEmpty(t)) return true;
            if (lower.Length > 0 && !t.ToLower().Contains(lower)) return true;
            RECT r;
            GetWindowRect(h, out r);
            var csb = new StringBuilder(256);
            GetClassNameW(h, csb, 256);
            var rec = new WinRec();
            rec.hwnd = h.ToInt64();
            rec.title = t;
            rec.cls = csb.ToString();
            rec.x = r.L; rec.y = r.T;
            rec.w = r.R - r.L; rec.h = r.B - r.T;
            rec.iconic = IsIconic(h);
            list.Add(rec);
            return true;
        }, IntPtr.Zero);
        return list;
    }

    /// <summary>
    /// 同名多窗口的最佳选择（2026-11-21 审计）。
    /// UWP 应用最小化时，Windows.UI.Core.CoreWindow（内容壳）会以「可见」姿态和
    /// ApplicationFrameWindow（真窗，iconic）同时出现在 EnumWindows 里；以前取第一个
    /// 非最小化 → 选中空壳，UIA 树 0 节点、聚焦后 GetForegroundWindow=0。
    /// 排序：非 CoreWindow 优先 → 非最小化 → 面积大。
    /// </summary>
    public static WinRec PickBest(List<object> wins)
    {
        if (wins == null || wins.Count == 0) return null;
        WinRec best = null;
        long bestScore = long.MinValue;
        foreach (var o in wins)
        {
            var w = (WinRec)o;
            long score = 0;
            if (string.Equals(w.cls, "Windows.UI.Core.CoreWindow", StringComparison.OrdinalIgnoreCase)) score -= 5000;
            if (string.Equals(w.cls, "ApplicationFrameWindow", StringComparison.OrdinalIgnoreCase)) score += 120;
            score += w.iconic ? -1000 : 300;
            long area = (long)w.w * (long)w.h;
            if (area > 0) score += Math.Min(200, (long)(Math.Log10(area) * 40));
            if (score > bestScore) { bestScore = score; best = w; }
        }
        return best;
    }

    // ── 聚焦（2026-11-09 三十五轮新增：把 focusWindow 从「每次 spawn pwsh」降到毫秒级）──
    //
    // 为什么要做：game-control.js 的 focusWindow() 现在每次都 spawn 一个 pwsh 进程
    // （实测 300ms+ 启动开销），而 UIA 服务是常驻的、本来就有 FindAll。
    // 把 SetForegroundWindow/ShowWindow 也放进这个常驻进程，聚焦就从 300ms+ 降到 <5ms。
    //
    // 三段式（缺一不可，都是 Windows 前台权限的硬约束）：
    //   1. ShowWindow(SW_RESTORE) —— 最小化的窗口必须先恢复，否则 SetForegroundWindow 静默失败
    //   2. AttachThreadInput —— Windows 只允许「前台窗口的线程」把前台转给别人。
    //      我们的进程不在前台，所以要把自己的输入线程 attach 到目标窗口线程，借它的权限
    //   3. SetForegroundWindow
    //   最后用 GetForegroundWindow 复核 —— 返回值 true 只说明「请求被接受」，
    //   实测被 alwaysOnTop 盖住时焦点切了但窗口不在最上层，所以必须复核 + 报告真实结果。

    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll")] public static extern void Sleep(uint ms);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool fAttach);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr SendMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);

    public static readonly int SW_RESTORE = 9;

    public class FocusResult
    {
        public bool ok;             // 复核通过：焦点真的在目标上了
        public long hwnd;
        public string title;
        public bool wasIconic;      // 之前是最小化的（说明我们做了恢复）
        public string fgTitle;      // 复核时实际的前台窗口标题（失败时能看出是谁占了）
        public long fgHwnd;
        public string error;
    }

    /// <summary>按标题子串（或 hwnd 字符串）聚焦窗口，并复核结果。</summary>
    public static FocusResult Focus(string titleSub)
    {
        var res = new FocusResult();
        long hTarget = 0;
        string targetTitle = null;

        // 支持直接传 hwnd（纯数字）——比按标题匹配更准，也不会撞名
        long hwndArg;
        if (long.TryParse((titleSub ?? "").Trim(), out hwndArg) && hwndArg > 0)
        {
            hTarget = hwndArg;
            var sb = new StringBuilder(512);
            GetWindowTextW(new IntPtr(hTarget), sb, 512);
            targetTitle = sb.ToString();
        }
        else
        {
            var wins = FindAll(titleSub);
            if (wins.Count == 0) { res.error = "没找到窗口：" + titleSub; return res; }
            var rec = PickBest(wins);
            hTarget = rec.hwnd;
            targetTitle = rec.title;
            res.wasIconic = rec.iconic;
        }

        var h = new IntPtr(hTarget);
        res.hwnd = hTarget;
        res.title = targetTitle;

        try
        {
            // ① 最小化的先恢复（不恢复，后面两步都会静默失败）
            if (IsIconic(h)) { ShowWindow(h, SW_RESTORE); Sleep(80); }

            // ② 借前台线程的输入权限
            var fg = GetForegroundWindow();
            uint fgPid;
            uint fgThread = GetWindowThreadProcessId(fg, out fgPid);
            uint targetPid;
            uint targetThread = GetWindowThreadProcessId(h, out targetPid);
            uint selfThread = GetCurrentThreadId();

            bool attached1 = false, attached2 = false;
            try
            {
                if (fgThread != 0 && fgThread != selfThread) attached1 = AttachThreadInput(selfThread, fgThread, true);
                if (targetThread != 0 && targetThread != selfThread && targetThread != fgThread)
                    attached2 = AttachThreadInput(selfThread, targetThread, true);

                // ③ 三连：BringWindowToTop + SetForegroundWindow + 再 Bring 一次
                BringWindowToTop(h);
                SetForegroundWindow(h);
                BringWindowToTop(h);
            }
            finally
            {
                if (attached1) AttachThreadInput(selfThread, fgThread, false);
                if (attached2) AttachThreadInput(selfThread, targetThread, false);
            }

            Sleep(120);

            // ④ 复核：只看「焦点真的到没到」，不信返回值
            var nowFg = GetForegroundWindow();
            res.fgHwnd = nowFg.ToInt64();
            var sbn = new StringBuilder(512);
            GetWindowTextW(nowFg, sbn, 512);
            res.fgTitle = sbn.ToString();
            res.ok = (nowFg == h);
        }
        catch (Exception ex)
        {
            res.error = ex.Message;
        }
        return res;
    }

    /// <summary>读当前前台窗口信息（给 assertTargetFocused 用，替代每次 spawn pwsh）。</summary>
    public static FocusResult Foreground()
    {
        var res = new FocusResult();
        try
        {
            var h = GetForegroundWindow();
            res.hwnd = h.ToInt64();
            res.fgHwnd = res.hwnd;
            var sb = new StringBuilder(512);
            GetWindowTextW(h, sb, 512);
            res.title = sb.ToString();
            res.fgTitle = res.title;
            res.ok = h != IntPtr.Zero;
        }
        catch (Exception ex) { res.error = ex.Message; }
        return res;
    }

    // ── Chromium/Electron 渲染进程宿主查找（2026-11-09 三十五轮）──────────────
    //
    // 用途：唤醒 Chromium 的 UIA 无障碍树。
    //
    // 为什么不用 UIA 找：**空壳状态下 UIA 树里看不到 renderer**（那正是「空」的含义）。
    // 我们实测：UIA 的 FindAll(Descendants, ClassName='Chrome_RenderWidgetHostHWND')
    // 对空壳窗口返回 0 —— 用 UIA 找 UIA 还没建的东西是逻辑死循环。
    // 必须走 Win32 EnumChildWindows（它看的是真实窗口层级，跟无障碍树无关）。
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);

    public class RendererRec
    {
        public long hwnd;
        public string cls;
    }

    /// <summary>枚举顶层窗口下的 Chrome_RenderWidgetHostHWND 子窗口。</summary>
    public static List<object> ChromiumRenderers(long topHwnd, int max)
    {
        var list = new List<object>();
        try
        {
            EnumChildWindows(new IntPtr(topHwnd), delegate (IntPtr h, IntPtr l)
            {
                var sb = new StringBuilder(256);
                GetClassNameW(h, sb, 256);
                var cls = sb.ToString();
                if (cls.IndexOf("Chrome_RenderWidgetHost", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    var rec = new RendererRec();
                    rec.hwnd = h.ToInt64();
                    rec.cls = cls;
                    list.Add(rec);
                    if (list.Count >= max) return false;
                }
                return true;
            }, IntPtr.Zero);
        }
        catch { }
        return list;
    }
}
