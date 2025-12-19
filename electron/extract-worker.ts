import { parentPort, workerData } from "worker_threads";
import path from "path";
import fs from "fs";
import extractZip from "extract-zip";
import { createExtractorFromFile } from "node-unrar-js";
import sevenZip from "7zip-min";

interface ExtractJob {
  filePath: string;
  downloadId: string;
}

const { filePath, downloadId } = workerData as ExtractJob;

async function extract() {
  const ext = path.extname(filePath).toLowerCase();
  const dir = path.dirname(filePath);
  const baseName = path.basename(filePath, ext);
  const extractDir = path.join(dir, baseName);

  try {
    // Create extract directory
    if (!fs.existsSync(extractDir)) {
      fs.mkdirSync(extractDir, { recursive: true });
    }

    parentPort?.postMessage({ type: "progress", percent: 0, status: "Starting extraction..." });

    if (ext === ".zip") {
      let entryCount = 0;
      await extractZip(filePath, {
        dir: extractDir,
        onEntry: () => {
          entryCount++;
          parentPort?.postMessage({
            type: "progress",
            percent: Math.min(95, entryCount * 5),
            status: `Extracting files...`,
          });
        },
      });
      parentPort?.postMessage({ type: "progress", percent: 100, status: "Extraction complete" });
      parentPort?.postMessage({ type: "done", extractDir, success: true });
      return;
    }

    if (ext === ".rar") {
      parentPort?.postMessage({ type: "progress", percent: 10, status: "Reading RAR archive..." });
      const extractor = await createExtractorFromFile({ filepath: filePath, targetPath: extractDir });
      const { files } = extractor.extract();
      let count = 0;
      for (const file of files) {
        count++;
        parentPort?.postMessage({
          type: "progress",
          percent: Math.min(95, 10 + count * 3),
          status: `Extracting: ${file.fileHeader.name}`,
        });
      }
      parentPort?.postMessage({ type: "progress", percent: 100, status: "Extraction complete" });
      parentPort?.postMessage({ type: "done", extractDir, success: true });
      return;
    }

    if (ext === ".7z") {
      parentPort?.postMessage({ type: "progress", percent: 10, status: "Extracting 7z archive..." });
      await new Promise<void>((resolve, reject) => {
        sevenZip.unpack(filePath, extractDir, (err: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      });
      parentPort?.postMessage({ type: "progress", percent: 100, status: "Extraction complete" });
      parentPort?.postMessage({ type: "done", extractDir, success: true });
      return;
    }

    // Unsupported format
    parentPort?.postMessage({ type: "done", extractDir: null, success: false, error: "Unsupported format" });
  } catch (err: any) {
    parentPort?.postMessage({
      type: "done",
      extractDir: null,
      success: false,
      error: err.message || "Extraction failed",
    });
  }
}

extract();
