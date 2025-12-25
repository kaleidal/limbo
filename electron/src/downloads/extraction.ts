// Archive extraction handlers

import fs from "fs";
import path from "path";
import { Worker } from "worker_threads";
import { BrowserWindow, app } from "electron";
import { store } from "../store.js";
import { isExtractableArchive, parseMultiPartArchive, areAllPartsCompleted } from "../utils.js";
import type { Download } from "../types.js";

// Cache for running worker
let extractWorker: Worker | null = null;

function getExtractWorker(): Worker {
  if (!extractWorker) {
    extractWorker = new Worker(
      path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), "dist-electron/extract-worker.js")
    );
    extractWorker.on("error", (err) => {
      console.error("[Extract] Worker error:", err);
      extractWorker = null;
    });
    extractWorker.on("exit", (code) => {
      if (code !== 0) console.warn(`[Extract] Worker exited with code ${code}`);
      extractWorker = null;
    });
  }
  return extractWorker;
}

export async function shutdownExtractWorker(): Promise<void> {
  const worker = extractWorker;
  extractWorker = null;
  if (!worker) return;
  try {
    await worker.terminate();
  } catch { }
}

export function handleMultiPartExtraction(
  download: Download,
  getMainWindow: () => BrowserWindow | null
): boolean {
  const settings = store.get("settings");
  if (!settings.autoExtract) return false;

  const isExtractable = isExtractableArchive(download.filename);
  const multiPart = parseMultiPartArchive(download.filename);

  if (!isExtractable || !multiPart.isMultiPart) return false;

  const downloads = store.get("downloads") || [];

  // Check completion
  const result = areAllPartsCompleted(multiPart.baseName, downloads);

  if (result.allCompleted && result.part1Path) {
    // Check if already extracted using persistent store
    const extractedGroups = store.get("extractedGroups") || [];
    const extractKey = `multipart:${multiPart.baseName.toLowerCase()}`;

    if (extractedGroups.includes(extractKey)) {
      console.log(`[Download] Already extracted ${extractKey}, skipping`);
      return false;
    }

    const firstPartPath = result.part1Path;
    console.log(`[Download] All ${result.totalParts} parts ready for ${multiPart.baseName}, extracting from: ${firstPartPath}`);
    const outDir = path.dirname(firstPartPath);

    getMainWindow()?.webContents.send("extraction-progress", {
      downloadId: download.id,
      status: "extracting",
      archivePath: firstPartPath,
    });

    const worker = getExtractWorker();
    const messageHandler = (msg: any) => {
      if (msg.archivePath !== firstPartPath) return;
      getMainWindow()?.webContents.send("extraction-progress", {
        downloadId: download.id,
        ...msg,
      });
      if (msg.status === "done" || msg.status === "error") {
        worker.off("message", messageHandler);

        if (msg.status === "done") {
          // Mark as extracted in store
          const currentExtracted = store.get("extractedGroups") || [];
          if (!currentExtracted.includes(extractKey)) {
            store.set("extractedGroups", [...currentExtracted, extractKey]);
          }

          if (settings.deleteArchiveAfterExtract) {
            // Find all parts and delete
            const partDownloads = downloads.filter(d => {
              if (download.groupId && d.groupId === download.groupId) return true;
              const p = parseMultiPartArchive(d.filename);
              return p.isMultiPart && p.baseName.toLowerCase() === multiPart.baseName.toLowerCase();
            });

            for (const d of partDownloads) {
              try {
                if (fs.existsSync(d.path)) {
                  console.log(`[Extract] Deleting part: ${d.path}`);
                  fs.unlinkSync(d.path);
                }
              } catch (e) {
                console.warn(`[Extract] Could not delete ${d.path}:`, e);
              }
            }
          }
        }
      }
    };
    worker.on("message", messageHandler);
    worker.postMessage({ archivePath: firstPartPath, outDir });

    return true;
  }

  return false;
}

export function handleSingleExtraction(
  download: Download,
  getMainWindow: () => BrowserWindow | null
): boolean {
  const settings = store.get("settings");
  if (!settings.autoExtract) return false;

  const isExtractable = isExtractableArchive(download.filename);
  const multiPart = parseMultiPartArchive(download.filename);

  if (!isExtractable || multiPart.isMultiPart) return false;

  // Check persistent store
  const extractedGroups = store.get("extractedGroups") || [];
  const extractKey = `single:${download.path.toLowerCase()}`;

  if (extractedGroups.includes(extractKey)) {
    console.log(`[Download] Already extracted ${extractKey}, skipping`);
    return false;
  }

  console.log(`[Download] Auto-extracting: ${download.filename}`);
  const outDir = path.dirname(download.path);

  getMainWindow()?.webContents.send("extraction-progress", {
    downloadId: download.id,
    status: "extracting",
    archivePath: download.path,
  });

  const worker = getExtractWorker();
  const messageHandler = (msg: any) => {
    if (msg.archivePath !== download.path) return;
    getMainWindow()?.webContents.send("extraction-progress", {
      downloadId: download.id,
      ...msg,
    });
    if (msg.status === "done" || msg.status === "error") {
      worker.off("message", messageHandler);

      if (msg.status === "done") {
        // Mark as extracted
        const currentExtracted = store.get("extractedGroups") || [];
        if (!currentExtracted.includes(extractKey)) {
          store.set("extractedGroups", [...currentExtracted, extractKey]);
        }

        if (settings.deleteArchiveAfterExtract) {
          try {
            if (fs.existsSync(download.path)) fs.unlinkSync(download.path);
          } catch (e) {
            console.warn(`[Extract] Could not delete archive:`, e);
          }
        }
      }
    }
  };
  worker.on("message", messageHandler);
  worker.postMessage({ archivePath: download.path, outDir });

  return true;
}
