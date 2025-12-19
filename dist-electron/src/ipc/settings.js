// Settings IPC handlers
import { ipcMain, dialog, app } from "electron";
import { store } from "../store.js";
import { updateTorrentSeeding } from "../torrent.js";
export function registerSettingsHandlers(getMainWindow) {
    ipcMain.handle("get-settings", () => store.get("settings"));
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
        const result = await dialog.showOpenDialog(getMainWindow(), {
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
