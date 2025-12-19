// Archive extraction handlers
import fs from "fs";
import path from "path";
import { Worker } from "worker_threads";
import { app } from "electron";
import { store } from "../store.js";
import { isExtractableArchive, parseMultiPartArchive, areAllPartsCompleted } from "../utils.js";
const multiPartArchives = new Map();
// Track which archives have been extracted
const extractedArchives = new Set();
// Cache for running worker
let extractWorker = null;
function getExtractWorker() {
    if (!extractWorker) {
        extractWorker = new Worker(path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), "dist-electron/extract-worker.js"));
        extractWorker.on("error", (err) => {
            console.error("[Extract] Worker error:", err);
            extractWorker = null;
        });
        extractWorker.on("exit", (code) => {
            if (code !== 0)
                console.warn(`[Extract] Worker exited with code ${code}`);
            extractWorker = null;
        });
    }
    return extractWorker;
}
export function handleMultiPartExtraction(download, getMainWindow) {
    const settings = store.get("settings");
    if (!settings.autoExtract)
        return false;
    const isExtractable = isExtractableArchive(download.filename);
    const multiPart = parseMultiPartArchive(download.filename);
    if (!isExtractable || !multiPart.isMultiPart)
        return false;
    // Track this part
    const existing = multiPartArchives.get(multiPart.baseName);
    if (existing) {
        existing.partPaths.set(multiPart.partNumber, download.path);
    }
    else {
        multiPartArchives.set(multiPart.baseName, {
            baseName: multiPart.baseName,
            partPaths: new Map([[multiPart.partNumber, download.path]]),
        });
    }
    const tracker = multiPartArchives.get(multiPart.baseName);
    const downloads = store.get("downloads");
    // Check if all parts are completed
    const result = areAllPartsCompleted(multiPart.baseName, downloads);
    if (result.allCompleted && result.part1Path) {
        const extractKey = `multipart:${multiPart.baseName}`;
        if (extractedArchives.has(extractKey)) {
            console.log(`[Download] Already extracted ${extractKey}, skipping`);
            return false;
        }
        extractedArchives.add(extractKey);
        const firstPartPath = result.part1Path;
        console.log(`[Download] All ${result.totalParts} parts ready for ${multiPart.baseName}, extracting from: ${firstPartPath}`);
        const outDir = path.dirname(firstPartPath);
        getMainWindow()?.webContents.send("extraction-progress", {
            downloadId: download.id,
            status: "extracting",
            archivePath: firstPartPath,
        });
        const worker = getExtractWorker();
        const messageHandler = (msg) => {
            if (msg.archivePath !== firstPartPath)
                return;
            getMainWindow()?.webContents.send("extraction-progress", {
                downloadId: download.id,
                ...msg,
            });
            if (msg.status === "done" || msg.status === "error") {
                worker.off("message", messageHandler);
                if (msg.status === "done" && settings.deleteArchiveAfterExtract) {
                    for (const p of tracker.partPaths.values()) {
                        try {
                            if (fs.existsSync(p))
                                fs.unlinkSync(p);
                        }
                        catch (e) {
                            console.warn(`[Extract] Could not delete ${p}:`, e);
                        }
                    }
                }
                multiPartArchives.delete(multiPart.baseName);
            }
        };
        worker.on("message", messageHandler);
        worker.postMessage({ archivePath: firstPartPath, outDir });
        return true;
    }
    return false;
}
export function handleSingleExtraction(download, getMainWindow) {
    const settings = store.get("settings");
    if (!settings.autoExtract)
        return false;
    const isExtractable = isExtractableArchive(download.filename);
    const multiPart = parseMultiPartArchive(download.filename);
    if (!isExtractable || multiPart.isMultiPart)
        return false;
    const extractKey = `single:${download.path}`;
    if (extractedArchives.has(extractKey)) {
        console.log(`[Download] Already extracted ${extractKey}, skipping`);
        return false;
    }
    extractedArchives.add(extractKey);
    console.log(`[Download] Auto-extracting: ${download.filename}`);
    const outDir = path.dirname(download.path);
    getMainWindow()?.webContents.send("extraction-progress", {
        downloadId: download.id,
        status: "extracting",
        archivePath: download.path,
    });
    const worker = getExtractWorker();
    const messageHandler = (msg) => {
        if (msg.archivePath !== download.path)
            return;
        getMainWindow()?.webContents.send("extraction-progress", {
            downloadId: download.id,
            ...msg,
        });
        if (msg.status === "done" || msg.status === "error") {
            worker.off("message", messageHandler);
            if (msg.status === "done" && settings.deleteArchiveAfterExtract) {
                try {
                    if (fs.existsSync(download.path))
                        fs.unlinkSync(download.path);
                }
                catch (e) {
                    console.warn(`[Extract] Could not delete archive:`, e);
                }
            }
        }
    };
    worker.on("message", messageHandler);
    worker.postMessage({ archivePath: download.path, outDir });
    return true;
}
