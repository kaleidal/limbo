import { parentPort, workerData } from "worker_threads";
import path from "path";
import fs from "fs";
import extractZip from "extract-zip";
import { createExtractorFromFile } from "node-unrar-js";
import sevenZip from "7zip-min";

type ExtractJob = {
  archivePath: string;
  outDir: string;
};

function post(msg: any) {
  parentPort?.postMessage(msg);
}

async function extract(job: ExtractJob) {
  const filePath = job.archivePath;
  const ext = path.extname(filePath).toLowerCase();
  const dir = job.outDir || path.dirname(filePath);
  const baseName = path.basename(filePath, ext);
  const extractDir = path.join(dir, baseName);

  try {
    // Create extract directory
    if (!fs.existsSync(extractDir)) {
      fs.mkdirSync(extractDir, { recursive: true });
    }

    post({ archivePath: filePath, status: "progress", percent: 0, message: "Starting extraction..." });

    if (ext === ".zip") {
      let entryCount = 0;
      await extractZip(filePath, {
        dir: extractDir,
        onEntry: () => {
          entryCount++;
          post({
            archivePath: filePath,
            status: "progress",
            percent: Math.min(95, entryCount * 5),
            message: `Extracting files...`,
          });
        },
      });
      post({ archivePath: filePath, status: "progress", percent: 100, message: "Extraction complete" });
      post({ archivePath: filePath, status: "done", extractDir, success: true });
      return;
    }

    if (ext === ".rar") {
      post({ archivePath: filePath, status: "progress", percent: 10, message: "Reading RAR archive..." });
      const extractor = await createExtractorFromFile({ filepath: filePath, targetPath: extractDir });
      const { files } = extractor.extract();
      let count = 0;
      for (const file of files) {
        count++;
        post({
          archivePath: filePath,
          status: "progress",
          percent: Math.min(95, 10 + count * 3),
          message: `Extracting: ${file.fileHeader.name}`,
        });
      }
      post({ archivePath: filePath, status: "progress", percent: 100, message: "Extraction complete" });
      post({ archivePath: filePath, status: "done", extractDir, success: true });
      return;
    }

    if (ext === ".7z") {
      post({ archivePath: filePath, status: "progress", percent: 10, message: "Extracting 7z archive..." });
      await new Promise<void>((resolve, reject) => {
        sevenZip.unpack(filePath, extractDir, (err: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      });
      post({ archivePath: filePath, status: "progress", percent: 100, message: "Extraction complete" });
      post({ archivePath: filePath, status: "done", extractDir, success: true });
      return;
    }

    // Unsupported format
    post({ archivePath: filePath, status: "error", extractDir: null, success: false, error: "Unsupported format" });
  } catch (err: any) {
    post({
      archivePath: filePath,
      status: "error",
      extractDir: null,
      success: false,
      error: err?.message || "Extraction failed",
    });
  }
}

// Support both styles:
// - Reused worker: parentPort.postMessage({ archivePath, outDir })
// - One-off workerData (backwards compatibility)
if (parentPort) {
  parentPort.on("message", (job: ExtractJob) => {
    if (!job?.archivePath) return;
    extract(job);
  });
} else if (workerData?.filePath) {
  // Legacy shape
  extract({ archivePath: workerData.filePath, outDir: path.dirname(workerData.filePath) });
}
