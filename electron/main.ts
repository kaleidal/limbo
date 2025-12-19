// Limbo Electron main entry point

import { app, BrowserWindow, clipboard, session, dialog } from "electron";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import Store from "electron-store";
import electronUpdater from "electron-updater";
import log from "electron-log";

import { store } from "./src/store.js";
import { findMagnetArg, findTorrentFileArg } from "./src/utils.js";
import { isDownloadableUrl } from "./src/file-hosts.js";
import { initTorrentWorker, setTorrentEventHandler, shutdownTorrentWorker } from "./src/torrent.js";
import { registerAllIpcHandlers } from "./src/ipc/index.js";
import {
  setupDownloadHandler,
  activeDownloads,
  syncLibraryWithFilesystem,
  shutdownExtractWorker,
} from "./src/downloads/index.js";

const { autoUpdater } = electronUpdater;

// ESM compatibility
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Platform setup
if (process.platform === "win32") {
  app.setAppUserModelId("al.kaleid.limbo");
}

// Check hardware acceleration setting early
const tempStore = new Store({ name: "config" });
const settings = tempStore.get("settings") as any;
if (settings && settings.hardwareAcceleration === false) {
  app.disableHardwareAcceleration();
  console.log("Hardware acceleration disabled by user setting");
}

// Register as magnet and torrent protocol handler
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient("magnet", process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient("magnet");
}

if (process.platform === "win32") {
  app.setAsDefaultProtocolClient("limbo-torrent");
}

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();
let mainWindow: BrowserWindow | null = null;
let pendingMagnetLink: string | null = null;
let pendingTorrentFile: string | null = null;
let clipboardWatcher: ReturnType<typeof setInterval> | null = null;
let librarySyncInterval: ReturnType<typeof setInterval> | null = null;
let lastClipboardContent = "";

let isQuitting = false;

if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", (_, commandLine) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();

      const magnetArg = findMagnetArg(commandLine);
      if (magnetArg) mainWindow.webContents.send("magnet-link-opened", magnetArg);

      const torrentFile = findTorrentFileArg(commandLine);
      if (torrentFile) mainWindow.webContents.send("torrent-file-opened", torrentFile);
    }
  });
}

function initAutoUpdater() {
  if (!app.isPackaged) return;

  try {
    autoUpdater.logger = log;
    (log.transports.file as any).level = "info";

    autoUpdater.on("checking-for-update", () => log.info("Checking for updates..."));
    autoUpdater.on("update-available", (info) => log.info("Update available", info));
    autoUpdater.on("update-not-available", (info) => log.info("No update available", info));
    autoUpdater.on("error", (err) => log.error("Auto-updater error", err));
    autoUpdater.on("download-progress", (progress) => log.info("Update download progress", progress));

    autoUpdater.on("update-downloaded", async () => {
      const result = await dialog.showMessageBox({
        type: "info",
        title: "Update ready",
        message: "An update has been downloaded.",
        detail: "Restart Limbo to apply it now.",
        buttons: ["Restart", "Later"],
        defaultId: 0,
        cancelId: 1,
      });

      if (result.response === 0) {
        autoUpdater.quitAndInstall();
      }
    });

    autoUpdater.checkForUpdates().catch((err) => log.error("Auto-updater check failed", err));
  } catch (err) {
    log.error("Failed to initialize auto-updater", err);
  }
}

function startClipboardMonitoring() {
  clipboardWatcher = setInterval(() => {
    try {
      const text = clipboard.readText().trim();
      if (text && text !== lastClipboardContent) {
        lastClipboardContent = text;

        const potentialUrls = text.split(/[\n\r\s]+/).filter(Boolean);
        const detectedUrls: string[] = [];

        for (const potentialUrl of potentialUrls) {
          if (isDownloadableUrl(potentialUrl.trim())) {
            detectedUrls.push(potentialUrl.trim());
          }
        }

        if (detectedUrls.length === 0 && text.startsWith("magnet:")) {
          detectedUrls.push(text);
        }

        if (detectedUrls.length > 0) {
          mainWindow?.webContents.send("clipboard-download-detected", detectedUrls);
        }
      }
    } catch {
      // Ignore clipboard access errors
    }
  }, 100);
}

function createWindow() {
  const iconPath = path.join(__dirname, "../public/icon.png");

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    frame: false,
    backgroundColor: "#0a0a0a",
    icon: iconPath,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
      webviewTag: true,
    },
  });

  // Persistent session
  const ses = session.fromPartition("persist:limbo");

  app.on("web-contents-created", (_, contents) => {
    if (contents.getType() === "webview") {
      contents.session.setPermissionRequestHandler((_, permission, callback) => {
        callback(true);
      });
    }
  });

  if (process.env.NODE_ENV === "development") {
    mainWindow.loadURL("http://localhost:5173");
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  mainWindow.webContents.on("did-finish-load", () => {
    if (pendingMagnetLink) {
      mainWindow?.webContents.send("magnet-link-opened", pendingMagnetLink);
      pendingMagnetLink = null;
    }
    if (pendingTorrentFile) {
      mainWindow?.webContents.send("torrent-file-opened", pendingTorrentFile);
      pendingTorrentFile = null;
    }
  });

  // Setup download handler
  setupDownloadHandler(() => mainWindow);

  // Setup torrent event handler
  setTorrentEventHandler((event, payload) => {
    if (event === "library-updated") {
      mainWindow?.webContents.send("library-updated", payload);
    } else if (event === "torrent-progress") {
      mainWindow?.webContents.send("torrent-progress", payload);
    } else if (event === "torrent-complete") {
      mainWindow?.webContents.send("torrent-complete", payload);
    } else if (event === "torrent-error") {
      mainWindow?.webContents.send("torrent-error", payload);
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    if (clipboardWatcher) {
      clearInterval(clipboardWatcher);
      clipboardWatcher = null;
    }

    if (librarySyncInterval) {
      clearInterval(librarySyncInterval);
      librarySyncInterval = null;
    }
  });

  startClipboardMonitoring();
  syncLibraryWithFilesystem();

  // Periodic library sync
  librarySyncInterval = setInterval(() => {
    syncLibraryWithFilesystem();
  }, 30000);
}

async function shutdownBackgroundWork() {
  if (clipboardWatcher) {
    clearInterval(clipboardWatcher);
    clipboardWatcher = null;
  }
  if (librarySyncInterval) {
    clearInterval(librarySyncInterval);
    librarySyncInterval = null;
  }

  await Promise.allSettled([shutdownTorrentWorker(), shutdownExtractWorker()]);
}

app.whenReady().then(async () => {
  const torrentWorkerPath = path.join(__dirname, "torrent-worker.js");
  await initTorrentWorker(torrentWorkerPath);

  createWindow();
  initAutoUpdater();

  // Register IPC handlers
  registerAllIpcHandlers(
    () => mainWindow,
    () => activeDownloads
  );

  app.on("open-url", (event, url) => {
    event.preventDefault();
    if (url.startsWith("magnet:")) {
      if (mainWindow) {
        mainWindow.webContents.send("magnet-link-opened", url);
      } else {
        pendingMagnetLink = url;
      }
    }
  });

  app.on("open-file", (event, filePath) => {
    event.preventDefault();
    if (filePath.endsWith(".torrent")) {
      if (mainWindow) {
        mainWindow.webContents.send("torrent-file-opened", filePath);
      } else {
        pendingTorrentFile = filePath;
      }
    }
  });

  const torrentArg = findTorrentFileArg(process.argv);
  if (torrentArg) pendingTorrentFile = torrentArg;

  const magnetArg = findMagnetArg(process.argv);
  if (magnetArg) pendingMagnetLink = magnetArg;
});

app.on("before-quit", (event) => {
  if (isQuitting) return;

  // Ensure background workers/timers are stopped before Electron tears down Node.
  isQuitting = true;
  event.preventDefault();

  shutdownBackgroundWork()
    .catch(() => {})
    .finally(() => {
      app.quit();
    });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (mainWindow === null) {
    createWindow();
  }
});
