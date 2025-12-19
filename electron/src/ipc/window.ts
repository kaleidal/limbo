// Window control IPC handlers

import { ipcMain, BrowserWindow } from "electron";

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
}
