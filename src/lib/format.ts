const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return "--";
  if (bytes === 0) return "0 B";
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), SIZE_UNITS.length - 1);
  return `${parseFloat((bytes / 1024 ** exponent).toFixed(2))} ${SIZE_UNITS[exponent]}`;
}

export function formatSpeed(bytesPerSecond: number) {
  return `${formatSize(bytesPerSecond)}/s`;
}

export function formatEta(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 31_536_000) return "--";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

export function percent(done: number, total: number) {
  if (!Number.isFinite(done) || done < 0 || !Number.isFinite(total) || total <= 0) return 0;
  return Math.round((done / total) * 100);
}

export function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
