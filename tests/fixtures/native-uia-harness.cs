using System;
using System.Collections.Generic;

// Minimal fakes for the production FlatScan method's dependencies. All state lives in this test process.
public sealed class Rect
{
    public double X = 10, Y = 10, Width = 40, Height = 20;
    public bool IsEmpty;
    public static readonly Rect Empty = new Rect { IsEmpty = true };
}

public sealed class ControlType
{
    public string ProgrammaticName = "ControlType.Button";
    public static readonly ControlType Custom = new ControlType { ProgrammaticName = "ControlType.Custom" };
}

public static class ValuePattern { public static readonly object ValueProperty = new object(); }

public sealed class FakeCache : IDisposable
{
    public IDisposable Activate() { return this; }
    public void Dispose() { }
}

public static class Thread
{
    public static int Waits;
    public static void Sleep(int milliseconds)
    {
        if (++Waits > 1) throw new Exception("FlatScan attempted more than one retry");
    }
}

public sealed class AutomationElement
{
    public static readonly object ControlTypeProperty = new object(), BoundingRectangleProperty = new object(),
        NameProperty = new object(), AutomationIdProperty = new object(), IsOffscreenProperty = new object(), IsEnabledProperty = new object();
    public static Func<int, AutomationElement> CreateRoot;
    public static int Scans;
    public string ClassName = "", Name = "";
    public AutomationElement Current { get { return this; } }
    public readonly List<AutomationElement> CachedChildren = new List<AutomationElement>();
    public static AutomationElement FromHandle(IntPtr handle) { return CreateRoot(++Scans); }
    public AutomationElement GetUpdatedCache(FakeCache cache) { return this; }
}

public static class UiaHarness
{
    static readonly Dictionary<string, AutomationElement> flatCache = new Dictionary<string, AutomationElement>();
    static readonly HashSet<string> Interactive = new HashSet<string> { "Button" };
    static int flatSeq;
    static FakeCache TreeCache() { return new FakeCache(); }
    static bool Flag(AutomationElement element, object property) { return property == AutomationElement.IsEnabledProperty; }
    static string OneLine(string value) { return value ?? ""; }
    static string Clip(string value, int limit) { return value.Length > limit ? value.Substring(0, limit) : value; }
    static object Cached(AutomationElement element, object property)
    {
        if (property == AutomationElement.ControlTypeProperty) return new ControlType();
        if (property == AutomationElement.BoundingRectangleProperty) return new Rect();
        if (property == AutomationElement.NameProperty) return element.Name;
        return "";
    }

    // FLAT_SCAN_METHODS

    static void Check(string className, string query, int initial, int later, int expected, int scans)
    {
        AutomationElement.Scans = 0;
        Thread.Waits = 0;
        AutomationElement.CreateRoot = attempt =>
        {
            var root = new AutomationElement { ClassName = className, Name = "Test window" };
            for (int i = 0; i < (attempt == 1 ? initial : later); i++)
                root.CachedChildren.Add(new AutomationElement { Name = "Save " + i });
            // A narrow query must retain its filter on the second scan.
            if (!string.IsNullOrEmpty(query)) root.CachedChildren.Add(new AutomationElement { Name = "Other action" });
            return root;
        };
        var result = FlatScan((IntPtr)1, 100, query);
        var elements = (List<object>)result["elements"];
        if (elements.Count != expected || AutomationElement.Scans != scans || Thread.Waits != scans - 1)
            throw new Exception("Unexpected results/retry count for query '" + query + "', initial hits " + initial);
        foreach (Dictionary<string, object> element in elements)
            if (!((string)element["name"]).StartsWith("Save")) throw new Exception("The original query was lost");
    }

    public static string Run()
    {
        for (int matches = 0; matches < 8; matches++) Check("Chrome_WidgetWin_1", "save", matches, matches, matches, 2);
        Check("Chrome_WidgetWin_1", "", 0, 4, 4, 2);
        Check("Chrome_WidgetWin_1", null, 0, 5, 5, 2);
        Check("Chrome_WidgetWin_1", "save", 8, 1, 8, 1);
        Check("Chrome_WidgetWin_1", "save", 20, 1, 20, 1);
        Check("OtherWindow", "save", 1, 5, 1, 1);
        var before = AutomationElement.Scans;
        var empty = FlatScan(IntPtr.Zero, 100, "save");
        if (((List<object>)empty["elements"]).Count != 0 || AutomationElement.Scans != before)
            throw new Exception("A missing window must not be scanned");
        return "14 UIA retry cases passed";
    }
}
