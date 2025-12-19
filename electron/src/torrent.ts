// Torrent worker management

import path from "path";
import { Worker } from "worker_threads";
import { v4 as uuidv4 } from "uuid";
import { store } from "./store.js";
import { detectCategory } from "./utils.js";
import type { TorrentInfo } from "./types.js";

// Public trackers for peer discovery
export const publicTrackers = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.demonii.com:1337/announce",
  "udp://tracker.openbittorrent.com:6969/announce",
  "udp://exodus.desync.com:6969/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.moeking.me:6969/announce",
  "wss://tracker.btorrent.xyz",
  "wss://tracker.openwebtorrent.com",
];

let torrentWorker: Worker | null = null;
let torrentWorkerReady = false;
let streamServerPort = 0;

export const activeTorrentIds = new Set<string>();
const pendingTorrentWorkerRequests = new Map<
  string,
  { resolve: (value: any) => void; reject: (reason?: any) => void; timeout: NodeJS.Timeout }
>();

// Callback for events that need mainWindow access
let onTorrentEvent: ((event: string, payload: any) => void) | null = null;

export function setTorrentEventHandler(handler: (event: string, payload: any) => void) {
  onTorrentEvent = handler;
}

export function isTorrentReady(): boolean {
  return torrentWorkerReady;
}

export function getStreamServerPort(): number {
  return streamServerPort;
}

export function callTorrentWorker<T = any>(message: any, timeoutMs = 20000): Promise<T> {
  if (!torrentWorker || !torrentWorkerReady) {
    return Promise.reject(new Error("Torrent support is not available."));
  }

  const requestId = uuidv4();
  const payload = { ...message, requestId };

  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingTorrentWorkerRequests.delete(requestId);
      reject(new Error("Torrent worker request timed out"));
    }, timeoutMs);

    pendingTorrentWorkerRequests.set(requestId, { resolve, reject, timeout });
    torrentWorker!.postMessage(payload);
  });
}

function handleTorrentWorkerEvent(event: string, payload: any) {
  if (!payload || typeof payload !== "object") return;

  if (event === "torrent-metadata") {
    const torrents = store.get("torrents");
    const idx = torrents.findIndex((t) => t.id === payload.id);
    if (idx !== -1) {
      const settings = store.get("settings");
      const realName = payload.name || torrents[idx].name;
      torrents[idx] = {
        ...torrents[idx],
        name: realName,
        size: payload.size || torrents[idx].size,
        magnetUri: payload.magnetUri || torrents[idx].magnetUri,
        infoHash: payload.infoHash || torrents[idx].infoHash,
        path: path.join(settings.downloadPath, realName),
      };
      store.set("torrents", torrents);
      onTorrentEvent?.("torrent-progress", torrents[idx]);
    }
    return;
  }

  if (event === "torrent-progress") {
    const torrents = store.get("torrents");
    const idx = torrents.findIndex((t) => t.id === payload.id);
    if (idx === -1) return;

    const settings = store.get("settings");
    torrents[idx] = {
      ...torrents[idx],
      downloaded: payload.downloaded || 0,
      uploaded: settings.enableSeeding ? (payload.uploaded || 0) : 0,
      progress: payload.progress || 0,
      downloadSpeed: payload.downloadSpeed || 0,
      uploadSpeed: settings.enableSeeding ? (payload.uploadSpeed || 0) : 0,
      peers: payload.peers || 0,
      seeds: payload.seeds || 0,
      status: payload.done
        ? "completed"
        : torrents[idx].status === "paused"
          ? "paused"
          : "downloading",
    };
    store.set("torrents", torrents);
    onTorrentEvent?.("torrent-progress", torrents[idx]);
    return;
  }

  if (event === "torrent-done") {
    const torrents = store.get("torrents");
    const idx = torrents.findIndex((t) => t.id === payload.id);
    if (idx !== -1) {
      const settings = store.get("settings");
      torrents[idx].progress = 1;
      torrents[idx].status = settings.enableSeeding ? "seeding" : "completed";
      if (!settings.enableSeeding) {
        torrents[idx].uploaded = 0;
        torrents[idx].uploadSpeed = 0;
        activeTorrentIds.delete(payload.id);
      }
      store.set("torrents", torrents);

      // Add to library
      const library = store.get("library");
      const finalPath = torrents[idx].path;
      library.push({
        id: uuidv4(),
        name: torrents[idx].name,
        path: finalPath,
        size: torrents[idx].size,
        dateAdded: new Date().toISOString(),
        category: detectCategory(finalPath),
      });
      store.set("library", library);
      onTorrentEvent?.("library-updated", library);
      onTorrentEvent?.("torrent-complete", torrents[idx]);
    }
    return;
  }

  if (event === "torrent-error") {
    const torrents = store.get("torrents");
    const idx = torrents.findIndex((t) => t.id === payload.id);
    if (idx !== -1) {
      torrents[idx].status = "error";
      store.set("torrents", torrents);
    }
    onTorrentEvent?.("torrent-error", { id: payload.id, error: payload.error || "Torrent error" });
  }
}

export async function initTorrentWorker(workerPath: string): Promise<void> {
  try {
    torrentWorker = new Worker(workerPath);

    torrentWorker.on("message", (msg: any) => {
      if (!msg || typeof msg !== "object") return;

      if (msg.type === "ready") {
        torrentWorkerReady = !!msg.ok;
        if (msg.ok) {
          streamServerPort = msg.streamServerPort || 0;
          console.log(`Torrent worker ready. Stream server on http://127.0.0.1:${streamServerPort}`);

          // Resume torrents that were downloading last run
          try {
            const settings = store.get("settings");
            const torrents = store.get("torrents");
            for (const t of torrents) {
              if (t.status !== "downloading") continue;
              if (!t.magnetUri) continue;
              activeTorrentIds.add(t.id);
              callTorrentWorker({
                type: "add-magnet",
                torrentId: t.id,
                magnetUri: t.magnetUri,
                downloadPath: settings.downloadPath,
                announce: publicTrackers,
              }).catch(() => {});
            }
          } catch {}
        } else {
          console.warn("Torrent worker failed to initialize.", msg.error);
        }
        return;
      }

      if (msg.type === "response" && typeof msg.requestId === "string") {
        const pending = pendingTorrentWorkerRequests.get(msg.requestId);
        if (!pending) return;
        clearTimeout(pending.timeout);
        pendingTorrentWorkerRequests.delete(msg.requestId);
        if (msg.ok) pending.resolve(msg.data);
        else pending.reject(new Error(msg.error || "Torrent worker request failed"));
        return;
      }

      if (msg.type === "event") {
        handleTorrentWorkerEvent(msg.event, msg.payload);
      }
    });

    torrentWorker.on("error", (err) => {
      console.warn("Torrent worker error", err);
      torrentWorkerReady = false;
    });

    torrentWorker.on("exit", (code) => {
      console.warn("Torrent worker exited", code);
      torrentWorkerReady = false;
      torrentWorker = null;
    });

    const settings = store.get("settings");
    torrentWorker.postMessage({ type: "init", enableSeeding: settings.enableSeeding, publicTrackers });
  } catch (err) {
    console.warn("Torrent worker failed to start. Torrent support disabled.", err);
    torrentWorkerReady = false;
    torrentWorker = null;
  }
}

export function updateTorrentSeeding(enableSeeding: boolean) {
  try {
    torrentWorker?.postMessage({ type: "set-seeding", enableSeeding });
  } catch {}
}
