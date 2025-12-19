import { create } from "zustand";
import type {
  Bookmark,
  LibraryItem,
  Download,
  Settings,
  TorrentInfo,
} from "@/types/electron.d";

type ViewType = "library" | "downloads" | "settings" | "browser";

interface AppState {
  // Current view
  currentView: ViewType;
  setCurrentView: (view: ViewType) => void;

  // Active bookmark (for browser view)
  activeBookmark: Bookmark | null;
  setActiveBookmark: (bookmark: Bookmark | null) => void;

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

  // Init
  initializeData: () => Promise<void>;
}

export const useAppStore = create<AppState>((set, _) => ({
  // Current view
  currentView: "library",
  setCurrentView: (view) => set({ currentView: view }),

  // Active bookmark
  activeBookmark: null,
  setActiveBookmark: (bookmark) =>
    set({ activeBookmark: bookmark, currentView: bookmark ? "browser" : "library" }),

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
    set((state) => ({ downloads: [...state.downloads, download] })),
  removeDownload: (id) =>
    set((state) => ({ downloads: state.downloads.filter((d) => d.id !== id) })),

  // Torrents
  torrents: [],
  setTorrents: (torrents) => set({ torrents }),
  addTorrent: (torrent) =>
    set((state) => ({ torrents: [...state.torrents, torrent] })),
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
