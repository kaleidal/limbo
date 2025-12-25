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
import { getGroupId, getGroupName } from "../grouping.js";

export { activeDownloads } from "./speed.js";
export { syncLibraryWithFilesystem } from "./library-sync.js";


export function triggerQueueCheck(getMainWindow: () => BrowserWindow | null) {
  processDownloadQueue(getMainWindow);
}

export function addPendingDownload(download: Download, getMainWindow?: () => BrowserWindow | null) {
  downloadsCache.push(download);
  isCacheDirty = true;
  flushCache();
  processDownloadQueue(getMainWindow);
}

let downloadsCache: Download[] = [];
let isCacheDirty = false;

const lastActivity = new Map<string, number>();
const RETRY_THRESHOLD_MS = 30000;

const processingQueue = new Set<string>();
function loadCache() {
  downloadsCache = store.get("downloads") || [];
}

function flushCache() {
  if (isCacheDirty) {
    store.set("downloads", downloadsCache);
    isCacheDirty = false;
  }
}

setInterval(flushCache, 2000);

function sendStatusUpdate(getMainWindow: (() => BrowserWindow | null) | undefined, downloadId: string) {
  if (!getMainWindow) return;
  const d = downloadsCache.find(x => x.id === downloadId);
  if (!d) return;

  getMainWindow()?.webContents.send("download-progress", {
    id: d.id,
    downloaded: d.received || 0,
    total: d.size || 0,
    status: d.status,
    speed: d.speed || 0,
    extractProgress: d.extractProgress,
    extractStatus: d.extractStatus,
  });
}

function processDownloadQueue(getMainWindow?: () => BrowserWindow | null) {
  const settings = store.get("settings");
  const max = settings.maxConcurrentDownloads || 3;

  // Count running downloads: activeDownloads that are progressing + 
  // cache items marked "downloading" but not yet in activeDownloads (in-flight)
  let runningCount = 0;

  // Count physical active downloads
  for (const [_, item] of activeDownloads) {
    if (item.getState() === "progressing" || item.getState() === "interrupted") {
      runningCount++;
    }
  }

  // Also count "downloading" status in cache that aren't in activeDownloads yet (in-flight)
  for (const d of downloadsCache) {
    if (d.status === "downloading" && !activeDownloads.has(d.id)) {
      runningCount++;
    }
  }

  if (runningCount > max) {
    let toPause = runningCount - max;
    const reversedMap = Array.from(activeDownloads.entries()).reverse();

    for (const [id, item] of reversedMap) {
      if (toPause <= 0) break;
      if (item.getState() === "progressing") {
        item.pause();

        const idx = downloadsCache.findIndex(d => d.id === id);
        if (idx !== -1) {
          downloadsCache[idx].status = "paused";
          isCacheDirty = true;
          sendStatusUpdate(getMainWindow, id);
        }
        toPause--;
        runningCount--;
      }
    }
  }

  if (runningCount < max) {
    for (const d of downloadsCache) {
      if (runningCount >= max) break;
      if (d.status === "paused") {
        const item = activeDownloads.get(d.id);
        if (item && item.canResume()) {
          console.log(`[Queue] Resuming ${d.id}`);
          item.resume();

          const idx = downloadsCache.findIndex(x => x.id === d.id);
          if (idx !== -1) {
            downloadsCache[idx].status = "downloading";
            isCacheDirty = true;
            sendStatusUpdate(getMainWindow, d.id);
          }
          runningCount++;
        }
      }
    }

    // If still have space, start pending downloads
    if (runningCount < max) {
      // Find pending items in cache
      for (const d of downloadsCache) {
        if (runningCount >= max) break;
        if (d.status === "pending") {
          console.log(`[Queue] Starting pending download: ${d.filename || d.url}`);
          d.status = "downloading";
          isCacheDirty = true;
          sendStatusUpdate(getMainWindow, d.id);

          const ses = session.fromPartition("persist:limbo");
          ses.downloadURL(d.url);

          runningCount++;
        }
      }
    }
  }

  if (isCacheDirty) flushCache();
}

// Health check interval (every 5 seconds)
setInterval(() => {
  const now = Date.now();
  processDownloadQueue(); // Also run queue check here

  for (const [id, item] of activeDownloads) {
    if (item.isPaused()) continue;

    if (item.getState() === "interrupted") {
      console.log(`[Health] Download ${id} interrupted, attempting resume...`);
      item.resume();
      continue;
    }

    if (item.getState() === "progressing") {
      const lastTime = lastActivity.get(id) || now;
      if (now - lastTime > RETRY_THRESHOLD_MS) {
        console.warn(`[Health] Download ${id} stalled for ${RETRY_THRESHOLD_MS / 1000}s. Restarting...`);
        item.pause();
        setTimeout(() => {
          if (item.canResume()) {
            item.resume();
            lastActivity.set(id, Date.now());
          }
        }, 1000);
        lastActivity.set(id, now);
      }
    }
  }
}, 5000);


function handleWillDownload(
  getMainWindow: () => BrowserWindow | null,
  item: Electron.DownloadItem,
  _webContents: Electron.WebContents
) {
  const settings = store.get("settings");

  if (!fs.existsSync(settings.downloadPath)) {
    fs.mkdirSync(settings.downloadPath, { recursive: true });
  }

  const url = item.getURL();
  const filename = item.getFilename();

  // Try to find an existing pending/starting download for this URL
  let downloadId = uuidv4();
  let existingIdx = -1;

  existingIdx = downloadsCache.findIndex(d =>
    d.url === url &&
    (d.status === "pending" || d.status === "downloading") &&
    !activeDownloads.has(d.id)
  );

  if (existingIdx !== -1) {
    console.log(`[Download] Matched existing pending download: ${downloadsCache[existingIdx].id}`);
    downloadId = downloadsCache[existingIdx].id;
  }

  const downloadPath = path.join(settings.downloadPath, filename);
  item.setSavePath(downloadPath);

  activeDownloads.set(downloadId, item);
  lastActivity.set(downloadId, Date.now());

  const download: Download = {
    id: downloadId,
    filename: filename,
    path: downloadPath,
    url,
    size: item.getTotalBytes(),
    received: 0,
    status: "downloading",
    startTime: Date.now(),
    groupId: getGroupId(filename),
    groupName: getGroupName(filename),
  };

  if (existingIdx !== -1) {
    downloadsCache[existingIdx] = { ...downloadsCache[existingIdx], ...download };
  } else {
    downloadsCache.push(download);
  }

  isCacheDirty = true;
  flushCache();

  processDownloadQueue();

  console.log(`[Download] Started: ${download.filename} (${downloadId}) -> ${downloadPath}`);

  // Re-send status with updated Groups
  getMainWindow()?.webContents.send("download-started", download);

  // Progress updates
  item.on("updated", (_, state) => {
    lastActivity.set(downloadId, Date.now());

    const idx = downloadsCache.findIndex((d) => d.id === downloadId);
    if (idx === -1) return;

    const receivedBytes = item.getReceivedBytes();
    const totalBytes = item.getTotalBytes();
    const speed = updateSpeedTracker(downloadId, receivedBytes);

    if (state === "progressing") {
      downloadsCache[idx].received = receivedBytes;
      downloadsCache[idx].size = totalBytes || downloadsCache[idx].size;
      downloadsCache[idx].status = item.isPaused() ? "paused" : "downloading";
      downloadsCache[idx].speed = speed;
    } else if (state === "interrupted") {
      downloadsCache[idx].status = "paused";
    }

    isCacheDirty = true;

    getMainWindow()?.webContents.send("download-progress", {
      id: downloadId,
      downloaded: receivedBytes,
      total: totalBytes || downloadsCache[idx].size || 0,
      status: downloadsCache[idx].status,
      speed,
      extractProgress: downloadsCache[idx].extractProgress,
      extractStatus: downloadsCache[idx].extractStatus,
    });
  });

  // Download complete
  item.once("done", (_, state) => {
    activeDownloads.delete(downloadId);
    lastActivity.delete(downloadId);
    cleanupSpeedTracker(downloadId);

    const idx = downloadsCache.findIndex((d) => d.id === downloadId);
    if (idx === -1) return;

    setTimeout(() => processDownloadQueue(getMainWindow), 100);

    if (state === "completed") {
      downloadsCache[idx].status = "completed";
      downloadsCache[idx].received = item.getTotalBytes();
      console.log(`[Download] Completed: ${downloadsCache[idx].filename}`);

      const isPart = downloadsCache[idx].filename.match(/\.part\d+|\.r\d+|\.\d{3}$/i);

      if (!isPart) {
        addDownloadToLibrary(downloadsCache[idx]);
      }

      flushCache();
      flushCache();

      if (!handleMultiPartExtraction(downloadsCache[idx], getMainWindow)) {
        handleSingleExtraction(downloadsCache[idx], getMainWindow);
      }
    } else if (state === "cancelled") {
      // Remove from cache completely so it doesn't reappear
      if (idx !== -1) {
        downloadsCache.splice(idx, 1);
        isCacheDirty = true;
      }
      flushCache();
    } else {
      downloadsCache[idx].status = "error";
      flushCache();
    }

    // Only send the event if it still exists (for error/complete), or just ID for cancelled
    const payload = { id: downloadId, status: state === "cancelled" ? "cancelled" : (downloadsCache[idx]?.status || "error") };
    getMainWindow()?.webContents.send("download-complete", payload);
    getMainWindow()?.webContents.send("download-completed", payload);
  });
}

export function setupDownloadHandler(getMainWindow: () => BrowserWindow | null) {
  loadCache();
  syncLibraryWithFilesystem();

  const ses = session.fromPartition("persist:limbo");
  ses.on("will-download", (event, item, webContents) => {
    handleWillDownload(getMainWindow, item, webContents);
  });

  session.defaultSession.on("will-download", (event, item, webContents) => {
    handleWillDownload(getMainWindow, item, webContents);
  });
}
