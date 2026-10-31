import { create } from "zustand";
import {
  commands,
  type Bookmark,
  type Download,
  type LibraryItem,
  type Settings,
  type TorrentInfo,
} from "@/lib/bindings";

type ViewType = "library" | "downloads" | "settings" | "browser";
type DownloadsTab = "downloads" | "torrents";
type BrowserSession = {
  bookmarkId: string;
  url: string;
  updatedAt: number;
};

const BROWSER_SESSION_TTL_MS = 5 * 60 * 1000;

function upsert<T extends { id: string }>(items: T[], item: T) {
  const index = items.findIndex((existing) => existing.id === item.id);
  if (index === -1) return [...items, item];
  return items.map((existing, position) => (position === index ? item : existing));
}

interface AppState {
  currentView: ViewType;
  setCurrentView: (view: ViewType) => void;
  downloadsTab: DownloadsTab;
  showDownloads: (tab: DownloadsTab) => void;
  setDownloadsTab: (tab: DownloadsTab) => void;
  vpnRequired: boolean;
  setVpnRequired: (required: boolean) => void;

  activeBookmark: Bookmark | null;
  setActiveBookmark: (bookmark: Bookmark | null) => void;
  browserSessions: Record<string, BrowserSession>;
  rememberBrowserSession: (bookmarkId: string, url: string) => void;
  getBrowserSessionUrl: (bookmarkId: string, fallbackUrl: string) => string;
  clearExpiredBrowserSessions: () => void;

  bookmarks: Bookmark[];
  setBookmarks: (bookmarks: Bookmark[]) => void;
  addBookmark: (bookmark: Bookmark) => void;

  library: LibraryItem[];
  setLibrary: (library: LibraryItem[]) => void;

  downloads: Download[];
  setDownloads: (downloads: Download[]) => void;
  upsertDownload: (download: Download) => void;
  removeDownload: (id: string) => void;

  torrents: TorrentInfo[];
  setTorrents: (torrents: TorrentInfo[]) => void;
  upsertTorrent: (torrent: TorrentInfo) => void;
  removeTorrent: (id: string) => void;

  settings: Settings | null;
  setSettings: (settings: Settings) => void;

  incomingLinks: string[];
  incomingLinksExpire: boolean;
  showIncomingLinks: (links: string[], expire?: boolean) => void;
  dismissIncomingLinks: () => void;

  searchQuery: string;
  setSearchQuery: (query: string) => void;

  isAddBookmarkOpen: boolean;
  setIsAddBookmarkOpen: (open: boolean) => void;
  /// Native guest webviews sit above the React tree; depth > 0 hides them
  /// so modal overlays in the primary UI are visible.
  guestOcclusionDepth: number;
  guestOcclusionEpoch: number;
  guestOcclusionPrimeEpoch: number;
  guestOcclusionReady: boolean;
  primeGuestOcclusion: () => void;
  pushGuestOcclusion: () => void;
  popGuestOcclusion: () => void;
  completeGuestOcclusion: () => void;

  initializeData: () => Promise<void>;
}

export const useAppStore = create<AppState>((set, get) => ({
  currentView: "library",
  setCurrentView: (view) => set({ currentView: view }),
  downloadsTab: "downloads",
  showDownloads: (tab) =>
    set({ activeBookmark: null, currentView: "downloads", downloadsTab: tab }),
  setDownloadsTab: (tab) => set({ downloadsTab: tab }),
  vpnRequired: false,
  setVpnRequired: (required) => set({ vpnRequired: required }),

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

  bookmarks: [],
  setBookmarks: (bookmarks) => set({ bookmarks }),
  addBookmark: (bookmark) =>
    set((state) => ({ bookmarks: [...state.bookmarks, bookmark] })),

  library: [],
  setLibrary: (library) => set({ library }),

  downloads: [],
  setDownloads: (downloads) => set({ downloads }),
  upsertDownload: (download) =>
    set((state) => ({ downloads: upsert(state.downloads, download) })),
  removeDownload: (id) =>
    set((state) => ({ downloads: state.downloads.filter((d) => d.id !== id) })),

  torrents: [],
  setTorrents: (torrents) => set({ torrents }),
  upsertTorrent: (torrent) =>
    set((state) => ({ torrents: upsert(state.torrents, torrent) })),
  removeTorrent: (id) =>
    set((state) => ({ torrents: state.torrents.filter((t) => t.id !== id) })),

  settings: null,
  setSettings: (settings) => set({ settings }),

  incomingLinks: [],
  incomingLinksExpire: false,
  showIncomingLinks: (links, expire = false) =>
    set({ incomingLinks: links, incomingLinksExpire: expire }),
  dismissIncomingLinks: () => set({ incomingLinks: [] }),

  searchQuery: "",
  setSearchQuery: (query) => set({ searchQuery: query }),

  isAddBookmarkOpen: false,
  setIsAddBookmarkOpen: (open) => set({ isAddBookmarkOpen: open }),
  guestOcclusionDepth: 0,
  guestOcclusionEpoch: 0,
  guestOcclusionPrimeEpoch: 0,
  primeGuestOcclusion: () =>
    set((state) => ({ guestOcclusionPrimeEpoch: state.guestOcclusionPrimeEpoch + 1 })),
  pushGuestOcclusion: () =>
    set((state) => ({
      guestOcclusionDepth: state.guestOcclusionDepth + 1,
      guestOcclusionEpoch:
        state.guestOcclusionDepth === 0
          ? state.guestOcclusionEpoch + 1
          : state.guestOcclusionEpoch,
      guestOcclusionReady:
        state.guestOcclusionDepth > 0 ||
        state.currentView !== "browser" ||
        !state.activeBookmark,
    })),
  popGuestOcclusion: () =>
    set((state) => {
      const guestOcclusionDepth = Math.max(0, state.guestOcclusionDepth - 1);
      return {
        guestOcclusionDepth,
        guestOcclusionReady: guestOcclusionDepth === 0 || state.guestOcclusionReady,
      };
    }),
  guestOcclusionReady: true,
  completeGuestOcclusion: () => set({ guestOcclusionReady: true }),

  initializeData: async () => {
    const [bookmarks, library, downloads, torrents, settings] = await Promise.all([
      commands.bookmarksList(),
      commands.libraryList(),
      commands.downloadsList(),
      commands.torrentsList(),
      commands.settingsGet(),
    ]);
    set({ bookmarks, library, downloads, torrents, settings });
  },
}));
