// Window control IPC handlers

import { ipcMain, BrowserWindow, shell } from "electron";

export function registerWindowHandlers(getMainWindow: () => BrowserWindow | null) {
  ipcMain.on("window-minimize", () => getMainWindow()?.minimize());
  
  ipcMain.on("window-maximize", () => {
    const win = getMainWindow();
    if (win?.isMaximized()) {
      win.unmaximize();
    } else {
      win?.maximize();
    }
  });
  
  ipcMain.on("window-close", () => getMainWindow()?.close());

  ipcMain.handle("open-external", async (_event, url: string) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new Error("Invalid protocol");
      }
      await shell.openExternal(parsed.toString());
      return { success: true };
    } catch (err) {
      return { success: false, error: `${err}` };
    }
  });
}
