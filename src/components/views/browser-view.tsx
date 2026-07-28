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
import type { Bookmark } from "@/types/electron.d";

export function BrowserView() {
  const { activeBookmark, clearExpiredBrowserSessions } = useAppStore();

  useEffect(() => {
    clearExpiredBrowserSessions();
  }, [clearExpiredBrowserSessions]);

  if (!activeBookmark) {
    return (
      <div className="flex h-full items-center justify-center bg-neutral-950 text-neutral-500">
        <p>Select a site from the sidebar to browse</p>
      </div>
    );
  }

  return <GuestBookmarkBrowser key={activeBookmark.id} bookmark={activeBookmark} />;
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
    <div className="flex h-full flex-col bg-transparent">
      <div className="flex items-center gap-2 border-b border-neutral-800 bg-neutral-900 p-2">
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

function GuestBookmarkBrowser({ bookmark }: { bookmark: Bookmark }) {
  const { getBrowserSessionUrl, rememberBrowserSession, guestOcclusionDepth } = useAppStore();
  const hostRef = useRef<HTMLDivElement>(null);
  const guestIdRef = useRef<string | null>(null);
  const guestReadyRef = useRef(false);
  const guestEpochRef = useRef(0);
  const blockPopupsRef = useRef(false);
  const startUrl = getBrowserSessionUrl(bookmark.id, bookmark.url);
  const [currentUrl, setCurrentUrl] = useState(startUrl);
  const [isLoading, setIsLoading] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [isSecure, setIsSecure] = useState(startUrl.startsWith("https://"));
  const [blockPopups, setBlockPopups] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [coverBackdrop, setCoverBackdrop] = useState<string | null>(null);

  blockPopupsRef.current = blockPopups;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (guestOcclusionDepth <= 0) {
        setCoverBackdrop(null);
        await window.fenestra?.guest?.setCovered?.(false).catch(() => undefined);
        return;
      }
      const id = guestIdRef.current;
      const guestApi = window.fenestra?.guest;
      if (id && guestApi?.capturePreview) {
        try {
          const result = (await guestApi.capturePreview(id)) as { dataUrl?: string };
          if (!cancelled && result?.dataUrl) {
            setCoverBackdrop(result.dataUrl);
          }
        } catch {
          // Still cover so the modal is usable even if the snapshot fails.
        }
      }
      if (!cancelled) {
        await guestApi?.setCovered?.(true).catch(() => undefined);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [guestOcclusionDepth]);

  useLayoutEffect(() => {
    const guestApi = window.fenestra?.guest;
    const host = hostRef.current;
    if (!guestApi || !host) {
      setError("Guest browser unavailable");
      return;
    }

    const epoch = ++guestEpochRef.current;
    const guestId = `limbo-browser-${bookmark.id}-${epoch}`;
    const url = getBrowserSessionUrl(bookmark.id, bookmark.url);
    guestReadyRef.current = false;
    guestIdRef.current = null;

    const isCurrent = () => guestEpochRef.current === epoch;

    const syncBounds = async () => {
      if (!isCurrent() || !guestReadyRef.current || guestIdRef.current !== guestId) return;
      const rect = host.getBoundingClientRect();
      try {
        await guestApi.setBounds(guestId, {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.max(1, Math.round(rect.width)),
          height: Math.max(1, Math.round(rect.height)),
        });
      } catch {
        // Guest may have been destroyed during teardown/remount.
      }
    };

    const resizeObserver = new ResizeObserver(() => {
      void syncBounds();
    });
    resizeObserver.observe(host);
    window.addEventListener("resize", syncBounds);

    const unlistenNavigated = window.fenestra?.bridge.listen("guest.navigated", (payload) => {
      const data = payload as {
        id?: string;
        url?: string;
        canGoBack?: boolean;
        canGoForward?: boolean;
      };
      if (!isCurrent() || data.id !== guestId) return;
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
      if (!isCurrent() || data.id !== guestId) return;
      setIsLoading(Boolean(data.isLoading));
    });

    void (async () => {
      try {
        const rect = host.getBoundingClientRect();
        await guestApi.create({
          id: guestId,
          url,
          partition: "persist:limbo",
          popupPolicy: blockPopupsRef.current ? "deny" : "navigateSame",
          bounds: {
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.max(1, Math.round(rect.width)),
            height: Math.max(1, Math.round(rect.height)),
          },
          visible: true,
          backgroundColor: "#0a0a0a",
        });
        // StrictMode / remount: a newer effect owns the slot — leave its guest alone.
        if (guestEpochRef.current !== epoch) return;
        guestIdRef.current = guestId;
        guestReadyRef.current = true;
        await syncBounds();
        if (useAppStore.getState().guestOcclusionDepth > 0) {
          try {
            const result = (await guestApi.capturePreview?.(guestId)) as
              | { dataUrl?: string }
              | undefined;
            if (guestEpochRef.current === epoch && result?.dataUrl) {
              setCoverBackdrop(result.dataUrl);
            }
          } catch {
            // Cover anyway.
          }
          await guestApi.setCovered?.(true).catch(() => undefined);
        } else {
          await guestApi.setCovered?.(false).catch(() => undefined);
        }
        setError(null);
      } catch (createError) {
        if (guestEpochRef.current === epoch) {
          setError(createError instanceof Error ? createError.message : "Failed to create browser");
        }
      }
    })();

    return () => {
      if (guestEpochRef.current === epoch) {
        guestEpochRef.current += 1;
      }
      if (guestIdRef.current === guestId) {
        guestReadyRef.current = false;
        guestIdRef.current = null;
      }
      resizeObserver.disconnect();
      window.removeEventListener("resize", syncBounds);
      unlistenNavigated?.();
      unlistenLoading?.();
      void guestApi.destroy(guestId).catch(() => undefined);
    };
  }, [bookmark.id, bookmark.url, getBrowserSessionUrl, rememberBrowserSession]);

  const guestId = () => (guestReadyRef.current ? guestIdRef.current : null);

  const handleUrlSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const id = guestId();
    if (!id || !window.fenestra?.guest) return;
    let nextUrl = currentUrl.trim();
    if (!nextUrl.startsWith("http://") && !nextUrl.startsWith("https://")) {
      nextUrl = `https://${nextUrl}`;
    }
    void window.fenestra.guest.navigate(id, nextUrl).catch(() => undefined);
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
        if (id) void window.fenestra?.guest?.goBack(id).catch(() => undefined);
      }}
      onGoForward={() => {
        const id = guestId();
        if (id) void window.fenestra?.guest?.goForward(id).catch(() => undefined);
      }}
      onReload={() => {
        const id = guestId();
        if (id) void window.fenestra?.guest?.reload(id).catch(() => undefined);
      }}
      onHome={() => {
        const id = guestId();
        if (!id || !window.fenestra?.guest) return;
        void window.fenestra.guest.navigate(id, bookmark.url).catch(() => undefined);
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
      <div ref={hostRef} className="relative min-h-0 w-full flex-1 bg-transparent">
        {coverBackdrop ? (
          <img
            src={coverBackdrop}
            alt=""
            className="pointer-events-none absolute inset-0 h-full w-full object-cover"
            draggable={false}
          />
        ) : null}
      </div>
    </BrowserChrome>
  );
}
