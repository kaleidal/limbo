import { useState } from "react";
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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { TorrentInfo } from "@/types/electron.d";

export function DownloadsView() {
  const { downloads, torrents, setTorrents, addTorrent, updateTorrent } = useAppStore();
  const [activeTab, setActiveTab] = useState<"downloads" | "torrents">("downloads");
  const [urlInput, setUrlInput] = useState("");
  const [isAdding, setIsAdding] = useState(false);

  const formatSize = (bytes: number) => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  };

  const formatSpeed = (bytesPerSecond: number) => {
    return formatSize(bytesPerSecond) + "/s";
  };

  const getProgress = (downloaded: number, total: number) => {
    if (total === 0) return 0;
    return Math.round((downloaded / total) * 100);
  };

  const getStatusIcon = (status: string) => {
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
  };

  const handleStartDownload = async () => {
    if (!urlInput.trim() || !window.limbo || isAdding) return;
    
    setIsAdding(true);
    try {
      // Check if it's a magnet link
      if (urlInput.startsWith("magnet:")) {
        try {
          const torrent = await window.limbo.addTorrent(urlInput);
          addTorrent(torrent);
          setActiveTab("torrents");
        } catch (err) {
          console.error("Failed to add torrent:", err);
        }
      } else {
        await window.limbo.startDownload(urlInput);
      }
      setUrlInput("");
    } finally {
      setIsAdding(false);
    }
  };

  const handlePause = async (id: string) => {
    if (window.limbo) {
      await window.limbo.pauseDownload(id);
    }
  };

  const handleResume = async (id: string) => {
    if (window.limbo) {
      await window.limbo.resumeDownload(id);
    }
  };

  const handleCancel = async (id: string) => {
    if (window.limbo) {
      const updated = await window.limbo.cancelDownload(id);
      useAppStore.getState().setDownloads(updated);
    }
  };

  const handleClearCompleted = async () => {
    if (window.limbo) {
      const updated = await window.limbo.clearCompletedDownloads();
      useAppStore.getState().setDownloads(updated);
    }
  };

  const handleOpenLocation = async (path: string) => {
    if (window.limbo) {
      await window.limbo.openFileLocation(path);
    }
  };

  // Torrent handlers
  const handlePauseTorrent = async (id: string) => {
    if (window.limbo) {
      await window.limbo.pauseTorrent(id);
      updateTorrent(id, { status: "paused" });
    }
  };

  const handleResumeTorrent = async (id: string) => {
    if (window.limbo) {
      await window.limbo.resumeTorrent(id);
      updateTorrent(id, { status: "downloading" });
    }
  };

  const handleRemoveTorrent = async (id: string, deleteFiles: boolean = false) => {
    if (window.limbo) {
      const updated = await window.limbo.removeTorrent(id, deleteFiles);
      setTorrents(updated);
    }
  };

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
      <div className="flex gap-2 mb-6">
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

function DownloadItem({
  download,
  onPause,
  onResume,
  onCancel,
  onOpenLocation,
  formatSize,
  getProgress,
  getStatusIcon,
}: {
  download: any;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onCancel: (id: string) => void;
  onOpenLocation: (path: string) => void;
  formatSize: (bytes: number) => string;
  getProgress: (downloaded: number, total: number) => number;
  getStatusIcon: (status: string) => React.ReactNode;
}) {
  const progress = getProgress(download.downloaded, download.size);

  return (
    <div className="bg-neutral-900 rounded-lg p-4 border border-neutral-800">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          {getStatusIcon(download.status)}
          <span className="font-medium truncate" title={download.filename}>
            {download.filename}
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
        {download.speed && <span>{formatSize(download.speed)}/s</span>}
      </div>
    </div>
  );
}

function TorrentItem({
  torrent,
  onPause,
  onResume,
  onRemove,
  onOpenLocation,
  formatSize,
  formatSpeed,
  getStatusIcon,
}: {
  torrent: TorrentInfo;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onRemove: (id: string, deleteFiles: boolean) => void;
  onOpenLocation: (path: string) => void;
  formatSize: (bytes: number) => string;
  formatSpeed: (bytes: number) => string;
  getStatusIcon: (status: string) => React.ReactNode;
}) {
  const progress = Math.round(torrent.progress * 100);

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
            <span>{formatSpeed(torrent.downloadSpeed)}</span>
          </div>
          <div className="flex items-center gap-1">
            <ArrowUp className="w-3 h-3 text-blue-500" />
            <span>{formatSpeed(torrent.uploadSpeed)}</span>
          </div>
          <div className="flex items-center gap-1">
            <Users className="w-3 h-3" />
            <span>{torrent.peers}</span>
          </div>
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
}
