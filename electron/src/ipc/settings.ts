// Settings IPC handlers

import { ipcMain, dialog, app, BrowserWindow } from "electron";
import path from "path";
import { store } from "../store.js";
import { updateTorrentSeeding, callTorrentWorker, activeTorrentIds } from "../torrent.js";
import { activeDownloads } from "../downloads/index.js";
import { startApiServer, stopApiServer } from "../api/server.js";
import { ensureApiToken } from "../api/discovery.js";

export function registerSettingsHandlers(getMainWindow: () => BrowserWindow | null) {
  ipcMain.handle("get-settings", () => store.get("settings"));

  // Clear all data except bookmarks
  ipcMain.handle("clear-data", async () => {
    try {
      // Cancel all active downloads
      for (const [, item] of activeDownloads) {
        try {
          item.cancel();
        } catch (error) {
          console.warn("[Settings] Failed to cancel active download during clear-data", error);
        }
      }
      activeDownloads.clear();

      // Remove all active torrents
      for (const id of activeTorrentIds) {
        try {
          await callTorrentWorker({ type: "remove", torrentId: id, deleteFiles: false }, 5000);
        } catch (error) {
          console.warn(`[Settings] Failed to remove torrent ${id} during clear-data`, error);
        }
      }
      activeTorrentIds.clear();

      // Clear store data (preserve bookmarks)
      store.set("downloads", []);
      store.set("torrents", []);
      store.set("library", []);
      store.set("extractedGroups", []);

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
        apiEnabled: currentSettings.apiEnabled !== false,
        apiPort: currentSettings.apiPort || 17890,
        apiToken: currentSettings.apiToken || "",
        apiPromptPolicy: currentSettings.apiPromptPolicy || "always",
        trustedApiClients: currentSettings.trustedApiClients || [],
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

  ipcMain.handle("update-settings", async (_, settings) => {
    const current = store.get("settings");
    const updated = { ...current, ...settings };
    if (!updated.apiToken) {
      updated.apiToken = ensureApiToken();
    }
    store.set("settings", updated);

    if (typeof settings.enableSeeding === "boolean" && settings.enableSeeding !== current.enableSeeding) {
      updateTorrentSeeding(updated.enableSeeding);
    }

    if (typeof settings.startOnBoot === "boolean" && settings.startOnBoot !== current.startOnBoot) {
      app.setLoginItemSettings({ openAtLogin: settings.startOnBoot, openAsHidden: false });
    }

    const apiChanged =
      (typeof settings.apiEnabled === "boolean" && settings.apiEnabled !== current.apiEnabled) ||
      (typeof settings.apiPort === "number" && settings.apiPort !== current.apiPort);

    if (apiChanged) {
      await stopApiServer();
      if (updated.apiEnabled !== false) {
        await startApiServer();
      }
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
