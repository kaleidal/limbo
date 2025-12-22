// Main download handler setup

import { session, BrowserWindow } from "electron";
import path from "path";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import { store } from "../store.js";
import type { Download } from "../types.js";
import { activeDownloads, updateSpeedTracker, cleanupSpeedTracker } from "./speed.js";
import { handleMultiPartExtraction, handleSingleExtraction } from "./extraction.js";
import { addDownloadToLibrary, syncLibraryWithFilesystem } from "./library-sync.js";

// Re-export for external access
export { activeDownloads } from "./speed.js";
export { syncLibraryWithFilesystem } from "./library-sync.js";

function handleWillDownload(
  getMainWindow: () => BrowserWindow | null,
  item: Electron.DownloadItem,
  _webContents: Electron.WebContents
) {
  const settings = store.get("settings");
  
  // Ensure download directory exists
  if (!fs.existsSync(settings.downloadPath)) {
    fs.mkdirSync(settings.downloadPath, { recursive: true });
  }

  const downloadPath = path.join(settings.downloadPath, item.getFilename());
  
  // CRITICAL: Set save path immediately to prevent save dialog
  item.setSavePath(downloadPath);

  const downloadId = uuidv4();
  const url = item.getURL();

  activeDownloads.set(downloadId, item);

  const download: Download = {
    id: downloadId,
    filename: item.getFilename(),
    path: downloadPath,
    url,
    size: item.getTotalBytes(),
    received: 0,
    status: "downloading",
    startTime: Date.now(),
  };

  const downloads = store.get("downloads");
  downloads.push(download);
  store.set("downloads", downloads);

  console.log(`[Download] Started: ${download.filename} (${downloadId}) -> ${downloadPath}`);
  getMainWindow()?.webContents.send("download-started", download);

  // Progress updates
  item.on("updated", (_, state) => {
    const downloads = store.get("downloads");
    const idx = downloads.findIndex((d) => d.id === downloadId);
    if (idx === -1) return;

    const receivedBytes = item.getReceivedBytes();
    const totalBytes = item.getTotalBytes();
    const speed = updateSpeedTracker(downloadId, receivedBytes);

    if (state === "progressing") {
      downloads[idx].received = receivedBytes;
      downloads[idx].size = totalBytes || downloads[idx].size;
      downloads[idx].status = item.isPaused() ? "paused" : "downloading";
    } else if (state === "interrupted") {
      downloads[idx].status = "paused";
    }

    store.set("downloads", downloads);

    getMainWindow()?.webContents.send("download-progress", {
      id: downloadId,
      received: receivedBytes,
      size: totalBytes,
      status: downloads[idx].status,
      speed,
    });
  });

  // Download complete
  item.once("done", (_, state) => {
    activeDownloads.delete(downloadId);
    cleanupSpeedTracker(downloadId);

    const downloads = store.get("downloads");
    const idx = downloads.findIndex((d) => d.id === downloadId);
    if (idx === -1) return;

    if (state === "completed") {
      downloads[idx].status = "completed";
      downloads[idx].received = item.getTotalBytes();
      console.log(`[Download] Completed: ${downloads[idx].filename}`);

      // Add to library
      addDownloadToLibrary(downloads[idx]);

      // Handle extraction
      if (!handleMultiPartExtraction(downloads[idx], getMainWindow)) {
        handleSingleExtraction(downloads[idx], getMainWindow);
      }
    } else if (state === "cancelled") {
      downloads[idx].status = "cancelled";
    } else {
      downloads[idx].status = "error";
    }

    store.set("downloads", downloads);

    getMainWindow()?.webContents.send("download-completed", {
      id: downloadId,
      status: downloads[idx].status,
    });
  });
}

export function setupDownloadHandler(getMainWindow: () => BrowserWindow | null) {
  // Sync library on startup
  syncLibraryWithFilesystem();

  // Handle downloads from the persist:limbo partition (webview)
  const ses = session.fromPartition("persist:limbo");
  ses.on("will-download", (event, item, webContents) => {
    handleWillDownload(getMainWindow, item, webContents);
  });

  // Also handle downloads from the default session (main window)
  session.defaultSession.on("will-download", (event, item, webContents) => {
    handleWillDownload(getMainWindow, item, webContents);
  });
}
