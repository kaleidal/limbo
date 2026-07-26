# Limbo

Limbo is a desktop software manager built with Electron, React, and TypeScript. It combines a browser, direct download manager, torrent client, Debrid integration, extraction pipeline, and library view into one app.

![Limbo preview](./preview.png)

## What It Does

- Direct HTTP/HTTPS downloads with queue management
- Torrent downloads from magnet links and `.torrent` files
- Real-Debrid, AllDebrid, Premiumize, and TorBox support for supported flows
- Embedded browser with bookmarks, popup blocking, and short-lived session memory
- Automatic archive extraction after download
- Local library for downloaded software, media, archives, and other files
- Magnet and `.torrent` file association support in packaged builds

## Tech Stack

- Electron
- Vite
- React 19
- TypeScript
- Tailwind CSS
- Base UI / shadcn-style components
- WebTorrent
- electron-store

## Legal Notice

Limbo is a general-purpose download and organization tool. It supports direct downloads, BitTorrent, Debrid services, and local file management.

Users are solely responsible for ensuring they have the legal right to access, download, and possess any content used with this application. Limbo does not host or provide infringing content.

## Development

### Prerequisites

- Node.js
- npm

### Install

```bash
npm install
```

### Run In Development

```bash
npm run dev:electron
```

This starts the Vite renderer and launches Electron against the local dev server.

## Build

### Build Renderer + Electron Bundles

```bash
npm run build
```

### Build Installers

```bash
npm run build:electron
```

Packaged builds are created with `electron-builder`.

## Auto Updates

Auto updates are handled with `electron-updater` and the `build.publish` configuration in `package.json`.

Notes:

- Auto update checks only run in packaged builds
- Development mode does not perform update checks
- Release distribution is configured for GitHub Releases

## Companion API

Limbo exposes a localhost HTTP API so other apps (for example Raffi) can add magnets and stream files without embedding a torrent client.

- Health: `GET http://127.0.0.1:17890/v1/health`
- Add torrent: `POST /v1/torrents` with `{ "magnet": "...", "fileIndex": 0, "sequential": true, "clientId": "raffi" }` and `Authorization: Bearer <token>`
- Status: `GET /v1/torrents/:id`
- Stream: `GET /v1/stream/:infoHash/:fileIndex?token=<token>` (Range requests supported)
- Discovery file: `%APPDATA%/limbo/api.json` (or Limbo userData) contains `{ port, token, baseUrl }`

Toggle the API under Settings → Torrent Settings → Companion API.

When an app adds a torrent, Limbo shows a system-wide approval prompt. Identity is resolved from the **localhost TCP peer** (process path + OS icon via Electron `getFileIcon`), not from fields the client sends. Self-reported names/icons are shown only as claims if they disagree. “Always allow” trusts that executable path.

## Associations

Packaged builds register support for:

- `magnet:` links
- `.torrent` files

## Troubleshooting

### Torrent Support

If Limbo’s API is up but torrents fail with `torrent engine is not ready`, or the log shows `Cannot find module ... node_datachannel.node`, the WebTorrent native binary is missing (common after `bun install`, which can skip install scripts).

```bash
bun run rebuild:native
```

That rebuilds Electron-ABI modules (`bufferutil`, `utf-8-validate`, `utp-native`) and ensures the `node-datachannel` N-API prebuild is present. Restart Limbo afterward.

## License

This project is licensed under the MIT License. See [LICENSE](./LICENSE).
