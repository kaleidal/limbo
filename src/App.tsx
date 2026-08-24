import { useEffect, useState } from "react";
import { useAppStore } from "@/store/app-store";
import { useOccludeGuest } from "@/hooks/use-occlude-guest";
import { Sidebar } from "@/components/sidebar";
import { TitleBar } from "@/components/title-bar";
import { LibraryView } from "@/components/views/library-view";
import { DownloadsView } from "@/components/views/downloads-view";
import { BrowserView } from "@/components/views/browser-view";
import { SettingsView } from "@/components/views/settings-view";
import { AddBookmarkDialog } from "@/components/dialogs/add-bookmark-dialog";
import { ApiApprovalDialog } from "@/components/dialogs/api-approval-dialog";
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
import { CloudDownload, FileArchive, HardDriveDownload } from "lucide-react";
import type { ApiApprovalRequest, BrowserDownloadRequest, Download } from "@/types/desktop.d";

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isVpnRequiredError(error: unknown) {
  return getErrorMessage(error).includes("VPN_REQUIRED");
}

function isDownloadStatus(status: string): status is Download["status"] {
  return [
    "pending",
    "downloading",
    "paused",
    "completed",
    "error",
    "extracting",
    "cancelled",
  ].includes(status);
}

export function App() {
  const {
    currentView,
    initializeData,
    setLibrary,
    addDownload,
    updateDownload,
    addTorrent,
    updateTorrent,
    removeTorrent,
    setCurrentView,
    setActiveBookmark,
    settings,
  } = useAppStore();
  const [pendingBrowserDownload, setPendingBrowserDownload] = useState<BrowserDownloadRequest | null>(null);
  const [pendingApiApproval, setPendingApiApproval] = useState<ApiApprovalRequest | null>(null);
  const [browserDownloadDebridSupported, setBrowserDownloadDebridSupported] = useState(false);
  const guestOcclusionReady = useOccludeGuest(!!pendingBrowserDownload);

  const isTorrentFileRequest =
    !!pendingBrowserDownload &&
    (pendingBrowserDownload.filename.toLowerCase().endsWith(".torrent") ||
      pendingBrowserDownload.url.toLowerCase().includes(".torrent"));

  const handleBrowserDownloadChoice = async (useDebrid: boolean) => {
    if (!pendingBrowserDownload || !window.limbo) return;
    try {
      if (isTorrentFileRequest && useDebrid) {
        const links = await window.limbo.convertTorrentFileDebrid(pendingBrowserDownload.url);
        for (const link of links) {
          await window.limbo.startDownload(link);
        }
      } else if (isTorrentFileRequest) {
        await window.limbo.addRemoteTorrent(pendingBrowserDownload.url);
      } else {
        await window.limbo.startDownload(pendingBrowserDownload.url, {
          filename: pendingBrowserDownload.filename,
          useDebrid,
        });
      }
      setActiveBookmark(null);
      setCurrentView("downloads");
      if (isTorrentFileRequest && !useDebrid) {
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent("switch-to-torrents"));
        }, 100);
      }
    } catch (error) {
      console.error("Failed to start browser-triggered download:", error);
    } finally {
      setPendingBrowserDownload(null);
      setBrowserDownloadDebridSupported(false);
    }
  };

  useEffect(() => {
    if (!pendingBrowserDownload || !window.limbo) {
      setBrowserDownloadDebridSupported(false);
      return;
    }

    let cancelled = false;
    const checkSupport = async () => {
      const supported = isTorrentFileRequest
        ? await window.limbo.isDebridTorrentSupported().catch(() => false)
        : await window.limbo.isDebridUrlSupported(pendingBrowserDownload.url).catch(() => false);
      if (!cancelled) {
        setBrowserDownloadDebridSupported(supported);
      }
    };

    checkSupport();
    return () => {
      cancelled = true;
    };
  }, [isTorrentFileRequest, pendingBrowserDownload]);

  useEffect(() => {
    // Load initial data
    initializeData();

    // Set up event listeners
    if (window.limbo) {
      const unsubStarted = window.limbo.onDownloadStarted((download) => {
        addDownload(download);
      });

      const unsubProgress = window.limbo.onDownloadProgress((progress) => {
        updateDownload(progress.id, {
          downloaded: progress.downloaded,
          size: progress.total,
          status: isDownloadStatus(progress.status) ? progress.status : "error",
          speed: progress.speed,
        });
      });

      const unsubComplete = window.limbo.onDownloadComplete((data) => {
        if (isDownloadStatus(data.status)) {
          updateDownload(data.id, { status: data.status });
        }
      });

      const unsubLibrary = window.limbo.onLibraryUpdated((library) => {
        setLibrary(library);
      });

      const unsubTorrentAdded = window.limbo.onTorrentAdded((torrent) => {
        addTorrent(torrent);
      });

      const unsubTorrentProgress = window.limbo.onTorrentProgress((torrent) => {
        updateTorrent(torrent.id, torrent);
      });

      const unsubTorrentComplete = window.limbo.onTorrentComplete((torrent) => {
        updateTorrent(torrent.id, torrent);
      });

      const unsubTorrentError = window.limbo.onTorrentError((data) => {
        updateTorrent(data.id, { status: "error" });
      });

      const unsubTorrentRemoved = window.limbo.onTorrentRemoved((data) => {
        removeTorrent(data.id);
      });

      const unsubTorrentFile = window.limbo.onTorrentFileOpened(async (filePath: string) => {
        try {
          setCurrentView("downloads");
          setTimeout(() => {
            window.dispatchEvent(new CustomEvent('switch-to-torrents'));
          }, 100);
          // `addTorrentFile` will cause the main process to emit `torrent-added`.
          // We listen for that event above and add it to state there.
          await window.limbo.addTorrentFile(filePath);
        } catch (error: unknown) {
          console.error("Failed to add torrent file:", error);
          if (isVpnRequiredError(error)) {
            setCurrentView("downloads");
            setTimeout(() => {
              window.dispatchEvent(new CustomEvent("switch-to-torrents"));
              window.dispatchEvent(new CustomEvent("vpn-required"));
            }, 100);
          }
        }
      });

      const unsubBrowserDownload = window.limbo.onBrowserDownloadRequested((request) => {
        setPendingBrowserDownload(request);
      });

      const unsubApiApproval = window.limbo.onApiApprovalRequested((request) => {
        setPendingApiApproval(request);
      });

      const unsubApiApprovalExpired = window.limbo.onApiApprovalExpired(({ requestId }) => {
        setPendingApiApproval((current) => current?.requestId === requestId ? null : current);
      });

      return () => {
        unsubStarted();
        unsubProgress();
        unsubComplete();
        unsubLibrary();
        unsubTorrentAdded();
        unsubTorrentProgress();
        unsubTorrentComplete();
        unsubTorrentError();
        unsubTorrentRemoved();
        unsubTorrentFile();
        unsubBrowserDownload();
        unsubApiApproval();
        unsubApiApprovalExpired();
      };
    }
  }, [addDownload, addTorrent, initializeData, removeTorrent, setActiveBookmark, setCurrentView, setLibrary, updateDownload, updateTorrent]);

  const renderView = () => {
    switch (currentView) {
      case "library":
        return <LibraryView />;
      case "downloads":
        return <DownloadsView />;
      case "browser":
        return <BrowserView />;
      case "settings":
        return <SettingsView />;
      default:
        return <LibraryView />;
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
            {renderView()}
          </main>
        </div>
      </div>
      <AddBookmarkDialog />
      <ClipboardMonitor />
      <ApiApprovalDialog
        request={pendingApiApproval}
        onDecide={(approved, remember) => {
          if (!pendingApiApproval || !window.limbo) return;
          const requestId = pendingApiApproval.requestId;
          setPendingApiApproval(null);
          void window.limbo.decideApiApproval(requestId, approved, remember);
        }}
      />
      <AlertDialog
        open={!!pendingBrowserDownload && guestOcclusionReady}
        onOpenChange={(open) => {
          if (!open) {
            setPendingBrowserDownload(null);
            setBrowserDownloadDebridSupported(false);
          }
        }}
      >
        <AlertDialogContent
          size="sm"
          className="w-fit min-w-[24rem] max-w-[min(30rem,calc(100vw-2rem))] overflow-hidden border border-neutral-700 bg-neutral-900 p-0 text-neutral-100 shadow-[0_24px_80px_rgba(0,0,0,0.55)]"
        >
          <div className="border-b border-neutral-800 bg-linear-to-r from-neutral-900 via-neutral-950 to-neutral-900 px-5 py-4">
            <AlertDialogHeader className="place-items-start text-left">
              <AlertDialogTitle className="text-base font-semibold text-neutral-50">
                {isTorrentFileRequest ? "Start Torrent Download?" : "Start Download?"}
              </AlertDialogTitle>
              <AlertDialogDescription className="max-w-none text-sm leading-6 text-neutral-400">
              {pendingBrowserDownload
                ? isTorrentFileRequest
                  ? `Do you want Limbo to fetch ${pendingBrowserDownload.filename} and start the actual torrent download?`
                  : `Do you want to download ${pendingBrowserDownload.filename} from the browser?`
                : "Do you want to start this download?"}
              </AlertDialogDescription>
            </AlertDialogHeader>
          </div>
          <AlertDialogFooter className="flex flex-row justify-end gap-2 border-t border-neutral-800 bg-neutral-950 px-5 py-4">
            {settings?.debrid?.service && settings?.debrid?.apiKey && browserDownloadDebridSupported ? (
              <AlertDialogAction
                size="default"
                className="shrink-0 px-4"
                onClick={() => handleBrowserDownloadChoice(true)}
              >
                <CloudDownload className="size-4" />
                Download via Debrid
              </AlertDialogAction>
            ) : null}
            <AlertDialogAction
              size="default"
              variant={
                settings?.debrid?.service && settings?.debrid?.apiKey && browserDownloadDebridSupported
                  ? "outline"
                  : "default"
              }
              className="shrink-0 px-5"
              onClick={() => handleBrowserDownloadChoice(false)}
            >
              {isTorrentFileRequest ? <FileArchive className="size-4" /> : <HardDriveDownload className="size-4" />}
              {isTorrentFileRequest ? "Start Torrent Download" : "Download Normally"}
            </AlertDialogAction>
            <AlertDialogCancel
              size="default"
              className="shrink-0 px-5"
              onClick={() => {
                setPendingBrowserDownload(null);
                setBrowserDownloadDebridSupported(false);
              }}
            >
              Cancel
            </AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export default App;
