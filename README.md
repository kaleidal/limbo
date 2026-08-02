# Limbo

Limbo is a desktop software manager with an integrated browser, download manager, torrent client, Debrid integration, extraction pipeline, and library view. The UI is React + TypeScript. The desktop host is **Fenestra** (Rust).

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

- [Fenestra](https://github.com/Misoworks/Fenestra) (WebView2 on Windows, CEF on Linux)
- librqbit for torrents
- Vite + React 19 + TypeScript
- Tailwind CSS
- Base UI / shadcn-style components

## Legal Notice

Limbo is a general-purpose download and organization tool. It supports direct downloads, BitTorrent, Debrid services, and local file management.

Users are solely responsible for ensuring they have the legal right to access, download, and possess any content used with this application. Limbo does not host or provide infringing content.

## Development

### Prerequisites

- [Bun](https://bun.sh)
- Rust (stable, 1.89+)
- WebView2 Runtime on Windows

### Install

```bash
bun install
```

### Run

```bash
bun run dev:desktop
```

This runs the Rust host from `desktop/`. In debug builds it starts Vite (`bun run dev` on port 5177) and loads the UI in Fenestra.

To run only the Vite UI in a browser:

```bash
bun run dev
```

## Build

### Build Renderer

```bash
bun run build
```

### Build Desktop Host

```bash
bun run build:desktop
```

## Companion API

Limbo exposes a localhost HTTP API so other apps (for example Raffi) can add magnets and stream files without embedding a torrent client.

- Health: `GET http://127.0.0.1:17890/v1/health`
- Add torrent: `POST /v1/torrents` with `{ "magnet": "...", "fileIndex": 0, "sequential": true, "clientId": "raffi" }` and `Authorization: Bearer <token>`
- Status: `GET /v1/torrents/:id`
- Stream: `GET /v1/stream/:infoHash/:fileIndex?token=<token>` (Range requests supported)
- Discovery file under Limbo’s app data directory contains `{ port, token, baseUrl }`

Toggle the API under Settings → Torrent Settings → Companion API.

## Associations

Packaged builds register support for:

- `magnet:` links
- `.torrent` files

## License

This project is licensed under the MIT License. See [LICENSE](./LICENSE).
