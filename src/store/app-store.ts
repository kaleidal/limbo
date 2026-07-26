import { create } from "zustand";
import type {
  Bookmark,
  LibraryItem,
  Download,
  Settings,
  TorrentInfo,
} from "@/types/electron.d";

type ViewType = "library" | "downloads" | "settings" | "browser";
type BrowserSession = {
  bookmarkId: string;
  url: string;
  updatedAt: number;
};

const BROWSER_SESSION_TTL_MS = 5 * 60 * 1000;

interface AppState {
  // Current view
  currentView: ViewType;
  setCurrentView: (view: ViewType) => void;

  // Active bookmark (for browser view)
  activeBookmark: Bookmark | null;
  setActiveBookmark: (bookmark: Bookmark | null) => void;
  browserSessions: Record<string, BrowserSession>;
  rememberBrowserSession: (bookmarkId: string, url: string) => void;
  getBrowserSessionUrl: (bookmarkId: string, fallbackUrl: string) => string;
  clearExpiredBrowserSessions: () => void;

  // Bookmarks
  bookmarks: Bookmark[];
  setBookmarks: (bookmarks: Bookmark[]) => void;
  addBookmark: (bookmark: Bookmark) => void;
  removeBookmark: (id: string) => void;

  // Library
  library: LibraryItem[];
  setLibrary: (library: LibraryItem[]) => void;
  addToLibrary: (item: LibraryItem) => void;
  removeFromLibrary: (id: string) => void;

  // Downloads
  downloads: Download[];
  setDownloads: (downloads: Download[]) => void;
  updateDownload: (id: string, updates: Partial<Download>) => void;
  addDownload: (download: Download) => void;
  removeDownload: (id: string) => void;

  // Torrents
  torrents: TorrentInfo[];
  setTorrents: (torrents: TorrentInfo[]) => void;
  addTorrent: (torrent: TorrentInfo) => void;
  updateTorrent: (id: string, updates: Partial<TorrentInfo>) => void;
  removeTorrent: (id: string) => void;

  // Settings
  settings: Settings | null;
  setSettings: (settings: Settings) => void;

  // Search
  searchQuery: string;
  setSearchQuery: (query: string) => void;

  // Modals
  isAddBookmarkOpen: boolean;
  setIsAddBookmarkOpen: (open: boolean) => void;
  isSettingsOpen: boolean;
  setIsSettingsOpen: (open: boolean) => void;
  /// Native guest webviews sit above the React tree; depth > 0 hides them
  /// so modal overlays in the primary UI are visible.
  guestOcclusionDepth: number;
  pushGuestOcclusion: () => void;
  popGuestOcclusion: () => void;

  // Init
  initializeData: () => Promise<void>;
}

export const useAppStore = create<AppState>((set, get) => ({
  // Current view
  currentView: "library",
  setCurrentView: (view) => set({ currentView: view }),

  // Active bookmark
  activeBookmark: null,
  setActiveBookmark: (bookmark) =>
    set({ activeBookmark: bookmark, currentView: bookmark ? "browser" : "library" }),
  browserSessions: {},
  rememberBrowserSession: (bookmarkId, url) =>
    set((state) => ({
      browserSessions: {
        ...state.browserSessions,
        [bookmarkId]: {
          bookmarkId,
          url,
          updatedAt: Date.now(),
        },
      },
    })),
  getBrowserSessionUrl: (bookmarkId, fallbackUrl): string => {
    const session = get().browserSessions[bookmarkId];
    if (!session) return fallbackUrl;
    if (Date.now() - session.updatedAt > BROWSER_SESSION_TTL_MS) return fallbackUrl;
    return session.url || fallbackUrl;
  },
  clearExpiredBrowserSessions: () =>
    set((state) => ({
      browserSessions: Object.fromEntries(
        Object.entries(state.browserSessions).filter(
          ([, session]) => Date.now() - session.updatedAt <= BROWSER_SESSION_TTL_MS
        )
      ),
    })),

  // Bookmarks
  bookmarks: [],
  setBookmarks: (bookmarks) => set({ bookmarks }),
  addBookmark: (bookmark) =>
    set((state) => ({ bookmarks: [...state.bookmarks, bookmark] })),
  removeBookmark: (id) =>
    set((state) => ({ bookmarks: state.bookmarks.filter((b) => b.id !== id) })),

  // Library
  library: [],
  setLibrary: (library) => set({ library }),
  addToLibrary: (item) =>
    set((state) => ({ library: [...state.library, item] })),
  removeFromLibrary: (id) =>
    set((state) => ({ library: state.library.filter((l) => l.id !== id) })),

  // Downloads
  downloads: [],
  setDownloads: (downloads) => set({ downloads }),
  updateDownload: (id, updates) =>
    set((state) => ({
      downloads: state.downloads.map((d) =>
        d.id === id ? { ...d, ...updates } : d
      ),
    })),
  addDownload: (download) =>
    set((state) => {
      const existingIndex = state.downloads.findIndex((d) => d.id === download.id);
      if (existingIndex !== -1) {
        return {
          downloads: state.downloads.map((item) =>
            item.id === download.id ? { ...item, ...download } : item
          ),
        };
      }
      return { downloads: [...state.downloads, download] };
    }),
  removeDownload: (id) =>
    set((state) => ({ downloads: state.downloads.filter((d) => d.id !== id) })),

  // Torrents
  torrents: [],
  setTorrents: (torrents) => set({ torrents }),
  addTorrent: (torrent) =>
    set((state) => {
      // Prevent duplicates
      if (state.torrents.some((t) => t.id === torrent.id)) {
        return state;
      }
      return { torrents: [...state.torrents, torrent] };
    }),
  updateTorrent: (id, updates) =>
    set((state) => ({
      torrents: state.torrents.map((t) =>
        t.id === id ? { ...t, ...updates } : t
      ),
    })),
  removeTorrent: (id) =>
    set((state) => ({ torrents: state.torrents.filter((t) => t.id !== id) })),

  // Settings
  settings: null,
  setSettings: (settings) => set({ settings }),

  // Search
  searchQuery: "",
  setSearchQuery: (query) => set({ searchQuery: query }),

  // Modals
  isAddBookmarkOpen: false,
  setIsAddBookmarkOpen: (open) => set({ isAddBookmarkOpen: open }),
  isSettingsOpen: false,
  setIsSettingsOpen: (open) => set({ isSettingsOpen: open }),
  guestOcclusionDepth: 0,
  pushGuestOcclusion: () =>
    set((state) => ({ guestOcclusionDepth: state.guestOcclusionDepth + 1 })),
  popGuestOcclusion: () =>
    set((state) => ({
      guestOcclusionDepth: Math.max(0, state.guestOcclusionDepth - 1),
    })),

  // Initialize data from electron
  initializeData: async () => {
    if (window.limbo) {
      const [bookmarks, library, downloads, torrents, settings] = await Promise.all([
        window.limbo.getBookmarks(),
        window.limbo.getLibrary(),
        window.limbo.getDownloads(),
        window.limbo.getTorrents(),
        window.limbo.getSettings(),
      ]);
      set({ bookmarks, library, downloads, torrents, settings });
    }
  },
}));
