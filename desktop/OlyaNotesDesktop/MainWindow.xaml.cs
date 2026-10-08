using System;
using System.IO;
using System.Net.Http;
using System.Windows;
using Microsoft.Web.WebView2.Core;

namespace OlyaNotesDesktop;

public partial class MainWindow : Window
{
    public MainWindow()
    {
        InitializeComponent();
        Loaded += OnLoaded;
    }

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        try
        {
            var www = FindWwwFolder();
            if (www is null)
            {
                MessageBox.Show(
                    "Не найдены файлы заметок рядом с программой.\nОжидается папка www с index.html.",
                    "OlyaNotes",
                    MessageBoxButton.OK,
                    MessageBoxImage.Error);
                Close();
                return;
            }

            var userData = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "OlyaNotes",
                "WebView2");
            Directory.CreateDirectory(userData);

            var env = await CoreWebView2Environment.CreateAsync(userDataFolder: userData);
            await Web.EnsureCoreWebView2Async(env);

            Web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
            Web.CoreWebView2.Settings.AreDevToolsEnabled = false;
            Web.CoreWebView2.Settings.IsStatusBarEnabled = false;
            Web.CoreWebView2.Settings.IsZoomControlEnabled = true;

            if (await ServerIsUp("http://127.0.0.1:5173/"))
            {
                Web.CoreWebView2.Navigate("http://127.0.0.1:5173/");
                return;
            }

            Web.CoreWebView2.SetVirtualHostNameToFolderMapping(
                "olyanotes.local",
                www,
                CoreWebView2HostResourceAccessKind.Allow);

            Web.CoreWebView2.Navigate("https://olyanotes.local/index.html");
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                "Не удалось открыть окно заметок.\n\n" + ex.Message +
                "\n\nУстановите «Microsoft Edge WebView2 Runtime», если его ещё нет.",
                "OlyaNotes",
                MessageBoxButton.OK,
                MessageBoxImage.Error);
            Close();
        }
    }

    private static async System.Threading.Tasks.Task<bool> ServerIsUp(string url)
    {
        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromMilliseconds(800) };
            using var response = await client.GetAsync(url);
            return response.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    private static string? FindWwwFolder()
    {
        var baseDir = AppDomain.CurrentDomain.BaseDirectory;
        var candidates = new[]
        {
            Path.Combine(baseDir, "www"),
            Path.GetFullPath(Path.Combine(baseDir, "..", "..", "..", "..", "..")),
            Path.GetFullPath(Path.Combine(baseDir, "..", "..", "..", "..")),
        };

        foreach (var path in candidates)
        {
            if (File.Exists(Path.Combine(path, "index.html")) && Directory.Exists(Path.Combine(path, "src")))
                return path;
            var nested = Path.Combine(path, "www");
            if (File.Exists(Path.Combine(nested, "index.html")))
                return nested;
        }

        return null;
    }
}
