// Download IPC handlers

import { ipcMain, session, BrowserWindow } from "electron";
import { store } from "../store.js";
import type { Download } from "../types.js";
import { unrestrictLink } from "../debrid.js";
import { isFileHostUrl, extractFileHostLink } from "../file-hosts.js";

import { v4 as uuidv4 } from "uuid";
import { getGroupId, getGroupName } from "../grouping.js";
import { triggerQueueCheck, addPendingDownload } from "../downloads/handler.js";

export function registerDownloadHandlers(
  getMainWindow: () => BrowserWindow | null,
  getActiveDownloads: () => Map<string, Electron.DownloadItem>
) {
  ipcMain.handle("get-downloads", () => {
    const downloads = store.get("downloads");
    return downloads.map((d) => ({
      id: d.id,
      filename: d.filename,
      url: d.url,
      path: d.path,
      size: d.size,
      downloaded: d.received,
      status: d.status,
      speed: d.speed,
      eta: d.eta,
      extractProgress: d.extractProgress,
      extractStatus: d.extractStatus,
      groupId: d.groupId,
      groupName: d.groupName,
    }));
  });

  ipcMain.handle("pause-download", (_, id: string) => {
    const item = getActiveDownloads().get(id);
    if (item) {
      item.pause();
      console.log(`[Download] Paused download: ${id}`);
    }
  });

  ipcMain.handle("resume-download", async (_, id: string) => {
    const item = getActiveDownloads().get(id);
    if (item) {
      if (item.isPaused()) {
        item.resume();
        console.log(`[Download] Resumed download: ${id}`);
      }
      return;
    }
    const downloads = store.get("downloads");
    const download = downloads.find((d) => d.id === id);
    if (!download || (download.status !== "paused" && download.status !== "downloading")) return;
    console.log(`[Download] Re-starting download ${id} from URL`);
    const ses = session.fromPartition("persist:limbo");
    ses.downloadURL(download.url);
  });

  ipcMain.handle("pause-all-downloads", () => {
    const activeDownloads = getActiveDownloads();
    for (const [id, item] of activeDownloads) {
      if (!item.isPaused()) {
        item.pause();
        console.log(`[Download] Paused: ${id}`);
      }
    }
  });

  ipcMain.handle("resume-all-downloads", async () => {
    const activeDownloads = getActiveDownloads();
    for (const [id, item] of activeDownloads) {
      if (item.isPaused()) {
        item.resume();
        console.log(`[Download] Resumed: ${id}`);
      }
    }
    const downloads = store.get("downloads");
    const ses = session.fromPartition("persist:limbo");
    for (const d of downloads) {
      if (d.status === "paused" && d.url && !activeDownloads.has(d.id)) {
        console.log(`[Download] Re-starting paused download: ${d.id}`);
        ses.downloadURL(d.url);
      }
    }
  });

  ipcMain.handle("cancel-download", (_, id: string) => {
    const item = getActiveDownloads().get(id);
    if (item) item.cancel();
    getActiveDownloads().delete(id);
    const downloads = store.get("downloads").filter((d) => d.id !== id);
    store.set("downloads", downloads);
    return downloads;
  });

  ipcMain.handle("cancel-all-downloads", () => {
    const activeDownloads = getActiveDownloads();
    for (const [id, item] of activeDownloads) {
      item.cancel();
    }
    activeDownloads.clear();

    // Remove all non-terminal downloads (downloading, paused, pending, extracting)
    const downloads = store.get("downloads").filter(
      (d) => d.status === "completed" || d.status === "error"
    );
    store.set("downloads", downloads);
    return downloads;
  });

  ipcMain.handle("clear-completed-downloads", () => {
    const downloads = store.get("downloads").filter(
      (d) => d.status !== "completed" && d.status !== "error"
    );
    store.set("downloads", downloads);
    return downloads;
  });

  ipcMain.handle(
    "start-download",
    async (_, url: string, options?: { filename?: string; useDebrid?: boolean }) => {
      const settings = store.get("settings");
      let finalUrl = url;
      let debridError: string | undefined;
      let warning: string | undefined;

      const shouldUseDebrid =
        options?.useDebrid !== false && settings.debrid.service && settings.debrid.apiKey;

      if (shouldUseDebrid) {
        // Resolve Debrid Link
        const result = await unrestrictLink(url, settings.debrid);
        if (result.url) {
          finalUrl = result.url;
        } else {
          debridError = result.error;
        }
      }

      if (finalUrl === url && isFileHostUrl(url)) {
        const extractedUrl = await extractFileHostLink(url);
        if (extractedUrl) {
          finalUrl = extractedUrl;
        } else {
          warning = "File host detected - download may fail without Debrid.";
        }
      }

      const downloadId = uuidv4();

      let filename = options?.filename || decodeURIComponent(finalUrl.split('/').pop() || "unknown");

      const download: Download = {
        id: downloadId,
        filename: filename,
        path: "", // Will be set when started
        url: finalUrl,
        size: 0,
        received: 0,
        status: "pending", // Start as pending
        startTime: Date.now(),
        groupId: getGroupId(filename),
        groupName: getGroupName(filename),
      };

      addPendingDownload(download, getMainWindow);

      getMainWindow()?.webContents.send("download-started", download);

      return { success: true, debridError, warning };
    }
  );
}
