import { useRef, useState, useEffect, useLayoutEffect } from "react";
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
import { isFenestraRuntime } from "@/lib/limbo-bridge";
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

  if (isFenestraRuntime()) {
    return <FenestraBookmarkBrowser key={activeBookmark.id} bookmark={activeBookmark} />;
  }

  return <ElectronBookmarkBrowser key={activeBookmark.id} bookmark={activeBookmark} />;
}

function BrowserChrome({
  currentUrl,
  setCurrentUrl,
  isLoading,
  canGoBack,
  canGoForward,
  isSecure,
  blockPopups,
  setBlockPopups,
  error,
  onGoBack,
  onGoForward,
  onReload,
  onHome,
  onUrlSubmit,
  onOpenExternal,
  children,
}: {
  currentUrl: string;
  setCurrentUrl: (url: string) => void;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  isSecure: boolean;
  blockPopups: boolean;
  setBlockPopups: (value: boolean | ((current: boolean) => boolean)) => void;
  error: string | null;
  onGoBack: () => void;
  onGoForward: () => void;
  onReload: () => void;
  onHome: () => void;
  onUrlSubmit: (event: React.FormEvent) => void;
  onOpenExternal: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="h-full flex flex-col bg-neutral-950">
      <div className="flex items-center gap-2 p-2 bg-neutral-900 border-b border-neutral-800">
        <button
          onClick={onGoBack}
          disabled={!canGoBack}
          className="p-2 hover:bg-neutral-800 rounded disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <button
          onClick={onGoForward}
          disabled={!canGoForward}
          className="p-2 hover:bg-neutral-800 rounded disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <ArrowRight className="w-4 h-4" />
        </button>
        <button onClick={onReload} className="p-2 hover:bg-neutral-800 rounded transition-colors">
          <RotateCcw className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} />
        </button>
        <button onClick={onHome} className="p-2 hover:bg-neutral-800 rounded transition-colors">
          <Home className="w-4 h-4" />
        </button>

        <form onSubmit={onUrlSubmit} className="flex-1 flex items-center">
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
          onClick={onOpenExternal}
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
            onClick={onReload}
            className="ml-auto text-xs px-2 py-1 bg-red-900/50 hover:bg-red-900 rounded transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {children}
    </div>
  );
}

function FenestraBookmarkBrowser({ bookmark }: { bookmark: Bookmark }) {
  const { getBrowserSessionUrl, rememberBrowserSession } = useAppStore();
  const hostRef = useRef<HTMLDivElement>(null);
  const guestIdRef = useRef<string | null>(null);
  const initialUrl = getBrowserSessionUrl(bookmark.id, bookmark.url);
  const [currentUrl, setCurrentUrl] = useState(initialUrl);
  const [isLoading, setIsLoading] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [isSecure, setIsSecure] = useState(initialUrl.startsWith("https://"));
  const [blockPopups, setBlockPopups] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useLayoutEffect(() => {
    const guestApi = window.fenestra?.guest;
    const host = hostRef.current;
    if (!guestApi || !host) return;

    let cancelled = false;
    const guestId = `limbo-browser-${bookmark.id}`;
    guestIdRef.current = guestId;

    const syncBounds = async () => {
      const rect = host.getBoundingClientRect();
      await guestApi.setBounds(guestId, {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height)),
      });
    };

    void (async () => {
      try {
        await guestApi.create({
          id: guestId,
          url: initialUrl,
          partition: "persist:limbo",
          popupPolicy: blockPopups ? "deny" : "navigateSame",
          bounds: { x: 0, y: 0, width: 1, height: 1 },
          visible: true,
        });
        if (cancelled) {
          await guestApi.destroy(guestId);
          return;
        }
        await syncBounds();
      } catch (createError) {
        if (!cancelled) {
          setError(createError instanceof Error ? createError.message : "Failed to create browser");
        }
      }
    })();

    const resizeObserver = new ResizeObserver(() => {
      void syncBounds();
    });
    resizeObserver.observe(host);
    window.addEventListener("resize", syncBounds);

    const unlistenNavigated = window.fenestra?.bridge.listen("guest.navigated", (payload) => {
      const data = payload as { id?: string; url?: string; canGoBack?: boolean; canGoForward?: boolean };
      if (data.id !== guestId) return;
      if (data.url?.startsWith("magnet:")) {
        navigator.clipboard.writeText(data.url).catch(() => undefined);
        return;
      }
      if (data.url) {
        setCurrentUrl(data.url);
        setIsSecure(data.url.startsWith("https://"));
        rememberBrowserSession(bookmark.id, data.url);
      }
      setCanGoBack(Boolean(data.canGoBack));
      setCanGoForward(Boolean(data.canGoForward));
      setIsLoading(false);
      setError(null);
    });

    const unlistenLoading = window.fenestra?.bridge.listen("guest.loading", (payload) => {
      const data = payload as { id?: string; isLoading?: boolean };
      if (data.id !== guestId) return;
      setIsLoading(Boolean(data.isLoading));
    });

    return () => {
      cancelled = true;
      resizeObserver.disconnect();
      window.removeEventListener("resize", syncBounds);
      unlistenNavigated?.();
      unlistenLoading?.();
      void guestApi.destroy(guestId);
      guestIdRef.current = null;
    };
  }, [bookmark.id, bookmark.url, blockPopups, initialUrl, rememberBrowserSession]);

  const guestId = () => guestIdRef.current;

  const handleUrlSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const id = guestId();
    if (!id || !window.fenestra?.guest) return;
    let nextUrl = currentUrl.trim();
    if (!nextUrl.startsWith("http://") && !nextUrl.startsWith("https://")) {
      nextUrl = `https://${nextUrl}`;
    }
    void window.fenestra.guest.navigate(id, nextUrl);
    setCurrentUrl(nextUrl);
    setIsSecure(nextUrl.startsWith("https://"));
    rememberBrowserSession(bookmark.id, nextUrl);
  };

  return (
    <BrowserChrome
      currentUrl={currentUrl}
      setCurrentUrl={setCurrentUrl}
      isLoading={isLoading}
      canGoBack={canGoBack}
      canGoForward={canGoForward}
      isSecure={isSecure}
      blockPopups={blockPopups}
      setBlockPopups={setBlockPopups}
      error={error}
      onGoBack={() => {
        const id = guestId();
        if (id) void window.fenestra?.guest?.goBack(id);
      }}
      onGoForward={() => {
        const id = guestId();
        if (id) void window.fenestra?.guest?.goForward(id);
      }}
      onReload={() => {
        const id = guestId();
        if (id) void window.fenestra?.guest?.reload(id);
      }}
      onHome={() => {
        const id = guestId();
        if (!id || !window.fenestra?.guest) return;
        void window.fenestra.guest.navigate(id, bookmark.url);
        setCurrentUrl(bookmark.url);
        setIsSecure(bookmark.url.startsWith("https://"));
        rememberBrowserSession(bookmark.id, bookmark.url);
        setError(null);
      }}
      onUrlSubmit={handleUrlSubmit}
      onOpenExternal={() => {
        if (currentUrl && window.limbo) {
          window.limbo.openExternal(currentUrl).catch(() => undefined);
        }
      }}
    >
      <div ref={hostRef} className="flex-1 w-full min-h-0 bg-neutral-950" />
    </BrowserChrome>
  );
}

function ElectronBookmarkBrowser({ bookmark }: { bookmark: Bookmark }) {
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

  return (
    <BrowserChrome
      currentUrl={currentUrl}
      setCurrentUrl={setCurrentUrl}
      isLoading={isLoading}
      canGoBack={canGoBack}
      canGoForward={canGoForward}
      isSecure={isSecure}
      blockPopups={blockPopups}
      setBlockPopups={setBlockPopups}
      error={error}
      onGoBack={() => webviewRef.current?.goBack()}
      onGoForward={() => webviewRef.current?.goForward()}
      onReload={() => webviewRef.current?.reload()}
      onHome={() => {
        if (webviewRef.current) {
          webviewRef.current.src = bookmark.url;
          setCurrentUrl(bookmark.url);
          setIsSecure(bookmark.url.startsWith("https://"));
          rememberBrowserSession(bookmark.id, bookmark.url);
          setError(null);
        }
      }}
      onUrlSubmit={handleUrlSubmit}
      onOpenExternal={() => {
        if (currentUrl && window.limbo) {
          window.limbo.openExternal(currentUrl).catch(() => undefined);
        }
      }}
    >
      <webview
        ref={webviewRef}
        src={initialUrl}
        className="flex-1 w-full"
        partition="persist:limbo"
        allowpopups={true}
        webpreferences="javascript=yes"
      />
    </BrowserChrome>
  );
}
