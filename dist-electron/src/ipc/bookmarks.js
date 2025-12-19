// Bookmark IPC handlers
import { ipcMain, dialog, app } from "electron";
import path from "path";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import { store } from "../store.js";
export function registerBookmarkHandlers(getMainWindow) {
    ipcMain.handle("get-bookmarks", () => store.get("bookmarks"));
    ipcMain.handle("add-bookmark", (_, bookmark) => {
        const bookmarks = store.get("bookmarks");
        const newBookmark = { ...bookmark, id: uuidv4() };
        bookmarks.push(newBookmark);
        store.set("bookmarks", bookmarks);
        return newBookmark;
    });
    ipcMain.handle("remove-bookmark", (_, id) => {
        const bookmarks = store.get("bookmarks").filter((b) => b.id !== id);
        store.set("bookmarks", bookmarks);
        return bookmarks;
    });
    ipcMain.handle("update-bookmark", (_, bookmark) => {
        const bookmarks = store.get("bookmarks");
        const idx = bookmarks.findIndex((b) => b.id === bookmark.id);
        if (idx !== -1) {
            bookmarks[idx] = bookmark;
            store.set("bookmarks", bookmarks);
        }
        return bookmarks;
    });
    ipcMain.handle("reset-bookmarks", () => {
        const defaults = [
            {
                id: "1",
                name: "Internet Archive",
                url: "https://archive.org",
                favicon: "https://www.google.com/s2/favicons?domain=archive.org&sz=64",
            },
        ];
        store.set("bookmarks", defaults);
        return defaults;
    });
    ipcMain.handle("export-bookmarks", async () => {
        const bookmarks = store.get("bookmarks");
        const result = await dialog.showSaveDialog(getMainWindow(), {
            title: "Export bookmarks",
            defaultPath: path.join(app.getPath("documents"), "limbo-bookmarks.json"),
            filters: [{ name: "JSON", extensions: ["json"] }],
        });
        if (result.canceled || !result.filePath)
            return null;
        fs.writeFileSync(result.filePath, JSON.stringify(bookmarks, null, 2), "utf-8");
        return result.filePath;
    });
    ipcMain.handle("import-bookmarks", async () => {
        const result = await dialog.showOpenDialog(getMainWindow(), {
            title: "Import bookmarks",
            properties: ["openFile"],
            filters: [{ name: "JSON", extensions: ["json"] }],
        });
        if (result.canceled || !result.filePaths[0])
            return null;
        const raw = fs.readFileSync(result.filePaths[0], "utf-8");
        const parsed = JSON.parse(raw);
        const bookmarks = sanitizeBookmarks(parsed);
        store.set("bookmarks", bookmarks);
        return bookmarks;
    });
}
// Helper functions
function buildFaviconUrl(url) {
    try {
        const u = new URL(url);
        return `https://www.google.com/s2/favicons?domain=${u.hostname}&sz=64`;
    }
    catch {
        return "";
    }
}
function normalizeBookmarkUrl(value) {
    const raw = String(value || "").trim();
    if (!raw)
        return null;
    try {
        const candidate = raw.startsWith("http://") || raw.startsWith("https://") ? raw : `https://${raw}`;
        const u = new URL(candidate);
        if (!u.hostname)
            return null;
        if (!["http:", "https:"].includes(u.protocol))
            return null;
        return u.toString();
    }
    catch {
        return null;
    }
}
function sanitizeBookmarks(input) {
    if (!Array.isArray(input))
        return [];
    const result = [];
    const seenIds = new Set();
    for (const entry of input) {
        if (!entry || typeof entry !== "object")
            continue;
        const obj = entry;
        const normalizedUrl = normalizeBookmarkUrl(obj.url);
        if (!normalizedUrl)
            continue;
        const nameRaw = typeof obj.name === "string" ? obj.name.trim() : "";
        let name = nameRaw;
        if (!name) {
            try {
                name = new URL(normalizedUrl).hostname;
            }
            catch {
                name = "Bookmark";
            }
        }
        let id = typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : uuidv4();
        while (seenIds.has(id))
            id = uuidv4();
        seenIds.add(id);
        const favicon = typeof obj.favicon === "string" && obj.favicon.trim()
            ? obj.favicon.trim()
            : buildFaviconUrl(normalizedUrl);
        result.push({ id, name, url: normalizedUrl, favicon });
    }
    return result;
}
