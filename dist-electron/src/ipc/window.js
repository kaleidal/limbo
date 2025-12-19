// Window control IPC handlers
import { ipcMain } from "electron";
export function registerWindowHandlers(getMainWindow) {
    ipcMain.on("window-minimize", () => getMainWindow()?.minimize());
    ipcMain.on("window-maximize", () => {
        const win = getMainWindow();
        if (win?.isMaximized()) {
            win.unmaximize();
        }
        else {
            win?.maximize();
        }
    });
    ipcMain.on("window-close", () => getMainWindow()?.close());
}
