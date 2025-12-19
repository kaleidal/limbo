# Limbo

Limbo is a Windows/macOS/Linux desktop app built with Electron + React that combines:

- Download manager
- Integrated browser with bookmarks
- Library view for downloaded content
- Optional magnet/torrent handling (via WebTorrent)

This project is intended for legitimate use cases only (e.g., downloading content you have rights/permission to access).

## Tech

- Electron (main + preload)
- Vite + React + TypeScript
- Tailwind + shadcn/ui

## Development

Prereqs:

- Node.js
- Bun (optional, but supported)

Install dependencies:

    bun install

Run the app (Vite + Electron):

    bun run dev:electron

## Build

Build renderer + Electron bundles:

    bun run build

Create an installer/package (electron-builder):

    bun run build:electron

## Auto-updates (electron-updater)

Auto-updates are enabled via electron-updater and use the electron-builder publish configuration in package.json.

Notes:

- Auto-update runs only in packaged builds (app.isPackaged === true).
- In development it is disabled.
- Updates are typically distributed via GitHub Releases (the build.publish configuration points to the repo).

## Associations

- magnet: URLs: the app registers as a protocol handler for magnet links.
- .torrent files: file association is configured via electron-builder.

## Troubleshooting

### Torrent support: node-datachannel native module

If torrent support fails to load due to node-datachannel, rebuilding it is often enough:

    npm rebuild node-datachannel

If it still fails:

    npx electron-rebuild

## License

No license has been specified yet.
