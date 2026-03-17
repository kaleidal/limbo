import { useRef, useState, useEffect } from "react";
import { useAppStore } from "@/store/app-store";
import {
  ArrowLeft,
  ArrowRight,
  RotateCcw,
  Home,
  Lock,
  Unlock,
  ExternalLink,
  AlertCircle,
  Popcorn,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import type { Bookmark, ElectronWebviewElement } from "@/types/electron.d";

type WebviewNavigationEvent = Event & {
  url: string;
  errorCode?: number;
  errorDescription?: string;
  preventDefault?: () => void;
};

export function BrowserView() {
  const { activeBookmark, clearExpiredBrowserSessions } = useAppStore();

  useEffect(() => {
    clearExpiredBrowserSessions();
  }, [clearExpiredBrowserSessions]);

  if (!activeBookmark) {
    return (
      <div className="h-full flex items-center justify-center text-neutral-500">
        <p>Select a site from the sidebar to browse</p>
      </div>
    );
  }

  return <BookmarkBrowser key={activeBookmark.id} bookmark={activeBookmark} />;
}

function BookmarkBrowser({ bookmark }: { bookmark: Bookmark }) {
  const { getBrowserSessionUrl, rememberBrowserSession } = useAppStore();
  const webviewRef = useRef<ElectronWebviewElement>(null);
  const initialUrl = getBrowserSessionUrl(bookmark.id, bookmark.url);
  const [currentUrl, setCurrentUrl] = useState(initialUrl);
  const [isLoading, setIsLoading] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [isSecure, setIsSecure] = useState(initialUrl.startsWith("https://"));
  const [blockPopups, setBlockPopups] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    const handleDidStartLoading = () => {
      setIsLoading(true);
      setError(null);
    };

    const handleDidStopLoading = () => {
      setIsLoading(false);
      try {
        setCanGoBack(webview.canGoBack());
        setCanGoForward(webview.canGoForward());
      } catch {
        // Webview can briefly disappear during navigation resets.
      }
    };

    const handleDidNavigate = (event: Event) => {
      const navigationEvent = event as WebviewNavigationEvent;
      setCurrentUrl(navigationEvent.url);
      setIsSecure(navigationEvent.url.startsWith("https://"));
      rememberBrowserSession(bookmark.id, navigationEvent.url);
    };

    const handleDidNavigateInPage = (event: Event) => {
      const navigationEvent = event as WebviewNavigationEvent;
      setCurrentUrl(navigationEvent.url);
      setIsSecure(navigationEvent.url.startsWith("https://"));
      rememberBrowserSession(bookmark.id, navigationEvent.url);
    };

    const handleDidFailLoad = (event: Event) => {
      const navigationEvent = event as WebviewNavigationEvent;
      if (navigationEvent.errorCode !== -3) {
        setError(`Failed to load: ${navigationEvent.errorDescription || "Unknown error"}`);
      }
      setIsLoading(false);
    };

    const handleWillNavigate = (event: Event) => {
      const navigationEvent = event as WebviewNavigationEvent;
      if (navigationEvent.url.startsWith("magnet:")) {
        navigationEvent.preventDefault?.();
        navigator.clipboard.writeText(navigationEvent.url).catch(() => undefined);
      }
    };

    const handleNewWindow = (event: Event) => {
      const navigationEvent = event as WebviewNavigationEvent;
      if (blockPopups) {
        navigationEvent.preventDefault?.();
        return;
      }

      if (navigationEvent.url.startsWith("magnet:")) {
        navigationEvent.preventDefault?.();
        navigator.clipboard.writeText(navigationEvent.url).catch(() => undefined);
      }
    };

    webview.addEventListener("did-start-loading", handleDidStartLoading);
    webview.addEventListener("did-stop-loading", handleDidStopLoading);
    webview.addEventListener("did-navigate", handleDidNavigate);
    webview.addEventListener("did-navigate-in-page", handleDidNavigateInPage);
    webview.addEventListener("did-fail-load", handleDidFailLoad);
    webview.addEventListener("will-navigate", handleWillNavigate);
    webview.addEventListener("new-window", handleNewWindow);

    return () => {
      webview.removeEventListener("did-start-loading", handleDidStartLoading);
      webview.removeEventListener("did-stop-loading", handleDidStopLoading);
      webview.removeEventListener("did-navigate", handleDidNavigate);
      webview.removeEventListener("did-navigate-in-page", handleDidNavigateInPage);
      webview.removeEventListener("did-fail-load", handleDidFailLoad);
      webview.removeEventListener("will-navigate", handleWillNavigate);
      webview.removeEventListener("new-window", handleNewWindow);
    };
  }, [blockPopups, bookmark.id, rememberBrowserSession]);

  const handleGoBack = () => webviewRef.current?.goBack();
  const handleGoForward = () => webviewRef.current?.goForward();
  const handleReload = () => webviewRef.current?.reload();
  const handleHome = () => {
    if (webviewRef.current) {
      webviewRef.current.src = bookmark.url;
      setCurrentUrl(bookmark.url);
      setIsSecure(bookmark.url.startsWith("https://"));
      rememberBrowserSession(bookmark.id, bookmark.url);
      setError(null);
    }
  };

  const handleUrlSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!webviewRef.current) return;

    let nextUrl = currentUrl.trim();
    if (!nextUrl.startsWith("http://") && !nextUrl.startsWith("https://")) {
      nextUrl = `https://${nextUrl}`;
    }

    webviewRef.current.src = nextUrl;
    setCurrentUrl(nextUrl);
    setIsSecure(nextUrl.startsWith("https://"));
    rememberBrowserSession(bookmark.id, nextUrl);
  };

  const handleOpenExternal = () => {
    if (currentUrl && window.limbo) {
      window.limbo.openExternal(currentUrl).catch(() => undefined);
    }
  };

  return (
    <div className="h-full flex flex-col bg-neutral-950">
      <div className="flex items-center gap-2 p-2 bg-neutral-900 border-b border-neutral-800">
        <button
          onClick={handleGoBack}
          disabled={!canGoBack}
          className="p-2 hover:bg-neutral-800 rounded disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <button
          onClick={handleGoForward}
          disabled={!canGoForward}
          className="p-2 hover:bg-neutral-800 rounded disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <ArrowRight className="w-4 h-4" />
        </button>
        <button
          onClick={handleReload}
          className="p-2 hover:bg-neutral-800 rounded transition-colors"
        >
          <RotateCcw className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} />
        </button>
        <button
          onClick={handleHome}
          className="p-2 hover:bg-neutral-800 rounded transition-colors"
        >
          <Home className="w-4 h-4" />
        </button>

        <form onSubmit={handleUrlSubmit} className="flex-1 flex items-center">
          <div className="relative flex-1">
            <div className="absolute left-3 top-1/2 -translate-y-1/2">
              {isSecure ? (
                <Lock className="w-4 h-4 text-green-500" />
              ) : (
                <Unlock className="w-4 h-4 text-neutral-500" />
              )}
            </div>
            <Input
              value={currentUrl}
              onChange={(event) => setCurrentUrl(event.target.value)}
              className="pl-10 bg-neutral-800 border-neutral-700 text-sm"
              placeholder="Enter URL..."
            />
          </div>
        </form>

        <button
          onClick={() => setBlockPopups((current) => !current)}
          className={`p-2 rounded transition-colors ${
            blockPopups
              ? "bg-red-500/15 text-red-400 hover:bg-red-500/25"
              : "hover:bg-neutral-800 text-neutral-400"
          }`}
          title={blockPopups ? "Popups blocked" : "Popups allowed"}
        >
          <Popcorn className="w-4 h-4" />
        </button>

        <button
          onClick={handleOpenExternal}
          className="p-2 hover:bg-neutral-800 rounded transition-colors"
          title="Open in external browser"
        >
          <ExternalLink className="w-4 h-4" />
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 bg-red-950/50 border-b border-red-900 text-red-400">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span className="text-sm">{error}</span>
          <button
            onClick={handleReload}
            className="ml-auto text-xs px-2 py-1 bg-red-900/50 hover:bg-red-900 rounded transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      <webview
        ref={webviewRef}
        src={initialUrl}
        className="flex-1 w-full"
        partition="persist:limbo"
        allowpopups={true}
        webpreferences="javascript=yes"
      />
    </div>
  );
}
