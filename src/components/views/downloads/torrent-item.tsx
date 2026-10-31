import { memo } from "react";
import { ArrowDown, ArrowUp, FolderOpen, Pause, Play, Users, X } from "lucide-react";
import { commands, type TorrentInfo } from "@/lib/bindings";
import { formatEta, formatSize, formatSpeed } from "@/lib/format";
import { cn } from "@/lib/utils";
import { StatusIcon } from "./status-icon";

const ICON_BUTTON = "p-1.5 hover:bg-neutral-700 rounded transition-colors";

function reportFailure(action: string) {
  return (error: unknown) => console.error(`Failed to ${action} torrent:`, error);
}

export const TorrentItem = memo(function TorrentItem({ torrent }: { torrent: TorrentInfo }) {
  const progress = Math.round(torrent.progress * 100);
  const running = torrent.status === "downloading" || torrent.status === "seeding";
  const eta =
    torrent.downloadSpeed > 0 ? (torrent.size - torrent.downloaded) / torrent.downloadSpeed : 0;

  const pause = () => void commands.torrentsPause({ id: torrent.id }).catch(reportFailure("pause"));
  const resume = () => void commands.torrentsResume({ id: torrent.id }).catch(reportFailure("resume"));
  const reveal = () => void commands.filesReveal({ path: torrent.path }).catch(reportFailure("show"));
  const remove = () =>
    void commands.torrentsRemove({ id: torrent.id, deleteFiles: false }).catch(reportFailure("remove"));

  return (
    <div className="bg-neutral-900 rounded-lg p-4 border border-neutral-800">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <StatusIcon status={torrent.status} />
          <div className="min-w-0 flex-1">
            <span className="font-medium truncate block" title={torrent.name}>
              {torrent.name}
            </span>
            {torrent.clientName ? (
              <p className="text-xs text-neutral-500 truncate mt-0.5">Added by {torrent.clientName}</p>
            ) : null}
          </div>
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
          {torrent.status === "downloading" && eta > 0 && (
            <span className="text-neutral-500">ETA: {formatEta(eta)}</span>
          )}
        </div>
        <div className="flex items-center gap-2 ml-4">
          {running && (
            <button onClick={pause} className={ICON_BUTTON} title="Pause">
              <Pause className="w-4 h-4" />
            </button>
          )}
          {(torrent.status === "paused" || torrent.status === "completed") && (
            <button
              onClick={resume}
              className={ICON_BUTTON}
              title={torrent.status === "completed" ? "Seed" : "Resume"}
            >
              <Play className="w-4 h-4" />
            </button>
          )}
          {(torrent.status === "completed" || torrent.status === "seeding") && (
            <button onClick={reveal} className={ICON_BUTTON} title="Open folder">
              <FolderOpen className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={remove}
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
                : torrent.status === "seeding" || torrent.status === "completed"
                  ? "bg-blue-500"
                  : "bg-lime-500",
            )}
            style={{ width: `${progress}%` }}
          />
        </div>
        <span className="text-sm text-neutral-400 w-12 text-right">{progress}%</span>
      </div>
      <div className="flex items-center justify-between gap-4 mt-2 text-xs text-neutral-500">
        <span className={cn("truncate", torrent.status === "error" && "text-red-400")}>
          {torrent.status === "error" && torrent.lastError
            ? torrent.lastError
            : `${formatSize(torrent.downloaded)} / ${formatSize(torrent.size)}`}
        </span>
        <span className="shrink-0">Uploaded {formatSize(torrent.uploaded)}</span>
      </div>
    </div>
  );
});
