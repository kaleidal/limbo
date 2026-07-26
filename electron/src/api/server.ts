import fs from "fs";
import http from "http";
import path from "path";
import { URL } from "url";
import { v4 as uuidv4 } from "uuid";
import { app, BrowserWindow } from "electron";
import { store } from "../store.js";
import { isVpnConnected, magnetLabel } from "../utils.js";
import {
  activeTorrentIds,
  callTorrentWorker,
  getStreamServerPort,
  isTorrentReady,
  publicTrackers,
  removeStoredTorrent,
} from "../torrent.js";
import type { TorrentInfo } from "../types.js";
import {
  clearApiDiscovery,
  ensureApiToken,
  getApiPort,
  isApiEnabled,
  writeApiDiscovery,
} from "./discovery.js";
import { requestTorrentApproval } from "./approval.js";
import { LIMBO_API_VERSION, LIMBO_READY_BYTES, LIMBO_READY_PROGRESS } from "./constants.js";

function notifyMainUi(channel: string, payload: unknown) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      const url = win.webContents.getURL();
      if (url.includes("approval.html")) continue;
    } catch {
      // ignore
    }
    win.webContents.send(channel, payload);
  }
}

type ApiTorrentFile = {
  index: number;
  name: string;
  path: string;
  length: number;
  downloaded: number;
  progress: number;
};

type WorkerStatus = {
  id: string;
  infoHash?: string;
  name?: string;
  size?: number;
  downloaded?: number;
  progress?: number;
  downloadSpeed?: number;
  uploadSpeed?: number;
  peers?: number;
  seeds?: number;
  done?: boolean;
  selectedFileIndex?: number | null;
  files?: ApiTorrentFile[];
  contiguousBytes?: number;
  ready?: boolean;
  filePath?: string | null;
};

type JsonBody = Record<string, unknown> | unknown[] | null;

let apiServer: http.Server | null = null;
let apiPort = 0;
let apiToken = "";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
} as const;

function sendJson(res: http.ServerResponse, status: number, body: JsonBody) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    ...CORS_HEADERS,
  });
  res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parseJsonBody(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected JSON object body");
  }
  return parsed as Record<string, unknown>;
}

function extractBearer(req: http.IncomingMessage, url: URL): string | null {
  const header = req.headers.authorization;
  if (typeof header === "string") {
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (match?.[1]) return match[1].trim();
  }
  const queryToken = url.searchParams.get("token");
  return queryToken?.trim() || null;
}

function requireAuth(req: http.IncomingMessage, res: http.ServerResponse, url: URL): boolean {
  const token = extractBearer(req, url);
  if (!token || token !== apiToken) {
    sendJson(res, 401, { error: "Unauthorized" });
    return false;
  }
  return true;
}

function buildStreamUrl(infoHash: string, fileIndex: number): string {
  return `http://127.0.0.1:${apiPort}/v1/stream/${infoHash}/${fileIndex}?token=${encodeURIComponent(apiToken)}`;
}

function computeReady(file: ApiTorrentFile | undefined, done: boolean): boolean {
  if (done) return true;
  if (!file) return false;
  if (file.length <= 0) return false;
  if (file.downloaded >= Math.min(LIMBO_READY_BYTES, file.length)) return true;
  return file.progress >= LIMBO_READY_PROGRESS;
}

async function getWorkerStatus(torrentId: string): Promise<WorkerStatus | null> {
  try {
    return await callTorrentWorker<WorkerStatus>({ type: "get-status", torrentId }, 10000);
  } catch {
    return null;
  }
}

function toApiTorrent(torrent: TorrentInfo, status: WorkerStatus | null) {
  const infoHash = status?.infoHash || torrent.infoHash || "";
  const files = status?.files || [];
  const selectedFileIndex =
    status?.selectedFileIndex ??
    (typeof torrent.selectedFileIndex === "number" ? torrent.selectedFileIndex : null);
  const selected =
    selectedFileIndex != null
      ? files.find((file) => file.index === selectedFileIndex)
      : files.find((file) => file.name.match(/\.(mp4|mkv|avi|mov|webm|m4v)$/i)) || files[0];
  const done = Boolean(status?.done) || torrent.status === "completed" || torrent.status === "seeding";
  const ready = computeReady(selected, done);
  const progress = selected?.progress ?? status?.progress ?? torrent.progress;

  let stage: "metadata" | "downloading" | "ready" | "done" | "error" = "downloading";
  if (torrent.status === "error") stage = "error";
  else if (done) stage = "done";
  else if (ready) stage = "ready";
  else if (!infoHash || files.length === 0) stage = "metadata";

  const resolvedSelectedIndex =
    selectedFileIndex != null
      ? selectedFileIndex
      : typeof selected?.index === "number"
        ? selected.index
        : null;

  return {
    id: torrent.id,
    infoHash: infoHash || null,
    name: torrent.clientProvidedName
      ? torrent.name
      : status?.name || torrent.name,
    status: torrent.status,
    stage,
    progress,
    downloadSpeed: status?.downloadSpeed ?? torrent.downloadSpeed,
    uploadSpeed: status?.uploadSpeed ?? torrent.uploadSpeed,
    peers: status?.peers ?? torrent.peers,
    seeds: status?.seeds ?? torrent.seeds,
    size: selected?.length ?? status?.size ?? torrent.size,
    downloaded: selected?.downloaded ?? status?.downloaded ?? torrent.downloaded,
    files,
    selectedFileIndex: resolvedSelectedIndex,
    streamUrl:
      infoHash && resolvedSelectedIndex != null
        ? buildStreamUrl(infoHash, resolvedSelectedIndex)
        : null,
    filePath: status?.filePath ?? null,
    ready,
    contiguousBytes: status?.contiguousBytes ?? selected?.downloaded ?? 0,
    clientId: torrent.clientId ?? null,
    lastError: torrent.lastError ?? null,
  };
}

async function addTorrentFromApi(input: {
  magnet: string;
  fileIndex?: number | null;
  sequential?: boolean;
  name?: string | null;
  clientId?: string | null;
  clientName?: string | null;
  clientVersion?: string | null;
  clientIconDataUrl?: string | null;
  remotePort?: number;
}) {
  if (!isTorrentReady()) {
    throw new Error("Torrent support is not available.");
  }

  const settings = store.get("settings");
  if (settings.requireVpn && !isVpnConnected()) {
    throw new Error("VPN_REQUIRED");
  }

  const clientNameInput = typeof input.name === "string" ? input.name.trim() : "";
  const clientProvidedName = clientNameInput.length > 0;
  const displayName = clientProvidedName ? clientNameInput : magnetLabel(input.magnet);
  const selectedFileIndex =
    typeof input.fileIndex === "number" && Number.isFinite(input.fileIndex)
      ? Math.max(0, Math.floor(input.fileIndex))
      : null;
  const sequential = input.sequential !== false;
  const clientId = (input.clientId || "unknown").trim() || "unknown";
  const clientName = (input.clientName || clientId).trim() || clientId;

  const decision = await requestTorrentApproval({
    clientId,
    clientName,
    clientVersion: input.clientVersion || undefined,
    // Client icon is only a claim; approval UI prefers the verified process icon.
    clientIconDataUrl: input.clientIconDataUrl || undefined,
    magnet: input.magnet,
    displayName,
    fileIndex: selectedFileIndex,
    sequential,
    remotePort: input.remotePort,
  });

  if (!decision.approved) {
    const reason =
      decision.reason === "timeout"
        ? "Approval timed out"
        : decision.reason === "closed"
          ? "Approval dismissed"
          : "User denied the torrent request";
    throw new Error(`APPROVAL_DENIED: ${reason}`);
  }

  // Re-check VPN after the prompt in case it dropped while waiting.
  if (settings.requireVpn && !isVpnConnected()) {
    throw new Error("VPN_REQUIRED");
  }

  if (!fs.existsSync(settings.downloadPath)) {
    fs.mkdirSync(settings.downloadPath, { recursive: true });
  }

  const torrentId = uuidv4();

  const torrentInfo: TorrentInfo = {
    id: torrentId,
    name: displayName,
    magnetUri: input.magnet,
    sourceType: "magnet",
    sourceValue: input.magnet,
    size: 0,
    downloaded: 0,
    uploaded: 0,
    progress: 0,
    downloadSpeed: 0,
    uploadSpeed: 0,
    peers: 0,
    seeds: 0,
    status: "downloading",
    path: path.join(settings.downloadPath, displayName),
    infoHash: undefined,
    selectedFileIndex: selectedFileIndex ?? undefined,
    clientId,
    clientName,
    clientProvidedName,
    keepAlive: true,
  };

  const torrents = store.get("torrents");
  torrents.push(torrentInfo);
  store.set("torrents", torrents);
  activeTorrentIds.add(torrentId);
  notifyMainUi("torrent-added", torrentInfo);

  try {
    await callTorrentWorker({
      type: "add-magnet",
      torrentId,
      magnetUri: input.magnet,
      downloadPath: settings.downloadPath,
      announce: publicTrackers,
      keepAlive: true,
      selectedFileIndex,
      sequential,
    });
  } catch (error) {
    const next = store.get("torrents").map((torrent) =>
      torrent.id === torrentId
        ? {
            ...torrent,
            status: "error" as const,
            lastError: error instanceof Error ? error.message : String(error),
          }
        : torrent
    );
    store.set("torrents", next);
    activeTorrentIds.delete(torrentId);
    const failed = next.find((torrent) => torrent.id === torrentId);
    if (failed) notifyMainUi("torrent-progress", failed);
    throw error;
  }

  return torrentInfo;
}

async function waitForMetadata(torrentId: string, timeoutMs = 45000): Promise<TorrentInfo> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const torrent = store.get("torrents").find((item) => item.id === torrentId);
    if (!torrent) throw new Error("Torrent not found");
    if (torrent.status === "error") {
      throw new Error(torrent.lastError || "Torrent error");
    }
    if (torrent.infoHash) return torrent;

    const status = await getWorkerStatus(torrentId);
    if (status?.infoHash) {
      const torrents = store.get("torrents");
      const index = torrents.findIndex((item) => item.id === torrentId);
      if (index !== -1) {
        torrents[index] = {
          ...torrents[index],
          infoHash: status.infoHash,
          name: torrents[index].clientProvidedName
            ? torrents[index].name
            : status.name || torrents[index].name,
          size: status.size || torrents[index].size,
        };
        store.set("torrents", torrents);
        return torrents[index];
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for torrent metadata");
}

async function proxyStream(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  infoHash: string,
  fileIndex: number
) {
  const streamPort = getStreamServerPort();
  if (!streamPort) {
    sendJson(res, 503, { error: "Stream server unavailable" });
    return;
  }

  const target = `http://127.0.0.1:${streamPort}/stream/${infoHash}/${fileIndex}?token=${encodeURIComponent(apiToken)}`;
  const headers: Record<string, string> = {};
  if (req.headers.range) headers.Range = String(req.headers.range);
  if (req.headers["if-range"]) headers["If-Range"] = String(req.headers["if-range"]);

  const upstream = await fetch(target, { headers });
  res.statusCode = upstream.status;
  upstream.headers.forEach((value, key) => {
    if (key.toLowerCase() === "transfer-encoding") return;
    res.setHeader(key, value);
  });
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");

  if (!upstream.body) {
    res.end();
    return;
  }

  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        const canContinue = res.write(Buffer.from(value));
        if (!canContinue) {
          await new Promise<void>((resolve) => res.once("drain", resolve));
        }
      }
    }
    res.end();
  } catch (error) {
    console.warn("[limbo-api] stream proxy failed", error);
    try {
      res.destroy();
    } catch {
      // ignore
    }
  }
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  const host = req.headers.host || `127.0.0.1:${apiPort}`;
  const url = new URL(req.url || "/", `http://${host}`);
  const method = (req.method || "GET").toUpperCase();

  if (method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  if (method === "GET" && url.pathname === "/v1/health") {
    sendJson(res, 200, {
      ok: true,
      service: "limbo",
      version: app.getVersion(),
      apiVersion: LIMBO_API_VERSION,
      torrentReady: isTorrentReady(),
      apiTokenRequired: true,
    });
    return;
  }

  if (!requireAuth(req, res, url)) return;

  if (method === "GET" && url.pathname === "/v1/torrents") {
    const torrents = store.get("torrents");
    const payload = [];
    for (const torrent of torrents) {
      payload.push(toApiTorrent(torrent, await getWorkerStatus(torrent.id)));
    }
    sendJson(res, 200, { torrents: payload });
    return;
  }

  if (method === "POST" && url.pathname === "/v1/torrents") {
    const body = parseJsonBody(await readBody(req));
    const magnet = typeof body.magnet === "string" ? body.magnet.trim() : "";
    if (!magnet.startsWith("magnet:")) {
      sendJson(res, 400, { error: "magnet is required" });
      return;
    }

    const fileIndex =
      typeof body.fileIndex === "number"
        ? body.fileIndex
        : typeof body.fileIdx === "number"
          ? body.fileIdx
          : null;
    const clientId = typeof body.clientId === "string" ? body.clientId : null;
    const clientName = typeof body.clientName === "string" ? body.clientName : null;
    const clientVersion = typeof body.clientVersion === "string" ? body.clientVersion : null;
    const clientIconDataUrl =
      typeof body.clientIconDataUrl === "string" ? body.clientIconDataUrl : null;
    const name = typeof body.name === "string" ? body.name : null;
    const sequential = body.sequential !== false;

    let created;
    try {
      created = await addTorrentFromApi({
        magnet,
        fileIndex,
        sequential,
        name,
        clientId,
        clientName,
        clientVersion,
        clientIconDataUrl,
        remotePort: req.socket.remotePort,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "VPN_REQUIRED") {
        sendJson(res, 403, {
          error: "VPN_REQUIRED",
          message: "Limbo requires a VPN for torrents. Connect a VPN or disable the check in Settings.",
        });
        return;
      }
      if (message.startsWith("APPROVAL_DENIED")) {
        sendJson(res, 403, {
          error: "APPROVAL_DENIED",
          message: message.replace(/^APPROVAL_DENIED:\s*/, "") || "Request denied",
        });
        return;
      }
      throw error;
    }

    let torrent = created;
    try {
      torrent = await waitForMetadata(created.id);
    } catch (error) {
      // Metadata can still arrive later; return current state.
      console.warn("[limbo-api] metadata wait", error);
    }

    if (fileIndex != null) {
      try {
        await callTorrentWorker({
          type: "select-file",
          torrentId: torrent.id,
          fileIndex,
          sequential,
        });
        const torrents = store.get("torrents");
        const index = torrents.findIndex((item) => item.id === torrent.id);
        if (index !== -1) {
          torrents[index] = { ...torrents[index], selectedFileIndex: fileIndex };
          store.set("torrents", torrents);
          torrent = torrents[index];
        }
      } catch (error) {
        console.warn("[limbo-api] select-file failed", error);
      }
    }

    sendJson(res, 201, toApiTorrent(torrent, await getWorkerStatus(torrent.id)));
    return;
  }

  const torrentMatch = url.pathname.match(/^\/v1\/torrents\/([^/]+)(?:\/(select|events))?$/);
  if (torrentMatch) {
    const torrentId = decodeURIComponent(torrentMatch[1]);
    const action = torrentMatch[2] || null;
    const torrent = store.get("torrents").find((item) => item.id === torrentId);
    if (!torrent) {
      sendJson(res, 404, { error: "Torrent not found" });
      return;
    }

    if (method === "GET" && !action) {
      sendJson(res, 200, toApiTorrent(torrent, await getWorkerStatus(torrent.id)));
      return;
    }

    if (method === "POST" && action === "select") {
      const body = parseJsonBody(await readBody(req));
      const fileIndex =
        typeof body.fileIndex === "number"
          ? body.fileIndex
          : typeof body.fileIdx === "number"
            ? body.fileIdx
            : null;
      if (fileIndex == null) {
        sendJson(res, 400, { error: "fileIndex is required" });
        return;
      }
      const sequential = body.sequential !== false;
      await callTorrentWorker({
        type: "select-file",
        torrentId,
        fileIndex,
        sequential,
      });
      const torrents = store.get("torrents");
      const index = torrents.findIndex((item) => item.id === torrentId);
      if (index !== -1) {
        torrents[index] = { ...torrents[index], selectedFileIndex: fileIndex };
        store.set("torrents", torrents);
      }
      const updated = store.get("torrents").find((item) => item.id === torrentId)!;
      sendJson(res, 200, toApiTorrent(updated, await getWorkerStatus(torrentId)));
      return;
    }

    if (method === "GET" && action === "events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      res.write("\n");

      let closed = false;
      const writeEvent = async () => {
        if (closed) return;
        const current = store.get("torrents").find((item) => item.id === torrentId);
        if (!current) {
          res.write(`event: error\ndata: ${JSON.stringify({ error: "Torrent not found" })}\n\n`);
          return;
        }
        const payload = toApiTorrent(current, await getWorkerStatus(torrentId));
        const eventName =
          current.status === "error" ? "error" : payload.ready ? "ready" : "progress";
        res.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
      };

      const interval = setInterval(() => {
        void writeEvent();
      }, 1000);
      void writeEvent();

      req.on("close", () => {
        closed = true;
        clearInterval(interval);
      });
      return;
    }

    if (method === "DELETE" && !action) {
      const deleteFiles = url.searchParams.get("deleteFiles") === "true";
      await removeStoredTorrent(torrentId, deleteFiles);
      notifyMainUi("torrent-removed", { id: torrentId });
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  const streamMatch = url.pathname.match(/^\/v1\/stream\/([0-9a-fA-F]{40})\/(\d+)$/);
  if (method === "GET" && streamMatch) {
    await proxyStream(req, res, streamMatch[1].toLowerCase(), Number.parseInt(streamMatch[2], 10));
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

export function getApiServerPort(): number {
  return apiPort;
}

export function getApiToken(): string {
  return apiToken;
}

export async function startApiServer(): Promise<number | null> {
  if (!isApiEnabled()) {
    clearApiDiscovery();
    return null;
  }

  if (apiServer) return apiPort;

  apiToken = ensureApiToken();
  const preferredPort = getApiPort();

  apiServer = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      console.error("[limbo-api] request failed", error);
      if (!res.headersSent) {
        sendJson(res, 500, {
          error: error instanceof Error ? error.message : String(error),
        });
      } else {
        try {
          res.destroy();
        } catch {
          // ignore
        }
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" && preferredPort !== 0) {
        apiServer?.off("error", onError);
        apiServer?.listen(0, "127.0.0.1", () => resolve());
        return;
      }
      reject(error);
    };
    apiServer?.once("error", onError);
    apiServer?.listen(preferredPort, "127.0.0.1", () => {
      apiServer?.off("error", onError);
      resolve();
    });
  });

  const address = apiServer.address();
  apiPort = address && typeof address === "object" ? address.port : preferredPort;
  writeApiDiscovery(apiPort, apiToken);
  console.log(`Limbo API listening on http://127.0.0.1:${apiPort}/v1`);
  return apiPort;
}

export async function stopApiServer(): Promise<void> {
  const server = apiServer;
  apiServer = null;
  apiPort = 0;
  clearApiDiscovery();
  if (!server) return;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}
