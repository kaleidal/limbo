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

export interface DebridConfig {
  service: "realdebrid" | "alldebrid" | "premiumize" | null;
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
