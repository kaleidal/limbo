import { useState, useEffect, useCallback, memo } from "react";
import { useAppStore } from "@/store/app-store";
import {
  Download,
  Pause,
  Play,
  X,
  Trash2,
  Link,
  Magnet,
  CheckCircle,
  AlertCircle,
  Clock,
  FolderOpen,
  ArrowUp,
  ArrowDown,
  Users,
  Loader2,
  Archive,
  Shield,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { TorrentInfo } from "@/types/electron.d";

export function DownloadsView() {
  const { downloads, torrents, setTorrents, updateTorrent, updateDownload } = useAppStore();
  const [activeTab, setActiveTab] = useState<"downloads" | "torrents">("downloads");
  const [urlInput, setUrlInput] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const [vpnWarning, setVpnWarning] = useState(false);

  // Listen for switch-to-torrents event from clipboard monitor
  useEffect(() => {
    const handleSwitchToTorrents = () => {
      setActiveTab("torrents");
    };
    
    const handleVpnRequired = () => {
      setVpnWarning(true);
    };
    
    window.addEventListener("switch-to-torrents", handleSwitchToTorrents);
    window.addEventListener("vpn-required", handleVpnRequired);
    return () => {
      window.removeEventListener("switch-to-torrents", handleSwitchToTorrents);
      window.removeEventListener("vpn-required", handleVpnRequired);
    };
  }, []);

  const formatSize = useCallback((bytes: number) => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }, []);

  const formatSpeed = useCallback((bytesPerSecond: number) => {
    return formatSize(bytesPerSecond) + "/s";
  }, [formatSize]);

  const formatEta = useCallback((seconds: number) => {
    if (!seconds || seconds <= 0 || !isFinite(seconds)) return "--";
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600) {
      const mins = Math.floor(seconds / 60);
      const secs = Math.round(seconds % 60);
      return `${mins}m ${secs}s`;
    }
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${mins}m`;
  }, []);

  const getProgress = useCallback((downloaded: number, total: number) => {
    if (total === 0) return 0;
    return Math.round((downloaded / total) * 100);
  }, []);

  const getStatusIcon = useCallback((status: string) => {
    switch (status) {
      case "downloading":
        return <Download className="w-4 h-4 text-lime-500 animate-pulse" />;
      case "extracting":
        return <Archive className="w-4 h-4 text-purple-500 animate-pulse" />;
      case "paused":
        return <Pause className="w-4 h-4 text-yellow-500" />;
      case "completed":
        return <CheckCircle className="w-4 h-4 text-green-500" />;
      case "error":
        return <AlertCircle className="w-4 h-4 text-red-500" />;
      case "pending":
        return <Clock className="w-4 h-4 text-neutral-500" />;
      case "seeding":
        return <ArrowUp className="w-4 h-4 text-blue-500" />;
      default:
        return <Download className="w-4 h-4" />;
    }
  }, []);

  const handleStartDownload = useCallback(async () => {
    if (!urlInput.trim() || !window.limbo || isAdding) return;
    
    setIsAdding(true);
    setVpnWarning(false);
    try {
      // Check if it's a magnet link
      if (urlInput.startsWith("magnet:")) {
        try {
          // Main process will emit `torrent-added` which App.tsx listens for.
          await window.limbo.addTorrent(urlInput);
          setActiveTab("torrents");
          setUrlInput("");
        } catch (err: any) {
          if (err?.message?.includes("VPN_REQUIRED")) {
            setVpnWarning(true);
          } else {
            console.error("Failed to add torrent:", err);
          }
        }
      } else {
        await window.limbo.startDownload(urlInput);
        setUrlInput("");
      }
    } finally {
      setIsAdding(false);
    }
  }, [urlInput, isAdding]);

  const handlePause = useCallback(async (id: string) => {
    if (window.limbo) {
      // Optimistic UI update
      updateDownload(id, { status: "paused" });
      await window.limbo.pauseDownload(id);
    }
  }, [updateDownload]);

  const handleResume = useCallback(async (id: string) => {
    if (window.limbo) {
      // Optimistic UI update
      updateDownload(id, { status: "downloading" });
      await window.limbo.resumeDownload(id);
    }
  }, [updateDownload]);

  const handleCancel = useCallback(async (id: string) => {
    if (window.limbo) {
      const updated = await window.limbo.cancelDownload(id);
      useAppStore.getState().setDownloads(updated);
    }
  }, []);

  const handleClearCompleted = useCallback(async () => {
    if (window.limbo) {
      const updated = await window.limbo.clearCompletedDownloads();
      useAppStore.getState().setDownloads(updated);
    }
  }, []);

  const handleOpenLocation = useCallback(async (path: string) => {
    if (window.limbo) {
      await window.limbo.openFileLocation(path);
    }
  }, []);

  // Torrent handlers
  const handlePauseTorrent = useCallback(async (id: string) => {
    if (window.limbo) {
      await window.limbo.pauseTorrent(id);
      updateTorrent(id, { status: "paused" });
    }
  }, [updateTorrent]);

  const handleResumeTorrent = useCallback(async (id: string) => {
    if (window.limbo) {
      await window.limbo.resumeTorrent(id);
      updateTorrent(id, { status: "downloading" });
    }
  }, [updateTorrent]);

  const handleRemoveTorrent = useCallback(async (id: string, deleteFiles: boolean = false) => {
    if (window.limbo) {
      const updated = await window.limbo.removeTorrent(id, deleteFiles);
      setTorrents(updated);
    }
  }, [setTorrents]);

  // Pause/Resume all handlers
  const handlePauseAll = useCallback(async () => {
    if (!window.limbo) return;
    if (activeTab === "downloads") {
      // Optimistic UI update for downloads
      downloads.forEach(d => {
        if (d.status === "downloading") {
          updateDownload(d.id, { status: "paused" });
        }
      });
      await window.limbo.pauseAllDownloads();
    } else {
      // Update local state for torrents
      torrents.forEach(t => {
        if (t.status === "downloading") {
          updateTorrent(t.id, { status: "paused" });
        }
      });
      await window.limbo.pauseAllTorrents();
    }
  }, [activeTab, downloads, torrents, updateDownload, updateTorrent]);

  const handleResumeAll = useCallback(async () => {
    if (!window.limbo) return;
    if (activeTab === "downloads") {
      // Optimistic UI update for downloads
      downloads.forEach(d => {
        if (d.status === "paused") {
          updateDownload(d.id, { status: "downloading" });
        }
      });
      await window.limbo.resumeAllDownloads();
    } else {
      // Update local state for torrents
      torrents.forEach(t => {
        if (t.status === "paused") {
          updateTorrent(t.id, { status: "downloading" });
        }
      });
      await window.limbo.resumeAllTorrents();
    }
  }, [activeTab, downloads, torrents, updateDownload, updateTorrent]);

  const activeDownloads = downloads.filter(
    (d) => d.status === "downloading" || d.status === "pending" || d.status === "extracting" || d.status === "paused"
  );
  const completedDownloads = downloads.filter(
    (d) => d.status === "completed" || d.status === "error"
  );

  const activeTorrents = torrents.filter(
    (t) => t.status === "downloading" || t.status === "paused"
  );
  const completedTorrents = torrents.filter(
    (t) => t.status === "completed" || t.status === "seeding"
  );

  return (
    <div className="h-full flex flex-col p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Downloads</h1>
        <div className="flex items-center gap-2">
          <Button
            variant={activeTab === "downloads" ? "default" : "outline"}
            onClick={() => setActiveTab("downloads")}
            size="sm"
          >
            <Link className="w-4 h-4 mr-2" />
            HTTP ({downloads.length})
          </Button>
          <Button
            variant={activeTab === "torrents" ? "default" : "outline"}
            onClick={() => setActiveTab("torrents")}
            size="sm"
          >
            <Magnet className="w-4 h-4 mr-2" />
            Torrents ({torrents.length})
          </Button>
        </div>
      </div>

      {/* Add download input */}
      <div className="flex gap-2 mb-4">
        <Input
          placeholder={
            activeTab === "downloads"
              ? "Enter download URL..."
              : "Enter magnet link..."
          }
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleStartDownload()}
          className="flex-1 bg-neutral-900 border-neutral-700"
        />
        <Button onClick={handleStartDownload} className="gap-2" disabled={isAdding || !urlInput.trim()}>
          {isAdding ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : urlInput.startsWith("magnet:") ? (
            <Magnet className="w-4 h-4" />
          ) : (
            <Download className="w-4 h-4" />
          )}
          {isAdding ? "Adding..." : "Add"}
        </Button>
      </div>

      {/* Pause/Resume all controls */}
      {((activeTab === "downloads" && activeDownloads.length > 0) ||
        (activeTab === "torrents" && activeTorrents.length > 0)) && (
        <div className="flex gap-2 mb-4">
          <Button
            variant="outline"
            size="sm"
            onClick={handlePauseAll}
            className="gap-2"
          >
            <Pause className="w-4 h-4" />
            Pause All
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleResumeAll}
            className="gap-2"
          >
            <Play className="w-4 h-4" />
            Resume All
          </Button>
        </div>
      )}

      {/* VPN Warning Banner */}
      {vpnWarning && (
        <div className="flex items-center gap-3 p-4 mb-4 bg-amber-500/10 border border-amber-500/30 rounded-lg">
          <Shield className="w-5 h-5 text-amber-500 shrink-0" />
          <div className="flex-1">
            <p className="font-medium text-amber-500">VPN Required</p>
            <p className="text-sm text-neutral-400">
              Torrent downloads are blocked because no VPN was detected. Connect to a VPN and try again, 
              or disable this check in Settings &gt; Torrent Settings.
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setVpnWarning(false)}
            className="text-neutral-400 hover:text-white"
          >
            <X className="w-4 h-4" />
          </Button>
        </div>
      )}

      {activeTab === "downloads" ? (
        <div className="flex-1 overflow-auto space-y-6">
          {/* Active downloads */}
          {activeDownloads.length > 0 && (
            <div>
              <h2 className="text-sm font-medium text-neutral-400 mb-3">
                Active ({activeDownloads.length})
              </h2>
              <div className="space-y-2">
                {activeDownloads.map((download) => (
                  <DownloadItem
                    key={download.id}
                    download={download}
                    onPause={handlePause}
                    onResume={handleResume}
                    onCancel={handleCancel}
                    onOpenLocation={handleOpenLocation}
                    formatSize={formatSize}
                    formatEta={formatEta}
                    getProgress={getProgress}
                    getStatusIcon={getStatusIcon}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Completed downloads */}
          {completedDownloads.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-medium text-neutral-400">
                  Completed ({completedDownloads.length})
                </h2>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleClearCompleted}
                  className="text-neutral-500 hover:text-white"
                >
                  <Trash2 className="w-4 h-4 mr-2" />
                  Clear
                </Button>
              </div>
              <div className="space-y-2">
                {completedDownloads.map((download) => (
                  <DownloadItem
                    key={download.id}
                    download={download}
                    onPause={handlePause}
                    onResume={handleResume}
                    onCancel={handleCancel}
                    onOpenLocation={handleOpenLocation}
                    formatSize={formatSize}
                    formatEta={formatEta}
                    getProgress={getProgress}
                    getStatusIcon={getStatusIcon}
                  />
                ))}
              </div>
            </div>
          )}

          {downloads.length === 0 && (
            <div className="flex-1 flex flex-col items-center justify-center text-neutral-500 py-20">
              <Download className="w-16 h-16 mb-4" />
              <p className="text-lg">No downloads yet</p>
              <p className="text-sm">
                Add a URL above or browse a site to start downloading
              </p>
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 overflow-auto space-y-6">
          {/* Active torrents */}
          {activeTorrents.length > 0 && (
            <div>
              <h2 className="text-sm font-medium text-neutral-400 mb-3">
                Active ({activeTorrents.length})
              </h2>
              <div className="space-y-2">
                {activeTorrents.map((torrent) => (
                  <TorrentItem
                    key={torrent.id}
                    torrent={torrent}
                    onPause={handlePauseTorrent}
                    onResume={handleResumeTorrent}
                    onRemove={handleRemoveTorrent}
                    onOpenLocation={handleOpenLocation}
                    formatSize={formatSize}
                    formatSpeed={formatSpeed}
                    formatEta={formatEta}
                    getStatusIcon={getStatusIcon}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Completed torrents */}
          {completedTorrents.length > 0 && (
            <div>
              <h2 className="text-sm font-medium text-neutral-400 mb-3">
                Completed ({completedTorrents.length})
              </h2>
              <div className="space-y-2">
                {completedTorrents.map((torrent) => (
                  <TorrentItem
                    key={torrent.id}
                    torrent={torrent}
                    onPause={handlePauseTorrent}
                    onResume={handleResumeTorrent}
                    onRemove={handleRemoveTorrent}
                    onOpenLocation={handleOpenLocation}
                    formatSize={formatSize}
                    formatSpeed={formatSpeed}
                    formatEta={formatEta}
                    getStatusIcon={getStatusIcon}
                  />
                ))}
              </div>
            </div>
          )}

          {torrents.length === 0 && (
            <div className="flex flex-col items-center justify-center text-neutral-500 py-20">
              <Magnet className="w-16 h-16 mb-4" />
              <p className="text-lg">No active torrents</p>
              <p className="text-sm">Add a magnet link above to start downloading</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const DownloadItem = memo(function DownloadItem({
  download,
  onPause,
  onResume,
  onCancel,
  onOpenLocation,
  formatSize,
  formatEta,
  getProgress,
  getStatusIcon,
}: {
  download: any;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onCancel: (id: string) => void;
  onOpenLocation: (path: string) => void;
  formatSize: (bytes: number) => string;
  formatEta: (seconds: number) => string;
  getProgress: (downloaded: number, total: number) => number;
  getStatusIcon: (status: string) => React.ReactNode;
}) {
  const progress = getProgress(download.downloaded, download.size);

  const displayFilename = (() => {
    const name = String(download.filename || "");
    const partMatch = name.match(/^(.+)\.part\d+\.rar$/i);
    if (partMatch) return `${partMatch[1]}.rar`;
    const oldStyleMatch = name.match(/^(.+)\.r\d{2,}$/i);
    if (oldStyleMatch) return `${oldStyleMatch[1]}.rar`;
    return name;
  })();
  
  // Calculate speed and ETA - show 0 when paused
  const speed = download.status === "paused" ? 0 : (download.speed || 0);
  const remaining = download.size - download.downloaded;
  const eta = speed > 0 ? remaining / speed : 0;

  return (
    <div className="bg-neutral-900 rounded-lg p-4 border border-neutral-800">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          {getStatusIcon(download.status)}
          <span className="font-medium truncate" title={displayFilename}>
            {displayFilename}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {download.status === "downloading" && (
            <button
              onClick={() => onPause(download.id)}
              className="p-1.5 hover:bg-neutral-700 rounded transition-colors"
              title="Pause"
            >
              <Pause className="w-4 h-4" />
            </button>
          )}
          {download.status === "paused" && (
            <button
              onClick={() => onResume(download.id)}
              className="p-1.5 hover:bg-neutral-700 rounded transition-colors"
              title="Resume"
            >
              <Play className="w-4 h-4" />
            </button>
          )}
          {download.status === "completed" && (
            <button
              onClick={() => onOpenLocation(download.path)}
              className="p-1.5 hover:bg-neutral-700 rounded transition-colors"
              title="Open folder"
            >
              <FolderOpen className="w-4 h-4" />
            </button>
          )}
          {(download.status === "downloading" || download.status === "paused") && (
            <button
              onClick={() => onCancel(download.id)}
              className="p-1.5 hover:bg-red-500/20 text-red-500 rounded transition-colors"
              title="Cancel"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
      <div className="flex items-center gap-4">
        <div className="flex-1 h-2 bg-neutral-800 rounded-full overflow-hidden">
          <div
            className={cn(
              "h-full transition-all",
              download.status === "error" ? "bg-red-500" : 
              download.status === "extracting" ? "bg-purple-500" : "bg-lime-500"
            )}
            style={{ 
              width: download.status === "extracting" 
                ? `${Math.max(0, download.extractProgress || 0)}%` 
                : `${progress}%` 
            }}
          />
        </div>
        <span className="text-sm text-neutral-400 w-12 text-right">
          {download.status === "extracting" 
            ? `${Math.max(0, download.extractProgress || 0)}%` 
            : `${progress}%`}
        </span>
      </div>
      <div className="flex items-center justify-between mt-2 text-xs text-neutral-500">
        <span>
          {download.status === "extracting" 
            ? (download.extractStatus || "Extracting...") 
            : `${formatSize(download.downloaded)} / ${formatSize(download.size)}`}
        </span>
        <div className="flex items-center gap-3">
          {download.status === "downloading" && eta > 0 && (
            <span>ETA: {formatEta(eta)}</span>
          )}
          {download.status === "downloading" && <span>{formatSize(speed)}/s</span>}
          {download.status === "paused" && <span className="text-yellow-500">Paused</span>}
        </div>
      </div>
    </div>
  );
});

const TorrentItem = memo(function TorrentItem({
  torrent,
  onPause,
  onResume,
  onRemove,
  onOpenLocation,
  formatSize,
  formatSpeed,
  formatEta,
  getStatusIcon,
}: {
  torrent: TorrentInfo;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onRemove: (id: string, deleteFiles: boolean) => void;
  onOpenLocation: (path: string) => void;
  formatSize: (bytes: number) => string;
  formatSpeed: (bytes: number) => string;
  formatEta: (seconds: number) => string;
  getStatusIcon: (status: string) => React.ReactNode;
}) {
  const progress = Math.round(torrent.progress * 100);
  
  // Show 0 speed when paused
  const dlSpeed = torrent.status === "paused" ? 0 : torrent.downloadSpeed;
  const ulSpeed = torrent.status === "paused" ? 0 : torrent.uploadSpeed;
  const remaining = torrent.size - torrent.downloaded;
  const eta = dlSpeed > 0 ? remaining / dlSpeed : 0;

  return (
    <div className="bg-neutral-900 rounded-lg p-4 border border-neutral-800">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          {getStatusIcon(torrent.status)}
          <span className="font-medium truncate" title={torrent.name}>
            {torrent.name}
          </span>
        </div>
        <div className="flex items-center gap-4 text-sm text-neutral-400">
          <div className="flex items-center gap-1">
            <ArrowDown className="w-3 h-3 text-lime-500" />
            <span>{formatSpeed(dlSpeed)}</span>
          </div>
          <div className="flex items-center gap-1">
            <ArrowUp className="w-3 h-3 text-blue-500" />
            <span>{formatSpeed(ulSpeed)}</span>
          </div>
          <div className="flex items-center gap-1">
            <Users className="w-3 h-3" />
            <span>{torrent.status === "paused" ? 0 : torrent.peers}</span>
          </div>
          {torrent.status === "downloading" && eta > 0 && (
            <span className="text-neutral-500">ETA: {formatEta(eta)}</span>
          )}
        </div>
        <div className="flex items-center gap-2 ml-4">
          {torrent.status === "downloading" && (
            <button
              onClick={() => onPause(torrent.id)}
              className="p-1.5 hover:bg-neutral-700 rounded transition-colors"
              title="Pause"
            >
              <Pause className="w-4 h-4" />
            </button>
          )}
          {torrent.status === "paused" && (
            <button
              onClick={() => onResume(torrent.id)}
              className="p-1.5 hover:bg-neutral-700 rounded transition-colors"
              title="Resume"
            >
              <Play className="w-4 h-4" />
            </button>
          )}
          {(torrent.status === "completed" || torrent.status === "seeding") && (
            <button
              onClick={() => onOpenLocation(torrent.path)}
              className="p-1.5 hover:bg-neutral-700 rounded transition-colors"
              title="Open folder"
            >
              <FolderOpen className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={() => onRemove(torrent.id, false)}
            className="p-1.5 hover:bg-red-500/20 text-red-500 rounded transition-colors"
            title="Remove"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
      <div className="flex items-center gap-4">
        <div className="flex-1 h-2 bg-neutral-800 rounded-full overflow-hidden">
          <div
            className={cn(
              "h-full transition-all",
              torrent.status === "error"
                ? "bg-red-500"
                : torrent.status === "seeding"
                ? "bg-blue-500"
                : "bg-lime-500"
            )}
            style={{ width: `${progress}%` }}
          />
        </div>
        <span className="text-sm text-neutral-400 w-12 text-right">
          {progress}%
        </span>
      </div>
      <div className="flex items-center justify-between mt-2 text-xs text-neutral-500">
        <span>
          {formatSize(torrent.downloaded)} / {formatSize(torrent.size)}
        </span>
        <span>Uploaded: {formatSize(torrent.uploaded)}</span>
      </div>
    </div>
  );
});
