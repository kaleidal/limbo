// Torrent worker management
// Runs in Electron utilityProcess — not worker_threads — because WebTorrent's
// HTTP tracker client uses fetch, which fails inside worker threads (0 peers
// when UDP trackers/DHT are blocked).

import fs from "fs";
import path from "path";
import { utilityProcess, type UtilityProcess } from "electron";
import { v4 as uuidv4 } from "uuid";
import { ensureApiToken } from "./api/discovery.js";
import { store } from "./store.js";
import { detectCategory } from "./utils.js";
import type { TorrentInfo } from "./types.js";

type TorrentWorkerRequest =
  | { type: "init"; enableSeeding: boolean; publicTrackers: string[]; streamToken?: string }
  | { type: "shutdown" }
  | { type: "set-seeding"; enableSeeding: boolean }
  | {
      type: "add-magnet";
      torrentId: string;
      magnetUri: string;
      downloadPath: string;
      announce: string[];
      keepAlive?: boolean;
      selectedFileIndex?: number | null;
      sequential?: boolean;
    }
  | {
      type: "add-file";
      torrentId: string;
      filePath: string;
      downloadPath: string;
      announce: string[];
      keepAlive?: boolean;
      selectedFileIndex?: number | null;
      sequential?: boolean;
    }
  | { type: "pause"; torrentId: string }
  | { type: "resume"; torrentId: string }
  | { type: "remove"; torrentId: string; deleteFiles: boolean }
  | { type: "get-files"; infoHash: string }
  | { type: "select-file"; torrentId: string; fileIndex: number; sequential?: boolean }
  | { type: "get-status"; torrentId: string };

type TorrentWorkerEnvelope = TorrentWorkerRequest & { requestId?: string };

type TorrentWorkerReadyMessage = {
  type: "ready";
  ok: boolean;
  error?: string;
  streamServerPort?: number;
};

type TorrentWorkerResponseMessage = {
  type: "response";
  requestId: string;
  ok: boolean;
  data?: unknown;
  error?: string;
};

type TorrentWorkerEventMessage = {
  type: "event";
  event: string;
  payload: unknown;
};

type TorrentWorkerMessage =
  | TorrentWorkerReadyMessage
  | TorrentWorkerResponseMessage
  | TorrentWorkerEventMessage;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timeout: NodeJS.Timeout;
};

type TorrentMetadataPayload = {
  id: string;
  name?: string;
  size?: number;
  magnetUri?: string;
  infoHash?: string;
};

type TorrentProgressPayload = {
  id: string;
  downloaded?: number;
  uploaded?: number;
  progress?: number;
  downloadSpeed?: number;
  uploadSpeed?: number;
  peers?: number;
  seeds?: number;
  done?: boolean;
  size?: number;
};

type TorrentDonePayload = { id: string };
type TorrentErrorPayload = { id: string; error?: string };

export const publicTrackers = [
  // Prefer reachable HTTP trackers first — UDP/DHT often blocked (VPN/firewall).
  // opentrackr:1337 frequently times out from restricted networks.
  "http://tracker.bt4g.com:2095/announce",
  "http://tracker2.dler.org:80/announce",
  "http://open.trackerlist.xyz:80/announce",
  "wss://tracker.openwebtorrent.com",
  "wss://tracker.webtorrent.dev",
  "wss://tracker.btorrent.xyz",
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://exodus.desync.com:6969/announce",
  "udp://open.demonii.com:1337/announce",
  "udp://explodie.org:6969/announce",
];

let torrentWorker: UtilityProcess | null = null;
let torrentWorkerReady = false;
let streamServerPort = 0;

export const activeTorrentIds = new Set<string>();
const pendingTorrentWorkerRequests = new Map<string, PendingRequest>();

let onTorrentEvent: ((event: string, payload: unknown) => void) | null = null;

function updateStoredTorrent(torrentId: string, updater: (torrent: TorrentInfo) => TorrentInfo | void) {
  const torrents = store.get("torrents");
  const index = torrents.findIndex((torrent) => torrent.id === torrentId);
  if (index === -1) return null;

  const updated = updater(torrents[index]) || torrents[index];
  torrents[index] = updated;
  store.set("torrents", torrents);
  return updated;
}

function clearTorrentError(torrent: TorrentInfo): TorrentInfo {
  return {
    ...torrent,
    lastError: undefined,
  };
}

function getTorrentStartRequest(torrent: TorrentInfo, downloadPath: string): TorrentWorkerRequest | null {
  if (torrent.sourceType === "file" && torrent.sourceValue && fs.existsSync(torrent.sourceValue)) {
    return {
      type: "add-file",
      torrentId: torrent.id,
      filePath: torrent.sourceValue,
      downloadPath,
      announce: publicTrackers,
    };
  }

  const magnetUri = torrent.magnetUri || (torrent.sourceType === "magnet" ? torrent.sourceValue || "" : "");
  if (!magnetUri) return null;

  return {
    type: "add-magnet",
    torrentId: torrent.id,
    magnetUri,
    downloadPath,
    announce: publicTrackers,
  };
}

async function startStoredTorrent(torrent: TorrentInfo, nextStatus: TorrentInfo["status"] = "downloading") {
  const settings = store.get("settings");
  const request = getTorrentStartRequest(torrent, settings.downloadPath);
  if (!request) {
    throw new Error(
      torrent.sourceType === "file"
        ? "Torrent source file is missing. Re-add the .torrent file."
        : "Missing magnet metadata for this torrent."
    );
  }

  await callTorrentWorker(request);
  activeTorrentIds.add(torrent.id);
  updateStoredTorrent(torrent.id, (current) => ({
    ...clearTorrentError(current),
    status: nextStatus,
    path: path.join(settings.downloadPath, current.name),
  }));
}

export function setTorrentEventHandler(handler: (event: string, payload: unknown) => void) {
  onTorrentEvent = handler;
}

export function isTorrentReady(): boolean {
  return torrentWorkerReady;
}

export function getStreamServerPort(): number {
  return streamServerPort;
}

export function callTorrentWorker<T = unknown>(
  message: TorrentWorkerRequest,
  timeoutMs = 20000
): Promise<T> {
  if (!torrentWorker || !torrentWorkerReady) {
    return Promise.reject(new Error("Torrent support is not available."));
  }

  const requestId = uuidv4();
  const payload: TorrentWorkerEnvelope = { ...message, requestId };

  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingTorrentWorkerRequests.delete(requestId);
      reject(new Error("Torrent worker request timed out"));
    }, timeoutMs);

    pendingTorrentWorkerRequests.set(requestId, {
      resolve: (value) => resolve(value as T),
      reject,
      timeout,
    });

    const worker = torrentWorker;
    if (!worker) {
      clearTimeout(timeout);
      pendingTorrentWorkerRequests.delete(requestId);
      reject(new Error("Torrent worker is not available."));
      return;
    }

    worker.postMessage(payload);
  });
}

function handleTorrentWorkerEvent(event: string, payload: unknown) {
  if (!payload || typeof payload !== "object") return;

  if (event === "torrent-metadata") {
    const metadata = payload as TorrentMetadataPayload;
    const torrents = store.get("torrents");
    const index = torrents.findIndex((torrent) => torrent.id === metadata.id);
    if (index === -1) return;

    const settings = store.get("settings");
    const resolvedName = torrents[index].clientProvidedName
      ? torrents[index].name
      : metadata.name || torrents[index].name;
    torrents[index] = {
      ...clearTorrentError(torrents[index]),
      name: resolvedName,
      size: metadata.size || torrents[index].size,
      magnetUri: metadata.magnetUri || torrents[index].magnetUri,
      infoHash: metadata.infoHash || torrents[index].infoHash,
      path: path.join(settings.downloadPath, resolvedName),
    };
    store.set("torrents", torrents);
    onTorrentEvent?.("torrent-progress", torrents[index]);
    return;
  }

  if (event === "torrent-progress") {
    const progressPayload = payload as TorrentProgressPayload;
    const torrents = store.get("torrents");
    const index = torrents.findIndex((torrent) => torrent.id === progressPayload.id);
    if (index === -1) return;

    const settings = store.get("settings");
    torrents[index] = {
      ...clearTorrentError(torrents[index]),
      downloaded: progressPayload.downloaded || 0,
      uploaded: settings.enableSeeding ? (progressPayload.uploaded || 0) : 0,
      progress: progressPayload.progress || 0,
      downloadSpeed: progressPayload.downloadSpeed || 0,
      uploadSpeed: settings.enableSeeding ? (progressPayload.uploadSpeed || 0) : 0,
      peers: progressPayload.peers || 0,
      seeds: progressPayload.seeds || 0,
      size:
        typeof progressPayload.size === "number" && progressPayload.size > 0
          ? progressPayload.size
          : torrents[index].size,
      status: progressPayload.done
        ? "completed"
        : torrents[index].status === "paused"
          ? "paused"
          : "downloading",
    };
    store.set("torrents", torrents);
    onTorrentEvent?.("torrent-progress", torrents[index]);
    return;
  }

  if (event === "torrent-done") {
    const donePayload = payload as TorrentDonePayload;
    const torrents = store.get("torrents");
    const index = torrents.findIndex((torrent) => torrent.id === donePayload.id);
    if (index === -1) return;

    const settings = store.get("settings");
    torrents[index].progress = 1;
    torrents[index].status = settings.enableSeeding ? "seeding" : "completed";
    torrents[index].downloaded = torrents[index].size;
    torrents[index].downloadSpeed = 0;
    torrents[index].peers = 0;
    torrents[index].seeds = 0;
    if (!settings.enableSeeding) {
      torrents[index].uploaded = 0;
      torrents[index].uploadSpeed = 0;
      activeTorrentIds.delete(donePayload.id);
    } else {
      torrents[index].uploadSpeed = 0;
    }
    store.set("torrents", torrents);

    const library = store.get("library");
    const finalPath = torrents[index].path;
    if (!library.some((item) => item.path === finalPath)) {
      library.push({
        id: uuidv4(),
        name: torrents[index].name,
        path: finalPath,
        size: torrents[index].size,
        dateAdded: new Date().toISOString(),
        category: detectCategory(finalPath),
      });
      store.set("library", library);
    }

    onTorrentEvent?.("library-updated", library);
    onTorrentEvent?.("torrent-complete", torrents[index]);
    return;
  }

  if (event === "torrent-error") {
    const errorPayload = payload as TorrentErrorPayload;
    updateStoredTorrent(errorPayload.id, (torrent) => ({
      ...torrent,
      status: "error",
      lastError: errorPayload.error || "Torrent error",
      downloadSpeed: 0,
      uploadSpeed: 0,
    }));
    activeTorrentIds.delete(errorPayload.id);
    onTorrentEvent?.("torrent-error", {
      id: errorPayload.id,
      error: errorPayload.error || "Torrent error",
    });
  }
}

export async function initTorrentWorker(workerPath: string): Promise<void> {
  try {
    torrentWorker = utilityProcess.fork(workerPath, [], {
      serviceName: "limbo-torrent-engine",
      stdio: ["ignore", "inherit", "inherit"],
    });

    torrentWorker.on("message", (message: TorrentWorkerMessage) => {
      if (!message || typeof message !== "object") return;

      if (message.type === "ready") {
        torrentWorkerReady = !!message.ok;
        if (message.ok) {
          streamServerPort = message.streamServerPort || 0;
          console.log(`Torrent worker ready. Stream server on http://127.0.0.1:${streamServerPort}`);

          try {
            const torrents = store.get("torrents");
            for (const torrent of torrents) {
              if (torrent.status !== "downloading" && torrent.status !== "seeding") continue;
              startStoredTorrent(torrent, torrent.status).catch((error) => {
                console.warn("Failed to resume persisted torrent", error);
                updateStoredTorrent(torrent.id, (current) => ({
                  ...current,
                  status: "error",
                  lastError: error instanceof Error ? error.message : String(error),
                }));
              });
            }
          } catch (error) {
            console.warn("Failed to restore persisted torrents", error);
          }
        } else {
          console.warn("Torrent worker failed to initialize.", message.error);
        }
        return;
      }

      if (message.type === "response") {
        const pending = pendingTorrentWorkerRequests.get(message.requestId);
        if (!pending) return;
        clearTimeout(pending.timeout);
        pendingTorrentWorkerRequests.delete(message.requestId);
        if (message.ok) pending.resolve(message.data);
        else pending.reject(new Error(message.error || "Torrent worker request failed"));
        return;
      }

      if (message.type === "event") {
        handleTorrentWorkerEvent(message.event, message.payload);
      }
    });

    torrentWorker.on("exit", (code) => {
      console.warn("Torrent worker exited", code);
      torrentWorkerReady = false;
      torrentWorker = null;
    });

    const settings = store.get("settings");
    const streamToken = ensureApiToken();
    torrentWorker.postMessage({
      type: "init",
      enableSeeding: settings.enableSeeding,
      publicTrackers,
      streamToken,
    });
  } catch (error) {
    console.warn("Torrent worker failed to start. Torrent support disabled.", error);
    torrentWorkerReady = false;
    torrentWorker = null;
  }
}

export function updateTorrentSeeding(enableSeeding: boolean) {
  try {
    torrentWorker?.postMessage({ type: "set-seeding", enableSeeding });
  } catch (error) {
    console.warn("Failed to update torrent seeding", error);
  }
}

export async function resumeStoredTorrent(torrentId: string) {
  const torrent = store.get("torrents").find((item) => item.id === torrentId);
  if (!torrent) throw new Error("Torrent not found");
  await startStoredTorrent(torrent, torrent.status === "seeding" ? "seeding" : "downloading");
  return store.get("torrents").find((item) => item.id === torrentId) || torrent;
}

export async function pauseStoredTorrent(torrentId: string) {
  await callTorrentWorker({ type: "pause", torrentId });
  activeTorrentIds.delete(torrentId);
  return updateStoredTorrent(torrentId, (torrent) => ({
    ...clearTorrentError(torrent),
    status: "paused",
    downloadSpeed: 0,
    uploadSpeed: 0,
  }));
}

export async function removeStoredTorrent(torrentId: string, deleteFiles: boolean) {
  await callTorrentWorker({ type: "remove", torrentId, deleteFiles });
  activeTorrentIds.delete(torrentId);
  const torrents = store.get("torrents").filter((torrent) => torrent.id !== torrentId);
  store.set("torrents", torrents);
  return torrents;
}

export async function shutdownTorrentWorker(): Promise<void> {
  const worker = torrentWorker;
  if (!worker) return;

  try {
    if (torrentWorkerReady) {
      await callTorrentWorker({ type: "shutdown" }, 5000);
    }
  } catch (error) {
    console.warn("Torrent worker shutdown request failed", error);
  }

  torrentWorkerReady = false;
  streamServerPort = 0;

  for (const [requestId, pending] of pendingTorrentWorkerRequests) {
    clearTimeout(pending.timeout);
    pending.reject(new Error("Torrent worker shutting down"));
    pendingTorrentWorkerRequests.delete(requestId);
  }

  activeTorrentIds.clear();
  onTorrentEvent = null;
  torrentWorker = null;

  try {
    worker.kill();
  } catch (error) {
    console.warn("Failed to terminate torrent worker", error);
  }
}
