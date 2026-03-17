// Main download handler setup

import { session, BrowserWindow } from "electron";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";
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
  downloadsCache.push({
    ...download,
    groupId: shouldGroupDownload(download.filename) ? getGroupId(download.filename) : undefined,
    groupName: shouldGroupDownload(download.filename) ? getGroupName(download.filename) : undefined,
    speed: 0,
    eta: undefined,
  });
  markDirty();
  emitDownloadStarted(getMainWindow, getDownloadById(download.id));
  processDownloadQueue(getMainWindow);
}

let downloadsCache: Download[] = [];
let isCacheDirty = false;

const lastActivity = new Map<string, number>();
const RETRY_THRESHOLD_MS = 30000;
const START_TIMEOUT_MS = 15000;
const dispatchedStarts = new Map<string, number>();
const pendingLaunchIdsByUrl = new Map<string, string[]>();
let listenersRegistered = false;

function loadCache() {
  const loaded = store.get("downloads") || [];
  let changed = false;

  downloadsCache = loaded.map((download) => {
    let next = { ...download };

    if (next.status === "downloading" || next.status === "extracting") {
      next = {
        ...next,
        status: "paused",
        speed: 0,
        eta: undefined,
      };
      changed = true;
    }

    if (shouldGroupDownload(next.filename)) {
      const groupId = getGroupId(next.filename);
      const groupName = getGroupName(next.filename);
      if (next.groupId !== groupId || next.groupName !== groupName) {
        next = { ...next, groupId, groupName };
        changed = true;
      }
    } else if (next.groupId || next.groupName) {
      next = { ...next, groupId: undefined, groupName: undefined };
      changed = true;
    }

    return next;
  });

  if (changed) {
    store.set("downloads", downloadsCache);
  }
}

function flushCache() {
  if (isCacheDirty) {
    store.set("downloads", downloadsCache);
    isCacheDirty = false;
  }
}

setInterval(flushCache, 2000);

function shouldGroupDownload(filename: string) {
  return /\.part\d+\.rar$|\.r\d{2,}$|\.\d{3}$/i.test(filename);
}

function markDirty() {
  isCacheDirty = true;
  flushCache();
}

function getDownloadById(downloadId: string) {
  return downloadsCache.find((download) => download.id === downloadId);
}

function updateDownloadRecord(downloadId: string, updater: (download: Download) => Download | void) {
  const index = downloadsCache.findIndex((download) => download.id === downloadId);
  if (index === -1) return null;

  const current = downloadsCache[index];
  const updated = updater(current) || current;
  downloadsCache[index] = updated;
  markDirty();
  return updated;
}

function emitDownloadStarted(getMainWindow: (() => BrowserWindow | null) | undefined, download?: Download | null) {
  if (!getMainWindow || !download) return;
  getMainWindow()?.webContents.send("download-started", {
    id: download.id,
    filename: download.filename,
    url: download.url,
    path: download.path,
    size: download.size,
    downloaded: download.received,
    status: download.status,
    speed: download.speed,
    eta: download.eta,
    extractProgress: download.extractProgress,
    extractStatus: download.extractStatus,
    groupId: download.groupId,
    groupName: download.groupName,
  });
}

function sendStatusUpdate(getMainWindow: (() => BrowserWindow | null) | undefined, downloadId: string) {
  if (!getMainWindow) return;
  const d = downloadsCache.find((x) => x.id === downloadId);
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
  let runningCount = getRunningCount();

  if (runningCount > max) {
    let toPause = runningCount - max;
    const reversedMap = Array.from(activeDownloads.entries()).reverse();

    for (const [id, item] of reversedMap) {
      if (toPause <= 0) break;
      if (item.getState() === "progressing") {
        item.pause();

        updateDownloadRecord(id, (download) => ({
          ...download,
          status: "paused",
          speed: 0,
          eta: undefined,
        }));
        sendStatusUpdate(getMainWindow, id);
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

          updateDownloadRecord(d.id, (download) => ({
            ...download,
            status: "downloading",
          }));
          sendStatusUpdate(getMainWindow, d.id);
          runningCount++;
        }
      }
    }

    if (runningCount < max) {
      for (const d of downloadsCache) {
        if (runningCount >= max) break;
        if (d.status === "pending") {
          if (dispatchPendingDownload(d, getMainWindow)) {
            runningCount++;
          }
        }
      }
    }
  }

  flushCache();
}

function getRunningCount() {
  let runningCount = 0;

  for (const [, item] of activeDownloads) {
    if (item.getState() === "progressing" || item.getState() === "interrupted") {
      runningCount++;
    }
  }

  runningCount += dispatchedStarts.size;
  return runningCount;
}

function queueLaunchId(download: Download) {
  const queue = pendingLaunchIdsByUrl.get(download.url) || [];
  queue.push(download.id);
  pendingLaunchIdsByUrl.set(download.url, queue);
}

function dequeueLaunchId(url: string) {
  const queue = pendingLaunchIdsByUrl.get(url);
  if (!queue || queue.length === 0) return null;

  const downloadId = queue.shift() || null;
  if (queue.length === 0) pendingLaunchIdsByUrl.delete(url);
  return downloadId;
}

function dispatchPendingDownload(download: Download, getMainWindow?: () => BrowserWindow | null) {
  console.log(`[Queue] Starting pending download: ${download.filename || download.url}`);

  updateDownloadRecord(download.id, (current) => ({
    ...current,
    status: "downloading",
    speed: 0,
    eta: undefined,
  }));
  queueLaunchId(download);
  dispatchedStarts.set(download.id, Date.now());
  sendStatusUpdate(getMainWindow, download.id);

  try {
    const ses = session.fromPartition("persist:limbo");
    ses.downloadURL(download.url);
    return true;
  } catch (error) {
    dispatchedStarts.delete(download.id);
    updateDownloadRecord(download.id, (current) => ({
      ...current,
      status: "error",
      speed: 0,
      eta: undefined,
      extractStatus: error instanceof Error ? error.message : "Failed to start download",
    }));
    sendStatusUpdate(getMainWindow, download.id);
    return false;
  }
}

setInterval(() => {
  const now = Date.now();
  processDownloadQueue(); // Also run queue check here

  for (const [downloadId, startedAt] of dispatchedStarts) {
    if (activeDownloads.has(downloadId)) continue;
    if (now - startedAt < START_TIMEOUT_MS) continue;

    console.warn(`[Health] Download ${downloadId} never entered will-download, marking as error.`);
    dispatchedStarts.delete(downloadId);
    updateDownloadRecord(downloadId, (download) => ({
      ...download,
      status: "error",
      speed: 0,
      eta: undefined,
      extractStatus: "Failed to start download",
    }));
  }

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
  webContents: Electron.WebContents
) {
  const settings = store.get("settings");

  if (!fs.existsSync(settings.downloadPath)) {
    fs.mkdirSync(settings.downloadPath, { recursive: true });
  }

  const url = item.getURL();
  const filename = item.getFilename();
  const matchedId = dequeueLaunchId(url);
  let downloadId = matchedId || item.getURLChain().find((candidateUrl) => dequeueLaunchId(candidateUrl)) || null;

  if (!downloadId) {
    const fallback = downloadsCache.find(
      (download) =>
        download.url === url &&
        (download.status === "pending" || download.status === "downloading") &&
        !activeDownloads.has(download.id)
    );
    downloadId = fallback?.id || null;
  }

  if (!downloadId) {
    if (webContents.getType() === "webview") {
      item.cancel();
      getMainWindow()?.webContents.send("browser-download-requested", {
        url,
        filename,
      });
      console.log(`[Download] Prompting for browser-initiated download: ${url}`);
      return;
    }

    downloadId = randomUUID();
    console.log(`[Download] Adopting unmanaged download for ${url} as ${downloadId}`);
  }

  dispatchedStarts.delete(downloadId);

  const downloadPath = path.join(settings.downloadPath, filename);
  item.setSavePath(downloadPath);

  activeDownloads.set(downloadId, item);
  lastActivity.set(downloadId, Date.now());

  const download: Download = {
    id: downloadId,
    filename,
    path: downloadPath,
    url,
    size: item.getTotalBytes(),
    received: 0,
    status: "downloading",
    startTime: Date.now(),
    groupId: shouldGroupDownload(filename) ? getGroupId(filename) : undefined,
    groupName: shouldGroupDownload(filename) ? getGroupName(filename) : undefined,
    speed: 0,
  };

  const existingIdx = downloadsCache.findIndex((existing) => existing.id === downloadId);
  if (existingIdx !== -1) downloadsCache[existingIdx] = { ...downloadsCache[existingIdx], ...download };
  else downloadsCache.push(download);
  markDirty();

  processDownloadQueue();

  console.log(`[Download] Started: ${download.filename} (${downloadId}) -> ${downloadPath}`);

  emitDownloadStarted(getMainWindow, getDownloadById(downloadId));

  item.on("updated", (_, state) => {
    lastActivity.set(downloadId, Date.now());

    const receivedBytes = item.getReceivedBytes();
    const totalBytes = item.getTotalBytes();
    const speed = updateSpeedTracker(downloadId, receivedBytes);
    updateDownloadRecord(downloadId, (downloadState) => {
      const nextStatus = state === "interrupted"
        ? "paused"
        : item.isPaused()
          ? "paused"
          : "downloading";
      const size = totalBytes || downloadState.size;
      const remaining = Math.max(0, size - receivedBytes);
      const eta = speed > 0 ? Math.ceil(remaining / speed) : undefined;

      return {
        ...downloadState,
        received: receivedBytes,
        size,
        status: nextStatus,
        speed,
        eta,
      };
    });

    getMainWindow()?.webContents.send("download-progress", {
      id: downloadId,
      downloaded: receivedBytes,
      total: totalBytes || getDownloadById(downloadId)?.size || 0,
      status: getDownloadById(downloadId)?.status || "downloading",
      speed,
      extractProgress: getDownloadById(downloadId)?.extractProgress,
      extractStatus: getDownloadById(downloadId)?.extractStatus,
    });
  });

  item.once("done", (_, state) => {
    activeDownloads.delete(downloadId);
    lastActivity.delete(downloadId);
    cleanupSpeedTracker(downloadId);

    const idx = downloadsCache.findIndex((d) => d.id === downloadId);
    if (idx === -1) return;

    setTimeout(() => processDownloadQueue(getMainWindow), 100);

    if (state === "completed") {
      updateDownloadRecord(downloadId, (downloadState) => ({
        ...downloadState,
        status: "completed",
        received: item.getTotalBytes(),
        size: item.getTotalBytes() || downloadState.size,
        speed: 0,
        eta: undefined,
      }));
      console.log(`[Download] Completed: ${downloadsCache[idx].filename}`);

      const isPart = downloadsCache[idx].filename.match(/\.part\d+|\.r\d+|\.\d{3}$/i);

      if (!isPart) {
        addDownloadToLibrary(downloadsCache[idx]);
        getMainWindow()?.webContents.send("library-updated", store.get("library"));
      }

      flushCache();

      if (!handleMultiPartExtraction(downloadsCache[idx], getMainWindow)) {
        handleSingleExtraction(downloadsCache[idx], getMainWindow);
      }
    } else if (state === "cancelled") {
      removeDownload(downloadId);
    } else {
      updateDownloadRecord(downloadId, (downloadState) => ({
        ...downloadState,
        status: "error",
        speed: 0,
        eta: undefined,
      }));
    }

    const payload = {
      id: downloadId,
      status: state === "cancelled" ? "cancelled" : (downloadsCache[idx]?.status || "error"),
    };
    getMainWindow()?.webContents.send("download-complete", payload);
    getMainWindow()?.webContents.send("download-completed", payload);
  });
}

function removeDownload(downloadId: string) {
  dispatchedStarts.delete(downloadId);
  pendingLaunchIdsByUrl.forEach((queue, url) => {
    const filtered = queue.filter((id) => id !== downloadId);
    if (filtered.length === 0) pendingLaunchIdsByUrl.delete(url);
    else pendingLaunchIdsByUrl.set(url, filtered);
  });

  const index = downloadsCache.findIndex((download) => download.id === downloadId);
  if (index === -1) return null;
  const [removed] = downloadsCache.splice(index, 1);
  markDirty();
  return removed;
}

export function getDownloadsSnapshot() {
  return downloadsCache.map((download) => ({
    ...download,
    downloaded: download.received,
  }));
}

export function pauseDownload(downloadId: string, getMainWindow?: () => BrowserWindow | null) {
  const item = activeDownloads.get(downloadId);
  if (item && !item.isPaused()) {
    item.pause();
  }

  const updated = updateDownloadRecord(downloadId, (download) => ({
    ...download,
    status: "paused",
    speed: 0,
    eta: undefined,
  }));
  if (updated) sendStatusUpdate(getMainWindow, downloadId);
}

export function resumeDownload(downloadId: string, getMainWindow?: () => BrowserWindow | null) {
  const item = activeDownloads.get(downloadId);
  if (item && item.isPaused()) {
    item.resume();
    updateDownloadRecord(downloadId, (download) => ({ ...download, status: "downloading" }));
    sendStatusUpdate(getMainWindow, downloadId);
    return;
  }

  const updated = updateDownloadRecord(downloadId, (download) => ({
    ...download,
    status: "pending",
    speed: 0,
    eta: undefined,
  }));

  if (updated) {
    sendStatusUpdate(getMainWindow, downloadId);
    processDownloadQueue(getMainWindow);
  }
}

export function cancelDownload(downloadId: string, getMainWindow?: () => BrowserWindow | null) {
  const item = activeDownloads.get(downloadId);
  if (item) item.cancel();
  activeDownloads.delete(downloadId);
  cleanupSpeedTracker(downloadId);
  removeDownload(downloadId);
  processDownloadQueue(getMainWindow);
  return getDownloadsSnapshot();
}

export function cancelAllDownloads(getMainWindow?: () => BrowserWindow | null) {
  for (const [, item] of activeDownloads) {
    item.cancel();
  }
  activeDownloads.clear();
  downloadsCache = downloadsCache.filter(
    (download) => download.status === "completed" || download.status === "error"
  );
  dispatchedStarts.clear();
  pendingLaunchIdsByUrl.clear();
  markDirty();
  processDownloadQueue(getMainWindow);
  return getDownloadsSnapshot();
}

export function clearCompletedDownloads() {
  downloadsCache = downloadsCache.filter(
    (download) => download.status !== "completed" && download.status !== "error"
  );
  markDirty();
  return getDownloadsSnapshot();
}

export function setupDownloadHandler(getMainWindow: () => BrowserWindow | null) {
  loadCache();
  syncLibraryWithFilesystem();

  if (listenersRegistered) return;
  listenersRegistered = true;

  const ses = session.fromPartition("persist:limbo");
  ses.on("will-download", (_event, item, webContents) => {
    handleWillDownload(getMainWindow, item, webContents);
  });

  session.defaultSession.on("will-download", (_event, item, webContents) => {
    handleWillDownload(getMainWindow, item, webContents);
  });
}
