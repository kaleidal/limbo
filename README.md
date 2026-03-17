# Limbo

Limbo is a desktop software manager built with Electron, React, and TypeScript. It combines a browser, direct download manager, torrent client, Debrid integration, extraction pipeline, and library view into one app.

![Limbo preview](./preview.png)

## What It Does

- Direct HTTP/HTTPS downloads with queue management
- Torrent downloads from magnet links and `.torrent` files
- Real-Debrid, AllDebrid, and Premiumize support for supported flows
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

## Associations

Packaged builds register support for:

- `magnet:` links
- `.torrent` files

## Troubleshooting

### Torrent Support

If torrent support fails because of a native dependency issue, try:

```bash
npx electron-rebuild
```

If you are working with a specific native module manually, rebuilding that module may also help.

## License

This project is licensed under the MIT License. See [LICENSE](./LICENSE).
