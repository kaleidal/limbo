import { contextBridge, ipcRenderer, IpcRendererEvent } from "electron";

// Types for the exposed API
export interface LimboAPI {
  // Window controls
  minimize: () => void;
  maximize: () => void;
  close: () => void;
  openExternal: (url: string) => Promise<{ success: boolean; error?: string }>;

  // Bookmarks
  getBookmarks: () => Promise<Bookmark[]>;
  addBookmark: (bookmark: Omit<Bookmark, "id">) => Promise<Bookmark>;
  removeBookmark: (id: string) => Promise<Bookmark[]>;
  updateBookmark: (bookmark: Bookmark) => Promise<Bookmark[]>;
  resetBookmarks: () => Promise<Bookmark[]>;
  exportBookmarks: () => Promise<string | null>;
  importBookmarks: () => Promise<Bookmark[] | null>;

  // Library
  getLibrary: () => Promise<LibraryItem[]>;
  addToLibrary: (item: Omit<LibraryItem, "id" | "dateAdded">) => Promise<LibraryItem>;
  removeFromLibrary: (id: string, deleteFiles: boolean) => Promise<LibraryItem[]>;
  openFileLocation: (path: string) => Promise<void>;
  openFile: (path: string) => Promise<void>;
  addFolderToLibrary: () => Promise<LibraryItem | null>;

  // Downloads
  getDownloads: () => Promise<Download[]>;
  startDownload: (url: string, options?: { filename?: string; useDebrid?: boolean }) => Promise<{ success: boolean; debridError?: string; warning?: string }>;
  pauseDownload: (id: string) => Promise<void>;
  resumeDownload: (id: string) => Promise<void>;
  cancelDownload: (id: string) => Promise<Download[]>;
  clearCompletedDownloads: () => Promise<Download[]>;
  pauseAllDownloads: () => Promise<void>;
  resumeAllDownloads: () => Promise<void>;

  // Torrents
  getTorrents: () => Promise<TorrentInfo[]>;
  addTorrent: (magnetUri: string) => Promise<TorrentInfo>;
  addTorrentFile: (filePath: string) => Promise<TorrentInfo>;
  pauseTorrent: (id: string) => Promise<void>;
  resumeTorrent: (id: string) => Promise<void>;
  removeTorrent: (id: string, deleteFiles: boolean) => Promise<TorrentInfo[]>;
  isTorrentSupported: () => Promise<boolean>;
  getStreamServerPort: () => Promise<number>;
  getTorrentFiles: (infoHash: string) => Promise<TorrentFile[]>;
  pauseAllTorrents: () => Promise<void>;
  resumeAllTorrents: () => Promise<void>;
  checkVpnStatus: () => Promise<boolean>;

  // Settings
  getSettings: () => Promise<Settings>;
  updateSettings: (settings: Partial<Settings>) => Promise<Settings>;
  selectDownloadPath: () => Promise<string | null>;
  clearData: () => Promise<{ downloads: Download[]; torrents: TorrentInfo[]; library: LibraryItem[]; settings: Settings }>;

  // Debrid
  isDebridConfigured: () => Promise<boolean>;
  convertMagnetDebrid: (magnetUri: string) => Promise<string[]>;
  getSupportedHosts: () => Promise<{ hosts: string[]; error?: string }>;
  realDebridDeviceStart: () => Promise<
    | { success: true; userCode: string; verificationUrl: string; interval: number; expiresIn: number }
    | { success: false; error: string }
  >;
  realDebridDevicePoll: () => Promise<
    | { status: "idle" }
    | { status: "pending" }
    | { status: "expired"; error: string }
    | { status: "success"; accessToken: string }
    | { status: "error"; error: string }
  >;
  realDebridDeviceCancel: () => Promise<{ success: boolean }>;

  // Events
  onDownloadStarted: (callback: (download: Download) => void) => () => void;
  onDownloadProgress: (callback: (progress: DownloadProgress) => void) => () => void;
  onDownloadComplete: (callback: (data: { id: string; status: string }) => void) => () => void;
  onLibraryUpdated: (callback: (library: LibraryItem[]) => void) => () => void;
  onTorrentAdded: (callback: (torrent: TorrentInfo) => void) => () => void;
  onTorrentProgress: (callback: (torrent: TorrentInfo) => void) => () => void;
  onTorrentComplete: (callback: (torrent: TorrentInfo) => void) => () => void;
  onTorrentError: (callback: (data: { id: string; error: string }) => void) => () => void;
  onClipboardDownloadDetected: (callback: (urls: string[]) => void) => () => void;
  onMagnetLinkOpened: (callback: (magnetUri: string) => void) => () => void;
  onTorrentFileOpened: (callback: (filePath: string) => void) => () => void;
  onExtractionProgress: (
    callback: (data: {
      downloadId: string;
      status: string;
      percent?: number;
      message?: string;
      error?: string;
    }) => void
  ) => () => void;
}

interface TorrentFile {
  index: number;
  name: string;
  path: string;
  length: number;
  downloaded: number;
  progress: number;
  streamUrl: string;
}

interface Bookmark {
  id: string;
  name: string;
  url: string;
  favicon: string;
}

interface LibraryItem {
  id: string;
  name: string;
  path: string;
  size: number;
  dateAdded: string;
  icon?: string;
  category?: string;
}

interface Download {
  id: string;
  filename: string;
  url: string;
  path: string;
  size: number;
  downloaded: number;
  status: "pending" | "downloading" | "paused" | "completed" | "error";
  speed?: number;
  eta?: number;
}

interface DownloadProgress {
  id: string;
  downloaded: number;
  total: number;
  status: string;
}

interface Settings {
  downloadPath: string;
  maxConcurrentDownloads: number;
  hardwareAcceleration: boolean;
  enableSeeding: boolean;
  startOnBoot: boolean;
  requireVpn: boolean;
  debrid: {
    service: "realdebrid" | "alldebrid" | "premiumize" | null;
    apiKey: string;
  };
}

interface TorrentInfo {
  id: string;
  name: string;
  magnetUri: string;
  size: number;
  downloaded: number;
  uploaded: number;
  progress: number;
  downloadSpeed: number;
  uploadSpeed: number;
  peers: number;
  seeds: number;
  status: "downloading" | "seeding" | "paused" | "completed" | "error";
  path: string;
  infoHash?: string;
}

const api: LimboAPI = {
  // Window controls
  minimize: () => ipcRenderer.send("window-minimize"),
  maximize: () => ipcRenderer.send("window-maximize"),
  close: () => ipcRenderer.send("window-close"),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),

  // Bookmarks
  getBookmarks: () => ipcRenderer.invoke("get-bookmarks"),
  addBookmark: (bookmark) => ipcRenderer.invoke("add-bookmark", bookmark),
  removeBookmark: (id) => ipcRenderer.invoke("remove-bookmark", id),
  updateBookmark: (bookmark) => ipcRenderer.invoke("update-bookmark", bookmark),
  resetBookmarks: () => ipcRenderer.invoke("reset-bookmarks"),
  exportBookmarks: () => ipcRenderer.invoke("export-bookmarks"),
  importBookmarks: () => ipcRenderer.invoke("import-bookmarks"),

  // Library
  getLibrary: () => ipcRenderer.invoke("get-library"),
  addToLibrary: (item) => ipcRenderer.invoke("add-to-library", item),
  removeFromLibrary: (id, deleteFiles) =>
    ipcRenderer.invoke("remove-from-library", id, deleteFiles),
  openFileLocation: (path) => ipcRenderer.invoke("open-file-location", path),
  openFile: (path) => ipcRenderer.invoke("open-file", path),
  addFolderToLibrary: () => ipcRenderer.invoke("add-folder-to-library"),

  // Downloads
  getDownloads: () => ipcRenderer.invoke("get-downloads"),
  startDownload: (url, options) => ipcRenderer.invoke("start-download", url, options),
  pauseDownload: (id) => ipcRenderer.invoke("pause-download", id),
  resumeDownload: (id) => ipcRenderer.invoke("resume-download", id),
  cancelDownload: (id) => ipcRenderer.invoke("cancel-download", id),
  clearCompletedDownloads: () => ipcRenderer.invoke("clear-completed-downloads"),
  pauseAllDownloads: () => ipcRenderer.invoke("pause-all-downloads"),
  resumeAllDownloads: () => ipcRenderer.invoke("resume-all-downloads"),

  // Torrents
  getTorrents: () => ipcRenderer.invoke("get-torrents"),
  addTorrent: (magnetUri) => ipcRenderer.invoke("add-torrent", magnetUri),
  addTorrentFile: (filePath) => ipcRenderer.invoke("add-torrent-file", filePath),
  pauseTorrent: (id) => ipcRenderer.invoke("pause-torrent", id),
  resumeTorrent: (id) => ipcRenderer.invoke("resume-torrent", id),
  removeTorrent: (id, deleteFiles) => ipcRenderer.invoke("remove-torrent", id, deleteFiles),
  isTorrentSupported: () => ipcRenderer.invoke("is-torrent-supported"),
  getStreamServerPort: () => ipcRenderer.invoke("get-stream-server-port"),
  getTorrentFiles: (infoHash) => ipcRenderer.invoke("get-torrent-files", infoHash),
  pauseAllTorrents: () => ipcRenderer.invoke("pause-all-torrents"),
  resumeAllTorrents: () => ipcRenderer.invoke("resume-all-torrents"),
  checkVpnStatus: () => ipcRenderer.invoke("check-vpn-status"),

  // Settings
  getSettings: () => ipcRenderer.invoke("get-settings"),
  updateSettings: (settings) => ipcRenderer.invoke("update-settings", settings),
  selectDownloadPath: () => ipcRenderer.invoke("select-download-path"),
  clearData: () => ipcRenderer.invoke("clear-data"),

  // Debrid
  isDebridConfigured: () => ipcRenderer.invoke("is-debrid-configured"),
  convertMagnetDebrid: (magnetUri) => ipcRenderer.invoke("convert-magnet-debrid", magnetUri),
  getSupportedHosts: () => ipcRenderer.invoke("get-supported-hosts"),
  realDebridDeviceStart: () => ipcRenderer.invoke("realdebrid-device-start"),
  realDebridDevicePoll: () => ipcRenderer.invoke("realdebrid-device-poll"),
  realDebridDeviceCancel: () => ipcRenderer.invoke("realdebrid-device-cancel"),

  // Events
  onDownloadStarted: (callback) => {
    const handler = (_: IpcRendererEvent, download: Download) => callback(download);
    ipcRenderer.on("download-started", handler);
    return () => ipcRenderer.removeListener("download-started", handler);
  },
  onDownloadProgress: (callback) => {
    const handler = (_: IpcRendererEvent, progress: DownloadProgress) => callback(progress);
    ipcRenderer.on("download-progress", handler);
    return () => ipcRenderer.removeListener("download-progress", handler);
  },
  onDownloadComplete: (callback) => {
    const handler = (_: IpcRendererEvent, data: { id: string; status: string }) =>
      callback(data);
    ipcRenderer.on("download-complete", handler);
    return () => ipcRenderer.removeListener("download-complete", handler);
  },
  onLibraryUpdated: (callback) => {
    const handler = (_: IpcRendererEvent, library: LibraryItem[]) => callback(library);
    ipcRenderer.on("library-updated", handler);
    return () => ipcRenderer.removeListener("library-updated", handler);
  },
  onTorrentAdded: (callback) => {
    const handler = (_: IpcRendererEvent, torrent: TorrentInfo) => callback(torrent);
    ipcRenderer.on("torrent-added", handler);
    return () => ipcRenderer.removeListener("torrent-added", handler);
  },
  onTorrentProgress: (callback) => {
    const handler = (_: IpcRendererEvent, torrent: TorrentInfo) => callback(torrent);
    ipcRenderer.on("torrent-progress", handler);
    return () => ipcRenderer.removeListener("torrent-progress", handler);
  },
  onTorrentComplete: (callback) => {
    const handler = (_: IpcRendererEvent, torrent: TorrentInfo) => callback(torrent);
    ipcRenderer.on("torrent-complete", handler);
    return () => ipcRenderer.removeListener("torrent-complete", handler);
  },
  onTorrentError: (callback) => {
    const handler = (_: IpcRendererEvent, data: { id: string; error: string }) => callback(data);
    ipcRenderer.on("torrent-error", handler);
    return () => ipcRenderer.removeListener("torrent-error", handler);
  },
  onClipboardDownloadDetected: (callback) => {
    const handler = (_: IpcRendererEvent, urls: string[]) => callback(urls);
    ipcRenderer.on("clipboard-download-detected", handler);
    return () => ipcRenderer.removeListener("clipboard-download-detected", handler);
  },
  onMagnetLinkOpened: (callback) => {
    const handler = (_: IpcRendererEvent, magnetUri: string) => callback(magnetUri);
    ipcRenderer.on("magnet-link-opened", handler);
    return () => ipcRenderer.removeListener("magnet-link-opened", handler);
  },
  onTorrentFileOpened: (callback) => {
    const handler = (_: IpcRendererEvent, filePath: string) => callback(filePath);
    ipcRenderer.on("torrent-file-opened", handler);
    return () => ipcRenderer.removeListener("torrent-file-opened", handler);
  },
  onExtractionProgress: (callback) => {
    const handler = (
      _: IpcRendererEvent,
      data: {
        downloadId: string;
        status: string;
        percent?: number;
        message?: string;
        error?: string;
      }
    ) => callback(data);
    ipcRenderer.on("extraction-progress", handler);
    return () => ipcRenderer.removeListener("extraction-progress", handler);
  },
};

contextBridge.exposeInMainWorld("limbo", api);
