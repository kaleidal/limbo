import { useEffect } from "react";
import { app, appWindow, events as sabineEvents, guest } from "@lantharos/sabine";
import { commands, events } from "@/lib/bindings";
import { addTorrentFile, isMagnet, pathFromFileUrl } from "@/lib/transfers";
import { useAppStore } from "@/store/app-store";

export type BrowserDownloadRequest = {
  url: string;
  filename: string;
};

async function openPendingUrls() {
  for (const url of await app.takeOpenUrls()) {
    if (isMagnet(url)) {
      useAppStore.getState().showIncomingLinks([url]);
    } else if (url.startsWith("file:") && url.toLowerCase().endsWith(".torrent")) {
      await addTorrentFile(pathFromFileUrl(url));
    }
  }
}

/** Keeps the store in step with the desktop host and routes what the desktop hands Limbo. */
export function useDesktopIntegration(onBrowserDownload: (request: BrowserDownloadRequest) => void) {
  useEffect(() => {
    const store = useAppStore.getState;
    const unsubscribers = [
      events.downloadUpdated((download) => store().upsertDownload(download)),
      events.downloadRemoved(({ id }) => store().removeDownload(id)),
      events.torrentUpdated((torrent) => store().upsertTorrent(torrent)),
      events.torrentRemoved(({ id }) => store().removeTorrent(id)),
      events.libraryUpdated((library) => store().setLibrary(library)),
      events.clipboardLinks((links) => {
        const visible =
          store().currentView === "browser" ? links.filter((link) => !isMagnet(link)) : links;
        if (visible.length > 0) store().showIncomingLinks(visible, true);
      }),
      sabineEvents.trayActivate(({ itemId }) => {
        if (itemId === "quit") {
          void commands.appQuit();
          return;
        }
        appWindow.show();
        appWindow.focus();
      }),
      sabineEvents.guestDownload((download) => {
        if (download.state !== "requested") return;
        void guest.downloadAction(download.downloadId, "cancel").catch(() => undefined);
        onBrowserDownload({ url: download.url, filename: download.filename || "download" });
      }),
      sabineEvents.openUrlsAvailable(() => void openPendingUrls()),
    ];
    void store().initializeData();
    void openPendingUrls();
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [onBrowserDownload]);
}
