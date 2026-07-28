type ListenerMap = Map<string, Set<(payload: unknown) => void>>;

declare global {
  interface Window {
    fenestra?: {
      window: {
        minimize: () => void;
        maximize: () => void;
        toggleMaximize?: () => void;
        close: () => void;
      };
      bridge: {
        invoke: (name: string, params?: unknown) => Promise<unknown>;
        listen: (name: string, callback: (payload: unknown) => void) => () => void;
      };
      guest?: {
        create: (options: Record<string, unknown>) => Promise<{ id: string }>;
        destroy: (id: string) => Promise<void>;
        navigate: (id: string, url: string) => Promise<void>;
        setBounds: (id: string, bounds: { x: number; y: number; width: number; height: number }) => Promise<void>;
        setVisible: (id: string, visible: boolean) => Promise<void>;
        setCovered: (covered: boolean) => Promise<void>;
        focus: (id: string) => Promise<void>;
        reload: (id: string) => Promise<void>;
        goBack: (id: string) => Promise<void>;
        goForward: (id: string) => Promise<void>;
        get: (id: string) => Promise<{
          id: string;
          url?: string;
          title?: string;
          canGoBack?: boolean;
          canGoForward?: boolean;
          isLoading?: boolean;
        } | null>;
        downloadAction: (
          downloadId: string,
          action: string,
          options?: Record<string, unknown>
        ) => Promise<void>;
      };
    };
  }
}

const listeners: ListenerMap = new Map();
let pollTimer: number | null = null;

function ensureListener(name: string) {
  let set = listeners.get(name);
  if (!set) {
    set = new Set();
    listeners.set(name, set);
  }
  return set;
}

function emitLocal(name: string, payload: unknown) {
  const set = listeners.get(name);
  if (!set) return;
  for (const callback of set) {
    queueMicrotask(() => callback(payload));
  }
}

async function invoke<T>(name: string, params: Record<string, unknown> = {}): Promise<T> {
  const fenestra = window.fenestra;
  if (!fenestra?.bridge) {
    throw new Error("Fenestra bridge unavailable");
  }
  return (await fenestra.bridge.invoke(name, params)) as T;
}

function subscribe(name: string, callback: (payload: unknown) => void) {
  ensureListener(name).add(callback);
  startEventPolling();
  const fenestra = window.fenestra;
  const unlistenNative = fenestra?.bridge.listen(name, callback);
  return () => {
    ensureListener(name).delete(callback);
    unlistenNative?.();
  };
}

function startEventPolling() {
  if (pollTimer !== null || !window.fenestra?.bridge) return;
  pollTimer = window.setInterval(async () => {
    try {
      const events = await invoke<Array<{ name: string; payload: unknown }>>("limbo.drainEvents");
      for (const event of events) {
        emitLocal(event.name, event.payload);
      }
    } catch {
      // Bridge may be unavailable during teardown.
    }
  }, 400);
}

export function installLimboBridge() {
  if (window.limbo || !window.fenestra?.bridge) {
    return Boolean(window.limbo);
  }

  window.fenestra.bridge.listen("guest.download", (payload) => {
    const data = payload as { url?: string; filename?: string; suggestedFilename?: string };
    emitLocal("browser-download-requested", {
      url: data.url ?? "",
      filename: data.filename ?? data.suggestedFilename ?? "download",
    });
  });

  window.limbo = {
    minimize: () => window.fenestra?.window.minimize(),
    maximize: () => window.fenestra?.window.toggleMaximize?.() ?? window.fenestra?.window.maximize(),
    close: () => window.fenestra?.window.close(),
    openExternal: (url) => invoke("limbo.openExternal", { url }),

    getBookmarks: () => invoke("limbo.getBookmarks"),
    addBookmark: (bookmark) => invoke("limbo.addBookmark", { ...bookmark }),
    removeBookmark: (id) => invoke("limbo.removeBookmark", { id }),
    updateBookmark: (bookmark) => invoke("limbo.updateBookmark", { ...bookmark }),
    resetBookmarks: () => invoke("limbo.resetBookmarks"),
    exportBookmarks: () => invoke("limbo.exportBookmarks"),
    importBookmarks: () => invoke("limbo.importBookmarks"),

    getLibrary: () => invoke("limbo.getLibrary"),
    addToLibrary: (item) => invoke("limbo.addToLibrary", { ...item }),
    removeFromLibrary: (id, deleteFiles) => invoke("limbo.removeFromLibrary", { id, deleteFiles }),
    openFileLocation: (path) => invoke("limbo.openFileLocation", { path }),
    openFile: (path) => invoke("limbo.openFile", { path }),
    addFolderToLibrary: () => invoke("limbo.addFolderToLibrary"),

    getDownloads: () => invoke("limbo.getDownloads"),
    startDownload: (url, options) =>
      invoke("limbo.startDownload", { url, filename: options?.filename, useDebrid: options?.useDebrid }),
    pauseDownload: (id) => invoke("limbo.pauseDownload", { id }),
    resumeDownload: (id) => invoke("limbo.resumeDownload", { id }),
    cancelDownload: (id) => invoke("limbo.cancelDownload", { id }),
    cancelAllDownloads: () => invoke("limbo.cancelAllDownloads"),
    clearCompletedDownloads: () => invoke("limbo.clearCompletedDownloads"),
    pauseAllDownloads: () => invoke("limbo.pauseAllDownloads"),
    resumeAllDownloads: () => invoke("limbo.resumeAllDownloads"),

    getTorrents: () => invoke("limbo.getTorrents"),
    addTorrent: (magnetUri) => invoke("limbo.addTorrent", { magnetUri }),
    addTorrentFile: (filePath) => invoke("limbo.addTorrentFile", { filePath }),
    addRemoteTorrent: (url) => invoke("limbo.addRemoteTorrent", { url }),
    pauseTorrent: (id) => invoke("limbo.pauseTorrent", { id }),
    resumeTorrent: (id) => invoke("limbo.resumeTorrent", { id }),
    removeTorrent: (id, deleteFiles) => invoke("limbo.removeTorrent", { id, deleteFiles }),
    isTorrentSupported: () => invoke("limbo.isTorrentSupported"),
    getStreamServerPort: () => invoke("limbo.getStreamServerPort"),
    getTorrentFiles: (infoHash) => invoke("limbo.getTorrentFiles", { infoHash }),
    pauseAllTorrents: () => invoke("limbo.pauseAllTorrents"),
    resumeAllTorrents: () => invoke("limbo.resumeAllTorrents"),
    checkVpnStatus: () => invoke("limbo.checkVpnStatus"),

    isDebridConfigured: () => invoke("limbo.isDebridConfigured"),
    isDebridUrlSupported: (url) => invoke("limbo.isDebridUrlSupported", { url }),
    isDebridTorrentSupported: () => invoke("limbo.isDebridTorrentSupported"),
    convertMagnetDebrid: (magnetUri) => invoke("limbo.convertMagnetDebrid", { magnetUri }),
    convertTorrentFileDebrid: (torrentUrl) => invoke("limbo.convertTorrentFileDebrid", { torrentUrl }),
    getSupportedHosts: () => invoke("limbo.getSupportedHosts"),
    realDebridDeviceStart: () => invoke("limbo.realDebridDeviceStart"),
    realDebridDevicePoll: () => invoke("limbo.realDebridDevicePoll"),
    realDebridDeviceCancel: () => invoke("limbo.realDebridDeviceCancel"),

    getSettings: () => invoke("limbo.getSettings"),
    updateSettings: (settings) => invoke("limbo.updateSettings", { ...settings }),
    selectDownloadPath: () => invoke("limbo.selectDownloadPath"),
    clearData: () => invoke("limbo.clearData"),

    onDownloadStarted: (callback) => subscribe("download-started", callback as (payload: unknown) => void),
    onDownloadProgress: (callback) => subscribe("download-progress", callback as (payload: unknown) => void),
    onDownloadComplete: (callback) => subscribe("download-complete", callback as (payload: unknown) => void),
    onLibraryUpdated: (callback) => subscribe("library-updated", callback as (payload: unknown) => void),
    onTorrentAdded: (callback) => subscribe("torrent-added", callback as (payload: unknown) => void),
    onTorrentProgress: (callback) => subscribe("torrent-progress", callback as (payload: unknown) => void),
    onTorrentComplete: (callback) => subscribe("torrent-complete", callback as (payload: unknown) => void),
    onTorrentError: (callback) => subscribe("torrent-error", callback as (payload: unknown) => void),
    onTorrentRemoved: (callback) => subscribe("torrent-removed", callback as (payload: unknown) => void),
    onClipboardDownloadDetected: (callback) =>
      subscribe("clipboard-download-detected", callback as (payload: unknown) => void),
    onMagnetLinkOpened: (callback) => subscribe("magnet-link-opened", callback as (payload: unknown) => void),
    onTorrentFileOpened: (callback) => subscribe("torrent-file-opened", callback as (payload: unknown) => void),
    onExtractionProgress: (callback) => subscribe("extraction-progress", callback as (payload: unknown) => void),
    onBrowserDownloadRequested: (callback) =>
      subscribe("browser-download-requested", callback as (payload: unknown) => void),
  };

  startEventPolling();
  return true;
}

export function isFenestraRuntime() {
  return Boolean(window.fenestra?.bridge);
}
