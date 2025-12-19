// Download speed tracking utilities

import type { Download } from "../types.js";

// Active download items
export const activeDownloads = new Map<string, Electron.DownloadItem>();

// Speed tracking for EMA calculation
interface SpeedEntry {
  lastBytes: number;
  lastTime: number;
  emaSpeed: number;
}

export const downloadSpeedTrackers = new Map<string, SpeedEntry>();

const SPEED_ALPHA = 0.3; // EMA smoothing factor

export function updateSpeedTracker(
  downloadId: string,
  receivedBytes: number
): number {
  const now = Date.now();
  const entry = downloadSpeedTrackers.get(downloadId);

  if (!entry) {
    downloadSpeedTrackers.set(downloadId, {
      lastBytes: receivedBytes,
      lastTime: now,
      emaSpeed: 0,
    });
    return 0;
  }

  const deltaBytes = receivedBytes - entry.lastBytes;
  const deltaTime = (now - entry.lastTime) / 1000; // seconds

  if (deltaTime > 0) {
    const instantSpeed = deltaBytes / deltaTime;
    entry.emaSpeed = SPEED_ALPHA * instantSpeed + (1 - SPEED_ALPHA) * entry.emaSpeed;
  }

  entry.lastBytes = receivedBytes;
  entry.lastTime = now;

  return entry.emaSpeed;
}

export function cleanupSpeedTracker(downloadId: string) {
  downloadSpeedTrackers.delete(downloadId);
}
