// Download speed tracking utilities
// Active download items
export const activeDownloads = new Map();
export const downloadSpeedTrackers = new Map();
const SPEED_ALPHA = 0.3; // EMA smoothing factor
export function updateSpeedTracker(downloadId, receivedBytes) {
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
export function cleanupSpeedTracker(downloadId) {
    downloadSpeedTrackers.delete(downloadId);
}
