import { parentPort } from "worker_threads";
import fs from "fs";
import http from "http";
import path from "path";
let torrentClient = null;
let streamServer = null;
let streamServerPort = 0;
let enableSeeding = false;
let publicTrackers = [];
const torrentsById = new Map();
const torrentMetaById = new Map();
const pausedTorrentMetaById = new Map();
function post(msg) {
    parentPort?.postMessage(msg);
}
function respondOk(requestId, data) {
    post({ type: "response", requestId, ok: true, data });
}
function respondErr(requestId, error) {
    const message = error instanceof Error ? error.message : String(error);
    post({ type: "response", requestId, ok: false, error: message });
}
function getMimeType(filename) {
    const ext = path.extname(filename).toLowerCase();
    const mimeTypes = {
        ".mp4": "video/mp4",
        ".mkv": "video/x-matroska",
        ".avi": "video/x-msvideo",
        ".mov": "video/quicktime",
        ".webm": "video/webm",
        ".mp3": "audio/mpeg",
        ".flac": "audio/flac",
        ".wav": "audio/wav",
        ".ogg": "audio/ogg",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".gif": "image/gif",
        ".pdf": "application/pdf",
        ".zip": "application/zip",
        ".rar": "application/x-rar-compressed",
    };
    return mimeTypes[ext] || "application/octet-stream";
}
function applyTorrentUploadPolicy(torrent, allowSeeding) {
    const attachNoUpload = (wire) => {
        try {
            wire.choke?.();
        }
        catch { }
        try {
            wire.on?.("unchoke", () => {
                try {
                    wire.choke?.();
                }
                catch { }
            });
        }
        catch { }
    };
    if (allowSeeding) {
        if (torrent?.__limboNoUploadInterval) {
            clearInterval(torrent.__limboNoUploadInterval);
            torrent.__limboNoUploadInterval = null;
        }
        torrent.__limboNoUploadApplied = false;
        return;
    }
    if (torrent.__limboNoUploadApplied)
        return;
    torrent.__limboNoUploadApplied = true;
    try {
        torrent.on?.("wire", attachNoUpload);
    }
    catch { }
    try {
        if (Array.isArray(torrent.wires)) {
            for (const w of torrent.wires)
                attachNoUpload(w);
        }
    }
    catch { }
    torrent.__limboNoUploadInterval = setInterval(() => {
        try {
            if (Array.isArray(torrent.wires)) {
                for (const w of torrent.wires) {
                    try {
                        w.choke?.();
                    }
                    catch { }
                }
            }
        }
        catch { }
    }, 1500);
}
async function ensureTorrentClient() {
    if (torrentClient)
        return;
    const WebTorrent = await import("webtorrent");
    torrentClient = new WebTorrent.default();
}
async function ensureStreamServer() {
    if (streamServer)
        return;
    streamServer = http.createServer((req, res) => {
        const match = req.url?.match(/^\/stream\/([0-9a-f]{40})(?:\/(.*))?$/);
        if (!match) {
            res.statusCode = 404;
            return res.end("Not found");
        }
        const infoHash = match[1];
        const fileName = match[2] ? decodeURIComponent(match[2]) : null;
        const torrent = torrentClient?.get(infoHash);
        if (!torrent) {
            res.statusCode = 404;
            return res.end("Torrent not found");
        }
        let file = fileName
            ? torrent.files.find((f) => f.name === fileName)
            : torrent.files.find((f) => f.name.match(/\.(mp4|mkv|avi|mov|webm)$/i));
        if (!file)
            file = torrent.files[0];
        if (!file) {
            res.statusCode = 404;
            return res.end("No file found");
        }
        const range = req.headers.range;
        const fileSize = file.length;
        if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
            const chunkSize = end - start + 1;
            res.writeHead(206, {
                "Content-Range": `bytes ${start}-${end}/${fileSize}`,
                "Accept-Ranges": "bytes",
                "Content-Length": chunkSize,
                "Content-Type": getMimeType(file.name),
            });
            const stream = file.createReadStream({ start, end });
            stream.pipe(res);
        }
        else {
            res.writeHead(200, {
                "Content-Length": fileSize,
                "Content-Type": getMimeType(file.name),
            });
            file.createReadStream().pipe(res);
        }
    });
    await new Promise((resolve, reject) => {
        streamServer.once("error", reject);
        streamServer.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = streamServer.address();
    if (addr && typeof addr === "object") {
        streamServerPort = addr.port;
    }
}
function attachTorrentLifecycle(torrentId, torrent) {
    torrent.on("warning", (warn) => {
        post({ type: "event", event: "torrent-error", payload: { id: torrentId, error: String(warn?.message || warn) } });
    });
    torrent.on("error", (err) => {
        post({ type: "event", event: "torrent-error", payload: { id: torrentId, error: String(err?.message || err) } });
    });
    const sendMetadata = () => {
        const name = torrent.name || "Loading torrent…";
        const meta = torrentMetaById.get(torrentId);
        if (meta) {
            const nextMagnet = torrent.magnetURI || meta.magnetUri;
            torrentMetaById.set(torrentId, {
                ...meta,
                magnetUri: nextMagnet,
            });
        }
        post({
            type: "event",
            event: "torrent-metadata",
            payload: {
                id: torrentId,
                name,
                size: torrent.length || 0,
                magnetUri: torrent.magnetURI || "",
                infoHash: torrent.infoHash,
            },
        });
    };
    torrent.once("metadata", sendMetadata);
    torrent.once("ready", sendMetadata);
    const interval = setInterval(() => {
        post({
            type: "event",
            event: "torrent-progress",
            payload: {
                id: torrentId,
                downloaded: torrent.downloaded || 0,
                uploaded: enableSeeding ? (torrent.uploaded || 0) : 0,
                progress: torrent.progress || 0,
                downloadSpeed: torrent.downloadSpeed || 0,
                uploadSpeed: enableSeeding ? (torrent.uploadSpeed || 0) : 0,
                peers: torrent.numPeers || 0,
                seeds: torrent.numPeers || 0,
                done: !!torrent.done,
            },
        });
    }, 1000);
    torrent.__limboProgressInterval = interval;
    torrent.on("done", () => {
        if (torrent.__limboProgressInterval) {
            clearInterval(torrent.__limboProgressInterval);
            torrent.__limboProgressInterval = null;
        }
        post({ type: "event", event: "torrent-done", payload: { id: torrentId } });
        if (!enableSeeding) {
            try {
                torrent.destroy?.({ destroyStore: false });
            }
            catch { }
            torrentsById.delete(torrentId);
            torrentMetaById.delete(torrentId);
            pausedTorrentMetaById.delete(torrentId);
        }
    });
}
function safeStopTorrent(torrent) {
    if (!torrent)
        return;
    try {
        if (torrent.__limboProgressInterval) {
            clearInterval(torrent.__limboProgressInterval);
            torrent.__limboProgressInterval = null;
        }
    }
    catch { }
    try {
        if (torrent.__limboNoUploadInterval) {
            clearInterval(torrent.__limboNoUploadInterval);
            torrent.__limboNoUploadInterval = null;
        }
    }
    catch { }
}
async function handleInit(msg) {
    enableSeeding = msg.enableSeeding;
    publicTrackers = msg.publicTrackers || [];
    try {
        await ensureTorrentClient();
        await ensureStreamServer();
        post({ type: "ready", ok: true, streamServerPort });
    }
    catch (err) {
        post({ type: "ready", ok: false, error: err instanceof Error ? err.message : String(err) });
    }
}
parentPort?.on("message", async (msg) => {
    try {
        if (msg.type === "init") {
            await handleInit(msg);
            return;
        }
        if (!torrentClient) {
            // If init failed, all operations should fail explicitly.
            if (msg.requestId)
                respondErr(msg.requestId, "Torrent worker not initialized");
            return;
        }
        switch (msg.type) {
            case "set-seeding": {
                enableSeeding = msg.enableSeeding;
                for (const torrent of torrentsById.values()) {
                    applyTorrentUploadPolicy(torrent, enableSeeding);
                }
                return;
            }
            case "add-magnet": {
                const { requestId, torrentId, magnetUri, downloadPath, announce } = msg;
                const torrent = torrentClient.add(magnetUri, {
                    path: downloadPath,
                    announce: announce?.length ? announce : publicTrackers,
                });
                torrentsById.set(torrentId, torrent);
                torrentMetaById.set(torrentId, {
                    magnetUri,
                    downloadPath,
                    announce: announce?.length ? announce : publicTrackers,
                });
                pausedTorrentMetaById.delete(torrentId);
                applyTorrentUploadPolicy(torrent, enableSeeding);
                attachTorrentLifecycle(torrentId, torrent);
                respondOk(requestId);
                return;
            }
            case "add-file": {
                const { requestId, torrentId, filePath, downloadPath, announce } = msg;
                if (!fs.existsSync(filePath))
                    throw new Error("Torrent file not found");
                const torrentBuffer = fs.readFileSync(filePath);
                const torrent = torrentClient.add(torrentBuffer, {
                    path: downloadPath,
                    announce: announce?.length ? announce : publicTrackers,
                });
                torrentsById.set(torrentId, torrent);
                torrentMetaById.set(torrentId, {
                    magnetUri: "",
                    downloadPath,
                    announce: announce?.length ? announce : publicTrackers,
                });
                pausedTorrentMetaById.delete(torrentId);
                applyTorrentUploadPolicy(torrent, enableSeeding);
                attachTorrentLifecycle(torrentId, torrent);
                respondOk(requestId);
                return;
            }
            case "pause": {
                const torrentId = msg.torrentId;
                const torrent = torrentsById.get(torrentId);
                const meta = torrentMetaById.get(torrentId);
                const magnetUri = torrent?.magnetURI || meta?.magnetUri || "";
                if (!magnetUri) {
                    // If we don't have a magnet yet, best effort pause.
                    torrent?.pause?.();
                    respondOk(msg.requestId);
                    return;
                }
                if (meta) {
                    pausedTorrentMetaById.set(torrentId, { ...meta, magnetUri });
                }
                else {
                    pausedTorrentMetaById.set(torrentId, {
                        magnetUri,
                        downloadPath: "",
                        announce: publicTrackers,
                    });
                }
                safeStopTorrent(torrent);
                try {
                    torrent?.destroy?.({ destroyStore: false });
                }
                catch { }
                torrentsById.delete(torrentId);
                torrentMetaById.delete(torrentId);
                respondOk(msg.requestId);
                return;
            }
            case "resume": {
                const torrentId = msg.torrentId;
                const existing = torrentsById.get(torrentId);
                if (existing) {
                    existing.resume?.();
                    applyTorrentUploadPolicy(existing, enableSeeding);
                    respondOk(msg.requestId);
                    return;
                }
                const meta = pausedTorrentMetaById.get(torrentId);
                if (!meta || !meta.magnetUri) {
                    throw new Error("Torrent cannot be resumed yet (missing magnet metadata)");
                }
                const torrent = torrentClient.add(meta.magnetUri, {
                    path: meta.downloadPath,
                    announce: meta.announce?.length ? meta.announce : publicTrackers,
                });
                torrentsById.set(torrentId, torrent);
                torrentMetaById.set(torrentId, meta);
                applyTorrentUploadPolicy(torrent, enableSeeding);
                attachTorrentLifecycle(torrentId, torrent);
                pausedTorrentMetaById.delete(torrentId);
                respondOk(msg.requestId);
                return;
            }
            case "remove": {
                const torrent = torrentsById.get(msg.torrentId);
                if (torrent) {
                    safeStopTorrent(torrent);
                    torrent.destroy?.({ destroyStore: msg.deleteFiles });
                    torrentsById.delete(msg.torrentId);
                    torrentMetaById.delete(msg.torrentId);
                }
                pausedTorrentMetaById.delete(msg.torrentId);
                respondOk(msg.requestId);
                return;
            }
            case "get-files": {
                const torrent = torrentClient.get(msg.infoHash);
                if (!torrent) {
                    respondOk(msg.requestId, []);
                    return;
                }
                const files = torrent.files.map((file, index) => ({
                    index,
                    name: file.name,
                    path: file.path,
                    length: file.length,
                    downloaded: file.downloaded,
                    progress: file.progress,
                }));
                respondOk(msg.requestId, files);
                return;
            }
            default: {
                const _exhaustive = msg;
                return _exhaustive;
            }
        }
    }
    catch (err) {
        const requestId = msg.requestId;
        if (typeof requestId === "string") {
            respondErr(requestId, err);
        }
        else {
            post({ type: "event", event: "torrent-error", payload: { id: "unknown", error: err instanceof Error ? err.message : String(err) } });
        }
    }
});
