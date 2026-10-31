import { memo, useState } from "react";
import { ChevronDown, ChevronRight, FolderOpen, Package, Pause, Play, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { commands, type Download, type DownloadStatus } from "@/lib/bindings";
import { formatEta, formatSize, formatSpeed, percent } from "@/lib/format";
import { cn } from "@/lib/utils";
import { StatusIcon } from "./status-icon";

const ICON_BUTTON = "p-1.5 hover:bg-neutral-700 rounded transition-colors";
const REMOVE_BUTTON = "p-1.5 hover:bg-red-500/20 text-red-500 rounded transition-colors";

function reportFailure(action: string) {
  return (error: unknown) => console.error(`Failed to ${action} download:`, error);
}

export const downloadActions = {
  pause: (id: string) => void commands.downloadsPause({ id }).catch(reportFailure("pause")),
  resume: (id: string) => void commands.downloadsResume({ id }).catch(reportFailure("resume")),
  remove: (id: string) => void commands.downloadsCancel({ id }).catch(reportFailure("remove")),
  reveal: (path: string) =>
    void commands.filesReveal({ path }).catch(reportFailure("show")),
};

function barColor(status: DownloadStatus) {
  switch (status) {
    case "error":
      return "bg-red-500";
    case "extracting":
      return "bg-purple-500";
    case "completed":
      return "bg-blue-500";
    default:
      return "bg-lime-500";
  }
}

function detailLine(download: Download) {
  if (download.status === "extracting") return "Extracting…";
  if (download.status === "error") return download.error ?? "Download failed";
  const sizes = `${formatSize(download.downloaded)} / ${formatSize(download.size)}`;
  if (download.status === "pending") return `${sizes} · Queued`;
  if (download.extractStatus) return `${sizes} · ${download.extractStatus}`;
  return sizes;
}

export const DownloadItem = memo(function DownloadItem({ download }: { download: Download }) {
  const progress =
    download.status === "extracting"
      ? Math.round(download.extractProgress ?? 0)
      : percent(download.downloaded, download.size);
  const speed = download.status === "downloading" ? (download.speed ?? 0) : 0;

  return (
    <div className="bg-neutral-900 rounded-lg p-4 border border-neutral-800">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <StatusIcon status={download.status} />
          <span className="font-medium truncate" title={download.filename}>
            {download.filename}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {(download.status === "downloading" || download.status === "pending") && (
            <button onClick={() => downloadActions.pause(download.id)} className={ICON_BUTTON} title="Pause">
              <Pause className="w-4 h-4" />
            </button>
          )}
          {download.status === "paused" && (
            <button onClick={() => downloadActions.resume(download.id)} className={ICON_BUTTON} title="Resume">
              <Play className="w-4 h-4" />
            </button>
          )}
          {download.status === "error" && (
            <button onClick={() => downloadActions.resume(download.id)} className={ICON_BUTTON} title="Retry">
              <RotateCcw className="w-4 h-4" />
            </button>
          )}
          {download.status === "completed" && (
            <button onClick={() => downloadActions.reveal(download.path)} className={ICON_BUTTON} title="Open folder">
              <FolderOpen className="w-4 h-4" />
            </button>
          )}
          {download.status !== "extracting" && (
            <button
              onClick={() => downloadActions.remove(download.id)}
              className={REMOVE_BUTTON}
              title={download.status === "completed" ? "Remove from list" : "Cancel"}
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
      <div className="flex items-center gap-4">
        <div className="flex-1 h-2 bg-neutral-800 rounded-full overflow-hidden">
          <div
            className={cn("h-full transition-all", barColor(download.status))}
            style={{ width: `${progress}%` }}
          />
        </div>
        <span className="text-sm text-neutral-400 w-12 text-right">{progress}%</span>
      </div>
      <div className="flex items-center justify-between gap-4 mt-2 text-xs text-neutral-500">
        <span className={cn("truncate", download.status === "error" && "text-red-400")} title={detailLine(download)}>
          {detailLine(download)}
        </span>
        <div className="flex shrink-0 items-center gap-3">
          {speed > 0 && download.eta ? <span>ETA: {formatEta(download.eta)}</span> : null}
          {download.status === "downloading" && <span>{formatSpeed(speed)}</span>}
          {download.status === "paused" && <span className="text-yellow-500">Paused</span>}
        </div>
      </div>
    </div>
  );
});

function groupStatus(items: Download[]): DownloadStatus {
  const order: DownloadStatus[] = ["extracting", "downloading", "pending", "paused", "error"];
  return order.find((status) => items.some((item) => item.status === status)) ?? "completed";
}

export const DownloadGroup = memo(function DownloadGroup({ items }: { items: Download[] }) {
  const [expanded, setExpanded] = useState(false);
  const totalSize = items.reduce((sum, item) => sum + item.size, 0);
  const totalReceived = items.reduce((sum, item) => sum + item.downloaded, 0);
  const totalSpeed = items.reduce((sum, item) => sum + (item.speed ?? 0), 0);
  const status = groupStatus(items);
  const isActive = status !== "completed" && status !== "error";
  const sorted = items.slice().sort((a, b) => a.filename.localeCompare(b.filename));

  const cancelAll = () => {
    for (const item of items) {
      if (!["completed", "error"].includes(item.status)) downloadActions.remove(item.id);
    }
  };

  return (
    <div className="bg-neutral-900/50 rounded-lg border border-neutral-800 overflow-hidden">
      <div className="flex items-center pr-4">
        <div
          className="flex-1 p-4 flex items-center gap-3 cursor-pointer hover:bg-neutral-800/50 transition-colors"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? (
            <ChevronDown className="w-4 h-4 text-neutral-500" />
          ) : (
            <ChevronRight className="w-4 h-4 text-neutral-500" />
          )}
          <Package className="w-5 h-5 text-blue-400" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium truncate">{items[0].groupName}</span>
              <span className="text-xs text-neutral-500">{items.length} parts</span>
            </div>
            <div className="flex items-center gap-4 text-xs text-neutral-500 mt-1">
              <span>
                {formatSize(totalReceived)} / {formatSize(totalSize)}
              </span>
              {status === "downloading" && <span>{formatSpeed(totalSpeed)}</span>}
              {status === "extracting" && <span className="text-purple-400">Extracting…</span>}
            </div>
          </div>
          <div className="w-24 h-2 bg-neutral-800 rounded-full overflow-hidden mr-4">
            <div
              className={cn("h-full", barColor(status))}
              style={{ width: `${percent(totalReceived, totalSize)}%` }}
            />
          </div>
        </div>
        {isActive && (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-neutral-500 hover:text-red-500"
            onClick={cancelAll}
            title="Cancel all parts"
          >
            <X className="w-4 h-4" />
          </Button>
        )}
      </div>
      {expanded && (
        <div className="border-t border-neutral-800/50 bg-black/20 p-2 space-y-2">
          {sorted.map((item) => (
            <DownloadItem key={item.id} download={item} />
          ))}
        </div>
      )}
    </div>
  );
});
