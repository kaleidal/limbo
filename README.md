# Limbo

Limbo is a Windows/macOS/Linux desktop app built with Electron + React and is a software manager with integrated browser, download manager, and torrent client.

## Legal Notice

Limbo is a general-purpose download management tool. It supports:
- Direct HTTP/HTTPS downloads
- BitTorrent protocol (for legal torrents like Linux distributions, open source software, public domain media)
- Organization of downloaded files in a library view

**Users are solely responsible for ensuring they have legal rights to download and possess any content accessed through this application.** This tool does not host, link to, or endorse any infringing content.

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
