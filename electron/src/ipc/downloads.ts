// Download IPC handlers

import { ipcMain, BrowserWindow } from "electron";
import { store } from "../store.js";
import type { Download } from "../types.js";
import { unrestrictLink } from "../debrid.js";
import { isFileHostUrl, extractFileHostLink } from "../file-hosts.js";

import { v4 as uuidv4 } from "uuid";
import { getGroupId, getGroupName } from "../grouping.js";
import {
  addPendingDownload,
  cancelAllDownloads,
  cancelDownload,
  clearCompletedDownloads,
  getDownloadsSnapshot,
  pauseDownload,
  resumeDownload,
} from "../downloads/handler.js";

export function registerDownloadHandlers(
  getMainWindow: () => BrowserWindow | null,
  getActiveDownloads: () => Map<string, Electron.DownloadItem>
) {
  void getActiveDownloads;

  ipcMain.handle("get-downloads", () => {
    return getDownloadsSnapshot();
  });

  ipcMain.handle("pause-download", (_, id: string) => {
    pauseDownload(id, getMainWindow);
    console.log(`[Download] Paused download: ${id}`);
  });

  ipcMain.handle("resume-download", async (_, id: string) => {
    resumeDownload(id, getMainWindow);
    console.log(`[Download] Resumed download: ${id}`);
  });

  ipcMain.handle("pause-all-downloads", () => {
    for (const download of store.get("downloads")) {
      if (download.status === "downloading" || download.status === "pending") {
        pauseDownload(download.id, getMainWindow);
        console.log(`[Download] Paused: ${download.id}`);
      }
    }
  });

  ipcMain.handle("resume-all-downloads", async () => {
    for (const download of store.get("downloads")) {
      if (download.status === "paused") {
        resumeDownload(download.id, getMainWindow);
        console.log(`[Download] Resumed: ${download.id}`);
      }
    }
  });

  ipcMain.handle("cancel-download", (_, id: string) => {
    return cancelDownload(id, getMainWindow);
  });

  ipcMain.handle("cancel-all-downloads", () => {
    return cancelAllDownloads(getMainWindow);
  });

  ipcMain.handle("clear-completed-downloads", () => {
    return clearCompletedDownloads();
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

      const filename = options?.filename || decodeURIComponent(finalUrl.split('/').pop() || "unknown");

      const download: Download = {
        id: downloadId,
        filename,
        path: "", // Will be set when started
        url: finalUrl,
        size: 0,
        received: 0,
        status: "pending", // Start as pending
        startTime: Date.now(),
        groupId: /\.part\d+\.rar$|\.r\d{2,}$|\.\d{3}$/i.test(filename) ? getGroupId(filename) : undefined,
        groupName: /\.part\d+\.rar$|\.r\d{2,}$|\.\d{3}$/i.test(filename) ? getGroupName(filename) : undefined,
      };

      addPendingDownload(download, getMainWindow);

      return { success: true, debridError, warning };
    }
  );
}
