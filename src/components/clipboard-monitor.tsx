import { useState, useEffect } from "react";
import { Download, X, Link, Magnet, Zap, AlertCircle, CheckCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/store/app-store";

export function ClipboardMonitor() {
  const [detectedUrls, setDetectedUrls] = useState<string[]>([]);
  const [isVisible, setIsVisible] = useState(false);
  const [debridAvailable, setDebridAvailable] = useState(false);
  const [torrentSupported, setTorrentSupported] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successCount, setSuccessCount] = useState(0);
  const { setCurrentView, setActiveBookmark, currentView } = useAppStore();

  useEffect(() => {
    if (!window.limbo) return;

    // Check debrid and torrent support
    const checkSupport = async () => {
      const [debrid, torrent] = await Promise.all([
        window.limbo.isDebridConfigured(),
        window.limbo.isTorrentSupported(),
      ]);
      setDebridAvailable(debrid);
      setTorrentSupported(torrent);
    };
    checkSupport();

    // Listen for clipboard detections from main process (now receives array)
    const unsubClipboard = window.limbo.onClipboardDownloadDetected((urls: string[]) => {
      // Don't show if we're already in browser view viewing a site (let browser handle magnets)
      if (currentView === "browser") {
        // Only show for non-magnet links when in browser
        const nonMagnetUrls = urls.filter(u => !u.startsWith("magnet:"));
        if (nonMagnetUrls.length > 0) {
          setDetectedUrls(nonMagnetUrls);
          setIsVisible(true);
          setError(null);
          setSuccessCount(0);
        }
      } else {
        setDetectedUrls(urls);
        setIsVisible(true);
        setError(null);
        setSuccessCount(0);
      }
      
      // Auto-hide after 20 seconds
      setTimeout(() => {
        setIsVisible(false);
      }, 20000);
    });

    // Listen for magnet links opened from OS (always show these)
    const unsubMagnet = window.limbo.onMagnetLinkOpened((magnetUri: string) => {
      setDetectedUrls([magnetUri]);
      setIsVisible(true);
      setError(null);
      setSuccessCount(0);
    });

    return () => {
      unsubClipboard();
      unsubMagnet();
    };
  }, [currentView]);

  const handleDownloadAll = async (useDebrid: boolean) => {
    if (!detectedUrls.length || !window.limbo) return;
    setIsProcessing(true);
    setError(null);
    setSuccessCount(0);

    let completed = 0;
    const errors: string[] = [];

    for (const url of detectedUrls) {
      try {
        if (url.startsWith("magnet:")) {
          if (useDebrid && debridAvailable) {
            await window.limbo.convertMagnetDebrid(url);
          } else if (torrentSupported) {
            await window.limbo.addTorrent(url);
          } else {
            errors.push("Torrent support unavailable");
            continue;
          }
        } else {
          await window.limbo.startDownload(url);
        }
        completed++;
        setSuccessCount(completed);
      } catch (err: any) {
        // Parse error message for user-friendly display
        const errMsg = err?.message || "Download failed";
        if (errMsg.includes("VPN_REQUIRED")) {
          errors.push("VPN required for torrents. Enable VPN or disable check in Settings.");
        } else if (errMsg.includes("Error invoking remote method")) {
          // Extract the actual error from IPC wrapper
          const match = errMsg.match(/Error invoking remote method '[^']+': (.+)/);
          errors.push(match?.[1] || errMsg);
        } else {
          errors.push(errMsg);
        }
      }
    }

    setIsProcessing(false);

    if (completed > 0) {
      setActiveBookmark(null);
      // Switch to downloads view
      setCurrentView("downloads");
      
      // If any URLs were magnets and not using debrid, trigger switch to torrents tab
      // Use a timeout to ensure the DownloadsView is mounted first
      const hasMagnets = detectedUrls.some(u => u.startsWith("magnet:"));
      if (hasMagnets && !useDebrid) {
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent('switch-to-torrents'));
        }, 100);
      }
      
      // Hide after short delay on success
      setTimeout(() => {
        setIsVisible(false);
        setDetectedUrls([]);
      }, 1500);
    }

    if (errors.length > 0) {
      setError(`${errors.length} failed: ${errors[0]}`);
    }
  };

  const handleDismiss = () => {
    setIsVisible(false);
    setDetectedUrls([]);
    setError(null);
  };

  if (!isVisible || detectedUrls.length === 0) return null;

  const magnetCount = detectedUrls.filter(u => u.startsWith("magnet:")).length;
  const linkCount = detectedUrls.length - magnetCount;
  
  const getDisplayText = () => {
    if (detectedUrls.length === 1) {
      const url = detectedUrls[0];
      if (url.startsWith("magnet:")) {
        return decodeURIComponent(url.match(/dn=([^&]+)/)?.[1] || "Magnet Link");
      }
      return url.length > 50 ? url.substring(0, 50) + "..." : url;
    }
    
    const parts = [];
    if (magnetCount > 0) parts.push(`${magnetCount} magnet${magnetCount > 1 ? "s" : ""}`);
    if (linkCount > 0) parts.push(`${linkCount} link${linkCount > 1 ? "s" : ""}`);
    return parts.join(" + ");
  };

  const hasMagnets = magnetCount > 0;

  return (
    <div className="fixed bottom-4 right-4 z-50 animate-in slide-in-from-right-5 fade-in duration-300">
      <div className="bg-neutral-900 border border-neutral-700 rounded-lg shadow-xl p-4 w-80">
        <div className="flex items-start gap-3">
          <div className="p-2 bg-lime-500/20 rounded-lg shrink-0">
            {hasMagnets ? (
              <Magnet className="w-5 h-5 text-lime-500" />
            ) : (
              <Link className="w-5 h-5 text-lime-500" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-neutral-100">
              {detectedUrls.length === 1 
                ? (hasMagnets ? "Magnet Link Detected" : "Download Link Detected")
                : `${detectedUrls.length} Links Detected`}
            </p>
            <p className="text-xs text-neutral-400 truncate mt-1" title={detectedUrls.join("\n")}>
              {getDisplayText()}
            </p>
          </div>
          <button
            onClick={handleDismiss}
            className="p-1 hover:bg-neutral-800 rounded transition-colors shrink-0"
          >
            <X className="w-4 h-4 text-neutral-500" />
          </button>
        </div>

        {error && (
          <div className="flex items-center gap-2 mt-3 p-2 bg-red-950/50 border border-red-900/50 rounded text-red-400 text-xs">
            <AlertCircle className="w-3 h-3 shrink-0" />
            <span className="truncate">{error}</span>
          </div>
        )}

        {successCount > 0 && isProcessing && (
          <div className="flex items-center gap-2 mt-3 p-2 bg-lime-950/50 border border-lime-900/50 rounded text-lime-400 text-xs">
            <CheckCircle className="w-3 h-3 shrink-0" />
            <span>Started {successCount} of {detectedUrls.length}</span>
          </div>
        )}

        <div className="flex flex-col gap-2 mt-3">
          {/* Debrid option (preferred for magnets) */}
          {debridAvailable && (
            <Button
              onClick={() => handleDownloadAll(true)}
              disabled={isProcessing}
              size="sm"
              className="w-full gap-2 bg-gradient-to-r from-lime-600 to-green-600 hover:from-lime-500 hover:to-green-500"
            >
              <Zap className="w-4 h-4" />
              {isProcessing ? `Processing...` : `Download via Debrid${detectedUrls.length > 1 ? ` (${detectedUrls.length})` : ""}`}
            </Button>
          )}

          {/* Direct download option */}
          {(!hasMagnets || torrentSupported) && (
            <Button
              onClick={() => handleDownloadAll(false)}
              disabled={isProcessing}
              variant={debridAvailable ? "outline" : "default"}
              size="sm"
              className="w-full gap-2"
            >
              <Download className="w-4 h-4" />
              {isProcessing
                ? "Processing..."
                : hasMagnets
                ? `Download via Torrent${detectedUrls.length > 1 ? ` (${detectedUrls.length})` : ""}`
                : `Direct Download${detectedUrls.length > 1 ? ` (${detectedUrls.length})` : ""}`}
            </Button>
          )}

          {/* Show warning if no options available for magnet */}
          {hasMagnets && !torrentSupported && !debridAvailable && (
            <p className="text-xs text-amber-500 text-center">
              Configure a Debrid service in Settings to download magnet links
            </p>
          )}

          <Button onClick={handleDismiss} variant="ghost" size="sm" className="w-full">
            Dismiss
          </Button>
        </div>
      </div>
    </div>
  );
}
