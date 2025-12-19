// Debrid IPC handlers

import { ipcMain, BrowserWindow } from "electron";
import { store } from "../store.js";
import { convertMagnetWithDebrid } from "../debrid.js";

export function registerDebridHandlers(getMainWindow: () => BrowserWindow | null) {
  ipcMain.handle("is-debrid-configured", () => {
    const settings = store.get("settings");
    return settings.debrid.service !== null && settings.debrid.apiKey !== "";
  });

  ipcMain.handle("convert-magnet-debrid", async (_, magnetUri: string) => {
    const settings = store.get("settings");
    if (!settings.debrid.service || !settings.debrid.apiKey) {
      throw new Error("Debrid service not configured");
    }
    const links = await convertMagnetWithDebrid(magnetUri, settings.debrid);
    if (!links || links.length === 0) {
      throw new Error("Failed to convert magnet link");
    }
    for (const link of links) {
      getMainWindow()?.webContents.downloadURL(link);
    }
    return links;
  });
}
