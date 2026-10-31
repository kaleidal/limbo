import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Download, Link, Loader2, Magnet, Pause, Play, Plus, Shield, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { commands, type Download as DownloadRecord } from "@/lib/bindings";
import { isMagnet, isVpnRequired } from "@/lib/transfers";
import { useAppStore } from "@/store/app-store";
import { BatchAddDialog } from "./batch-add-dialog";
import { DownloadGroup, DownloadItem } from "./download-item";
import { TorrentItem } from "./torrent-item";

type Entry = { kind: "single"; download: DownloadRecord } | { kind: "group"; id: string; items: DownloadRecord[] };

function isFinished(download: DownloadRecord) {
  return download.status === "completed" || download.status === "error";
}

function entries(downloads: DownloadRecord[]) {
  const groups = new Map<string, DownloadRecord[]>();
  const result: Entry[] = [];
  for (const download of downloads) {
    if (!download.groupId) {
      result.push({ kind: "single", download });
      continue;
    }
    const items = groups.get(download.groupId);
    if (items) {
      items.push(download);
    } else {
      const created = [download];
      groups.set(download.groupId, created);
      result.push({ kind: "group", id: download.groupId, items: created });
    }
  }
  return result;
}

function entryFinished(entry: Entry) {
  return entry.kind === "single" ? isFinished(entry.download) : entry.items.every(isFinished);
}

function EntryView({ entry }: { entry: Entry }) {
  return entry.kind === "single" ? (
    <DownloadItem download={entry.download} />
  ) : (
    <DownloadGroup items={entry.items} />
  );
}

export function DownloadsView() {
  const { downloads, torrents, activeTab, setActiveTab, vpnRequired, setVpnRequired } = useAppStore(
    useShallow((state) => ({
      downloads: state.downloads,
      torrents: state.torrents,
      activeTab: state.downloadsTab,
      setActiveTab: state.setDownloadsTab,
      vpnRequired: state.vpnRequired,
      setVpnRequired: state.setVpnRequired,
    })),
  );
  const [urlInput, setUrlInput] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const [isBatchOpen, setIsBatchOpen] = useState(false);

  const [active, finished] = useMemo(() => {
    const all = entries(downloads);
    return [all.filter((entry) => !entryFinished(entry)), all.filter(entryFinished)];
  }, [downloads]);

  const handleAdd = async () => {
    const url = urlInput.trim();
    if (!url || isAdding) return;
    setIsAdding(true);
    setVpnRequired(false);
    try {
      if (isMagnet(url)) {
        await commands.torrentsAdd({ magnetUri: url });
        setActiveTab("torrents");
      } else {
        await commands.downloadsStart({ url });
      }
      setUrlInput("");
    } catch (error) {
      if (isVpnRequired(error)) setVpnRequired(true);
      else console.error("Failed to add download:", error);
    } finally {
      setIsAdding(false);
    }
  };

  const handleBatchAdd = async (urls: string[]) => {
    setIsAdding(true);
    try {
      await Promise.all(urls.map((url) => commands.downloadsStart({ url })));
    } catch (error) {
      console.error("Failed to add downloads:", error);
    } finally {
      setIsAdding(false);
    }
  };

  const pauseAll = () =>
    activeTab === "downloads" ? commands.downloadsPauseAll() : commands.torrentsPauseAll();
  const resumeAll = () =>
    activeTab === "downloads" ? commands.downloadsResumeAll() : commands.torrentsResumeAll();

  const showControls = activeTab === "downloads" ? active.length > 0 : torrents.length > 0;

  return (
    <div className="h-full flex flex-col p-6 relative">
      {isBatchOpen && (
        <BatchAddDialog onClose={() => setIsBatchOpen(false)} onAdd={handleBatchAdd} />
      )}

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

      <div className="flex gap-2 mb-4">
        <Input
          placeholder={activeTab === "downloads" ? "Enter download URL..." : "Enter magnet link..."}
          value={urlInput}
          onChange={(event) => setUrlInput(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && handleAdd()}
          className="flex-1 bg-neutral-900 border-neutral-700"
        />
        <Button onClick={handleAdd} className="gap-2" disabled={isAdding || !urlInput.trim()}>
          {isAdding ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : isMagnet(urlInput) ? (
            <Magnet className="w-4 h-4" />
          ) : (
            <Download className="w-4 h-4" />
          )}
          {isAdding ? "Adding..." : "Add"}
        </Button>
        {activeTab === "downloads" && (
          <Button variant="secondary" onClick={() => setIsBatchOpen(true)} title="Add several">
            <Plus className="w-4 h-4" />
          </Button>
        )}
      </div>

      {showControls && (
        <div className="flex gap-2 mb-4">
          <Button variant="outline" size="sm" onClick={pauseAll} className="gap-2">
            <Pause className="w-4 h-4" /> Pause all
          </Button>
          <Button variant="outline" size="sm" onClick={resumeAll} className="gap-2">
            <Play className="w-4 h-4" /> Resume all
          </Button>
          {activeTab === "downloads" && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => commands.downloadsCancelAll()}
              className="gap-2 text-red-500 hover:text-red-400 hover:bg-red-500/10"
            >
              <X className="w-4 h-4" /> Cancel all
            </Button>
          )}
        </div>
      )}

      {vpnRequired && (
        <div className="flex items-center gap-3 p-4 mb-4 bg-amber-500/10 border border-amber-500/30 rounded-lg">
          <Shield className="w-5 h-5 text-amber-500 shrink-0" />
          <div className="flex-1">
            <p className="font-medium text-amber-500">VPN required</p>
            <p className="text-sm text-neutral-400">
              Torrents are blocked because no VPN was detected. Connect to a VPN and try again.
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setVpnRequired(false)}>
            <X className="w-4 h-4" />
          </Button>
        </div>
      )}

      {activeTab === "downloads" ? (
        <div className="flex-1 overflow-auto space-y-6 [scrollbar-width:none]">
          {active.length > 0 && (
            <section>
              <h2 className="text-sm font-medium text-neutral-400 mb-3">Active</h2>
              <div className="space-y-4">
                {active.map((entry) => (
                  <EntryView key={entry.kind === "single" ? entry.download.id : entry.id} entry={entry} />
                ))}
              </div>
            </section>
          )}

          {finished.length > 0 && (
            <section>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-medium text-neutral-400">Finished</h2>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={async () =>
                    useAppStore.getState().setDownloads(await commands.downloadsClearFinished())
                  }
                  className="text-neutral-500 hover:text-white"
                >
                  <Trash2 className="w-4 h-4 mr-2" />
                  Clear
                </Button>
              </div>
              <div className="space-y-4">
                {finished.map((entry) => (
                  <EntryView key={entry.kind === "single" ? entry.download.id : entry.id} entry={entry} />
                ))}
              </div>
            </section>
          )}

          {downloads.length === 0 && (
            <div className="flex flex-col items-center justify-center text-neutral-500 py-20">
              <Download className="w-16 h-16 mb-4" />
              <p className="text-lg">No downloads yet</p>
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 overflow-auto">
          {torrents.length === 0 ? (
            <div className="flex flex-col items-center justify-center text-neutral-500 py-20">
              <Magnet className="w-16 h-16 mb-4" />
              <p className="text-lg">No torrents yet</p>
            </div>
          ) : (
            <div className="space-y-2">
              {torrents.map((torrent) => (
                <TorrentItem key={torrent.id} torrent={torrent} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
