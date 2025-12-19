// Torrent IPC handlers
import { ipcMain } from "electron";
import path from "path";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import { store } from "../store.js";
import { isVpnConnected, parseMagnetDisplayName } from "../utils.js";
import { callTorrentWorker, isTorrentReady, getStreamServerPort, activeTorrentIds, publicTrackers, } from "../torrent.js";
export function registerTorrentHandlers(getMainWindow) {
    ipcMain.handle("get-torrents", () => store.get("torrents"));
    ipcMain.handle("is-torrent-supported", () => isTorrentReady());
    ipcMain.handle("check-vpn-status", () => isVpnConnected());
    ipcMain.handle("get-stream-server-port", () => getStreamServerPort());
    ipcMain.handle("add-torrent", async (_, magnetUri) => {
        if (!isTorrentReady())
            throw new Error("Torrent support is not available.");
        const settings = store.get("settings");
        if (settings.requireVpn && !isVpnConnected()) {
            throw new Error("VPN_REQUIRED");
        }
        if (!fs.existsSync(settings.downloadPath)) {
            fs.mkdirSync(settings.downloadPath, { recursive: true });
        }
        const torrentId = uuidv4();
        const displayName = parseMagnetDisplayName(magnetUri) || "Loading torrent…";
        activeTorrentIds.add(torrentId);
        const torrentInfo = {
            id: torrentId,
            name: displayName,
            magnetUri,
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
        await callTorrentWorker({
            type: "add-magnet",
            torrentId,
            magnetUri,
            downloadPath: settings.downloadPath,
            announce: publicTrackers,
        });
        return torrentInfo;
    });
    ipcMain.handle("pause-torrent", (_, id) => {
        callTorrentWorker({ type: "pause", torrentId: id }).catch(() => { });
        const torrents = store.get("torrents");
        const idx = torrents.findIndex((t) => t.id === id);
        if (idx !== -1) {
            torrents[idx].status = "paused";
            store.set("torrents", torrents);
        }
    });
    ipcMain.handle("resume-torrent", (_, id) => {
        callTorrentWorker({ type: "resume", torrentId: id }).catch(() => { });
        const torrents = store.get("torrents");
        const idx = torrents.findIndex((t) => t.id === id);
        if (idx !== -1) {
            torrents[idx].status = "downloading";
            store.set("torrents", torrents);
        }
    });
    ipcMain.handle("pause-all-torrents", () => {
        const torrents = store.get("torrents");
        for (const t of torrents) {
            if (t.status === "downloading") {
                callTorrentWorker({ type: "pause", torrentId: t.id }).catch(() => { });
                t.status = "paused";
            }
        }
        store.set("torrents", torrents);
    });
    ipcMain.handle("resume-all-torrents", () => {
        const torrents = store.get("torrents");
        for (const t of torrents) {
            if (t.status === "paused") {
                callTorrentWorker({ type: "resume", torrentId: t.id }).catch(() => { });
                t.status = "downloading";
            }
        }
        store.set("torrents", torrents);
    });
    ipcMain.handle("remove-torrent", (_, id, deleteFiles) => {
        callTorrentWorker({ type: "remove", torrentId: id, deleteFiles }).catch(() => { });
        activeTorrentIds.delete(id);
        const torrents = store.get("torrents").filter((t) => t.id !== id);
        store.set("torrents", torrents);
        return torrents;
    });
    ipcMain.handle("add-torrent-file", async (_, filePath) => {
        if (!isTorrentReady())
            throw new Error("Torrent support is not available.");
        if (!fs.existsSync(filePath))
            throw new Error("Torrent file not found");
        const settings = store.get("settings");
        if (settings.requireVpn && !isVpnConnected()) {
            throw new Error("VPN_REQUIRED");
        }
        if (!fs.existsSync(settings.downloadPath)) {
            fs.mkdirSync(settings.downloadPath, { recursive: true });
        }
        const torrentId = uuidv4();
        const fallbackName = path.basename(filePath).replace(/\.torrent$/i, "") || "Loading torrent…";
        activeTorrentIds.add(torrentId);
        const torrentInfo = {
            id: torrentId,
            name: fallbackName,
            magnetUri: "",
            size: 0,
            downloaded: 0,
            uploaded: 0,
            progress: 0,
            downloadSpeed: 0,
            uploadSpeed: 0,
            peers: 0,
            seeds: 0,
            status: "downloading",
            path: path.join(settings.downloadPath, fallbackName),
            infoHash: undefined,
        };
        const torrents = store.get("torrents");
        torrents.push(torrentInfo);
        store.set("torrents", torrents);
        getMainWindow()?.webContents.send("torrent-added", torrentInfo);
        await callTorrentWorker({
            type: "add-file",
            torrentId,
            filePath,
            downloadPath: settings.downloadPath,
            announce: publicTrackers,
        });
        return torrentInfo;
    });
    ipcMain.handle("get-torrent-files", async (_, infoHash) => {
        if (!isTorrentReady())
            return [];
        const files = await callTorrentWorker({ type: "get-files", infoHash });
        const port = getStreamServerPort();
        return (files || []).map((file) => ({
            ...file,
            streamUrl: `http://127.0.0.1:${port}/stream/${infoHash}/${encodeURIComponent(file.name)}`,
        }));
    });
}
