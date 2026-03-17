import { parentPort } from "worker_threads";
import fs from "fs";
import http from "http";
import path from "path";

type WorkerRequest =
  | { type: "init"; enableSeeding: boolean; publicTrackers: string[] }
  | { type: "shutdown"; requestId: string }
  | {
      type: "add-magnet";
      requestId: string;
      torrentId: string;
      magnetUri: string;
      downloadPath: string;
      announce: string[];
    }
  | {
      type: "add-file";
      requestId: string;
      torrentId: string;
      filePath: string;
      downloadPath: string;
      announce: string[];
    }
  | { type: "pause"; requestId: string; torrentId: string }
  | { type: "resume"; requestId: string; torrentId: string }
  | { type: "remove"; requestId: string; torrentId: string; deleteFiles: boolean }
  | { type: "set-seeding"; enableSeeding: boolean }
  | { type: "get-files"; requestId: string; infoHash: string };

type WorkerResponse =
  | { type: "response"; requestId: string; ok: true; data?: unknown }
  | { type: "response"; requestId: string; ok: false; error: string };

type TorrentMetadataEvent = {
  id: string;
  name: string;
  size: number;
  magnetUri: string;
  infoHash?: string;
};

type TorrentProgressEvent = {
  id: string;
  downloaded: number;
  uploaded: number;
  progress: number;
  downloadSpeed: number;
  uploadSpeed: number;
  peers: number;
  seeds: number;
  done: boolean;
};

type TorrentErrorEvent = {
  id: string;
  error: string;
};

type WorkerEvent =
  | { type: "ready"; ok: true; streamServerPort: number }
  | { type: "ready"; ok: false; error: string }
  | { type: "event"; event: "torrent-metadata"; payload: TorrentMetadataEvent }
  | { type: "event"; event: "torrent-progress"; payload: TorrentProgressEvent }
  | { type: "event"; event: "torrent-done"; payload: { id: string } }
  | { type: "event"; event: "torrent-error"; payload: TorrentErrorEvent };

type TorrentSourceMeta = {
  magnetUri: string;
  downloadPath: string;
  announce: string[];
};

type WireLike = {
  choke?: () => void;
  on?: (event: string, listener: () => void) => void;
};

type TorrentFile = {
  name: string;
  path: string;
  length: number;
  downloaded: number;
  progress: number;
  createReadStream: (options?: { start?: number; end?: number }) => NodeJS.ReadableStream;
};

type TorrentLike = {
  name?: string;
  magnetURI?: string;
  infoHash?: string;
  length?: number;
  downloaded?: number;
  uploaded?: number;
  progress?: number;
  downloadSpeed?: number;
  uploadSpeed?: number;
  numPeers?: number;
  done?: boolean;
  files: TorrentFile[];
  wires?: WireLike[];
  pause?: () => void;
  resume?: () => void;
  destroy?: (optionsOrCallback?: { destroyStore?: boolean } | (() => void), callback?: () => void) => void;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  once: (event: string, listener: (...args: unknown[]) => void) => void;
  __limboNoUploadApplied?: boolean;
  __limboNoUploadInterval?: NodeJS.Timeout | null;
  __limboProgressInterval?: NodeJS.Timeout | null;
};

type WebTorrentClient = {
  add: (
    source: string | Buffer,
    options: { path: string; announce: string[] }
  ) => TorrentLike;
  get: (infoHash: string) => TorrentLike | undefined;
  destroy: (callback: () => void) => void;
};

function logIgnoredError(context: string, error: unknown) {
  console.warn(`[torrent-worker] ${context}`, error);
}

let torrentClient: WebTorrentClient | null = null;
let streamServer: http.Server | null = null;
let streamServerPort = 0;
let enableSeeding = false;
let publicTrackers: string[] = [];

const torrentsById = new Map<string, TorrentLike>();
const torrentMetaById = new Map<string, TorrentSourceMeta>();
const pausedTorrentMetaById = new Map<string, TorrentSourceMeta>();

function post(message: WorkerResponse | WorkerEvent) {
  parentPort?.postMessage(message);
}

function respondOk(requestId: string, data?: unknown) {
  post({ type: "response", requestId, ok: true, data });
}

function respondErr(requestId: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  post({ type: "response", requestId, ok: false, error: message });
}

function getMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const mimeTypes: Record<string, string> = {
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

function applyTorrentUploadPolicy(torrent: TorrentLike, allowSeeding: boolean) {
  const attachNoUpload = (wire: WireLike) => {
    try {
      wire.choke?.();
    } catch (error) {
      logIgnoredError("Failed to choke wire", error);
    }

    try {
      wire.on?.("unchoke", () => {
        try {
          wire.choke?.();
        } catch (error) {
          logIgnoredError("Failed to re-choke wire after unchoke", error);
        }
      });
    } catch (error) {
      logIgnoredError("Failed to attach wire unchoke listener", error);
    }
  };

  if (allowSeeding) {
    if (torrent.__limboNoUploadInterval) {
      clearInterval(torrent.__limboNoUploadInterval);
      torrent.__limboNoUploadInterval = null;
    }
    torrent.__limboNoUploadApplied = false;
    return;
  }

  if (torrent.__limboNoUploadApplied) return;
  torrent.__limboNoUploadApplied = true;

  try {
    torrent.on("wire", (...args: unknown[]) => {
      const [wire] = args;
      if (wire && typeof wire === "object") {
        attachNoUpload(wire as WireLike);
      }
    });
  } catch (error) {
    logIgnoredError("Failed to attach torrent wire listener", error);
  }

  try {
    if (Array.isArray(torrent.wires)) {
      for (const wire of torrent.wires) attachNoUpload(wire);
    }
  } catch (error) {
    logIgnoredError("Failed to apply no-upload policy to existing wires", error);
  }

  torrent.__limboNoUploadInterval = setInterval(() => {
    try {
      if (!Array.isArray(torrent.wires)) return;
      for (const wire of torrent.wires) {
        try {
          wire.choke?.();
        } catch (error) {
          logIgnoredError("Failed to choke wire during no-upload interval", error);
        }
      }
    } catch (error) {
      logIgnoredError("Failed to enforce no-upload policy", error);
    }
  }, 1500);
}

async function ensureTorrentClient() {
  if (torrentClient) return;
  const webTorrentModule = await import("webtorrent");
  const WebTorrentCtor = webTorrentModule.default as unknown as new () => WebTorrentClient;
  torrentClient = new WebTorrentCtor();
}

async function ensureStreamServer() {
  if (streamServer) return;

  streamServer = http.createServer((req, res) => {
    const match = req.url?.match(/^\/stream\/([0-9a-f]{40})(?:\/(.*))?$/);
    if (!match) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }

    const infoHash = match[1];
    const fileName = match[2] ? decodeURIComponent(match[2]) : null;
    const torrent = torrentClient?.get(infoHash);
    if (!torrent) {
      res.statusCode = 404;
      res.end("Torrent not found");
      return;
    }

    let file = fileName
      ? torrent.files.find((entry) => entry.name === fileName)
      : torrent.files.find((entry) => entry.name.match(/\.(mp4|mkv|avi|mov|webm)$/i));

    if (!file) file = torrent.files[0];
    if (!file) {
      res.statusCode = 404;
      res.end("No file found");
      return;
    }

    const range = req.headers.range;
    const fileSize = file.length;

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = Number.parseInt(parts[0], 10);
      const end = parts[1] ? Number.parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunkSize,
        "Content-Type": getMimeType(file.name),
      });

      file.createReadStream({ start, end }).pipe(res);
      return;
    }

    res.writeHead(200, {
      "Content-Length": fileSize,
      "Content-Type": getMimeType(file.name),
    });
    file.createReadStream().pipe(res);
  });

  await new Promise<void>((resolve, reject) => {
    streamServer?.once("error", reject);
    streamServer?.listen(0, "127.0.0.1", () => resolve());
  });

  const address = streamServer.address();
  if (address && typeof address === "object") {
    streamServerPort = address.port;
  }
}

function safeStopTorrent(torrent: TorrentLike) {
  if (torrent.__limboProgressInterval) {
    clearInterval(torrent.__limboProgressInterval);
    torrent.__limboProgressInterval = null;
  }

  if (torrent.__limboNoUploadInterval) {
    clearInterval(torrent.__limboNoUploadInterval);
    torrent.__limboNoUploadInterval = null;
  }
}

function attachTorrentLifecycle(torrentId: string, torrent: TorrentLike) {
  torrent.on("warning", (...args: unknown[]) => {
    const [warning] = args;
    post({
      type: "event",
      event: "torrent-error",
      payload: { id: torrentId, error: warning instanceof Error ? warning.message : String(warning) },
    });
  });

  torrent.on("error", (...args: unknown[]) => {
    const [error] = args;
    post({
      type: "event",
      event: "torrent-error",
      payload: { id: torrentId, error: error instanceof Error ? error.message : String(error) },
    });
  });

  const sendMetadata = () => {
    const name = torrent.name || "Loading torrent...";
    const meta = torrentMetaById.get(torrentId);
    if (meta) {
      torrentMetaById.set(torrentId, {
        ...meta,
        magnetUri: torrent.magnetURI || meta.magnetUri,
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

  torrent.__limboProgressInterval = setInterval(() => {
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
        done: Boolean(torrent.done),
      },
    });
  }, 1000);

  torrent.on("done", () => {
    safeStopTorrent(torrent);
    post({ type: "event", event: "torrent-done", payload: { id: torrentId } });

    if (!enableSeeding) {
      try {
        torrent.destroy?.({ destroyStore: false });
      } catch (error) {
        logIgnoredError("Failed to destroy completed torrent", error);
      }
      torrentsById.delete(torrentId);
      torrentMetaById.delete(torrentId);
      pausedTorrentMetaById.delete(torrentId);
    }
  });
}

async function shutdownWorker(): Promise<void> {
  for (const torrent of torrentsById.values()) {
    try {
      safeStopTorrent(torrent);
      torrent.destroy?.({ destroyStore: false });
    } catch (error) {
      logIgnoredError("Failed to destroy torrent during shutdown", error);
    }
  }
  torrentsById.clear();
  torrentMetaById.clear();
  pausedTorrentMetaById.clear();

  if (streamServer) {
    const server = streamServer;
    streamServer = null;
    await new Promise<void>((resolve) => {
      try {
        server.close(() => resolve());
      } catch (error) {
        logIgnoredError("Failed to close stream server cleanly", error);
        resolve();
      }
    });
  }
  streamServerPort = 0;

  if (torrentClient) {
    const client = torrentClient;
    torrentClient = null;
    await new Promise<void>((resolve) => {
      try {
        client.destroy(() => resolve());
      } catch (error) {
        logIgnoredError("Failed to destroy torrent client cleanly", error);
        resolve();
      }
    });
  }
}

async function handleInit(message: Extract<WorkerRequest, { type: "init" }>) {
  enableSeeding = message.enableSeeding;
  publicTrackers = message.publicTrackers || [];

  try {
    await ensureTorrentClient();
    await ensureStreamServer();
    post({ type: "ready", ok: true, streamServerPort });
  } catch (error) {
    post({
      type: "ready",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function getRequestId(message: WorkerRequest) {
  if ("requestId" in message) return message.requestId;
  return null;
}

parentPort?.on("message", async (message: WorkerRequest) => {
  try {
    if (message.type === "init") {
      await handleInit(message);
      return;
    }

    if (message.type === "shutdown") {
      await shutdownWorker();
      respondOk(message.requestId);
      return;
    }

    if (!torrentClient) {
      const requestId = getRequestId(message);
      if (requestId) respondErr(requestId, "Torrent worker not initialized");
      return;
    }

    switch (message.type) {
      case "set-seeding": {
        enableSeeding = message.enableSeeding;
        for (const torrent of torrentsById.values()) {
          applyTorrentUploadPolicy(torrent, enableSeeding);
        }
        return;
      }

      case "add-magnet": {
        const torrent = torrentClient.add(message.magnetUri, {
          path: message.downloadPath,
          announce: message.announce.length > 0 ? message.announce : publicTrackers,
        });

        torrentsById.set(message.torrentId, torrent);
        torrentMetaById.set(message.torrentId, {
          magnetUri: message.magnetUri,
          downloadPath: message.downloadPath,
          announce: message.announce.length > 0 ? message.announce : publicTrackers,
        });
        pausedTorrentMetaById.delete(message.torrentId);
        applyTorrentUploadPolicy(torrent, enableSeeding);
        attachTorrentLifecycle(message.torrentId, torrent);
        respondOk(message.requestId);
        return;
      }

      case "add-file": {
        if (!fs.existsSync(message.filePath)) {
          throw new Error("Torrent file not found");
        }

        const torrentBuffer = fs.readFileSync(message.filePath);
        const torrent = torrentClient.add(torrentBuffer, {
          path: message.downloadPath,
          announce: message.announce.length > 0 ? message.announce : publicTrackers,
        });

        torrentsById.set(message.torrentId, torrent);
        torrentMetaById.set(message.torrentId, {
          magnetUri: "",
          downloadPath: message.downloadPath,
          announce: message.announce.length > 0 ? message.announce : publicTrackers,
        });
        pausedTorrentMetaById.delete(message.torrentId);
        applyTorrentUploadPolicy(torrent, enableSeeding);
        attachTorrentLifecycle(message.torrentId, torrent);
        respondOk(message.requestId);
        return;
      }

      case "pause": {
        const torrent = torrentsById.get(message.torrentId);
        const meta = torrentMetaById.get(message.torrentId);
        const magnetUri = torrent?.magnetURI || meta?.magnetUri || "";

        if (!magnetUri) {
          torrent?.pause?.();
          respondOk(message.requestId);
          return;
        }

        pausedTorrentMetaById.set(message.torrentId, {
          magnetUri,
          downloadPath: meta?.downloadPath || "",
          announce: meta?.announce || publicTrackers,
        });

        if (torrent) {
          safeStopTorrent(torrent);
          try {
            torrent.destroy?.({ destroyStore: false });
          } catch (error) {
            logIgnoredError("Failed to destroy paused torrent", error);
          }
        }

        torrentsById.delete(message.torrentId);
        torrentMetaById.delete(message.torrentId);
        respondOk(message.requestId);
        return;
      }

      case "resume": {
        const existing = torrentsById.get(message.torrentId);
        if (existing) {
          existing.resume?.();
          applyTorrentUploadPolicy(existing, enableSeeding);
          respondOk(message.requestId);
          return;
        }

        const meta = pausedTorrentMetaById.get(message.torrentId);
        if (!meta || !meta.magnetUri) {
          throw new Error("Torrent cannot be resumed yet (missing magnet metadata)");
        }

        const torrent = torrentClient.add(meta.magnetUri, {
          path: meta.downloadPath,
          announce: meta.announce.length > 0 ? meta.announce : publicTrackers,
        });
        torrentsById.set(message.torrentId, torrent);
        torrentMetaById.set(message.torrentId, meta);
        pausedTorrentMetaById.delete(message.torrentId);
        applyTorrentUploadPolicy(torrent, enableSeeding);
        attachTorrentLifecycle(message.torrentId, torrent);
        respondOk(message.requestId);
        return;
      }

      case "remove": {
        const torrent = torrentsById.get(message.torrentId);
        if (torrent) {
          safeStopTorrent(torrent);
          try {
            torrent.destroy?.({ destroyStore: message.deleteFiles });
          } catch (error) {
            logIgnoredError("Failed to destroy removed torrent", error);
          }
          torrentsById.delete(message.torrentId);
          torrentMetaById.delete(message.torrentId);
        }
        pausedTorrentMetaById.delete(message.torrentId);
        respondOk(message.requestId);
        return;
      }

      case "get-files": {
        const torrent = torrentClient.get(message.infoHash);
        if (!torrent) {
          respondOk(message.requestId, []);
          return;
        }

        respondOk(
          message.requestId,
          torrent.files.map((file, index) => ({
            index,
            name: file.name,
            path: file.path,
            length: file.length,
            downloaded: file.downloaded,
            progress: file.progress,
          }))
        );
        return;
      }
    }
  } catch (error) {
    const requestId = getRequestId(message);
    if (requestId) {
      respondErr(requestId, error);
    } else {
      post({
        type: "event",
        event: "torrent-error",
        payload: {
          id: "unknown",
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
});
