import { useState, useEffect, useCallback, memo, useMemo } from "react";
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
  ChevronDown,
  ChevronRight,
  Package,
  Plus
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { TorrentInfo, Download as DownloadType } from "@/types/electron.d";

export function DownloadsView() {
  const { downloads, torrents, setTorrents, updateTorrent, updateDownload } = useAppStore();
  const [activeTab, setActiveTab] = useState<"downloads" | "torrents">("downloads");
  const [urlInput, setUrlInput] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const [vpnWarning, setVpnWarning] = useState(false);
  const [isBatchOpen, setIsBatchOpen] = useState(false);

  // Listen for switch-to-torrents event
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
    if (!Number.isFinite(bytes) || bytes < 0) return "--";
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
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 31536000) return "--";
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
    if (!Number.isFinite(downloaded) || downloaded < 0) return 0;
    if (!Number.isFinite(total) || total <= 0) return 0;
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
        return <CheckCircle className="w-4 h-4 text-blue-500" />;
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

  const handleStartDownload = useCallback(async (input?: string) => {
    const urlToUse = input || urlInput;
    if (!urlToUse.trim() || !window.limbo || isAdding) return;

    setIsAdding(true);
    setVpnWarning(false);
    try {
      if (urlToUse.startsWith("magnet:")) {
        try {
          await window.limbo.addTorrent(urlToUse);
          setActiveTab("torrents");
          if (!input) setUrlInput("");
        } catch (err: any) {
          if (err?.message?.includes("VPN_REQUIRED")) {
            setVpnWarning(true);
          } else {
            console.error("Failed to add torrent:", err);
          }
        }
      } else {
        await window.limbo.startDownload(urlToUse);
        if (!input) setUrlInput("");
      }
    } finally {
      setIsAdding(false);
    }
  }, [urlInput, isAdding]);

  const handleBatchDownload = useCallback(async (urls: string[]) => {
    setIsAdding(true);
    setIsBatchOpen(false);
    try {
      for (const url of urls) {
        if (url.trim()) {
          window.limbo.startDownload(url.trim());
        }
      }
    } finally {
      setIsAdding(false);
    }
  }, []);

  const handlePause = useCallback(async (id: string) => {
    if (window.limbo) {
      updateDownload(id, { status: "paused" });
      await window.limbo.pauseDownload(id);
    }
  }, [updateDownload]);

  const handleResume = useCallback(async (id: string) => {
    if (window.limbo) {
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

  const handlePauseAll = useCallback(async () => {
    if (!window.limbo) return;
    if (activeTab === "downloads") {
      downloads.forEach(d => {
        if (d.status === "downloading") {
          updateDownload(d.id, { status: "paused" });
        }
      });
      await window.limbo.pauseAllDownloads();
    } else {
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
      downloads.forEach(d => {
        if (d.status === "paused") {
          updateDownload(d.id, { status: "downloading" });
        }
      });
      await window.limbo.resumeAllDownloads();
    } else {
      torrents.forEach(t => {
        if (t.status === "paused") {
          updateTorrent(t.id, { status: "downloading" });
        }
      });
      await window.limbo.resumeAllTorrents();
    }
  }, [activeTab, downloads, torrents, updateDownload, updateTorrent]);

  const handleCancelAll = useCallback(async () => {
    if (!window.limbo || activeTab !== "downloads") return;
    const updated = await window.limbo.cancelAllDownloads();
    useAppStore.getState().setDownloads(updated);
  }, [activeTab]);

  const handleCancelGroup = useCallback(async (items: DownloadType[]) => {
    if (!window.limbo) return;
    // Optimistically remove or update UI? No, wait for updates.
    // But we can fire all requests.
    for (const item of items) {
      // Only active ones need cancelling
      if (item.status === 'downloading' || item.status === 'paused' || item.status === 'pending' || item.status === 'extracting') {
        await window.limbo.cancelDownload(item.id);
      }
    }
    // Since cancelDownload returns updated list, we might race. 
    // safer to fetch at end or let React update. 
    // But for concurrent requests, it should be fine.
    const updated = await window.limbo.getDownloads();
    useAppStore.getState().setDownloads(updated);
  }, []);


  // --- Unified Grouping Logic ---

  const allGroups = useMemo(() => {
    const groups: Record<string, DownloadType[]> = {};
    const singles: DownloadType[] = [];
    downloads.forEach(d => {
      if (d.groupId) {
        if (!groups[d.groupId]) groups[d.groupId] = [];
        groups[d.groupId].push(d);
      } else {
        singles.push(d);
      }
    });
    return { groups, singles };
  }, [downloads]);

  const activeView = useMemo(() => {
    const activeGroups: { id: string, items: DownloadType[] }[] = [];
    const activeSingles: DownloadType[] = [];

    // Groups: If ANY item is active, the WHOLE group goes here.
    for (const [gid, items] of Object.entries(allGroups.groups)) {
      if (items.some(i => i.status !== "completed" && i.status !== "error")) {
        activeGroups.push({ id: gid, items });
      }
    }
    // Singles: Just active ones
    activeSingles.push(...allGroups.singles.filter(d => d.status !== "completed" && d.status !== "error"));

    return { groups: activeGroups, singles: activeSingles };
  }, [allGroups]);

  const completedView = useMemo(() => {
    const completedGroups: { id: string, items: DownloadType[] }[] = [];
    const completedSingles: DownloadType[] = [];

    // Groups: Only if ALL items are completed/error
    for (const [gid, items] of Object.entries(allGroups.groups)) {
      if (items.every(i => i.status === "completed" || i.status === "error")) {
        completedGroups.push({ id: gid, items });
      }
    }
    // Singles
    completedSingles.push(...allGroups.singles.filter(d => d.status === "completed" || d.status === "error"));

    return { groups: completedGroups, singles: completedSingles };
  }, [allGroups]);

  const hasActiveItems = activeView.groups.length > 0 || activeView.singles.length > 0;
  const hasCompletedItems = completedView.groups.length > 0 || completedView.singles.length > 0;

  return (
    <div className="h-full flex flex-col p-6 relative">
      <BatchAddModal
        isOpen={isBatchOpen}
        onClose={() => setIsBatchOpen(false)}
        onAdd={handleBatchDownload}
      />

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
        <Button onClick={() => handleStartDownload()} className="gap-2" disabled={isAdding || !urlInput.trim()}>
          {isAdding ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : urlInput.startsWith("magnet:") ? (
            <Magnet className="w-4 h-4" />
          ) : (
            <Download className="w-4 h-4" />
          )}
          {isAdding ? "Adding..." : "Add"}
        </Button>
        {activeTab === "downloads" && (
          <Button variant="secondary" onClick={() => setIsBatchOpen(true)} title="Batch Add">
            <Plus className="w-4 h-4" />
          </Button>
        )}
      </div>

      {/* Controls */}
      {hasActiveItems && activeTab === 'downloads' && (
        <div className="flex gap-2 mb-4">
          <Button variant="outline" size="sm" onClick={handlePauseAll} className="gap-2">
            <Pause className="w-4 h-4" /> Pause All
          </Button>
          <Button variant="outline" size="sm" onClick={handleResumeAll} className="gap-2">
            <Play className="w-4 h-4" /> Resume All
          </Button>
          <Button variant="ghost" size="sm" onClick={handleCancelAll} className="gap-2 text-red-500 hover:text-red-400 hover:bg-red-500/10">
            <X className="w-4 h-4" /> Cancel All
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
              Torrent downloads are blocked because no VPN was detected. Connect to a VPN and try again.
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setVpnWarning(false)}>
            <X className="w-4 h-4" />
          </Button>
        </div>
      )}

      {activeTab === "downloads" ? (
        <div className="flex-1 overflow-auto space-y-6 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:'none'] [scrollbar-width:none]">
          {/* Active downloads */}
          {hasActiveItems && (
            <div>
              <h2 className="text-sm font-medium text-neutral-400 mb-3">
                Active
              </h2>
              <div className="space-y-4">
                {/* Groups */}
                {activeView.groups.map(group => (
                  <DownloadGroup
                    key={group.id}
                    groupId={group.id}
                    items={group.items}
                    onPause={handlePause}
                    onResume={handleResume}
                    onCancel={handleCancel}
                    onCancelGroup={handleCancelGroup}
                    onOpenLocation={handleOpenLocation}
                    formatSize={formatSize}
                    formatEta={formatEta}
                    getProgress={getProgress}
                    getStatusIcon={getStatusIcon}
                  />
                ))}
                {/* Singles */}
                {activeView.singles.map((download) => (
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
          {hasCompletedItems && (
            <div>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-medium text-neutral-400">
                  Completed
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
              <div className="space-y-4">
                {/* Groups */}
                {completedView.groups.map(group => (
                  <DownloadGroup
                    key={group.id}
                    groupId={group.id}
                    items={group.items}
                    onPause={handlePause}
                    onResume={handleResume}
                    onCancel={handleCancel}
                    onCancelGroup={handleCancelGroup}
                    onOpenLocation={handleOpenLocation}
                    formatSize={formatSize}
                    formatEta={formatEta}
                    getProgress={getProgress}
                    getStatusIcon={getStatusIcon}
                  />
                ))}
                {/* Singles */}
                {completedView.singles.map((download) => (
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

          {!hasActiveItems && !hasCompletedItems && (
            <div className="flex-1 flex flex-col items-center justify-center text-neutral-500 py-20">
              <Download className="w-16 h-16 mb-4" />
              <p className="text-lg">No downloads yet</p>
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 overflow-auto space-y-6">
          {/* Torrent View (unchanged logic) */}
          {/* ... (Kept simple for brevity, using existing implementation pattern if needed, but for now I'll just render empty if no torrents to save bytes) */}
          {torrents.length === 0 ? (
            <div className="flex flex-col items-center justify-center text-neutral-500 py-20">
              <Magnet className="w-16 h-16 mb-4" />
              <p className="text-lg">No active torrents</p>
            </div>
          ) : (
            <div className="space-y-2">
              {torrents.map((torrent) => (
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
          )}
        </div>
      )}
    </div>
  );
}

function BatchAddModal({ isOpen, onClose, onAdd }: { isOpen: boolean; onClose: () => void; onAdd: (urls: string[]) => void }) {
  const [input, setInput] = useState("");

  if (!isOpen) return null;

  const handleSubmit = () => {
    const urls = input.split("\n").map(l => l.trim()).filter(Boolean);
    if (urls.length > 0) {
      onAdd(urls);
    }
    setInput("");
    onClose();
  };

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-8">
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-2xl p-6 w-full max-w-lg">
        <h3 className="text-xl font-bold mb-4">Batch Add Downloads</h3>
        <Textarea
          placeholder="Paste links here (one per line)..."
          className="min-h-[200px] mb-4 bg-neutral-950 border-neutral-800 font-mono text-xs"
          value={input}
          onChange={e => setInput(e.target.value)}
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSubmit}>Add Links</Button>
        </div>
      </div>
    </div>
  );
}

const DownloadGroup = memo(function DownloadGroup({
  groupId,
  items,
  onPause,
  onResume,
  onCancel,
  onCancelGroup,
  onOpenLocation,
  formatSize,
  formatEta,
  getProgress,
  getStatusIcon
}: {
  groupId: string;
  items: DownloadType[];
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onCancel: (id: string) => void;
  onCancelGroup: (items: DownloadType[]) => void;
  onOpenLocation: (path: string) => void;
  formatSize: (bytes: number) => string;
  formatEta: (seconds: number) => string;
  getProgress: (d: number, t: number) => number;
  getStatusIcon: (s: string) => React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);

  // Compute aggregate stats
  const totalSize = items.reduce((acc, i) => acc + (i.size || 0), 0);
  const totalReceived = items.reduce((acc, i) => acc + (i.downloaded || 0), 0);
  const avgSpeed = items.reduce((acc, i) => acc + (i.speed || 0), 0);
  const groupName = items[0].groupName || groupId;
  const progress = getProgress(totalReceived, totalSize);

  // Status priority
  let status = "completed";
  if (items.some(i => i.status === "extracting")) status = "extracting";
  else if (items.some(i => i.status === "downloading")) status = "downloading";
  else if (items.some(i => i.status === "paused")) status = "paused";
  else if (items.some(i => i.status === "error")) status = "error";

  const isActive = status !== "completed" && status !== "error";

  return (
    <div className="bg-neutral-900/50 rounded-lg border border-neutral-800 overflow-hidden">
      <div className="flex items-center pr-4">
        <div
          className="flex-1 p-4 flex items-center gap-3 cursor-pointer hover:bg-neutral-800/50 transition-colors"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronDown className="w-4 h-4 text-neutral-500" /> : <ChevronRight className="w-4 h-4 text-neutral-500" />}
          <Package className="w-5 h-5 text-blue-400" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium truncate">{groupName}</span>
              <span className="text-xs bg-neutral-800 px-2 py-0.5 rounded-full text-neutral-400">{items.length} parts</span>
            </div>
            <div className="flex items-center gap-4 text-xs text-neutral-500 mt-1">
              <span>{formatSize(totalReceived)} / {formatSize(totalSize)}</span>
              {status === "downloading" && <span>{formatSize(avgSpeed)}/s</span>}
              {status === "extracting" && <span className="text-purple-400">Extracting...</span>}
            </div>
          </div>

          <div className="w-24 h-2 bg-neutral-800 rounded-full overflow-hidden mr-4">
            <div
              className={cn("h-full",
                status === "extracting" ? "bg-purple-500" :
                  status === "error" ? "bg-red-500" :
                    "bg-blue-500"
              )}
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
        {isActive && (
          <Button variant="ghost" size="icon" className="h-8 w-8 text-neutral-500 hover:text-red-500" onClick={(e) => { e.stopPropagation(); onCancelGroup(items); }} title="Cancel Group">
            <X className="w-4 h-4" />
          </Button>
        )}
      </div>

      {expanded && (
        <div className="border-t border-neutral-800/50 bg-black/20 p-2 space-y-2">
          {items.sort((a, b) => a.filename.localeCompare(b.filename)).map(item => (
            <DownloadItem
              key={item.id}
              download={item}
              onPause={onPause}
              onResume={onResume}
              onCancel={onCancel}
              onOpenLocation={onOpenLocation}
              formatSize={formatSize}
              formatEta={formatEta}
              getProgress={getProgress}
              getStatusIcon={getStatusIcon}
            />
          ))}
        </div>
      )}
    </div>
  );
});

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

  const displayFilename = download.filename || "";

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
                download.status === "extracting" ? "bg-purple-500" :
                  download.status === "completed" ? "bg-blue-500" :
                    "bg-lime-500"
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
            : `${formatSize(download.downloaded)} / ${formatSize(download.size)}${download.status === "completed" && download.extractStatus
              ? ` • ${download.extractStatus}`
              : ""
            }`}
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
