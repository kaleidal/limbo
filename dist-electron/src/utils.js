// Utility functions for Limbo Electron main process
import path from "path";
import fs from "fs";
import os from "os";
import { Worker } from "worker_threads";
// Check if a file is an extractable archive
export function isExtractableArchive(filename) {
    const ext = path.extname(filename).toLowerCase();
    return [".zip", ".rar", ".7z"].includes(ext);
}
// Parse multi-part archive filename
export function parseMultiPartArchive(filename) {
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
            isPart1: oldStyleMatch[2] === "00",
        };
    }
    return { isMultiPart: false, baseName: filename, partNumber: 0, isPart1: false };
}
// Check if all parts of a multi-part archive are COMPLETED
export function areAllPartsCompleted(baseName, downloads) {
    const matchingDownloads = [];
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
    let part1Path = null;
    let completedCount = 0;
    const maxPart = Math.max(...matchingDownloads.map((d) => d.partNumber));
    for (const download of matchingDownloads) {
        if (download.status === "completed" || download.status === "extracting") {
            completedCount++;
        }
        if (download.partNumber === 1) {
            part1Path = download.path;
        }
    }
    const partNumbers = matchingDownloads.map((d) => d.partNumber).sort((a, b) => a - b);
    const hasAllParts = partNumbers.length === maxPart &&
        partNumbers[0] === 1 &&
        partNumbers[partNumbers.length - 1] === maxPart;
    const allAreCompleted = completedCount === matchingDownloads.length;
    return {
        allCompleted: hasAllParts && allAreCompleted && part1Path !== null,
        part1Path,
        totalParts: maxPart,
        completedParts: completedCount,
    };
}
// VPN detection
export function isVpnConnected() {
    try {
        const interfaces = os.networkInterfaces();
        const vpnPatterns = [
            /^tun/i,
            /^tap/i,
            /^ppp/i,
            /^wg/i,
            /^utun/i,
            /wireguard/i,
            /openvpn/i,
            /nordlynx/i,
            /proton/i,
            /mullvad/i,
            /expressvpn/i,
            /surfshark/i,
            /cyberghost/i,
            /pia/i,
            /private.*internet/i,
        ];
        for (const [name, addrs] of Object.entries(interfaces)) {
            if (!addrs)
                continue;
            if (vpnPatterns.some((p) => p.test(name))) {
                const hasIp = addrs.some((addr) => addr.family === "IPv4" && !addr.internal);
                if (hasIp)
                    return true;
            }
        }
        return false;
    }
    catch {
        return false;
    }
}
// Detect category based on folder/file contents
export function detectCategory(itemPath) {
    try {
        const stat = fs.statSync(itemPath);
        if (stat.isDirectory()) {
            const files = fs.readdirSync(itemPath);
            for (const file of files) {
                const ext = path.extname(file).toLowerCase();
                if ([".exe", ".msi"].includes(ext))
                    return "software";
            }
            for (const file of files) {
                const lower = file.toLowerCase();
                if (lower.includes("game") || lower.includes("steam_api") || lower.includes("unityplayer")) {
                    return "games";
                }
            }
            for (const file of files) {
                const ext = path.extname(file).toLowerCase();
                if ([".mp4", ".mkv", ".avi", ".mov", ".wmv"].includes(ext))
                    return "movies";
            }
            for (const file of files) {
                const ext = path.extname(file).toLowerCase();
                if ([".mp3", ".flac", ".wav", ".aac", ".ogg"].includes(ext))
                    return "music";
            }
        }
        else {
            const ext = path.extname(itemPath).toLowerCase();
            if ([".exe", ".msi"].includes(ext))
                return "software";
            if ([".mp4", ".mkv", ".avi", ".mov", ".wmv"].includes(ext))
                return "movies";
            if ([".mp3", ".flac", ".wav", ".aac", ".ogg"].includes(ext))
                return "music";
        }
    }
    catch (err) {
        console.error("Error detecting category:", err);
    }
    return "other";
}
// Get folder size recursively
export function getFolderSize(folderPath) {
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
// Get MIME type for file
export function getMimeType(filename) {
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
// Auto-extract archive using worker thread (non-blocking)
export function autoExtractArchiveAsync(filePath, downloadId, workerPath, onProgress, onComplete) {
    const worker = new Worker(workerPath, {
        workerData: { filePath, downloadId },
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
// Parse magnet display name
export function parseMagnetDisplayName(magnetUri) {
    try {
        const match = magnetUri.match(/[?&]dn=([^&]+)/i);
        if (!match)
            return null;
        return decodeURIComponent(match[1].replace(/\+/g, "%20"));
    }
    catch {
        return null;
    }
}
// Normalize CLI argument (strip quotes, file:// prefix)
export function normalizeCliArg(arg) {
    let value = arg.trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
    }
    if (value.startsWith("file://")) {
        try {
            value = decodeURIComponent(value.replace("file://", ""));
        }
        catch {
            value = value.replace("file://", "");
        }
    }
    return value;
}
// Find torrent file in CLI args
export function findTorrentFileArg(args) {
    for (const raw of args) {
        const arg = normalizeCliArg(raw);
        if (!arg)
            continue;
        if (arg.toLowerCase().endsWith(".torrent") && fs.existsSync(arg))
            return arg;
    }
    return null;
}
// Find magnet link in CLI args
export function findMagnetArg(args) {
    for (const raw of args) {
        const arg = normalizeCliArg(raw);
        if (arg.startsWith("magnet:"))
            return arg;
    }
    return null;
}
