import {
  app,
  BrowserWindow,
  ipcMain,
  session,
  dialog,
  shell,
  DownloadItem,
  clipboard,
} from "electron";
import path from "path";
import fs from "fs";
import http from "http";
import os from "os";
import { fileURLToPath } from "url";
import { Worker } from "worker_threads";
import Store from "electron-store";
import { v4 as uuidv4 } from "uuid";
import electronUpdater from "electron-updater";
import log from "electron-log";

const { autoUpdater } = electronUpdater;

// ESM compatibility
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Check if a file is an extractable archive
function isExtractableArchive(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return ['.zip', '.rar', '.7z'].includes(ext);
}

// Multi-part archive detection
interface MultiPartInfo {
  isMultiPart: boolean;
  baseName: string;  // e.g., "Photoshop.2026.v27.2.0" from "Photoshop.2026.v27.2.0.part1.rar"
  partNumber: number;
  isPart1: boolean;
}

function parseMultiPartArchive(filename: string): MultiPartInfo {
  // Match patterns like: name.part1.rar, name.part01.rar, name.part001.rar
  const multiPartMatch = filename.match(/^(.+)\.part(\d+)\.rar$/i);
  if (multiPartMatch) {
    return {
      isMultiPart: true,
      baseName: multiPartMatch[1],
      partNumber: parseInt(multiPartMatch[2], 10),
      isPart1: parseInt(multiPartMatch[2], 10) === 1,
    };
  }
  
  // Match patterns like: name.r00, name.r01 (old-style multi-part RAR)
  const oldStyleMatch = filename.match(/^(.+)\.r(\d{2,})$/i);
  if (oldStyleMatch) {
    return {
      isMultiPart: true,
      baseName: oldStyleMatch[1],
      partNumber: parseInt(oldStyleMatch[2], 10) + 1, // r00 is part 1
      isPart1: oldStyleMatch[2] === '00',
    };
  }
  
  return { isMultiPart: false, baseName: filename, partNumber: 0, isPart1: false };
}

// Check if all parts of a multi-part archive are COMPLETED (not just present on disk)
// This checks the downloads store to ensure all parts have finished downloading
function areAllPartsCompleted(baseName: string, downloads: Download[]): { allCompleted: boolean; part1Path: string | null; totalParts: number; completedParts: number } {
  // Find all downloads that match this multi-part archive base name
  const matchingDownloads: { partNumber: number; path: string; status: string }[] = [];
  
  for (const download of downloads) {
    const info = parseMultiPartArchive(download.filename);
    if (info.isMultiPart && info.baseName.toLowerCase() === baseName.toLowerCase()) {
      matchingDownloads.push({
        partNumber: info.partNumber,
        path: download.path,
        status: download.status,
      });
    }
  }
  
  if (matchingDownloads.length === 0) {
    return { allCompleted: false, part1Path: null, totalParts: 0, completedParts: 0 };
  }
  
  // Count completed parts and find part1 path
  let part1Path: string | null = null;
  let completedCount = 0;
  const maxPart = Math.max(...matchingDownloads.map(d => d.partNumber));
  
  for (const download of matchingDownloads) {
    if (download.status === "completed" || download.status === "extracting") {
      completedCount++;
    }
    if (download.partNumber === 1) {
      part1Path = download.path;
    }
  }
  
  // Check if we have all parts from 1 to maxPart and all are completed
  const partNumbers = matchingDownloads.map(d => d.partNumber).sort((a, b) => a - b);
  const hasAllParts = partNumbers.length === maxPart && partNumbers[0] === 1 && partNumbers[partNumbers.length - 1] === maxPart;
  const allAreCompleted = completedCount === matchingDownloads.length;
  
  return {
    allCompleted: hasAllParts && allAreCompleted && part1Path !== null,
    part1Path,
    totalParts: maxPart,
    completedParts: completedCount,
  };
}

// Track pending multi-part extractions to avoid duplicate extraction attempts
const pendingMultiPartExtractions = new Set<string>();

// VPN detection - checks for common VPN network interface patterns
function isVpnConnected(): boolean {
  try {
    const interfaces = os.networkInterfaces();
    const vpnPatterns = [
      /^tun/i, /^tap/i, /^ppp/i, /^wg/i, // Linux/macOS VPN interfaces
      /^utun/i, // macOS IKEv2/IPsec
      /wireguard/i, /openvpn/i, /nordlynx/i, /proton/i, /mullvad/i,
      /expressvpn/i, /surfshark/i, /cyberghost/i, /pia/i, /private.*internet/i,
    ];
    
    for (const [name, addrs] of Object.entries(interfaces)) {
      if (!addrs) continue;
      // Check if interface name matches VPN patterns
      if (vpnPatterns.some(p => p.test(name))) {
        // Make sure it has a valid IP address
        const hasIp = addrs.some(addr => addr.family === 'IPv4' && !addr.internal);
        if (hasIp) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

if (process.platform === 'win32') {
    app.setAppUserModelId('al.kaleid.limbo');
}

// File host patterns and extractors
interface FileHostExtractor {
  pattern: RegExp;
  name: string;
  extract: (html: string, url: string) => string | null;
}

const FILE_HOST_EXTRACTORS: FileHostExtractor[] = [
  {
    name: "rapidgator",
    pattern: /rapidgator\.net/i,
    extract: (html, url) => {
      // Look for the download button link or direct download URL
      // Rapidgator uses JavaScript to reveal the link, but sometimes has a direct link
      const directMatch = html.match(/var\s+download_url\s*=\s*['"]([^'"]+)['"]/i);
      if (directMatch) return directMatch[1];
      
      // Check for the slow download form action
      const formMatch = html.match(/<form[^>]*action=['"]([^'"]*download[^'"]*)['"]/i);
      if (formMatch) return formMatch[1];
      
      return null;
    }
  },
  {
    name: "mediafire",
    pattern: /mediafire\.com/i,
    extract: (html) => {
      // MediaFire has a direct download link in the page
      const match = html.match(/href=['"]([^'"]*download[^'"]*\.mediafire\.com[^'"]+)['"]/i);
      if (match) return match[1];
      
      // Alternative pattern
      const altMatch = html.match(/aria-label=['"]Download file['"]\s+href=['"]([^'"]+)['"]/i);
      if (altMatch) return altMatch[1];
      
      // Look for download button
      const btnMatch = html.match(/id=['"]downloadButton['"]\s+href=['"]([^'"]+)['"]/i);
      return btnMatch?.[1] || null;
    }
  },
  {
    name: "1fichier",
    pattern: /1fichier\.com/i,
    extract: (html) => {
      // 1fichier shows a form, the link comes after clicking
      const match = html.match(/href=['"]([^'"]+\.1fichier\.com\/[^'"]+)['"]/i);
      return match?.[1] || null;
    }
  },
  {
    name: "uploadgig",
    pattern: /uploadgig\.com/i,
    extract: (html) => {
      // UploadGig direct download link
      const match = html.match(/href=['"]([^'"]*download[^'"]+uploadgig[^'"]+)['"]/i);
      return match?.[1] || null;
    }
  },
  {
    name: "katfile",
    pattern: /katfile\.com/i,
    extract: (html) => {
      const match = html.match(/href=['"]([^'"]*\.katfile\.com\/[a-zA-Z0-9]+\/[^'"]+)['"]/i);
      return match?.[1] || null;
    }
  },
  {
    name: "nitroflare",
    pattern: /nitroflare\.com/i,
    extract: (html) => {
      // Nitroflare embeds the link in JavaScript
      const match = html.match(/https?:\/\/[a-z0-9]+\.nitroflare\.com\/[^\s'"<>]+/i);
      return match?.[0] || null;
    }
  },
];

// Extract direct download link from file host page
async function extractFileHostLink(url: string): Promise<string | null> {
  const extractor = FILE_HOST_EXTRACTORS.find(e => e.pattern.test(url));
  if (!extractor) return null;

  try {
    console.log(`[FileHost] Fetching ${extractor.name} page: ${url}`);
    
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
    });

    if (!response.ok) {
      console.error(`[FileHost] Failed to fetch: ${response.status}`);
      return null;
    }

    const html = await response.text();
    const directLink = extractor.extract(html, url);

    if (directLink) {
      console.log(`[FileHost] Extracted link from ${extractor.name}: ${directLink}`);
      return directLink;
    }

    console.log(`[FileHost] No direct link found in ${extractor.name} page`);
    return null;
  } catch (err) {
    console.error(`[FileHost] Error extracting from ${extractor.name}:`, err);
    return null;
  }
}

// Check if a URL is a file host landing page
function isFileHostUrl(url: string): boolean {
  return FILE_HOST_EXTRACTORS.some(e => e.pattern.test(url));
}

function initAutoUpdater() {
  if (!app.isPackaged) return;

  try {
    autoUpdater.logger = log;
    (log.transports.file as any).level = "info";

    autoUpdater.on("checking-for-update", () => log.info("Checking for updates..."));
    autoUpdater.on("update-available", (info) => log.info("Update available", info));
    autoUpdater.on("update-not-available", (info) => log.info("No update available", info));
    autoUpdater.on("error", (err) => log.error("Auto-updater error", err));
    autoUpdater.on("download-progress", (progress) => log.info("Update download progress", progress));

    autoUpdater.on("update-downloaded", async () => {
      const result = await dialog.showMessageBox({
        type: "info",
        title: "Update ready",
        message: "An update has been downloaded.",
        detail: "Restart Limbo to apply it now.",
        buttons: ["Restart", "Later"],
        defaultId: 0,
        cancelId: 1,
      });

      if (result.response === 0) {
        autoUpdater.quitAndInstall();
      }
    });

    autoUpdater.checkForUpdates().catch((err) => {
      log.error("Auto-updater check failed", err);
    });
  } catch (err) {
    log.error("Failed to initialize auto-updater", err);
  }
}

// Auto-extract function using worker thread (non-blocking)
function autoExtractArchiveAsync(
  filePath: string,
  downloadId: string,
  onProgress: (percent: number, status: string) => void,
  onComplete: (extractDir: string | null) => void
): void {
  const workerPath = path.join(__dirname, "extract-worker.js");
  
  const worker = new Worker(workerPath, {
    workerData: { filePath, downloadId }
  });

  worker.on("message", (msg) => {
    if (msg.type === "progress") {
      onProgress(msg.percent, msg.status);
    } else if (msg.type === "done") {
      if (msg.success) {
        console.log(`Extracted ${filePath} to ${msg.extractDir}`);
        onComplete(msg.extractDir);
      } else {
        console.error(`Extraction failed: ${msg.error}`);
        onComplete(null);
      }
      worker.terminate();
    }
  });

  worker.on("error", (err) => {
    console.error("Worker error:", err);
    onComplete(null);
  });

  worker.on("exit", (code) => {
    if (code !== 0) {
      console.error(`Worker stopped with exit code ${code}`);
    }
  });
}

// Detect category based on folder/file contents
function detectCategory(itemPath: string): string {
  try {
    const stat = fs.statSync(itemPath);
    
    if (stat.isDirectory()) {
      // Check folder contents for executables
      const files = fs.readdirSync(itemPath);
      for (const file of files) {
        const ext = path.extname(file).toLowerCase();
        if (['.exe', '.msi'].includes(ext)) {
          return 'software';
        }
      }
      // Check for common game indicators
      for (const file of files) {
        const lower = file.toLowerCase();
        if (lower.includes('game') || lower.includes('steam_api') || lower.includes('unityplayer')) {
          return 'games';
        }
      }
      // Check for video files
      for (const file of files) {
        const ext = path.extname(file).toLowerCase();
        if (['.mp4', '.mkv', '.avi', '.mov', '.wmv'].includes(ext)) {
          return 'movies';
        }
      }
      // Check for music
      for (const file of files) {
        const ext = path.extname(file).toLowerCase();
        if (['.mp3', '.flac', '.wav', '.aac', '.ogg'].includes(ext)) {
          return 'music';
        }
      }
    } else {
      // Single file
      const ext = path.extname(itemPath).toLowerCase();
      if (['.exe', '.msi'].includes(ext)) return 'software';
      if (['.mp4', '.mkv', '.avi', '.mov', '.wmv'].includes(ext)) return 'movies';
      if (['.mp3', '.flac', '.wav', '.aac', '.ogg'].includes(ext)) return 'music';
    }
  } catch (err) {
    console.error('Error detecting category:', err);
  }
  return 'other';
}

// Sync library with filesystem - remove entries for deleted files/folders
function syncLibraryWithFilesystem(): void {
  const library = store.get('library');
  const validLibrary = library.filter(item => {
    try {
      return fs.existsSync(item.path);
    } catch {
      return false;
    }
  });
  
  if (validLibrary.length !== library.length) {
    store.set('library', validLibrary);
    mainWindow?.webContents.send('library-updated', validLibrary);
    console.log(`Cleaned ${library.length - validLibrary.length} missing items from library`);
  }
}

// Register as magnet and torrent protocol handler
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('magnet', process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient('magnet');
}

// Register .torrent file association
if (process.platform === 'win32') {
  app.setAsDefaultProtocolClient('limbo-torrent');
}

// Check hardware acceleration setting before app is ready
// We need a temporary store read to check this early
const tempStore = new Store({ name: 'config' });
const settings = tempStore.get('settings') as any;
if (settings && settings.hardwareAcceleration === false) {
  app.disableHardwareAcceleration();
  console.log('Hardware acceleration disabled by user setting');
}

// Single instance lock - prevent multiple windows
const gotTheLock = app.requestSingleInstanceLock();
let pendingMagnetLink: string | null = null;
let pendingTorrentFile: string | null = null;

function normalizeCliArg(arg: string): string {
  let value = arg.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  if (value.startsWith('file://')) {
    try {
      value = decodeURIComponent(value.replace('file://', ''));
    } catch {
      value = value.replace('file://', '');
    }
  }
  return value;
}

function findTorrentFileArg(args: string[]): string | null {
  for (const raw of args) {
    const arg = normalizeCliArg(raw);
    if (!arg) continue;
    if (arg.toLowerCase().endsWith('.torrent') && fs.existsSync(arg)) return arg;
  }
  return null;
}

function findMagnetArg(args: string[]): string | null {
  for (const raw of args) {
    const arg = normalizeCliArg(raw);
    if (arg.startsWith('magnet:')) return arg;
  }
  return null;
}

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (event, commandLine) => {
    // Someone tried to run a second instance
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      
      const magnetArg = findMagnetArg(commandLine);
      if (magnetArg) mainWindow.webContents.send('magnet-link-opened', magnetArg);

      const torrentFile = findTorrentFileArg(commandLine);
      if (torrentFile) mainWindow.webContents.send('torrent-file-opened', torrentFile);
    }
  });
}

// Clipboard monitoring
let lastClipboardContent = '';
let clipboardWatcher: ReturnType<typeof setInterval> | null = null;

// WebTorrent for full BitTorrent support (TCP/UDP + WebRTC since v2.3.0)
let torrentWorker: Worker | null = null;
let torrentWorkerReady = false;
let streamServerPort: number = 0;
const activeTorrentIds = new Set<string>();
const pendingTorrentWorkerRequests = new Map<
  string,
  { resolve: (value: any) => void; reject: (reason?: any) => void; timeout: NodeJS.Timeout }
>();

// Public trackers to help with peer discovery
const publicTrackers = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.moeking.me:6969/announce',
  'wss://tracker.btorrent.xyz',
  'wss://tracker.openwebtorrent.com',
];

// Function to initialize WebTorrent with streaming server
async function initWebTorrent() {
  try {
    const workerPath = path.join(__dirname, "torrent-worker.js");
    torrentWorker = new Worker(workerPath);

    torrentWorker.on("message", (msg: any) => {
      if (!msg || typeof msg !== "object") return;

      if (msg.type === "ready") {
        torrentWorkerReady = !!msg.ok;
        if (msg.ok) {
          streamServerPort = msg.streamServerPort || 0;
          console.log(`Torrent worker ready. Stream server on http://127.0.0.1:${streamServerPort}`);

          // Resume torrents that were downloading last run (best-effort)
          try {
            const settings = store.get("settings");
            const torrents = store.get("torrents");
            for (const t of torrents) {
              if (t.status !== "downloading") continue;
              if (!t.magnetUri) continue;
              activeTorrentIds.add(t.id);
              callTorrentWorker({
                type: "add-magnet",
                torrentId: t.id,
                magnetUri: t.magnetUri,
                downloadPath: settings.downloadPath,
                announce: publicTrackers,
              }).catch(() => {});
            }
          } catch {}
        } else {
          console.warn("Torrent worker failed to initialize.", msg.error);
        }
        return;
      }

      if (msg.type === "response" && typeof msg.requestId === "string") {
        const pending = pendingTorrentWorkerRequests.get(msg.requestId);
        if (!pending) return;
        clearTimeout(pending.timeout);
        pendingTorrentWorkerRequests.delete(msg.requestId);
        if (msg.ok) pending.resolve(msg.data);
        else pending.reject(new Error(msg.error || "Torrent worker request failed"));
        return;
      }

      if (msg.type === "event") {
        handleTorrentWorkerEvent(msg.event, msg.payload);
      }
    });

    torrentWorker.on("error", (err) => {
      console.warn("Torrent worker error", err);
      torrentWorkerReady = false;
    });

    torrentWorker.on("exit", (code) => {
      console.warn("Torrent worker exited", code);
      torrentWorkerReady = false;
      torrentWorker = null;
    });

    const settings = store.get("settings");
    torrentWorker.postMessage({ type: "init", enableSeeding: settings.enableSeeding, publicTrackers });
  } catch (err) {
    console.warn("Torrent worker failed to start. Torrent support disabled.", err);
    torrentWorkerReady = false;
    torrentWorker = null;
  }
}

// Get MIME type for file
function getMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.mp4': 'video/mp4',
    '.mkv': 'video/x-matroska',
    '.avi': 'video/x-msvideo',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.flac': 'audio/flac',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.rar': 'application/x-rar-compressed',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

function callTorrentWorker<T = any>(message: any, timeoutMs = 20000): Promise<T> {
  if (!torrentWorker || !torrentWorkerReady) {
    return Promise.reject(new Error("Torrent support is not available."));
  }

  const requestId = uuidv4();
  const payload = { ...message, requestId };

  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingTorrentWorkerRequests.delete(requestId);
      reject(new Error("Torrent worker request timed out"));
    }, timeoutMs);

    pendingTorrentWorkerRequests.set(requestId, { resolve, reject, timeout });
    torrentWorker!.postMessage(payload);
  });
}

function handleTorrentWorkerEvent(event: string, payload: any) {
  if (!payload || typeof payload !== "object") return;

  if (event === "torrent-metadata") {
    const torrents = store.get("torrents");
    const idx = torrents.findIndex((t: any) => t.id === payload.id);
    if (idx !== -1) {
      const settings = store.get("settings");
      const realName = payload.name || torrents[idx].name;
      torrents[idx] = {
        ...torrents[idx],
        name: realName,
        size: payload.size || torrents[idx].size,
        magnetUri: payload.magnetUri || torrents[idx].magnetUri,
        infoHash: payload.infoHash || torrents[idx].infoHash,
        path: path.join(settings.downloadPath, realName),
      };
      store.set("torrents", torrents);
      mainWindow?.webContents.send("torrent-progress", torrents[idx]);
    }
    return;
  }

  if (event === "torrent-progress") {
    const torrents = store.get("torrents");
    const idx = torrents.findIndex((t: any) => t.id === payload.id);
    if (idx === -1) return;

    const settings = store.get("settings");
    torrents[idx] = {
      ...torrents[idx],
      downloaded: payload.downloaded || 0,
      uploaded: settings.enableSeeding ? (payload.uploaded || 0) : 0,
      progress: payload.progress || 0,
      downloadSpeed: payload.downloadSpeed || 0,
      uploadSpeed: settings.enableSeeding ? (payload.uploadSpeed || 0) : 0,
      peers: payload.peers || 0,
      seeds: payload.seeds || 0,
      status: payload.done
        ? "completed"
        : torrents[idx].status === "paused"
          ? "paused"
          : "downloading",
    };
    store.set("torrents", torrents);
    mainWindow?.webContents.send("torrent-progress", torrents[idx]);
    return;
  }

  if (event === "torrent-done") {
    const torrents = store.get("torrents");
    const idx = torrents.findIndex((t: any) => t.id === payload.id);
    if (idx !== -1) {
      const settings = store.get("settings");
      torrents[idx].progress = 1;
      torrents[idx].status = settings.enableSeeding ? "seeding" : "completed";
      if (!settings.enableSeeding) {
        torrents[idx].uploaded = 0;
        torrents[idx].uploadSpeed = 0;
        activeTorrentIds.delete(payload.id);
      }
      store.set("torrents", torrents);

      // Add to library
      const library = store.get("library");
      const finalPath = torrents[idx].path;
      library.push({
        id: uuidv4(),
        name: torrents[idx].name,
        path: finalPath,
        size: torrents[idx].size,
        dateAdded: new Date().toISOString(),
        category: detectCategory(finalPath),
      });
      store.set("library", library);
      mainWindow?.webContents.send("library-updated", library);
      mainWindow?.webContents.send("torrent-complete", torrents[idx]);
    }
    return;
  }

  if (event === "torrent-error") {
    const torrents = store.get("torrents");
    const idx = torrents.findIndex((t: any) => t.id === payload.id);
    if (idx !== -1) {
      torrents[idx].status = "error";
      store.set("torrents", torrents);
    }
    mainWindow?.webContents.send("torrent-error", { id: payload.id, error: payload.error || "Torrent error" });
  }
}

// Types
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
  status: "pending" | "downloading" | "paused" | "completed" | "error" | "extracting";
  speed?: number;
  eta?: number;
  parts?: DownloadPart[];
  extractProgress?: number;
  extractStatus?: string;
  resumeData?: string;
}

interface DownloadPart {
  id: string;
  start: number;
  end: number;
  downloaded: number;
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

interface DebridConfig {
  service: "realdebrid" | "alldebrid" | "premiumize" | null;
  apiKey: string;
}

interface StoreSchema {
  bookmarks: Bookmark[];
  library: LibraryItem[];
  downloads: Download[];
  torrents: TorrentInfo[];
  settings: {
    downloadPath: string;
    maxConcurrentDownloads: number;
    hardwareAcceleration: boolean;
    enableSeeding: boolean;
    startOnBoot: boolean;
    requireVpn: boolean;
    debrid: DebridConfig;
  };
}

const store = new Store<StoreSchema>({
  defaults: {
    bookmarks: [
      {
        id: "1",
        name: "Internet Archive",
        url: "https://archive.org",
        favicon: "https://www.google.com/s2/favicons?domain=archive.org&sz=64",
      },
    ],
    library: [],
    downloads: [],
    torrents: [],
    settings: {
      downloadPath: path.join(app.getPath("downloads"), "Limbo"),
      maxConcurrentDownloads: 3,
      hardwareAcceleration: true,
      enableSeeding: false,
      startOnBoot: false,
      requireVpn: false,
      debrid: {
        service: null,
        apiKey: "",
      },
    },
  },
});

let mainWindow: BrowserWindow | null = null;
const activeDownloads = new Map<string, DownloadItem>();
const downloadSpeedTrackers = new Map<
  string,
  { lastBytes: number; lastTimeMs: number; emaBps: number }
>();
let resumeInProgress = false;

function updateSpeedTracker(downloadId: string, receivedBytes: number, paused: boolean): number {
  const now = Date.now();
  const prev = downloadSpeedTrackers.get(downloadId);

  if (!prev) {
    downloadSpeedTrackers.set(downloadId, {
      lastBytes: receivedBytes,
      lastTimeMs: now,
      emaBps: 0,
    });
    return 0;
  }

  if (paused) {
    // Reset timing baseline while paused so we don't spike on resume.
    downloadSpeedTrackers.set(downloadId, {
      lastBytes: receivedBytes,
      lastTimeMs: now,
      emaBps: 0,
    });
    return 0;
  }

  const dtSec = (now - prev.lastTimeMs) / 1000;
  const deltaBytes = receivedBytes - prev.lastBytes;

  // Too little time elapsed or bytes went backwards (shouldn't happen), just update baseline.
  if (dtSec <= 0.25 || deltaBytes < 0) {
    downloadSpeedTrackers.set(downloadId, {
      lastBytes: receivedBytes,
      lastTimeMs: now,
      emaBps: prev.emaBps,
    });
    return Math.max(0, Math.round(prev.emaBps));
  }

  const instBps = Math.max(0, deltaBytes / dtSec);
  const alpha = 0.2;
  const emaBps = prev.emaBps === 0 ? instBps : prev.emaBps * (1 - alpha) + instBps * alpha;

  downloadSpeedTrackers.set(downloadId, {
    lastBytes: receivedBytes,
    lastTimeMs: now,
    emaBps,
  });

  return Math.max(0, Math.round(emaBps));
}

function createWindow() {
  // Use PNG icon for all platforms (electron-builder will convert for production)
  const iconPath = path.join(__dirname, '../public/icon.png');

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    frame: false,
    backgroundColor: "#0a0a0a",
    icon: iconPath,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
      webviewTag: true,
    },
  });

  // Set partition for persistent cookies
  const ses = session.fromPartition("persist:limbo");
  
  // Allow webviews to use this session
  app.on("web-contents-created", (_, contents) => {
    if (contents.getType() === "webview") {
      contents.session.setPermissionRequestHandler((_, permission, callback) => {
        callback(true);
      });
    }
  });

  if (process.env.NODE_ENV === "development") {
    mainWindow.loadURL("http://localhost:5173");
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  // Send pending magnet/torrent links after the window is ready
  mainWindow.webContents.on('did-finish-load', () => {
    if (pendingMagnetLink) {
      mainWindow?.webContents.send('magnet-link-opened', pendingMagnetLink);
      pendingMagnetLink = null;
    }
    if (pendingTorrentFile) {
      mainWindow?.webContents.send('torrent-file-opened', pendingTorrentFile);
      pendingTorrentFile = null;
    }
  });

  // Download handler function
  const handleDownload = (
    event: Electron.Event,
    item: Electron.DownloadItem,
    webContents: Electron.WebContents,
    existingDownloadId?: string
  ) => {
    const downloadId = existingDownloadId ?? uuidv4();
    const settings = store.get("settings");
    const filename = item.getFilename();
    const mimeType = item.getMimeType();
    const savePath = item.getSavePath() || path.join(settings.downloadPath, filename);

    // Detect if we're downloading an HTML page instead of the actual file
    // This happens when file hosts serve their landing page
    const isHtmlDownload = mimeType === "text/html" || 
                           filename.endsWith(".html") || 
                           filename.endsWith(".htm");
    
    if (isHtmlDownload && isFileHostUrl(item.getURL())) {
      console.warn(`[Download] Received HTML from file host instead of file. Cancelling.`);
      console.warn(`[Download] URL: ${item.getURL()}`);
      console.warn(`[Download] Consider using a Debrid service for reliable file host downloads.`);
      item.cancel();
      
      // Notify user
      mainWindow?.webContents.send("download-complete", {
        id: downloadId,
        status: "error",
        error: "FILE_HOST_BLOCKED",
      });
      return;
    }

    // Ensure download directory exists
    if (!fs.existsSync(settings.downloadPath)) {
      fs.mkdirSync(settings.downloadPath, { recursive: true });
    }

    if (!item.getSavePath()) item.setSavePath(savePath);
    activeDownloads.set(downloadId, item);

    // Initialize speed tracking for this download (including resumes).
    downloadSpeedTrackers.set(downloadId, {
      lastBytes: item.getReceivedBytes(),
      lastTimeMs: Date.now(),
      emaBps: 0,
    });

    const download: Download = {
      id: downloadId,
      filename: filename,
      url: item.getURL(),
      path: savePath,
      size: item.getTotalBytes(),
      downloaded: 0,
      status: "downloading",
      speed: 0,
    };

    // Add to store (or reuse existing entry if resuming)
    const downloads = store.get("downloads");
    const existingIdx = downloads.findIndex((d) => d.id === downloadId);
    if (existingIdx === -1) {
      downloads.push(download);
      store.set("downloads", downloads);
      mainWindow?.webContents.send("download-started", download);
    } else {
      downloads[existingIdx] = {
        ...downloads[existingIdx],
        filename: download.filename,
        url: download.url,
        path: download.path,
        size: download.size,
        status: "downloading" as any,
      };
      store.set("downloads", downloads);
      mainWindow?.webContents.send("download-progress", {
        id: downloadId,
        downloaded: item.getReceivedBytes(),
        total: item.getTotalBytes(),
        status: "downloading",
        speed: downloads[existingIdx].speed || 0,
      });
    }

    item.on("updated", (event, state) => {
      const downloads = store.get("downloads");
      const idx = downloads.findIndex((d) => d.id === downloadId);
      if (idx !== -1) {
        const prevStatus = downloads[idx].status;
        const received = item.getReceivedBytes();
        downloads[idx].downloaded = received;
        // Electron's `state` can remain "progressing" even while the item is paused.
        // Use `item.isPaused()` as the source of truth to avoid UI flipping back to "downloading".
        const paused = item.isPaused();
        downloads[idx].status = paused ? "paused" : (state === "progressing" ? "downloading" : "paused");

        // Compute speed (bytes/sec) from received-bytes deltas.
        downloads[idx].speed = updateSpeedTracker(downloadId, received, paused);

        if (prevStatus !== downloads[idx].status) {
          console.log(`[Download] ${downloadId} status changed: ${prevStatus} -> ${downloads[idx].status}`);
        }

        try {
          const resumeData = (item as any).getResumeData?.();
          downloads[idx].resumeData = resumeData?.toString("base64");
        } catch {}

        store.set("downloads", downloads);
        mainWindow?.webContents.send("download-progress", {
          id: downloadId,
          downloaded: received,
          total: item.getTotalBytes(),
          status: downloads[idx].status,
          speed: downloads[idx].speed || 0,
        });
      }
    });

    item.once("done", (event, state) => {
      activeDownloads.delete(downloadId);
      downloadSpeedTrackers.delete(downloadId);
      const downloads = store.get("downloads");
      const idx = downloads.findIndex((d) => d.id === downloadId);
      if (idx !== -1) {
        downloads[idx].status = state === "completed" ? "completed" : "error";
        downloads[idx].downloaded = item.getReceivedBytes();
        downloads[idx].speed = 0;

        if (state === "completed") {
          downloads[idx].resumeData = undefined;
        } else {
          // Keep resumeData if present so we can continue after relaunch.
          try {
            const resumeData = (item as any).getResumeData?.();
            downloads[idx].resumeData = resumeData?.toString("base64") || downloads[idx].resumeData;
          } catch {}
        }

        store.set("downloads", downloads);

        // Add to library if completed
        if (state === "completed") {
          const filename = item.getFilename();
          const downloadDir = path.dirname(savePath);
          
          // Check if this is a multi-part archive
          const multiPartInfo = parseMultiPartArchive(filename);
          
          // Auto-extract if it's an archive (runs in worker thread, non-blocking)
          if (isExtractableArchive(filename)) {
            
            // Handle multi-part archives specially
            if (multiPartInfo.isMultiPart) {
              console.log(`[Download] Multi-part archive detected: ${filename} (part ${multiPartInfo.partNumber})`);
              
              // Check if all parts are COMPLETED (not just present on disk)
              const currentDownloads = store.get("downloads");
              const partsCheck = areAllPartsCompleted(multiPartInfo.baseName, currentDownloads);
              
              console.log(`[Download] Parts status: ${partsCheck.completedParts}/${partsCheck.totalParts} completed`);
              
              if (!partsCheck.allCompleted) {
                console.log(`[Download] Waiting for other parts to complete...`);
                
                // Mark as completed but don't extract yet - wait for other parts
                mainWindow?.webContents.send("download-complete", {
                  id: downloadId,
                  status: "completed",
                });
                return; // Don't extract yet
              }
              
              // All parts completed - check if extraction is already in progress
              if (pendingMultiPartExtractions.has(multiPartInfo.baseName.toLowerCase())) {
                console.log(`[Download] Extraction already in progress for ${multiPartInfo.baseName}`);
                mainWindow?.webContents.send("download-complete", {
                  id: downloadId,
                  status: "completed",
                });
                return;
              }
              
              // Mark extraction as pending
              pendingMultiPartExtractions.add(multiPartInfo.baseName.toLowerCase());
              console.log(`[Download] All ${partsCheck.totalParts} parts completed! Starting extraction from: ${partsCheck.part1Path}`);
              
              // Use part1 path for extraction
              const extractPath = partsCheck.part1Path!;
              
              // Update status to extracting for ALL parts so the UI doesn't show just the last-finished part as extracting.
              {
                const allDownloads = store.get("downloads");
                const related = allDownloads.filter((d) => {
                  const info = parseMultiPartArchive(d.filename);
                  return info.isMultiPart && info.baseName.toLowerCase() === multiPartInfo.baseName.toLowerCase();
                });

                for (const d of related) {
                  d.status = "extracting" as any;
                  d.extractProgress = 0;
                  d.extractStatus = "Extracting multi-part archive...";
                }
                store.set("downloads", allDownloads);

                for (const d of related) {
                  mainWindow?.webContents.send("download-progress", {
                    id: d.id,
                    downloaded: d.downloaded,
                    total: d.size,
                    status: "extracting",
                    extractProgress: 0,
                    extractStatus: "Extracting multi-part archive...",
                  });
                }
              }
              
              // Run extraction on part1 (which will use other parts automatically)
              autoExtractArchiveAsync(
                extractPath,
                downloadId,
                (percent, status) => {
                  // Mirror extraction progress across all parts
                  const allDownloads = store.get("downloads");
                  const related = allDownloads.filter((d) => {
                    const info = parseMultiPartArchive(d.filename);
                    return info.isMultiPart && info.baseName.toLowerCase() === multiPartInfo.baseName.toLowerCase();
                  });

                  for (const d of related) {
                    d.status = "extracting" as any;
                    d.extractProgress = percent;
                    d.extractStatus = status;
                  }
                  store.set("downloads", allDownloads);

                  for (const d of related) {
                    mainWindow?.webContents.send("download-progress", {
                      id: d.id,
                      downloaded: d.downloaded,
                      total: d.size,
                      status: "extracting",
                      extractProgress: percent,
                      extractStatus: status,
                    });
                  }
                },
                (extractedDir) => {
                  pendingMultiPartExtractions.delete(multiPartInfo.baseName.toLowerCase());
                  
                  const downloads = store.get("downloads");
                  let libraryPath = extractPath;
                  let libraryName = multiPartInfo.baseName;
                  
                  if (extractedDir) {
                    libraryPath = extractedDir;
                    libraryName = path.basename(extractedDir);
                    
                    // Delete all archive parts after successful extraction
                    try {
                      const files = fs.readdirSync(downloadDir);
                      for (const file of files) {
                        const info = parseMultiPartArchive(file);
                        if (info.isMultiPart && info.baseName.toLowerCase() === multiPartInfo.baseName.toLowerCase()) {
                          const filePath = path.join(downloadDir, file);
                          fs.unlinkSync(filePath);
                          console.log(`Deleted archive part: ${filePath}`);
                        }
                      }
                    } catch (err) {
                      console.error(`Failed to delete archive parts:`, err);
                    }
                  }
                  
                  // Update status back to completed for ALL parts.
                  // Also normalize the display name / open-location target so parts don't look like separate items forever.
                  const related = downloads.filter((d) => {
                    const info = parseMultiPartArchive(d.filename);
                    return info.isMultiPart && info.baseName.toLowerCase() === multiPartInfo.baseName.toLowerCase();
                  });

                  for (const d of related) {
                    d.status = "completed";
                    d.extractProgress = undefined;
                    d.extractStatus = undefined;
                    if (extractedDir) {
                      d.filename = libraryName;
                      d.path = libraryPath;
                    }
                  }
                  store.set("downloads", downloads);
                  
                  // Add to library with auto-detected category
                  const library = store.get("library");
                  library.push({
                    id: uuidv4(),
                    name: libraryName,
                    path: libraryPath,
                    size: item.getTotalBytes(),
                    dateAdded: new Date().toISOString(),
                    category: detectCategory(libraryPath),
                  });
                  store.set("library", library);
                  mainWindow?.webContents.send("library-updated", library);

                  for (const d of related) {
                    mainWindow?.webContents.send("download-complete", {
                      id: d.id,
                      status: "completed",
                    });
                  }
                }
              );
            } else {
              // Single-part archive - extract normally
              // Update status to extracting
              downloads[idx].status = "extracting" as any;
              store.set("downloads", downloads);
              mainWindow?.webContents.send("download-progress", {
                id: downloadId,
                downloaded: item.getReceivedBytes(),
                total: item.getTotalBytes(),
                status: "extracting",
                extractProgress: 0,
                extractStatus: "Starting extraction...",
              });

              // Run extraction in worker thread
              autoExtractArchiveAsync(
                savePath,
                downloadId,
                (percent, status) => {
                  mainWindow?.webContents.send("download-progress", {
                    id: downloadId,
                    downloaded: item.getReceivedBytes(),
                    total: item.getTotalBytes(),
                    status: "extracting",
                    extractProgress: percent,
                    extractStatus: status,
                  });
                },
                (extractedDir) => {
                  const downloads = store.get("downloads");
                  const idx = downloads.findIndex((d) => d.id === downloadId);
                  
                  let libraryPath = savePath;
                  let libraryName = filename;
                  
                  if (extractedDir) {
                    libraryPath = extractedDir;
                    libraryName = path.basename(extractedDir);
                    
                    // Delete the original archive
                    try {
                      fs.unlinkSync(savePath);
                      console.log(`Deleted archive: ${savePath}`);
                    } catch (err) {
                      console.error(`Failed to delete archive: ${savePath}`, err);
                    }
                  }
                  
                  // Update status back to completed
                  if (idx !== -1) {
                    downloads[idx].status = "completed";
                    store.set("downloads", downloads);
                  }
                  
                  // Add to library with auto-detected category
                  const library = store.get("library");
                  library.push({
                    id: uuidv4(),
                    name: libraryName,
                    path: libraryPath,
                    size: item.getTotalBytes(),
                    dateAdded: new Date().toISOString(),
                    category: detectCategory(libraryPath),
                  });
                  store.set("library", library);
                  mainWindow?.webContents.send("library-updated", library);
                  
                  mainWindow?.webContents.send("download-complete", {
                    id: downloadId,
                    status: "completed",
                  });
                }
              );
            }
          } else {
            // Not an archive, add directly to library with auto-detected category
            const library = store.get("library");
            library.push({
              id: uuidv4(),
              name: filename,
              path: savePath,
              size: item.getTotalBytes(),
              dateAdded: new Date().toISOString(),
              category: detectCategory(savePath),
            });
            store.set("library", library);
            mainWindow?.webContents.send("library-updated", library);
            
            mainWindow?.webContents.send("download-complete", {
              id: downloadId,
              status: downloads[idx].status,
            });
          }
        } else {
          // Download failed
          mainWindow?.webContents.send("download-complete", {
            id: downloadId,
            status: downloads[idx].status,
          });
        }
      }
    });
  };

  // Attach download handler to both sessions
  ses.on("will-download", handleDownload);
  session.defaultSession.on("will-download", handleDownload);

  // Resume downloads that were in-progress last run (best-effort)
  const resumePendingDownloads = () => {
    if (resumeInProgress) return;
    resumeInProgress = true;

    const downloads = store.get("downloads");
    const toResume = downloads.filter(
      (d) => (d.status === "downloading" || d.status === "pending") && !!d.resumeData
    );
    if (toResume.length === 0) {
      resumeInProgress = false;
      return;
    }

    for (const d of toResume) {
      try {
        const buf = Buffer.from(d.resumeData!, "base64");
        // Try the persistent session first (covers webview-initiated downloads).
        let item: DownloadItem | null = null;
        try {
          item = (ses as any).createInterruptedDownload(buf);
        } catch {
          item = (session.defaultSession as any).createInterruptedDownload(buf);
        }
        if (item) {
          handleDownload({} as any, item as any, mainWindow!.webContents, d.id);
        }
      } catch (err) {
        console.warn("Failed to resume download", d.id, err);
      }
    }

    resumeInProgress = false;
  };

  // Run after window load so renderer is ready to receive events.
  mainWindow.webContents.once("did-finish-load", () => {
    resumePendingDownloads();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    if (clipboardWatcher) {
      clearInterval(clipboardWatcher);
      clipboardWatcher = null;
    }
  });

  // Start clipboard monitoring
  startClipboardMonitoring();
  
  // Sync library with filesystem (remove deleted items)
  syncLibraryWithFilesystem();
  
  // Periodic library sync every 30 seconds
  setInterval(() => {
    syncLibraryWithFilesystem();
  }, 30000);
}

// Clipboard monitoring function
function startClipboardMonitoring() {
  // Check clipboard every 100ms for near-instant detection
  clipboardWatcher = setInterval(() => {
    try {
      const text = clipboard.readText().trim();
      if (text && text !== lastClipboardContent) {
        lastClipboardContent = text;
        
        // Check for multiple URLs (split by newlines, spaces, or common separators)
        const potentialUrls = text.split(/[\n\r\s]+/).filter(Boolean);
        const detectedUrls: string[] = [];
        
        for (const potentialUrl of potentialUrls) {
          if (isDownloadableUrl(potentialUrl.trim())) {
            detectedUrls.push(potentialUrl.trim());
          }
        }
        
        // Also check if the whole text is a single magnet link
        if (detectedUrls.length === 0 && text.startsWith('magnet:')) {
          detectedUrls.push(text);
        }
        
        if (detectedUrls.length > 0) {
          // Send all detected URLs
          mainWindow?.webContents.send('clipboard-download-detected', detectedUrls);
        }
      }
    } catch {
      // Ignore clipboard access errors
    }
  }, 100);
}

// URL patterns for clipboard monitoring
const DOWNLOAD_PATTERNS = [
  /^magnet:\?/i,
  /\.(rar|zip|7z|tar|gz|iso|exe|msi|dmg|pkg|deb|rpm)(\?.*)?$/i,
  /rapidgator\.net/i,
  /nitroflare\.com/i,
  /uploadgig\.com/i,
  /1fichier\.com/i,
  /mega\.nz/i,
  /mediafire\.com/i,
  /turbobit\.net/i,
  /katfile\.com/i,
  /filefactory\.com/i,
];

function isDownloadableUrl(text: string): boolean {
  if (!text || text.length < 5 || text.length > 2000) return false;
  
  try {
    if (text.startsWith('magnet:')) return true;
    
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    
    return DOWNLOAD_PATTERNS.some(pattern => pattern.test(text));
  } catch {
    return false;
  }
}

app.whenReady().then(async () => {
  await initWebTorrent();
  createWindow();
  initAutoUpdater();

  // Handle magnet links opened from OS
  app.on('open-url', (event, url) => {
    event.preventDefault();
    if (url.startsWith('magnet:')) {
      mainWindow?.webContents.send('magnet-link-opened', url);
    }
  });
  
  // Handle .torrent files opened from OS (macOS)
  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    if (filePath.endsWith('.torrent')) {
      if (mainWindow) {
        mainWindow.webContents.send('torrent-file-opened', filePath);
      } else {
        pendingTorrentFile = filePath;
      }
    }
  });
  
  // Check command line args for initial launch with .torrent file
  const torrentArg = findTorrentFileArg(process.argv);
  if (torrentArg) pendingTorrentFile = torrentArg;

  const magnetArg = findMagnetArg(process.argv);
  if (magnetArg) pendingMagnetLink = magnetArg;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (mainWindow === null) {
    createWindow();
  }
});

// IPC Handlers

// Window controls
ipcMain.on("window-minimize", () => mainWindow?.minimize());
ipcMain.on("window-maximize", () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow?.maximize();
  }
});
ipcMain.on("window-close", () => mainWindow?.close());

// Bookmarks
ipcMain.handle("get-bookmarks", () => store.get("bookmarks"));
ipcMain.handle("add-bookmark", (_, bookmark: Omit<Bookmark, "id">) => {
  const bookmarks = store.get("bookmarks");
  const newBookmark = { ...bookmark, id: uuidv4() };
  bookmarks.push(newBookmark);
  store.set("bookmarks", bookmarks);
  return newBookmark;
});
ipcMain.handle("remove-bookmark", (_, id: string) => {
  const bookmarks = store.get("bookmarks").filter((b) => b.id !== id);
  store.set("bookmarks", bookmarks);
  return bookmarks;
});
ipcMain.handle("update-bookmark", (_, bookmark: Bookmark) => {
  const bookmarks = store.get("bookmarks");
  const idx = bookmarks.findIndex((b) => b.id === bookmark.id);
  if (idx !== -1) {
    bookmarks[idx] = bookmark;
    store.set("bookmarks", bookmarks);
  }
  return bookmarks;
});

ipcMain.handle("reset-bookmarks", () => {
  const defaults: Bookmark[] = [
    {
      id: "1",
      name: "Internet Archive",
      url: "https://archive.org",
      favicon: "https://www.google.com/s2/favicons?domain=archive.org&sz=64",
    },
  ];
  store.set("bookmarks", defaults);
  return defaults;
});

function buildFaviconUrl(url: string): string {
  try {
    const u = new URL(url);
    return `https://www.google.com/s2/favicons?domain=${u.hostname}&sz=64`;
  } catch {
    return "";
  }
}

function normalizeBookmarkUrl(value: string): string | null {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    // Accept URLs without protocol and default them to https.
    const candidate = raw.startsWith("http://") || raw.startsWith("https://") ? raw : `https://${raw}`;
    const u = new URL(candidate);
    if (!u.hostname) return null;
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

function sanitizeBookmarks(input: unknown): Bookmark[] {
  if (!Array.isArray(input)) return [];

  const result: Bookmark[] = [];
  const seenIds = new Set<string>();

  for (const entry of input) {
    if (!entry || typeof entry !== "object") continue;
    const obj: any = entry;
    const normalizedUrl = normalizeBookmarkUrl(obj.url);
    if (!normalizedUrl) continue;

    const nameRaw = typeof obj.name === "string" ? obj.name.trim() : "";
    let name = nameRaw;
    if (!name) {
      try {
        name = new URL(normalizedUrl).hostname;
      } catch {
        name = "Bookmark";
      }
    }

    let id = typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : uuidv4();
    while (seenIds.has(id)) id = uuidv4();
    seenIds.add(id);

    const favicon = typeof obj.favicon === "string" && obj.favicon.trim()
      ? obj.favicon.trim()
      : buildFaviconUrl(normalizedUrl);

    result.push({ id, name, url: normalizedUrl, favicon });
  }

  return result;
}

ipcMain.handle("export-bookmarks", async () => {
  const bookmarks = store.get("bookmarks");
  const result = await dialog.showSaveDialog(mainWindow!, {
    title: "Export bookmarks",
    defaultPath: path.join(app.getPath("documents"), "limbo-bookmarks.json"),
    filters: [{ name: "JSON", extensions: ["json"] }],
  });

  if (result.canceled || !result.filePath) return null;

  fs.writeFileSync(result.filePath, JSON.stringify(bookmarks, null, 2), "utf-8");
  return result.filePath;
});

ipcMain.handle("import-bookmarks", async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: "Import bookmarks",
    properties: ["openFile"],
    filters: [{ name: "JSON", extensions: ["json"] }],
  });

  if (result.canceled || !result.filePaths[0]) return null;

  const raw = fs.readFileSync(result.filePaths[0], "utf-8");
  const parsed = JSON.parse(raw);
  const bookmarks = sanitizeBookmarks(parsed);
  store.set("bookmarks", bookmarks);
  return bookmarks;
});

// Library
ipcMain.handle("get-library", () => store.get("library"));
ipcMain.handle("add-to-library", (_, item: Omit<LibraryItem, "id" | "dateAdded">) => {
  const library = store.get("library");
  const newItem = { ...item, id: uuidv4(), dateAdded: new Date().toISOString() };
  library.push(newItem);
  store.set("library", library);
  return newItem;
});
ipcMain.handle("remove-from-library", async (_, id: string, deleteFiles: boolean) => {
  const library = store.get("library");
  const item = library.find((l) => l.id === id);
  
  if (item && deleteFiles) {
    try {
      if (fs.existsSync(item.path)) {
        fs.rmSync(item.path, { recursive: true });
      }
    } catch (err) {
      console.error("Failed to delete files:", err);
    }
  }
  
  const newLibrary = library.filter((l) => l.id !== id);
  store.set("library", newLibrary);
  return newLibrary;
});
ipcMain.handle("open-file-location", (_, filePath: string) => {
  // If it's a directory, open it directly. If it's a file, show in folder
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    shell.openPath(filePath);
  } else {
    shell.showItemInFolder(filePath);
  }
});
ipcMain.handle("open-file", (_, filePath: string) => {
  // If it's a directory, open it in explorer
  shell.openPath(filePath);
});

// Downloads
ipcMain.handle("get-downloads", () => store.get("downloads"));
ipcMain.handle("pause-download", (_, id: string) => {
  const item = activeDownloads.get(id);
  if (item) {
    if (item.canResume()) {
      item.pause();
      console.log(`[Download] Paused download: ${id}`);
    } else {
      console.warn(`[Download] Cannot pause download ${id} - server doesn't support resume`);
      // Still try to pause anyway
      item.pause();
    }
  } else {
    console.warn(`[Download] Cannot pause - download ${id} not found in active downloads`);
  }
});
ipcMain.handle("resume-download", async (_, id: string) => {
  // First, try to resume an active download
  const item = activeDownloads.get(id);
  if (item) {
    if (item.isPaused()) {
      item.resume();
      console.log(`[Download] Resumed download: ${id}`);
    } else {
      console.log(`[Download] Download ${id} is not paused, state: ${item.getState()}`);
    }
    return;
  }
  
  console.log(`[Download] Download ${id} not in active downloads, checking store...`);
  
  // If not in active downloads (app was restarted), try to resume with saved data
  const downloads = store.get("downloads");
  const download = downloads.find((d) => d.id === id);
  if (!download) {
    console.warn(`[Download] Download ${id} not found in store`);
    return;
  }
  
  if (download.status !== "paused" && download.status !== "downloading") {
    console.log(`[Download] Download ${id} status is ${download.status}, cannot resume`);
    return;
  }
  
  // Try to resume with resume data if available
  if (download.resumeData && download.path) {
    console.log(`[Download] Attempting to resume download ${id} with resume data`);
    try {
      const ses = session.fromPartition("persist:limbo");
      // Resume using the canResumeCallback pattern
      ses.createInterruptedDownload({
        path: download.path,
        urlChain: [download.url],
        offset: download.downloaded,
        length: download.size,
      });
      return;
    } catch (err) {
      console.error(`[Download] Failed to resume with resume data:`, err);
    }
  }
  
  // Fall back to re-starting the download
  console.log(`[Download] Re-starting download ${id} from URL`);
  const ses = session.fromPartition("persist:limbo");
  ses.downloadURL(download.url);
});
ipcMain.handle("pause-all-downloads", () => {
  console.log(`[Download] Pausing all downloads (${activeDownloads.size} active)`);
  for (const [id, item] of activeDownloads) {
    if (!item.isPaused()) {
      item.pause();
      console.log(`[Download] Paused: ${id}`);
    }
  }
});
ipcMain.handle("resume-all-downloads", async () => {
  console.log(`[Download] Resuming all downloads`);
  // Resume active downloads
  for (const [id, item] of activeDownloads) {
    if (item.isPaused()) {
      item.resume();
      console.log(`[Download] Resumed: ${id}`);
    }
  }
  
  // Also re-initiate any paused downloads that aren't in activeDownloads (after restart)
  const downloads = store.get("downloads");
  const ses = session.fromPartition("persist:limbo");
  for (const d of downloads) {
    if (d.status === "paused" && d.url && !activeDownloads.has(d.id)) {
      console.log(`[Download] Re-starting paused download: ${d.id}`);
      ses.downloadURL(d.url);
    }
  }
});
ipcMain.handle("cancel-download", (_, id: string) => {
  const item = activeDownloads.get(id);
  if (item) {
    item.cancel();
  }
  activeDownloads.delete(id);
  const downloads = store.get("downloads").filter((d) => d.id !== id);
  store.set("downloads", downloads);
  return downloads;
});
ipcMain.handle("clear-completed-downloads", () => {
  const downloads = store.get("downloads").filter(
    (d) => d.status !== "completed" && d.status !== "error"
  );
  store.set("downloads", downloads);
  return downloads;
});

// Start a manual download
ipcMain.handle("start-download", async (_, url: string, options?: { filename?: string; useDebrid?: boolean }): Promise<{ success: boolean; debridError?: string; warning?: string }> => {
  const settings = store.get("settings");
  let finalUrl = url;
  let debridError: string | undefined;
  let warning: string | undefined;
  
  // Check for debrid first (premium, most reliable) - only if not explicitly disabled
  const shouldUseDebrid = options?.useDebrid !== false && settings.debrid.service && settings.debrid.apiKey;
  
  if (shouldUseDebrid) {
    console.log(`[Download] Debrid configured (${settings.debrid.service}), attempting to unrestrict...`);
    const result = await unrestrictLink(url, settings.debrid);
    if (result.url) {
      console.log(`[Download] Using debrid unrestricted URL`);
      finalUrl = result.url;
    } else {
      debridError = result.error;
      console.warn(`[Download] Debrid failed: ${debridError}`);
    }
  } else if (options?.useDebrid === false) {
    console.log(`[Download] Debrid explicitly disabled for this download`);
  } else {
    console.log(`[Download] No debrid configured. Service: ${settings.debrid.service}, API key set: ${!!settings.debrid.apiKey}`);
  }
  
  // If debrid didn't work and it's a file host, try to extract direct link
  if (finalUrl === url && isFileHostUrl(url)) {
    console.log("[Download] Attempting to extract direct link from file host...");
    const extractedUrl = await extractFileHostLink(url);
    if (extractedUrl) {
      finalUrl = extractedUrl;
    } else {
      // File host detected but couldn't extract - warn user but still try
      warning = "File host detected - download may fail without Debrid.";
      console.warn("[Download] Could not extract direct link from file host. Will attempt anyway.");
    }
  }
  
  mainWindow?.webContents.downloadURL(finalUrl);
  return { success: true, debridError, warning };
});

// Settings
ipcMain.handle("get-settings", () => store.get("settings"));
ipcMain.handle("update-settings", (_, settings: Partial<StoreSchema["settings"]>) => {
  const current = store.get("settings");
  const updated = { ...current, ...settings };
  store.set("settings", updated);

  if (typeof settings.enableSeeding === "boolean" && settings.enableSeeding !== current.enableSeeding) {
    try {
      torrentWorker?.postMessage({ type: "set-seeding", enableSeeding: updated.enableSeeding });
    } catch {}
  }

  // Handle start on boot setting
  if (typeof settings.startOnBoot === "boolean" && settings.startOnBoot !== current.startOnBoot) {
    app.setLoginItemSettings({
      openAtLogin: settings.startOnBoot,
      openAsHidden: false,
    });
  }

  return updated;
});
ipcMain.handle("select-download-path", async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ["openDirectory"],
  });
  if (!result.canceled && result.filePaths[0]) {
    const settings = store.get("settings");
    settings.downloadPath = result.filePaths[0];
    store.set("settings", settings);
    return result.filePaths[0];
  }
  return null;
});

// Add folder to library (for manually adding existing games/software)
ipcMain.handle("add-folder-to-library", async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ["openDirectory"],
  });
  if (!result.canceled && result.filePaths[0]) {
    const folderPath = result.filePaths[0];
    const folderName = path.basename(folderPath);
    const stats = fs.statSync(folderPath);
    
    const library = store.get("library");
    const newItem: LibraryItem = {
      id: uuidv4(),
      name: folderName,
      path: folderPath,
      size: getFolderSize(folderPath),
      dateAdded: new Date().toISOString(),
    };
    library.push(newItem);
    store.set("library", library);
    return newItem;
  }
  return null;
});

// Debrid helpers
interface DebridResult {
  url: string | null;
  error?: string;
}

async function unrestrictLink(url: string, debrid: DebridConfig): Promise<DebridResult> {
  try {
    console.log(`[Debrid] Attempting to unrestrict link via ${debrid.service}: ${url}`);
    
    if (debrid.service === "realdebrid") {
      const response = await fetch("https://api.real-debrid.com/rest/1.0/unrestrict/link", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${debrid.apiKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: `link=${encodeURIComponent(url)}`,
      });
      const data = await response.json();
      
      if (data.error) {
        console.error(`[Debrid] Real-Debrid error: ${data.error} (code: ${data.error_code})`);
        // Provide user-friendly error messages
        let friendlyError = data.error;
        if (data.error.startsWith("ip_not_allowed")) {
          friendlyError = "Real-Debrid: IP not allowed. Regenerate API key from current IP or disable VPN.";
        } else if (data.error === "hoster_unavailable") {
          friendlyError = "Real-Debrid: This file host is not supported.";
        } else if (data.error === "link_host_not_supported") {
          friendlyError = "Real-Debrid: This file host is not supported.";
        }
        return { url: null, error: friendlyError };
      }
      
      if (data.download) {
        console.log(`[Debrid] Successfully unrestricted link via Real-Debrid`);
        return { url: data.download };
      }
      
      console.warn(`[Debrid] Real-Debrid returned no download link. Response:`, data);
      return { url: null, error: "Real-Debrid: No download link returned." };
    } else if (debrid.service === "alldebrid") {
      const response = await fetch(
        `https://api.alldebrid.com/v4/link/unlock?agent=limbo&apikey=${debrid.apiKey}&link=${encodeURIComponent(url)}`
      );
      const data = await response.json();
      
      if (data.status === "error" || data.error) {
        const errMsg = data.error?.message || data.error || 'Unknown error';
        console.error(`[Debrid] AllDebrid error: ${errMsg}`);
        return { url: null, error: `AllDebrid: ${errMsg}` };
      }
      
      if (data.data?.link) {
        console.log(`[Debrid] Successfully unrestricted link via AllDebrid`);
        return { url: data.data.link };
      }
      
      console.warn(`[Debrid] AllDebrid returned no download link. Response:`, data);
      return { url: null, error: "AllDebrid: No download link returned." };
    } else if (debrid.service === "premiumize") {
      const response = await fetch(
        `https://www.premiumize.me/api/transfer/directdl?apikey=${debrid.apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: `src=${encodeURIComponent(url)}`,
        }
      );
      const data = await response.json();
      
      if (data.status !== "success") {
        console.error(`[Debrid] Premiumize error: ${data.message || 'Unknown error'}`);
        return { url: null, error: `Premiumize: ${data.message || 'Unknown error'}` };
      }
      
      if (data.content?.[0]?.link) {
        console.log(`[Debrid] Successfully unrestricted link via Premiumize`);
        return { url: data.content[0].link };
      }
      
      console.warn(`[Debrid] Premiumize returned no download link. Response:`, data);
      return { url: null, error: "Premiumize: No download link returned." };
    }
    
    console.warn(`[Debrid] Unknown debrid service: ${debrid.service}`);
    return { url: null, error: `Unknown debrid service: ${debrid.service}` };
  } catch (err) {
    console.error("[Debrid] Error unrestricting link:", err);
    return { url: null, error: `Debrid error: ${err}` };
  }
}

// Debrid magnet link conversion
async function convertMagnetWithDebrid(magnetUri: string, debrid: DebridConfig): Promise<string[] | null> {
  try {
    if (debrid.service === "realdebrid") {
      // First, add the magnet to Real-Debrid
      const addResponse = await fetch("https://api.real-debrid.com/rest/1.0/torrents/addMagnet", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${debrid.apiKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: `magnet=${encodeURIComponent(magnetUri)}`,
      });
      const addData = await addResponse.json();
      
      if (!addData.id) return null;
      
      // Select all files
      await fetch(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${addData.id}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${debrid.apiKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "files=all",
      });
      
      // Wait a moment for processing
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Get torrent info
      const infoResponse = await fetch(`https://api.real-debrid.com/rest/1.0/torrents/info/${addData.id}`, {
        headers: { Authorization: `Bearer ${debrid.apiKey}` },
      });
      const infoData = await infoResponse.json();
      
      // Return the links
      if (infoData.links && infoData.links.length > 0) {
        // Unrestrict each link
        const unrestrictedLinks: string[] = [];
        for (const link of infoData.links) {
          const result = await unrestrictLink(link, debrid);
          if (result.url) unrestrictedLinks.push(result.url);
        }
        return unrestrictedLinks.length > 0 ? unrestrictedLinks : null;
      }
      return null;
    } else if (debrid.service === "alldebrid") {
      const response = await fetch(
        `https://api.alldebrid.com/v4/magnet/upload?agent=limbo&apikey=${debrid.apiKey}&magnets[]=${encodeURIComponent(magnetUri)}`
      );
      const data = await response.json();
      
      if (data.data?.magnets?.[0]?.id) {
        // Wait for processing
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        // Get status
        const statusResponse = await fetch(
          `https://api.alldebrid.com/v4/magnet/status?agent=limbo&apikey=${debrid.apiKey}&id=${data.data.magnets[0].id}`
        );
        const statusData = await statusResponse.json();
        
        if (statusData.data?.magnets?.links) {
          return statusData.data.magnets.links.map((l: any) => l.link);
        }
      }
      return null;
    } else if (debrid.service === "premiumize") {
      const formData = new URLSearchParams();
      formData.append('src', magnetUri);
      
      const response = await fetch("https://www.premiumize.me/api/transfer/create", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${debrid.apiKey}`,
        },
        body: formData,
      });
      const data = await response.json();
      
      if (data.id) {
        // Wait and check status
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        const listResponse = await fetch(`https://www.premiumize.me/api/transfer/list?apikey=${debrid.apiKey}`);
        const listData = await listResponse.json();
        
        const transfer = listData.transfers?.find((t: any) => t.id === data.id);
        if (transfer?.folder_id) {
          const folderResponse = await fetch(`https://www.premiumize.me/api/folder/list?id=${transfer.folder_id}&apikey=${debrid.apiKey}`);
          const folderData = await folderResponse.json();
          return folderData.content?.filter((f: any) => f.link).map((f: any) => f.link) || null;
        }
      }
      return null;
    }
  } catch (err) {
    console.error("Debrid magnet error:", err);
  }
  return null;
}

// Handler for debrid magnet conversion
ipcMain.handle("convert-magnet-debrid", async (_, magnetUri: string) => {
  const settings = store.get("settings");
  if (!settings.debrid.service || !settings.debrid.apiKey) {
    throw new Error("Debrid service not configured");
  }
  
  const links = await convertMagnetWithDebrid(magnetUri, settings.debrid);
  if (!links || links.length === 0) {
    throw new Error("Failed to convert magnet link");
  }
  
  // Start downloading all links
  for (const link of links) {
    mainWindow?.webContents.downloadURL(link);
  }
  
  return links;
});

// Check if debrid is configured
ipcMain.handle("is-debrid-configured", () => {
  const settings = store.get("settings");
  return settings.debrid.service !== null && settings.debrid.apiKey !== "";
});

function getFolderSize(folderPath: string): number {
  let size = 0;
  try {
    const files = fs.readdirSync(folderPath);
    for (const file of files) {
      const filePath = path.join(folderPath, file);
      const stats = fs.statSync(filePath);
      if (stats.isDirectory()) {
        size += getFolderSize(filePath);
      } else {
        size += stats.size;
      }
    }
  } catch (err) {
    console.error("Error calculating folder size:", err);
  }
  return size;
}

// Torrent handlers
ipcMain.handle("get-torrents", () => store.get("torrents"));
ipcMain.handle("is-torrent-supported", () => torrentWorkerReady);

function parseMagnetDisplayName(magnetUri: string): string | null {
  try {
    const match = magnetUri.match(/[?&]dn=([^&]+)/i);
    if (!match) return null;
    return decodeURIComponent(match[1].replace(/\+/g, '%20'));
  } catch {
    return null;
  }
}

ipcMain.handle("check-vpn-status", () => {
  return isVpnConnected();
});

ipcMain.handle("add-torrent", async (_, magnetUri: string) => {
  if (!torrentWorkerReady) throw new Error("Torrent support is not available.");
  
  const settings = store.get("settings");
  const downloadPath = settings.downloadPath;

  // Check VPN if required
  if (settings.requireVpn && !isVpnConnected()) {
    throw new Error("VPN_REQUIRED");
  }

  // Ensure download directory exists
  if (!fs.existsSync(downloadPath)) {
    fs.mkdirSync(downloadPath, { recursive: true });
  }

  try {
    const torrentId = uuidv4();
    const displayName = parseMagnetDisplayName(magnetUri) || "Loading torrent…";

    console.log(`[Torrent] Adding magnet: ${displayName}`);
    console.log(`[Torrent] Trackers: ${publicTrackers.length}`);

    activeTorrentIds.add(torrentId);

    const torrentInfo: TorrentInfo = {
      id: torrentId,
      name: displayName,
      magnetUri,
      size: 0,
      downloaded: 0,
      uploaded: 0,
      progress: 0,
      downloadSpeed: 0,
      uploadSpeed: 0,
      peers: 0,
      seeds: 0,
      status: "downloading",
      path: path.join(downloadPath, displayName),
      infoHash: undefined,
    };

    const torrents = store.get("torrents");
    torrents.push(torrentInfo);
    store.set("torrents", torrents);
    mainWindow?.webContents.send("torrent-added", torrentInfo);

    await callTorrentWorker({
      type: "add-magnet",
      torrentId,
      magnetUri,
      downloadPath,
      announce: publicTrackers,
    });

    return torrentInfo;
  } catch (err: any) {
    activeTorrentIds.delete(err?.torrentId);
    throw new Error(err?.message || "Failed to add torrent");
  }
});

ipcMain.handle("pause-torrent", (_, id: string) => {
  callTorrentWorker({ type: "pause", torrentId: id }).catch(() => {});
  const torrents = store.get("torrents");
  const idx = torrents.findIndex((t) => t.id === id);
  if (idx !== -1) {
    torrents[idx].status = "paused";
    store.set("torrents", torrents);
  }
});

ipcMain.handle("resume-torrent", (_, id: string) => {
  callTorrentWorker({ type: "resume", torrentId: id }).catch(() => {});
  const torrents = store.get("torrents");
  const idx = torrents.findIndex((t) => t.id === id);
  if (idx !== -1) {
    torrents[idx].status = "downloading";
    store.set("torrents", torrents);
  }
});

ipcMain.handle("pause-all-torrents", () => {
  const torrents = store.get("torrents");
  for (const t of torrents) {
    if (t.status === "downloading") {
      callTorrentWorker({ type: "pause", torrentId: t.id }).catch(() => {});
      t.status = "paused";
    }
  }
  store.set("torrents", torrents);
});

ipcMain.handle("resume-all-torrents", () => {
  const torrents = store.get("torrents");
  for (const t of torrents) {
    if (t.status === "paused") {
      callTorrentWorker({ type: "resume", torrentId: t.id }).catch(() => {});
      t.status = "downloading";
    }
  }
  store.set("torrents", torrents);
});

ipcMain.handle("remove-torrent", (_, id: string, deleteFiles: boolean) => {
  callTorrentWorker({ type: "remove", torrentId: id, deleteFiles }).catch(() => {});
  activeTorrentIds.delete(id);
  const torrents = store.get("torrents").filter((t) => t.id !== id);
  store.set("torrents", torrents);
  return torrents;
});

// Get stream server port for media playback
ipcMain.handle("get-stream-server-port", () => streamServerPort);

// Add torrent from .torrent file
ipcMain.handle("add-torrent-file", async (_, filePath: string) => {
  if (!torrentWorkerReady) throw new Error("Torrent support is not available.");
  
  if (!fs.existsSync(filePath)) {
    throw new Error("Torrent file not found");
  }
  
  const settings = store.get("settings");
  const downloadPath = settings.downloadPath;

  // Check VPN if required
  if (settings.requireVpn && !isVpnConnected()) {
    throw new Error("VPN_REQUIRED");
  }

  if (!fs.existsSync(downloadPath)) {
    fs.mkdirSync(downloadPath, { recursive: true });
  }

  try {
    const torrentId = uuidv4();
    const fallbackName = path.basename(filePath).replace(/\.torrent$/i, '') || 'Loading torrent…';

    activeTorrentIds.add(torrentId);

    const torrentInfo: TorrentInfo = {
      id: torrentId,
      name: fallbackName,
      magnetUri: '',
      size: 0,
      downloaded: 0,
      uploaded: 0,
      progress: 0,
      downloadSpeed: 0,
      uploadSpeed: 0,
      peers: 0,
      seeds: 0,
      status: "downloading",
      path: path.join(downloadPath, fallbackName),
      infoHash: undefined,
    };

    const torrents = store.get("torrents");
    torrents.push(torrentInfo);
    store.set("torrents", torrents);
    mainWindow?.webContents.send("torrent-added", torrentInfo);

    await callTorrentWorker({
      type: "add-file",
      torrentId,
      filePath,
      downloadPath,
      announce: publicTrackers,
    });

    return torrentInfo;
  } catch (err: any) {
    throw new Error(err?.message || "Failed to add torrent file");
  }
});

// Get torrent files list for streaming
ipcMain.handle("get-torrent-files", (_, infoHash: string) => {
  if (!torrentWorkerReady) return [];
  return callTorrentWorker<any[]>({ type: "get-files", infoHash }).then((files) =>
    (files || []).map((file: any) => ({
      ...file,
      streamUrl: `http://127.0.0.1:${streamServerPort}/stream/${infoHash}/${encodeURIComponent(file.name)}`,
    }))
  );
});
