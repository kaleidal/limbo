"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const api = {
    // Window controls
    minimize: () => electron_1.ipcRenderer.send("window-minimize"),
    maximize: () => electron_1.ipcRenderer.send("window-maximize"),
    close: () => electron_1.ipcRenderer.send("window-close"),
    // Bookmarks
    getBookmarks: () => electron_1.ipcRenderer.invoke("get-bookmarks"),
    addBookmark: (bookmark) => electron_1.ipcRenderer.invoke("add-bookmark", bookmark),
    removeBookmark: (id) => electron_1.ipcRenderer.invoke("remove-bookmark", id),
    updateBookmark: (bookmark) => electron_1.ipcRenderer.invoke("update-bookmark", bookmark),
    resetBookmarks: () => electron_1.ipcRenderer.invoke("reset-bookmarks"),
    exportBookmarks: () => electron_1.ipcRenderer.invoke("export-bookmarks"),
    importBookmarks: () => electron_1.ipcRenderer.invoke("import-bookmarks"),
    // Library
    getLibrary: () => electron_1.ipcRenderer.invoke("get-library"),
    addToLibrary: (item) => electron_1.ipcRenderer.invoke("add-to-library", item),
    removeFromLibrary: (id, deleteFiles) => electron_1.ipcRenderer.invoke("remove-from-library", id, deleteFiles),
    openFileLocation: (path) => electron_1.ipcRenderer.invoke("open-file-location", path),
    openFile: (path) => electron_1.ipcRenderer.invoke("open-file", path),
    addFolderToLibrary: () => electron_1.ipcRenderer.invoke("add-folder-to-library"),
    // Downloads
    getDownloads: () => electron_1.ipcRenderer.invoke("get-downloads"),
    startDownload: (url, filename) => electron_1.ipcRenderer.invoke("start-download", url, filename),
    pauseDownload: (id) => electron_1.ipcRenderer.invoke("pause-download", id),
    resumeDownload: (id) => electron_1.ipcRenderer.invoke("resume-download", id),
    cancelDownload: (id) => electron_1.ipcRenderer.invoke("cancel-download", id),
    clearCompletedDownloads: () => electron_1.ipcRenderer.invoke("clear-completed-downloads"),
    pauseAllDownloads: () => electron_1.ipcRenderer.invoke("pause-all-downloads"),
    resumeAllDownloads: () => electron_1.ipcRenderer.invoke("resume-all-downloads"),
    // Torrents
    getTorrents: () => electron_1.ipcRenderer.invoke("get-torrents"),
    addTorrent: (magnetUri) => electron_1.ipcRenderer.invoke("add-torrent", magnetUri),
    addTorrentFile: (filePath) => electron_1.ipcRenderer.invoke("add-torrent-file", filePath),
    pauseTorrent: (id) => electron_1.ipcRenderer.invoke("pause-torrent", id),
    resumeTorrent: (id) => electron_1.ipcRenderer.invoke("resume-torrent", id),
    removeTorrent: (id, deleteFiles) => electron_1.ipcRenderer.invoke("remove-torrent", id, deleteFiles),
    isTorrentSupported: () => electron_1.ipcRenderer.invoke("is-torrent-supported"),
    getStreamServerPort: () => electron_1.ipcRenderer.invoke("get-stream-server-port"),
    getTorrentFiles: (infoHash) => electron_1.ipcRenderer.invoke("get-torrent-files", infoHash),
    pauseAllTorrents: () => electron_1.ipcRenderer.invoke("pause-all-torrents"),
    resumeAllTorrents: () => electron_1.ipcRenderer.invoke("resume-all-torrents"),
    checkVpnStatus: () => electron_1.ipcRenderer.invoke("check-vpn-status"),
    // Debrid
    isDebridConfigured: () => electron_1.ipcRenderer.invoke("is-debrid-configured"),
    convertMagnetDebrid: (magnetUri) => electron_1.ipcRenderer.invoke("convert-magnet-debrid", magnetUri),
    // Settings
    getSettings: () => electron_1.ipcRenderer.invoke("get-settings"),
    updateSettings: (settings) => electron_1.ipcRenderer.invoke("update-settings", settings),
    selectDownloadPath: () => electron_1.ipcRenderer.invoke("select-download-path"),
    // Events
    onDownloadStarted: (callback) => {
        const handler = (_, download) => callback(download);
        electron_1.ipcRenderer.on("download-started", handler);
        return () => electron_1.ipcRenderer.removeListener("download-started", handler);
    },
    onDownloadProgress: (callback) => {
        const handler = (_, progress) => callback(progress);
        electron_1.ipcRenderer.on("download-progress", handler);
        return () => electron_1.ipcRenderer.removeListener("download-progress", handler);
    },
    onDownloadComplete: (callback) => {
        const handler = (_, data) => callback(data);
        electron_1.ipcRenderer.on("download-complete", handler);
        return () => electron_1.ipcRenderer.removeListener("download-complete", handler);
    },
    onLibraryUpdated: (callback) => {
        const handler = (_, library) => callback(library);
        electron_1.ipcRenderer.on("library-updated", handler);
        return () => electron_1.ipcRenderer.removeListener("library-updated", handler);
    },
    onTorrentAdded: (callback) => {
        const handler = (_, torrent) => callback(torrent);
        electron_1.ipcRenderer.on("torrent-added", handler);
        return () => electron_1.ipcRenderer.removeListener("torrent-added", handler);
    },
    onTorrentProgress: (callback) => {
        const handler = (_, torrent) => callback(torrent);
        electron_1.ipcRenderer.on("torrent-progress", handler);
        return () => electron_1.ipcRenderer.removeListener("torrent-progress", handler);
    },
    onTorrentComplete: (callback) => {
        const handler = (_, torrent) => callback(torrent);
        electron_1.ipcRenderer.on("torrent-complete", handler);
        return () => electron_1.ipcRenderer.removeListener("torrent-complete", handler);
    },
    onTorrentError: (callback) => {
        const handler = (_, data) => callback(data);
        electron_1.ipcRenderer.on("torrent-error", handler);
        return () => electron_1.ipcRenderer.removeListener("torrent-error", handler);
    },
    onClipboardDownloadDetected: (callback) => {
        const handler = (_, urls) => callback(urls);
        electron_1.ipcRenderer.on("clipboard-download-detected", handler);
        return () => electron_1.ipcRenderer.removeListener("clipboard-download-detected", handler);
    },
    onMagnetLinkOpened: (callback) => {
        const handler = (_, magnetUri) => callback(magnetUri);
        electron_1.ipcRenderer.on("magnet-link-opened", handler);
        return () => electron_1.ipcRenderer.removeListener("magnet-link-opened", handler);
    },
    onTorrentFileOpened: (callback) => {
        const handler = (_, filePath) => callback(filePath);
        electron_1.ipcRenderer.on("torrent-file-opened", handler);
        return () => electron_1.ipcRenderer.removeListener("torrent-file-opened", handler);
    },
};
electron_1.contextBridge.exposeInMainWorld("limbo", api);
