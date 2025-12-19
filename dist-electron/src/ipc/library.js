// Library IPC handlers
import { ipcMain, dialog, shell } from "electron";
import path from "path";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import { store } from "../store.js";
import { getFolderSize } from "../utils.js";
export function registerLibraryHandlers(getMainWindow) {
    ipcMain.handle("get-library", () => store.get("library"));
    ipcMain.handle("add-to-library", (_, item) => {
        const library = store.get("library");
        const newItem = { ...item, id: uuidv4(), dateAdded: new Date().toISOString() };
        library.push(newItem);
        store.set("library", library);
        return newItem;
    });
    ipcMain.handle("remove-from-library", async (_, id, deleteFiles) => {
        const library = store.get("library");
        const item = library.find((l) => l.id === id);
        if (item && deleteFiles) {
            try {
                if (fs.existsSync(item.path)) {
                    fs.rmSync(item.path, { recursive: true });
                }
            }
            catch (err) {
                console.error("Failed to delete files:", err);
            }
        }
        const newLibrary = library.filter((l) => l.id !== id);
        store.set("library", newLibrary);
        return newLibrary;
    });
    ipcMain.handle("open-file-location", (_, filePath) => {
        if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
            shell.openPath(filePath);
        }
        else {
            shell.showItemInFolder(filePath);
        }
    });
    ipcMain.handle("open-file", (_, filePath) => {
        shell.openPath(filePath);
    });
    ipcMain.handle("add-folder-to-library", async () => {
        const result = await dialog.showOpenDialog(getMainWindow(), {
            properties: ["openDirectory"],
        });
        if (!result.canceled && result.filePaths[0]) {
            const folderPath = result.filePaths[0];
            const folderName = path.basename(folderPath);
            const library = store.get("library");
            const newItem = {
                id: uuidv4(),
                name: folderName,
                path: folderPath,
                size: getFolderSize(folderPath),
                dateAdded: new Date().toISOString(),
            };
            library.push(newItem);
            store.set("library", library);
            return newItem;
        }
        return null;
    });
}
