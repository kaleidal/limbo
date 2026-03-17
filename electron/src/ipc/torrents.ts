// Torrent IPC handlers

import { ipcMain, BrowserWindow, app } from "electron";
import path from "path";
import fs from "fs";
import os from "os";
import { v4 as uuidv4 } from "uuid";
import { store } from "../store.js";
import { isVpnConnected, parseMagnetDisplayName } from "../utils.js";
import {
  activeTorrentIds,
  callTorrentWorker,
  getStreamServerPort,
  isTorrentReady,
  pauseStoredTorrent,
  publicTrackers,
  removeStoredTorrent,
  resumeStoredTorrent,
} from "../torrent.js";
import type { TorrentInfo } from "../types.js";

type TorrentFileEntry = {
  index: number;
  name: string;
  path: string;
  length: number;
  downloaded: number;
  progress: number;
};

function setTorrentFailure(torrentId: string, error: unknown) {
  const torrents = store.get("torrents");
  const index = torrents.findIndex((torrent) => torrent.id === torrentId);
  if (index === -1) return;

  torrents[index] = {
    ...torrents[index],
    status: "error",
    lastError: error instanceof Error ? error.message : String(error),
    downloadSpeed: 0,
    uploadSpeed: 0,
  };
  store.set("torrents", torrents);
  activeTorrentIds.delete(torrentId);
}

function sanitizeRemoteTorrentFilename(url: string) {
  try {
    const parsed = new URL(url);
    const filename = path.basename(parsed.pathname) || "remote.torrent";
    return filename.toLowerCase().endsWith(".torrent") ? filename : `${filename}.torrent`;
  } catch {
    return "remote.torrent";
  }
}

function createStoredTorrentInfo(filePath: string, downloadPath: string): TorrentInfo {
  const fallbackName = path.basename(filePath).replace(/\.torrent$/i, "") || "Loading torrent...";

  return {
    id: uuidv4(),
    name: fallbackName,
    magnetUri: "",
    sourceType: "file",
    sourceValue: filePath,
    size: 0,
    downloaded: 0,
    uploaded: 0,
    progress: 0,
    downloadSpeed: 0,
    uploadSpeed: 0,
    peers: 0,
    seeds: 0,
    status: "downloading",
    path: path.join(downloadPath, fallbackName),
    infoHash: undefined,
  };
}

async function createTorrentFromFile(filePath: string, getMainWindow: () => BrowserWindow | null) {
  if (!isTorrentReady()) throw new Error("Torrent support is not available.");
  if (!fs.existsSync(filePath)) throw new Error("Torrent file not found");

  const settings = store.get("settings");
  if (settings.requireVpn && !isVpnConnected()) {
    throw new Error("VPN_REQUIRED");
  }

  if (!fs.existsSync(settings.downloadPath)) {
    fs.mkdirSync(settings.downloadPath, { recursive: true });
  }

  const torrentInfo = createStoredTorrentInfo(filePath, settings.downloadPath);
  activeTorrentIds.add(torrentInfo.id);

  const torrents = store.get("torrents");
  torrents.push(torrentInfo);
  store.set("torrents", torrents);
  getMainWindow()?.webContents.send("torrent-added", torrentInfo);

  try {
    await callTorrentWorker({
      type: "add-file",
      torrentId: torrentInfo.id,
      filePath,
      downloadPath: settings.downloadPath,
      announce: publicTrackers,
    });
  } catch (error) {
    setTorrentFailure(torrentInfo.id, error);
    throw error;
  }

  return torrentInfo;
}

export function registerTorrentHandlers(getMainWindow: () => BrowserWindow | null) {
  ipcMain.handle("get-torrents", () => store.get("torrents"));
  ipcMain.handle("is-torrent-supported", () => isTorrentReady());
  ipcMain.handle("check-vpn-status", () => isVpnConnected());
  ipcMain.handle("get-stream-server-port", () => getStreamServerPort());

  ipcMain.handle("add-torrent", async (_, magnetUri: string) => {
    if (!isTorrentReady()) throw new Error("Torrent support is not available.");

    const settings = store.get("settings");
    if (settings.requireVpn && !isVpnConnected()) {
      throw new Error("VPN_REQUIRED");
    }

    if (!fs.existsSync(settings.downloadPath)) {
      fs.mkdirSync(settings.downloadPath, { recursive: true });
    }

    const torrentId = uuidv4();
    const displayName = parseMagnetDisplayName(magnetUri) || "Loading torrent...";
    activeTorrentIds.add(torrentId);

    const torrentInfo: TorrentInfo = {
      id: torrentId,
      name: displayName,
      magnetUri,
      sourceType: "magnet",
      sourceValue: magnetUri,
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
    };

    const torrents = store.get("torrents");
    torrents.push(torrentInfo);
    store.set("torrents", torrents);
    getMainWindow()?.webContents.send("torrent-added", torrentInfo);

    try {
      await callTorrentWorker({
        type: "add-magnet",
        torrentId,
        magnetUri,
        downloadPath: settings.downloadPath,
        announce: publicTrackers,
      });
    } catch (error) {
      setTorrentFailure(torrentId, error);
      throw error;
    }

    return torrentInfo;
  });

  ipcMain.handle("pause-torrent", async (_, id: string) => {
    await pauseStoredTorrent(id);
  });

  ipcMain.handle("resume-torrent", async (_, id: string) => {
    await resumeStoredTorrent(id);
  });

  ipcMain.handle("pause-all-torrents", async () => {
    const torrents = store.get("torrents");
    for (const torrent of torrents) {
      if (torrent.status === "downloading" || torrent.status === "seeding") {
        await pauseStoredTorrent(torrent.id);
      }
    }
  });

  ipcMain.handle("resume-all-torrents", async () => {
    const torrents = store.get("torrents");
    for (const torrent of torrents) {
      if (torrent.status === "paused") {
        await resumeStoredTorrent(torrent.id);
      }
    }
  });

  ipcMain.handle("remove-torrent", async (_, id: string, deleteFiles: boolean) => {
    return removeStoredTorrent(id, deleteFiles);
  });

  ipcMain.handle("add-torrent-file", async (_, filePath: string) => {
    return createTorrentFromFile(filePath, getMainWindow);
  });

  ipcMain.handle("add-remote-torrent", async (_, url: string) => {
    const tempDirectory = path.join(app.getPath("temp"), "limbo-torrents");
    fs.mkdirSync(tempDirectory, { recursive: true });

    const filename = sanitizeRemoteTorrentFilename(url);
    const tempFilePath = path.join(tempDirectory, `${uuidv4()}-${filename}`);
    const response = await fetch(url, {
      headers: {
        "User-Agent": `Limbo/${app.getVersion()} (${os.platform()})`,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch torrent file (${response.status})`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) {
      throw new Error("Fetched torrent file was empty");
    }

    fs.writeFileSync(tempFilePath, buffer);
    return createTorrentFromFile(tempFilePath, getMainWindow);
  });

  ipcMain.handle("get-torrent-files", async (_, infoHash: string) => {
    if (!isTorrentReady()) return [];
    const files = await callTorrentWorker<TorrentFileEntry[]>({ type: "get-files", infoHash });
    const port = getStreamServerPort();
    return (files || []).map((file) => ({
      ...file,
      streamUrl: `http://127.0.0.1:${port}/stream/${infoHash}/${encodeURIComponent(file.name)}`,
    }));
  });
}
