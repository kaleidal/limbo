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
} from "lucide-react";
import { Input } from "@/components/ui/input";
import type { ElectronWebviewElement } from "@/types/electron.d";

export function BrowserView() {
  const { activeBookmark } = useAppStore();
  const webviewRef = useRef<ElectronWebviewElement>(null);
  const [currentUrl, setCurrentUrl] = useState(activeBookmark?.url || "");
  const [isLoading, setIsLoading] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [isSecure, setIsSecure] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (activeBookmark) {
      setCurrentUrl(activeBookmark.url);
      setError(null);
    }
  }, [activeBookmark]);

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
      } catch (e) {
        // Webview not ready
      }
    };
    const handleDidNavigate = (e: any) => {
      setCurrentUrl(e.url);
      setIsSecure(e.url.startsWith("https://"));
    };
    const handleDidNavigateInPage = (e: any) => {
      setCurrentUrl(e.url);
    };
    const handleDidFailLoad = (e: any) => {
      if (e.errorCode !== -3) { // Ignore ERR_ABORTED
        setError(`Failed to load: ${e.errorDescription || 'Unknown error'}`);
      }
      setIsLoading(false);
    };

    // Intercept magnet links - copy to clipboard so clipboard monitor handles it
    const handleWillNavigate = (e: any) => {
      if (e.url && e.url.startsWith('magnet:')) {
        e.preventDefault?.();
        // Copy to clipboard - the clipboard monitor will detect it
        navigator.clipboard.writeText(e.url).catch(() => {});
      }
    };

    // Also intercept new-window events for magnet links
    const handleNewWindow = (e: any) => {
      if (e.url && e.url.startsWith('magnet:')) {
        e.preventDefault?.();
        navigator.clipboard.writeText(e.url).catch(() => {});
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
  }, []);

  const handleGoBack = () => webviewRef.current?.goBack();
  const handleGoForward = () => webviewRef.current?.goForward();
  const handleReload = () => webviewRef.current?.reload();
  const handleHome = () => {
    if (activeBookmark && webviewRef.current) {
      webviewRef.current.src = activeBookmark.url;
    }
  };

  const handleUrlSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (webviewRef.current) {
      let url = currentUrl;
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        url = "https://" + url;
      }
      webviewRef.current.src = url;
    }
  };

  const handleOpenExternal = () => {
    if (currentUrl) {
      window.open(currentUrl, "_blank");
    }
  };

  if (!activeBookmark) {
    return (
      <div className="h-full flex items-center justify-center text-neutral-500">
        <p>Select a site from the sidebar to browse</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-neutral-950">
      {/* Browser toolbar */}
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
              onChange={(e) => setCurrentUrl(e.target.value)}
              className="pl-10 bg-neutral-800 border-neutral-700 text-sm"
              placeholder="Enter URL..."
            />
          </div>
        </form>

        <button
          onClick={handleOpenExternal}
          className="p-2 hover:bg-neutral-800 rounded transition-colors"
          title="Open in external browser"
        >
          <ExternalLink className="w-4 h-4" />
        </button>
      </div>

      {/* Error display */}
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

      {/* Webview */}
      <webview
        ref={webviewRef}
        src={activeBookmark.url}
        className="flex-1 w-full"
        partition="persist:limbo"
        // @ts-ignore - webview attributes
        allowpopups="true"
        // @ts-ignore
        webpreferences="javascript=yes"
      />
    </div>
  );
}
