import { app, BrowserWindow, ipcMain, session, dialog, shell, clipboard, } from "electron";
import path from "path";
import fs from "fs";
import http from "http";
import { fileURLToPath } from "url";
import { Worker } from "worker_threads";
import Store from "electron-store";
import { v4 as uuidv4 } from "uuid";
// ESM compatibility
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Check if a file is an extractable archive
function isExtractableArchive(filename) {
    const ext = path.extname(filename).toLowerCase();
    return ['.zip', '.rar', '.7z'].includes(ext);
}
// Auto-extract function using worker thread (non-blocking)
function autoExtractArchiveAsync(filePath, downloadId, onProgress, onComplete) {
    const workerPath = path.join(__dirname, "extract-worker.js");
    const worker = new Worker(workerPath, {
        workerData: { filePath, downloadId }
    });
    worker.on("message", (msg) => {
        if (msg.type === "progress") {
            onProgress(msg.percent, msg.status);
        }
        else if (msg.type === "done") {
            if (msg.success) {
                console.log(`Extracted ${filePath} to ${msg.extractDir}`);
                onComplete(msg.extractDir);
            }
            else {
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
function detectCategory(itemPath) {
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
        }
        else {
            // Single file
            const ext = path.extname(itemPath).toLowerCase();
            if (['.exe', '.msi'].includes(ext))
                return 'software';
            if (['.mp4', '.mkv', '.avi', '.mov', '.wmv'].includes(ext))
                return 'movies';
            if (['.mp3', '.flac', '.wav', '.aac', '.ogg'].includes(ext))
                return 'music';
        }
    }
    catch (err) {
        console.error('Error detecting category:', err);
    }
    return 'other';
}
// Sync library with filesystem - remove entries for deleted files/folders
function syncLibraryWithFilesystem() {
    const library = store.get('library');
    const validLibrary = library.filter(item => {
        try {
            return fs.existsSync(item.path);
        }
        catch {
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
}
else {
    app.setAsDefaultProtocolClient('magnet');
}
// Register .torrent file association
if (process.platform === 'win32') {
    app.setAsDefaultProtocolClient('limbo-torrent');
}
// Check hardware acceleration setting before app is ready
// We need a temporary store read to check this early
const tempStore = new Store({ name: 'config' });
const settings = tempStore.get('settings');
if (settings && settings.hardwareAcceleration === false) {
    app.disableHardwareAcceleration();
    console.log('Hardware acceleration disabled by user setting');
}
// Single instance lock - prevent multiple windows
const gotTheLock = app.requestSingleInstanceLock();
let pendingMagnetLink = null;
let pendingTorrentFile = null;
if (!gotTheLock) {
    app.quit();
}
else {
    app.on('second-instance', (event, commandLine) => {
        // Someone tried to run a second instance
        if (mainWindow) {
            if (mainWindow.isMinimized())
                mainWindow.restore();
            mainWindow.focus();
            // Check if a magnet link was passed
            const magnetArg = commandLine.find(arg => arg.startsWith('magnet:'));
            if (magnetArg) {
                mainWindow.webContents.send('magnet-link-opened', magnetArg);
            }
            // Check if a .torrent file was passed
            const torrentFile = commandLine.find(arg => arg.endsWith('.torrent'));
            if (torrentFile && fs.existsSync(torrentFile)) {
                mainWindow.webContents.send('torrent-file-opened', torrentFile);
            }
        }
    });
}
// Clipboard monitoring
let lastClipboardContent = '';
let clipboardWatcher = null;
// WebTorrent for full BitTorrent support (TCP/UDP + WebRTC since v2.3.0)
let torrentClient = null;
let streamServer = null;
let streamServerPort = 0;
// Function to initialize WebTorrent with streaming server
async function initWebTorrent() {
    try {
        // WebTorrent 2.3.0+ has native TCP/UDP + WebRTC support built-in
        const WebTorrent = await import("webtorrent");
        torrentClient = new WebTorrent.default();
        console.log("WebTorrent loaded successfully (v2.3.0+ with native TCP/UDP support)");
        // Create HTTP streaming server for media files
        streamServer = http.createServer((req, res) => {
            const match = req.url?.match(/^\/stream\/([0-9a-f]{40})(?:\/(.*))?$/);
            if (!match) {
                res.statusCode = 404;
                return res.end('Not found');
            }
            const infoHash = match[1];
            const fileName = match[2] ? decodeURIComponent(match[2]) : null;
            const torrent = torrentClient?.get(infoHash);
            if (!torrent) {
                res.statusCode = 404;
                return res.end('Torrent not found');
            }
            // Find the requested file or largest video file
            let file = fileName
                ? torrent.files.find((f) => f.name === fileName)
                : torrent.files.find((f) => f.name.match(/\.(mp4|mkv|avi|mov|webm)$/i));
            if (!file) {
                file = torrent.files[0]; // Fallback to first file
            }
            if (!file) {
                res.statusCode = 404;
                return res.end('No file found');
            }
            // Handle range requests for seeking
            const range = req.headers.range;
            const fileSize = file.length;
            if (range) {
                const parts = range.replace(/bytes=/, '').split('-');
                const start = parseInt(parts[0], 10);
                const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
                const chunkSize = end - start + 1;
                res.writeHead(206, {
                    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                    'Accept-Ranges': 'bytes',
                    'Content-Length': chunkSize,
                    'Content-Type': getMimeType(file.name),
                });
                const stream = file.createReadStream({ start, end });
                stream.pipe(res);
            }
            else {
                res.writeHead(200, {
                    'Content-Length': fileSize,
                    'Content-Type': getMimeType(file.name),
                });
                file.createReadStream().pipe(res);
            }
        });
        streamServer.listen(0, '127.0.0.1', () => {
            const addr = streamServer?.address();
            if (addr && typeof addr === 'object') {
                streamServerPort = addr.port;
                console.log(`Torrent stream server running on http://127.0.0.1:${streamServerPort}`);
            }
        });
    }
    catch (err) {
        console.warn("WebTorrent failed to load. Torrent support disabled.", err);
    }
}
// Get MIME type for file
function getMimeType(filename) {
    const ext = path.extname(filename).toLowerCase();
    const mimeTypes = {
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
const store = new Store({
    defaults: {
        bookmarks: [
            {
                id: "1",
                name: "1377x",
                url: "https://1377x.to",
                favicon: "https://www.google.com/s2/favicons?domain=1377x.to&sz=64",
            },
            {
                id: "2",
                name: "FitGirl Repacks",
                url: "https://fitgirl-repacks.site",
                favicon: "https://www.google.com/s2/favicons?domain=fitgirl-repacks.site&sz=64",
            },
        ],
        library: [],
        downloads: [],
        torrents: [],
        settings: {
            downloadPath: path.join(app.getPath("downloads"), "Limbo"),
            maxConcurrentDownloads: 3,
            hardwareAcceleration: true,
            debrid: {
                service: null,
                apiKey: "",
            },
        },
    },
});
let mainWindow = null;
const activeDownloads = new Map();
const activeTorrents = new Map();
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
    }
    else {
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
    const handleDownload = (event, item, webContents) => {
        const downloadId = uuidv4();
        const settings = store.get("settings");
        const savePath = path.join(settings.downloadPath, item.getFilename());
        // Ensure download directory exists
        if (!fs.existsSync(settings.downloadPath)) {
            fs.mkdirSync(settings.downloadPath, { recursive: true });
        }
        item.setSavePath(savePath);
        activeDownloads.set(downloadId, item);
        const download = {
            id: downloadId,
            filename: item.getFilename(),
            url: item.getURL(),
            path: savePath,
            size: item.getTotalBytes(),
            downloaded: 0,
            status: "downloading",
        };
        // Add to store
        const downloads = store.get("downloads");
        downloads.push(download);
        store.set("downloads", downloads);
        // Notify renderer
        mainWindow?.webContents.send("download-started", download);
        item.on("updated", (event, state) => {
            const downloads = store.get("downloads");
            const idx = downloads.findIndex((d) => d.id === downloadId);
            if (idx !== -1) {
                downloads[idx].downloaded = item.getReceivedBytes();
                downloads[idx].status = state === "progressing" ? "downloading" : "paused";
                store.set("downloads", downloads);
                mainWindow?.webContents.send("download-progress", {
                    id: downloadId,
                    downloaded: item.getReceivedBytes(),
                    total: item.getTotalBytes(),
                    status: downloads[idx].status,
                });
            }
        });
        item.once("done", (event, state) => {
            activeDownloads.delete(downloadId);
            const downloads = store.get("downloads");
            const idx = downloads.findIndex((d) => d.id === downloadId);
            if (idx !== -1) {
                downloads[idx].status = state === "completed" ? "completed" : "error";
                downloads[idx].downloaded = item.getReceivedBytes();
                store.set("downloads", downloads);
                // Add to library if completed
                if (state === "completed") {
                    const filename = item.getFilename();
                    // Auto-extract if it's an archive (runs in worker thread, non-blocking)
                    if (isExtractableArchive(filename)) {
                        // Update status to extracting
                        downloads[idx].status = "extracting";
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
                        autoExtractArchiveAsync(savePath, downloadId, (percent, status) => {
                            mainWindow?.webContents.send("download-progress", {
                                id: downloadId,
                                downloaded: item.getReceivedBytes(),
                                total: item.getTotalBytes(),
                                status: "extracting",
                                extractProgress: percent,
                                extractStatus: status,
                            });
                        }, (extractedDir) => {
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
                                }
                                catch (err) {
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
                        });
                    }
                    else {
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
                }
                else {
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
                const detectedUrls = [];
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
        }
        catch {
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
function isDownloadableUrl(text) {
    if (!text || text.length < 5 || text.length > 2000)
        return false;
    try {
        if (text.startsWith('magnet:'))
            return true;
        const url = new URL(text);
        if (!['http:', 'https:'].includes(url.protocol))
            return false;
        return DOWNLOAD_PATTERNS.some(pattern => pattern.test(text));
    }
    catch {
        return false;
    }
}
app.whenReady().then(async () => {
    await initWebTorrent();
    createWindow();
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
            }
            else {
                pendingTorrentFile = filePath;
            }
        }
    });
    // Check command line args for initial launch with .torrent file
    const torrentArg = process.argv.find(arg => arg.endsWith('.torrent'));
    if (torrentArg && fs.existsSync(torrentArg)) {
        pendingTorrentFile = torrentArg;
    }
    // Check command line args for initial launch with magnet link
    const magnetArg = process.argv.find(arg => arg.startsWith('magnet:'));
    if (magnetArg) {
        pendingMagnetLink = magnetArg;
    }
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
    }
    else {
        mainWindow?.maximize();
    }
});
ipcMain.on("window-close", () => mainWindow?.close());
// Bookmarks
ipcMain.handle("get-bookmarks", () => store.get("bookmarks"));
ipcMain.handle("add-bookmark", (_, bookmark) => {
    const bookmarks = store.get("bookmarks");
    const newBookmark = { ...bookmark, id: uuidv4() };
    bookmarks.push(newBookmark);
    store.set("bookmarks", bookmarks);
    return newBookmark;
});
ipcMain.handle("remove-bookmark", (_, id) => {
    const bookmarks = store.get("bookmarks").filter((b) => b.id !== id);
    store.set("bookmarks", bookmarks);
    return bookmarks;
});
ipcMain.handle("update-bookmark", (_, bookmark) => {
    const bookmarks = store.get("bookmarks");
    const idx = bookmarks.findIndex((b) => b.id === bookmark.id);
    if (idx !== -1) {
        bookmarks[idx] = bookmark;
        store.set("bookmarks", bookmarks);
    }
    return bookmarks;
});
ipcMain.handle("reset-bookmarks", () => {
    const defaults = [
        {
            id: "1",
            name: "1377x",
            url: "https://1377x.to",
            favicon: "https://www.google.com/s2/favicons?domain=1377x.to&sz=64",
        },
        {
            id: "2",
            name: "FitGirl Repacks",
            url: "https://fitgirl-repacks.site",
            favicon: "https://www.google.com/s2/favicons?domain=fitgirl-repacks.site&sz=64",
        },
    ];
    store.set("bookmarks", defaults);
    return defaults;
});
// Library
ipcMain.handle("get-library", () => store.get("library"));
ipcMain.handle("add-to-library", (_, item) => {
    const library = store.get("library");
    const newItem = { ...item, id: uuidv4(), dateAdded: new Date().toISOString() };
    library.push(newItem);
    store.set("library", library);
    return newItem;
});
ipcMain.handle("remove-from-library", async (_, id, deleteFiles) => {
    const library = store.get("library");
    const item = library.find((l) => l.id === id);
    if (item && deleteFiles) {
        try {
            if (fs.existsSync(item.path)) {
                fs.rmSync(item.path, { recursive: true });
            }
        }
        catch (err) {
            console.error("Failed to delete files:", err);
        }
    }
    const newLibrary = library.filter((l) => l.id !== id);
    store.set("library", newLibrary);
    return newLibrary;
});
ipcMain.handle("open-file-location", (_, filePath) => {
    // If it's a directory, open it directly. If it's a file, show in folder
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
        shell.openPath(filePath);
    }
    else {
        shell.showItemInFolder(filePath);
    }
});
ipcMain.handle("open-file", (_, filePath) => {
    // If it's a directory, open it in explorer
    shell.openPath(filePath);
});
// Downloads
ipcMain.handle("get-downloads", () => store.get("downloads"));
ipcMain.handle("pause-download", (_, id) => {
    const item = activeDownloads.get(id);
    if (item) {
        item.pause();
    }
});
ipcMain.handle("resume-download", (_, id) => {
    const item = activeDownloads.get(id);
    if (item) {
        item.resume();
    }
});
ipcMain.handle("cancel-download", (_, id) => {
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
    const downloads = store.get("downloads").filter((d) => d.status !== "completed" && d.status !== "error");
    store.set("downloads", downloads);
    return downloads;
});
// Start a manual download
ipcMain.handle("start-download", async (_, url, filename) => {
    const settings = store.get("settings");
    // Check for debrid
    if (settings.debrid.service && settings.debrid.apiKey) {
        // Use debrid service to unrestrict the link
        const unrestrictedUrl = await unrestrictLink(url, settings.debrid);
        if (unrestrictedUrl) {
            url = unrestrictedUrl;
        }
    }
    mainWindow?.webContents.downloadURL(url);
    return true;
});
// Settings
ipcMain.handle("get-settings", () => store.get("settings"));
ipcMain.handle("update-settings", (_, settings) => {
    const current = store.get("settings");
    const updated = { ...current, ...settings };
    store.set("settings", updated);
    return updated;
});
ipcMain.handle("select-download-path", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
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
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ["openDirectory"],
    });
    if (!result.canceled && result.filePaths[0]) {
        const folderPath = result.filePaths[0];
        const folderName = path.basename(folderPath);
        const stats = fs.statSync(folderPath);
        const library = store.get("library");
        const newItem = {
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
async function unrestrictLink(url, debrid) {
    try {
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
            return data.download || null;
        }
        else if (debrid.service === "alldebrid") {
            const response = await fetch(`https://api.alldebrid.com/v4/link/unlock?agent=limbo&apikey=${debrid.apiKey}&link=${encodeURIComponent(url)}`);
            const data = await response.json();
            return data.data?.link || null;
        }
    }
    catch (err) {
        console.error("Debrid error:", err);
    }
    return null;
}
// Debrid magnet link conversion
async function convertMagnetWithDebrid(magnetUri, debrid) {
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
            if (!addData.id)
                return null;
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
                const unrestrictedLinks = [];
                for (const link of infoData.links) {
                    const unrestricted = await unrestrictLink(link, debrid);
                    if (unrestricted)
                        unrestrictedLinks.push(unrestricted);
                }
                return unrestrictedLinks.length > 0 ? unrestrictedLinks : null;
            }
            return null;
        }
        else if (debrid.service === "alldebrid") {
            const response = await fetch(`https://api.alldebrid.com/v4/magnet/upload?agent=limbo&apikey=${debrid.apiKey}&magnets[]=${encodeURIComponent(magnetUri)}`);
            const data = await response.json();
            if (data.data?.magnets?.[0]?.id) {
                // Wait for processing
                await new Promise(resolve => setTimeout(resolve, 3000));
                // Get status
                const statusResponse = await fetch(`https://api.alldebrid.com/v4/magnet/status?agent=limbo&apikey=${debrid.apiKey}&id=${data.data.magnets[0].id}`);
                const statusData = await statusResponse.json();
                if (statusData.data?.magnets?.links) {
                    return statusData.data.magnets.links.map((l) => l.link);
                }
            }
            return null;
        }
        else if (debrid.service === "premiumize") {
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
                const transfer = listData.transfers?.find((t) => t.id === data.id);
                if (transfer?.folder_id) {
                    const folderResponse = await fetch(`https://www.premiumize.me/api/folder/list?id=${transfer.folder_id}&apikey=${debrid.apiKey}`);
                    const folderData = await folderResponse.json();
                    return folderData.content?.filter((f) => f.link).map((f) => f.link) || null;
                }
            }
            return null;
        }
    }
    catch (err) {
        console.error("Debrid magnet error:", err);
    }
    return null;
}
// Handler for debrid magnet conversion
ipcMain.handle("convert-magnet-debrid", async (_, magnetUri) => {
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
function getFolderSize(folderPath) {
    let size = 0;
    try {
        const files = fs.readdirSync(folderPath);
        for (const file of files) {
            const filePath = path.join(folderPath, file);
            const stats = fs.statSync(filePath);
            if (stats.isDirectory()) {
                size += getFolderSize(filePath);
            }
            else {
                size += stats.size;
            }
        }
    }
    catch (err) {
        console.error("Error calculating folder size:", err);
    }
    return size;
}
// Torrent handlers
ipcMain.handle("get-torrents", () => store.get("torrents"));
ipcMain.handle("is-torrent-supported", () => torrentClient !== null);
ipcMain.handle("add-torrent", async (_, magnetUri) => {
    if (!torrentClient) {
        throw new Error("Torrent support is not available. WebTorrent failed to load.");
    }
    const settings = store.get("settings");
    const downloadPath = settings.downloadPath;
    // Ensure download directory exists
    if (!fs.existsSync(downloadPath)) {
        fs.mkdirSync(downloadPath, { recursive: true });
    }
    return new Promise((resolve, reject) => {
        try {
            const torrent = torrentClient.add(magnetUri, { path: downloadPath }, (torrent) => {
                const torrentId = uuidv4();
                activeTorrents.set(torrentId, torrent);
                const torrentInfo = {
                    id: torrentId,
                    name: torrent.name,
                    magnetUri: magnetUri,
                    size: torrent.length,
                    downloaded: 0,
                    uploaded: 0,
                    progress: 0,
                    downloadSpeed: 0,
                    uploadSpeed: 0,
                    peers: 0,
                    seeds: 0,
                    status: "downloading",
                    path: path.join(downloadPath, torrent.name),
                };
                const torrents = store.get("torrents");
                torrents.push(torrentInfo);
                store.set("torrents", torrents);
                mainWindow?.webContents.send("torrent-added", torrentInfo);
                // Update progress periodically
                const updateInterval = setInterval(() => {
                    if (!activeTorrents.has(torrentId)) {
                        clearInterval(updateInterval);
                        return;
                    }
                    const torrents = store.get("torrents");
                    const idx = torrents.findIndex((t) => t.id === torrentId);
                    if (idx !== -1) {
                        torrents[idx] = {
                            ...torrents[idx],
                            downloaded: torrent.downloaded,
                            uploaded: torrent.uploaded,
                            progress: torrent.progress,
                            downloadSpeed: torrent.downloadSpeed,
                            uploadSpeed: torrent.uploadSpeed,
                            peers: torrent.numPeers,
                            seeds: torrent.numPeers, // WebTorrent doesn't distinguish
                            status: torrent.done ? "completed" : "downloading",
                        };
                        store.set("torrents", torrents);
                        mainWindow?.webContents.send("torrent-progress", torrents[idx]);
                    }
                }, 1000);
                torrent.on("done", () => {
                    clearInterval(updateInterval);
                    const torrents = store.get("torrents");
                    const idx = torrents.findIndex((t) => t.id === torrentId);
                    if (idx !== -1) {
                        torrents[idx].status = "completed";
                        torrents[idx].progress = 1;
                        store.set("torrents", torrents);
                        // Add to library
                        const library = store.get("library");
                        library.push({
                            id: uuidv4(),
                            name: torrent.name,
                            path: path.join(downloadPath, torrent.name),
                            size: torrent.length,
                            dateAdded: new Date().toISOString(),
                        });
                        store.set("library", library);
                        mainWindow?.webContents.send("library-updated", library);
                        mainWindow?.webContents.send("torrent-complete", torrents[idx]);
                    }
                });
                torrent.on("error", (err) => {
                    clearInterval(updateInterval);
                    const torrents = store.get("torrents");
                    const idx = torrents.findIndex((t) => t.id === torrentId);
                    if (idx !== -1) {
                        torrents[idx].status = "error";
                        store.set("torrents", torrents);
                        mainWindow?.webContents.send("torrent-error", { id: torrentId, error: typeof err === 'string' ? err : err.message });
                    }
                });
                resolve(torrentInfo);
            });
            torrent.on("error", (err) => {
                reject(err);
            });
        }
        catch (err) {
            reject(err);
        }
    });
});
ipcMain.handle("pause-torrent", (_, id) => {
    const torrent = activeTorrents.get(id);
    if (torrent) {
        torrent.pause();
        const torrents = store.get("torrents");
        const idx = torrents.findIndex((t) => t.id === id);
        if (idx !== -1) {
            torrents[idx].status = "paused";
            store.set("torrents", torrents);
        }
    }
});
ipcMain.handle("resume-torrent", (_, id) => {
    const torrent = activeTorrents.get(id);
    if (torrent) {
        torrent.resume();
        const torrents = store.get("torrents");
        const idx = torrents.findIndex((t) => t.id === id);
        if (idx !== -1) {
            torrents[idx].status = "downloading";
            store.set("torrents", torrents);
        }
    }
});
ipcMain.handle("remove-torrent", (_, id, deleteFiles) => {
    const torrent = activeTorrents.get(id);
    if (torrent) {
        torrent.destroy({ destroyStore: deleteFiles });
        activeTorrents.delete(id);
    }
    const torrents = store.get("torrents").filter((t) => t.id !== id);
    store.set("torrents", torrents);
    return torrents;
});
// Get stream server port for media playback
ipcMain.handle("get-stream-server-port", () => streamServerPort);
// Add torrent from .torrent file
ipcMain.handle("add-torrent-file", async (_, filePath) => {
    if (!torrentClient) {
        throw new Error("Torrent support is not available.");
    }
    if (!fs.existsSync(filePath)) {
        throw new Error("Torrent file not found");
    }
    const torrentBuffer = fs.readFileSync(filePath);
    const settings = store.get("settings");
    const downloadPath = settings.downloadPath;
    if (!fs.existsSync(downloadPath)) {
        fs.mkdirSync(downloadPath, { recursive: true });
    }
    return new Promise((resolve, reject) => {
        try {
            const torrent = torrentClient.add(torrentBuffer, { path: downloadPath }, (torrent) => {
                const torrentId = uuidv4();
                activeTorrents.set(torrentId, torrent);
                const torrentInfo = {
                    id: torrentId,
                    name: torrent.name,
                    magnetUri: torrent.magnetURI,
                    size: torrent.length,
                    downloaded: 0,
                    uploaded: 0,
                    progress: 0,
                    downloadSpeed: 0,
                    uploadSpeed: 0,
                    peers: 0,
                    seeds: 0,
                    status: "downloading",
                    path: path.join(downloadPath, torrent.name),
                    infoHash: torrent.infoHash,
                };
                const torrents = store.get("torrents");
                torrents.push(torrentInfo);
                store.set("torrents", torrents);
                mainWindow?.webContents.send("torrent-added", torrentInfo);
                // Setup progress and completion handlers (same as add-torrent)
                const updateInterval = setInterval(() => {
                    if (!activeTorrents.has(torrentId)) {
                        clearInterval(updateInterval);
                        return;
                    }
                    const torrents = store.get("torrents");
                    const idx = torrents.findIndex((t) => t.id === torrentId);
                    if (idx !== -1) {
                        torrents[idx] = {
                            ...torrents[idx],
                            downloaded: torrent.downloaded,
                            uploaded: torrent.uploaded,
                            progress: torrent.progress,
                            downloadSpeed: torrent.downloadSpeed,
                            uploadSpeed: torrent.uploadSpeed,
                            peers: torrent.numPeers,
                            seeds: torrent.numPeers,
                            status: torrent.done ? "completed" : "downloading",
                        };
                        store.set("torrents", torrents);
                        mainWindow?.webContents.send("torrent-progress", torrents[idx]);
                    }
                }, 1000);
                torrent.on("done", () => {
                    clearInterval(updateInterval);
                    const torrents = store.get("torrents");
                    const idx = torrents.findIndex((t) => t.id === torrentId);
                    if (idx !== -1) {
                        torrents[idx].status = "completed";
                        torrents[idx].progress = 1;
                        store.set("torrents", torrents);
                        const library = store.get("library");
                        library.push({
                            id: uuidv4(),
                            name: torrent.name,
                            path: path.join(downloadPath, torrent.name),
                            size: torrent.length,
                            dateAdded: new Date().toISOString(),
                            category: detectCategory(path.join(downloadPath, torrent.name)),
                        });
                        store.set("library", library);
                        mainWindow?.webContents.send("library-updated", library);
                        mainWindow?.webContents.send("torrent-complete", torrents[idx]);
                    }
                });
                torrent.on("error", (err) => {
                    clearInterval(updateInterval);
                    const torrents = store.get("torrents");
                    const idx = torrents.findIndex((t) => t.id === torrentId);
                    if (idx !== -1) {
                        torrents[idx].status = "error";
                        store.set("torrents", torrents);
                        mainWindow?.webContents.send("torrent-error", { id: torrentId, error: typeof err === 'string' ? err : err.message });
                    }
                });
                resolve(torrentInfo);
            });
            torrent.on("error", (err) => {
                reject(err);
            });
        }
        catch (err) {
            reject(err);
        }
    });
});
// Get torrent files list for streaming
ipcMain.handle("get-torrent-files", (_, infoHash) => {
    if (!torrentClient)
        return [];
    const torrent = torrentClient.get(infoHash);
    if (!torrent)
        return [];
    return torrent.files.map((file, index) => ({
        index,
        name: file.name,
        path: file.path,
        length: file.length,
        downloaded: file.downloaded,
        progress: file.progress,
        streamUrl: `http://127.0.0.1:${streamServerPort}/stream/${infoHash}/${encodeURIComponent(file.name)}`,
    }));
});
