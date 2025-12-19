// Electron-store setup for Limbo
import path from "path";
import { app } from "electron";
import Store from "electron-store";
export const store = new Store({
    defaults: {
        bookmarks: [
            {
                id: "1",
                name: "Internet Archive",
                url: "https://archive.org",
                favicon: "https://www.google.com/s2/favicons?domain=archive.org&sz=64",
            },
        ],
        library: [],
        downloads: [],
        torrents: [],
        settings: {
            downloadPath: path.join(app.getPath("downloads"), "Limbo"),
            maxConcurrentDownloads: 3,
            hardwareAcceleration: true,
            enableSeeding: false,
            startOnBoot: false,
            requireVpn: false,
            autoExtract: true,
            deleteArchiveAfterExtract: false,
            debrid: {
                service: null,
                apiKey: "",
            },
        },
    },
});
