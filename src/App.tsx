import { useCallback, useEffect, useState } from "react";
import { CloudDownload, FileArchive, HardDriveDownload } from "lucide-react";
import { commands } from "@/lib/bindings";
import { isVpnRequired } from "@/lib/transfers";
import { useAppStore } from "@/store/app-store";
import { useOccludeGuest } from "@/hooks/use-occlude-guest";
import {
  useDesktopIntegration,
  type BrowserDownloadRequest,
} from "@/hooks/use-desktop-integration";
import { Sidebar } from "@/components/sidebar";
import { TitleBar } from "@/components/title-bar";
import { LibraryView } from "@/components/views/library-view";
import { DownloadsView } from "@/components/views/downloads";
import { BrowserView } from "@/components/views/browser-view";
import { SettingsView } from "@/components/views/settings";
import { AddBookmarkDialog } from "@/components/dialogs/add-bookmark-dialog";
import { ClipboardMonitor } from "@/components/clipboard-monitor";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

function isTorrentRequest(request: BrowserDownloadRequest) {
  return (
    request.filename.toLowerCase().endsWith(".torrent") ||
    request.url.toLowerCase().includes(".torrent")
  );
}

function CurrentView() {
  switch (useAppStore((state) => state.currentView)) {
    case "downloads":
      return <DownloadsView />;
    case "browser":
      return <BrowserView />;
    case "settings":
      return <SettingsView />;
    default:
      return <LibraryView />;
  }
}

export function App() {
  const currentView = useAppStore((state) => state.currentView);
  const debridConfigured = useAppStore(
    (state) => !!state.settings?.debrid.service && !!state.settings.debrid.apiKey,
  );
  const [pendingDownload, setPendingDownload] = useState<BrowserDownloadRequest | null>(null);
  const [debridSupported, setDebridSupported] = useState(false);
  const guestOcclusionReady = useOccludeGuest(!!pendingDownload);
  useDesktopIntegration(useCallback((request) => setPendingDownload(request), []));

  const isTorrent = !!pendingDownload && isTorrentRequest(pendingDownload);
  const offerDebrid = debridConfigured && debridSupported;

  useEffect(() => {
    setDebridSupported(false);
    if (!pendingDownload) return;
    let cancelled = false;
    const check = isTorrentRequest(pendingDownload)
      ? commands.debridTorrentSupported()
      : commands.debridUrlSupported({ url: pendingDownload.url });
    void check
      .catch(() => false)
      .then((supported) => {
        if (!cancelled) setDebridSupported(supported);
      });
    return () => {
      cancelled = true;
    };
  }, [pendingDownload]);

  const startPendingDownload = async (useDebrid: boolean) => {
    if (!pendingDownload) return;
    const { showDownloads, setVpnRequired } = useAppStore.getState();
    setPendingDownload(null);
    try {
      if (isTorrent && useDebrid) {
        showDownloads("downloads");
        await commands.debridDownloadTorrentFile({ url: pendingDownload.url });
      } else if (isTorrent) {
        showDownloads("torrents");
        await commands.torrentsAddRemote({ url: pendingDownload.url });
      } else {
        showDownloads("downloads");
        await commands.downloadsStart({
          url: pendingDownload.url,
          filename: pendingDownload.filename,
          useDebrid,
        });
      }
    } catch (error) {
      if (isVpnRequired(error)) setVpnRequired(true);
      else console.error("Failed to start browser download:", error);
    }
  };

  return (
    <>
      <div className="flex h-screen flex-col bg-transparent text-neutral-100">
        <TitleBar />
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <Sidebar />
          <main
            className={
              currentView === "browser"
                ? "flex-1 overflow-hidden bg-transparent"
                : "flex-1 overflow-hidden bg-neutral-950"
            }
          >
            <CurrentView />
          </main>
        </div>
      </div>
      <AddBookmarkDialog />
      <ClipboardMonitor />
      <AlertDialog
        open={!!pendingDownload && guestOcclusionReady}
        onOpenChange={(open) => {
          if (!open) setPendingDownload(null);
        }}
      >
        <AlertDialogContent
          size="sm"
          className="w-fit min-w-[24rem] max-w-[min(30rem,calc(100vw-2rem))] overflow-hidden border border-neutral-700 bg-neutral-900 p-0 text-neutral-100 shadow-[0_24px_80px_rgba(0,0,0,0.55)]"
        >
          <div className="border-b border-neutral-800 px-5 py-4">
            <AlertDialogHeader className="place-items-start text-left">
              <AlertDialogTitle className="text-base font-semibold text-neutral-50">
                {isTorrent ? "Start torrent download?" : "Start download?"}
              </AlertDialogTitle>
              <AlertDialogDescription className="max-w-none text-sm leading-6 text-neutral-400">
                {isTorrent
                  ? `Limbo will fetch ${pendingDownload?.filename} and start the torrent it points to.`
                  : `Download ${pendingDownload?.filename} from the browser?`}
              </AlertDialogDescription>
            </AlertDialogHeader>
          </div>
          <AlertDialogFooter className="flex flex-row justify-end gap-2 border-t border-neutral-800 bg-neutral-950 px-5 py-4">
            {offerDebrid ? (
              <AlertDialogAction
                size="default"
                className="shrink-0 px-4"
                onClick={() => startPendingDownload(true)}
              >
                <CloudDownload className="size-4" />
                Download via Debrid
              </AlertDialogAction>
            ) : null}
            <AlertDialogAction
              size="default"
              variant={offerDebrid ? "outline" : "default"}
              className="shrink-0 px-5"
              onClick={() => startPendingDownload(false)}
            >
              {isTorrent ? <FileArchive className="size-4" /> : <HardDriveDownload className="size-4" />}
              {isTorrent ? "Start torrent" : "Download"}
            </AlertDialogAction>
            <AlertDialogCancel size="default" className="shrink-0 px-5">
              Cancel
            </AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
