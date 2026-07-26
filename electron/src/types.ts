// Type definitions for Limbo Electron main process

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
  type?: string;
  icon?: string;
  category?: string;
}

export interface Download {
  id: string;
  filename: string;
  url: string;
  path: string;
  size: number;
  received: number;
  status: "pending" | "downloading" | "paused" | "completed" | "cancelled" | "error" | "extracting";
  startTime?: number;
  speed?: number;
  eta?: number;
  parts?: DownloadPart[];
  extractProgress?: number;
  extractStatus?: string;
  resumeData?: string;
  groupId?: string;
  groupName?: string;
}

export interface DownloadPart {
  id: string;
  start: number;
  end: number;
  downloaded: number;
}

export interface TorrentInfo {
  id: string;
  name: string;
  magnetUri: string;
  sourceType?: "magnet" | "file";
  sourceValue?: string;
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
  lastError?: string;
  selectedFileIndex?: number;
  clientId?: string;
  /** Display name of the companion app that added this torrent (e.g. Raffi). */
  clientName?: string;
  /** When true, keep `name` from the client instead of replacing with torrent metadata. */
  clientProvidedName?: boolean;
  keepAlive?: boolean;
}

export interface DebridConfig {
  service: "realdebrid" | "alldebrid" | "premiumize" | "torbox" | null;
  apiKey: string;
  refreshToken?: string;
  expiresAt?: number;
  clientId?: string;
  clientSecret?: string;
}

export interface Settings {
  downloadPath: string;
  maxConcurrentDownloads: number;
  hardwareAcceleration: boolean;
  enableSeeding: boolean;
  startOnBoot: boolean;
  requireVpn: boolean;
  autoExtract: boolean;
  deleteArchiveAfterExtract: boolean;
  debrid: DebridConfig;
  /** Localhost companion API for apps like Raffi. Default on. */
  apiEnabled?: boolean;
  apiPort?: number;
  apiToken?: string;
  /** always = prompt unless trusted; off = auto-approve authenticated clients */
  apiPromptPolicy?: "always" | "off";
  trustedApiClients?: string[];
}

export interface StoreSchema {
  bookmarks: Bookmark[];
  library: LibraryItem[];
  downloads: Download[];
  torrents: TorrentInfo[];
  settings: Settings;
  extractedGroups: string[];
}

export interface MultiPartInfo {
  isMultiPart: boolean;
  baseName: string;
  partNumber: number;
  isPart1: boolean;
}

export interface DebridResult {
  url: string | null;
  error?: string;
}
