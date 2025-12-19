// Electron webview element type
export interface ElectronWebviewElement extends HTMLElement {
  src: string;
  partition: string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getTitle(): string;
  isLoading(): boolean;
  addEventListener(event: string, callback: (e: any) => void): void;
  removeEventListener(event: string, callback: (e: any) => void): void;
}

export interface Bookmark {
  id: string;
  name: string;
  url: string;
  favicon: string;
}

export interface LibraryItem {
  id: string;
  name: string;
  path: string;
  size: number;
  dateAdded: string;
  icon?: string;
  category?: string;
}

export interface Download {
  id: string;
  filename: string;
  url: string;
  path: string;
  size: number;
  downloaded: number;
  status: "pending" | "downloading" | "paused" | "completed" | "error" | "extracting";
  speed?: number;
  eta?: number;
  extractProgress?: number;
  extractStatus?: string;
}

export interface DownloadProgress {
  id: string;
  downloaded: number;
  total: number;
  status: string;
  extractProgress?: number;
  extractStatus?: string;
}

export interface Settings {
  downloadPath: string;
  maxConcurrentDownloads: number;
  hardwareAcceleration: boolean;
  debrid: {
    service: "realdebrid" | "alldebrid" | "premiumize" | null;
    apiKey: string;
  };
}

export interface TorrentInfo {
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

export interface TorrentFile {
  index: number;
  name: string;
  path: string;
  length: number;
  downloaded: number;
  progress: number;
  streamUrl: string;
}

export interface LimboAPI {
  // Window controls
  minimize: () => void;
  maximize: () => void;
  close: () => void;

  // Bookmarks
  getBookmarks: () => Promise<Bookmark[]>;
  addBookmark: (bookmark: Omit<Bookmark, "id">) => Promise<Bookmark>;
  removeBookmark: (id: string) => Promise<Bookmark[]>;
  updateBookmark: (bookmark: Bookmark) => Promise<Bookmark[]>;
  resetBookmarks: () => Promise<Bookmark[]>;

  // Library
  getLibrary: () => Promise<LibraryItem[]>;
  addToLibrary: (item: Omit<LibraryItem, "id" | "dateAdded">) => Promise<LibraryItem>;
  removeFromLibrary: (id: string, deleteFiles: boolean) => Promise<LibraryItem[]>;
  openFileLocation: (path: string) => Promise<void>;
  openFile: (path: string) => Promise<void>;
  addFolderToLibrary: () => Promise<LibraryItem | null>;

  // Downloads
  getDownloads: () => Promise<Download[]>;
  startDownload: (url: string, filename?: string) => Promise<boolean>;
  pauseDownload: (id: string) => Promise<void>;
  resumeDownload: (id: string) => Promise<void>;
  cancelDownload: (id: string) => Promise<Download[]>;
  clearCompletedDownloads: () => Promise<Download[]>;

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

  // Debrid
  isDebridConfigured: () => Promise<boolean>;
  convertMagnetDebrid: (magnetUri: string) => Promise<string[]>;

  // Settings
  getSettings: () => Promise<Settings>;
  updateSettings: (settings: Partial<Settings>) => Promise<Settings>;
  selectDownloadPath: () => Promise<string | null>;

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
}

declare global {
  interface Window {
    limbo: LimboAPI;
  }
}
