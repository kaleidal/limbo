import { useEffect } from "react";
import { useAppStore } from "@/store/app-store";
import { Sidebar } from "@/components/sidebar";
import { TitleBar } from "@/components/title-bar";
import { LibraryView } from "@/components/views/library-view";
import { DownloadsView } from "@/components/views/downloads-view";
import { BrowserView } from "@/components/views/browser-view";
import { SettingsView } from "@/components/views/settings-view";
import { AddBookmarkDialog } from "@/components/dialogs/add-bookmark-dialog";
import { ClipboardMonitor } from "@/components/clipboard-monitor";

export function App() {
  const {
    currentView,
    initializeData,
    setLibrary,
    addDownload,
    updateDownload,
    addTorrent,
    updateTorrent,
  } = useAppStore();

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
          status: progress.status as any,
          extractProgress: progress.extractProgress,
          extractStatus: progress.extractStatus,
        });
      });

      const unsubComplete = window.limbo.onDownloadComplete((data) => {
        updateDownload(data.id, { status: data.status as any });
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

      return () => {
        unsubStarted();
        unsubProgress();
        unsubComplete();
        unsubLibrary();
        unsubTorrentAdded();
        unsubTorrentProgress();
        unsubTorrentComplete();
        unsubTorrentError();
      };
    }
  }, []);

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
    <div className="flex flex-col h-screen bg-neutral-950 text-neutral-100">
      <TitleBar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-hidden">{renderView()}</main>
      </div>
      <AddBookmarkDialog />
      <ClipboardMonitor />
    </div>
  );
}

export default App;