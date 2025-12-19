// Library sync utilities
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import { store } from "../store.js";
import { detectCategory, getFolderSize, getMimeType } from "../utils.js";
export function addDownloadToLibrary(download) {
    try {
        const stats = fs.existsSync(download.path) ? fs.statSync(download.path) : null;
        if (!stats)
            return null;
        const library = store.get("library");
        const existing = library.find((l) => l.path === download.path);
        if (existing)
            return existing;
        const item = {
            id: uuidv4(),
            name: download.filename,
            path: download.path,
            size: stats.isDirectory() ? getFolderSize(download.path) : stats.size,
            dateAdded: new Date().toISOString(),
            type: stats.isDirectory() ? "folder" : getMimeType(download.filename),
            category: detectCategory(download.filename),
        };
        library.push(item);
        store.set("library", library);
        console.log(`[Library] Added: ${item.name}`);
        return item;
    }
    catch (err) {
        console.error("[Library] Failed to add item:", err);
        return null;
    }
}
export function syncLibraryWithFilesystem() {
    const library = store.get("library");
    let changed = false;
    const filtered = library.filter((item) => {
        const exists = fs.existsSync(item.path);
        if (!exists) {
            console.log(`[Library] Removing missing item: ${item.path}`);
            changed = true;
            return false;
        }
        return true;
    });
    if (changed) {
        store.set("library", filtered);
    }
}
