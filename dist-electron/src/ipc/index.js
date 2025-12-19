// IPC handlers index - registers all handlers
import { registerWindowHandlers } from "./window.js";
import { registerBookmarkHandlers } from "./bookmarks.js";
import { registerLibraryHandlers } from "./library.js";
import { registerDownloadHandlers } from "./downloads.js";
import { registerSettingsHandlers } from "./settings.js";
import { registerDebridHandlers } from "./debrid.js";
import { registerTorrentHandlers } from "./torrents.js";
export function registerAllIpcHandlers(getMainWindow, getActiveDownloads) {
    registerWindowHandlers(getMainWindow);
    registerBookmarkHandlers(getMainWindow);
    registerLibraryHandlers(getMainWindow);
    registerDownloadHandlers(getMainWindow, getActiveDownloads);
    registerSettingsHandlers(getMainWindow);
    registerDebridHandlers(getMainWindow);
    registerTorrentHandlers(getMainWindow);
}
