// Settings IPC handlers

import { ipcMain, dialog, app, BrowserWindow } from "electron";
import path from "path";
import { store } from "../store.js";
import { updateTorrentSeeding, callTorrentWorker, activeTorrentIds } from "../torrent.js";
import { activeDownloads } from "../downloads/index.js";

export function registerSettingsHandlers(getMainWindow: () => BrowserWindow | null) {
  ipcMain.handle("get-settings", () => store.get("settings"));

  // Clear all data except bookmarks
  ipcMain.handle("clear-data", async () => {
    try {
      // Cancel all active downloads
      for (const [id, item] of activeDownloads) {
        try {
          item.cancel();
        } catch {}
      }
      activeDownloads.clear();

      // Remove all active torrents
      for (const id of activeTorrentIds) {
        try {
          await callTorrentWorker({ type: "remove", torrentId: id, deleteFiles: false }, 5000);
        } catch {}
      }
      activeTorrentIds.clear();

      // Clear store data (preserve bookmarks)
      store.set("downloads", []);
      store.set("torrents", []);
      store.set("library", []);

      // Reset settings to defaults but keep download path
      const currentSettings = store.get("settings");
      const defaultSettings = {
        downloadPath: currentSettings.downloadPath || path.join(app.getPath("downloads"), "Limbo"),
        maxConcurrentDownloads: 3,
        hardwareAcceleration: true,
        enableSeeding: false,
        startOnBoot: false,
        requireVpn: false,
        autoExtract: true,
        deleteArchiveAfterExtract: false,
        debrid: {
          service: null,
          apiKey: "",
        },
      };
      store.set("settings", defaultSettings);

      console.log("[Settings] Data cleared successfully (bookmarks preserved)");

      return {
        downloads: [],
        torrents: [],
        library: [],
        settings: defaultSettings,
      };
    } catch (err) {
      console.error("[Settings] Failed to clear data:", err);
      throw err;
    }
  });

  ipcMain.handle("update-settings", (_, settings) => {
    const current = store.get("settings");
    const updated = { ...current, ...settings };
    store.set("settings", updated);

    if (typeof settings.enableSeeding === "boolean" && settings.enableSeeding !== current.enableSeeding) {
      updateTorrentSeeding(updated.enableSeeding);
    }

    if (typeof settings.startOnBoot === "boolean" && settings.startOnBoot !== current.startOnBoot) {
      app.setLoginItemSettings({ openAtLogin: settings.startOnBoot, openAsHidden: false });
    }

    return updated;
  });

  ipcMain.handle("select-download-path", async () => {
    const result = await dialog.showOpenDialog(getMainWindow()!, {
      properties: ["openDirectory"],
    });
    if (!result.canceled && result.filePaths[0]) {
      const settings = store.get("settings");
      settings.downloadPath = result.filePaths[0];
      store.set("settings", settings);
      return result.filePaths[0];
    }
    return null;
  });
}
