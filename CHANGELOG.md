# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2025-12-25

### Added
- Downloads: **Persistent queue system** – all added links appear immediately as "Pending" and are processed by backend queue logic.
- Downloads: **Cancel All** button to clear all active/pending downloads.
- Downloads: **Cancel Group** button on each download group header.
- Downloads: **Grouped Downloads** - downloads are now grouped by URL and filename, making it easier to manage and cancel multiple downloads at once.
- Downloads: **Batch Add** button to add multiple links at once.

### Changed
- Downloads: Queue now enforces `maxConcurrentDownloads` setting by pausing excess downloads and resuming when slots open.
- Downloads: Improved concurrency counting to include "in-flight" downloads (marked as downloading but not yet started by browser).
- Downloads: Filenames now display full part numbers (e.g. `.part01.rar`) instead of being stripped.
- Downloads: Cancelled downloads are immediately removed from memory cache to prevent resurrection.
- Downloads: Store download progress in memory cache instead of writing every progress byte to disk.

### Fixed
- Real-Debrid: Fixed refresh token expiration handling.

## [1.1.3] - 2025-12-22

### Added
- Real-Debrid: **Device linking** flow (no manual API token required), including in-app status and controls (**Linked**, **Re-link**, **Unlink**).
- Settings: Real-Debrid token field is hidden by default when linked (optional reveal).

### Changed
- Downloads: aligned main-process download progress events with renderer expectations to prevent invalid progress displays.

### Fixed
- Downloads UI: prevent `NaN%` progress and invalid size rendering when total size is missing/unknown.
- Downloads: fixed download completion event naming mismatch so completion updates fire reliably.
- Library: fixed category detection using the wrong path (prevented ENOENT/stat errors on completed downloads).
- Extraction: fixed extract worker initialization and message handling (no longer crashes due to missing `workerData`).
- Downloads UI: show extraction state and display a completion/failure message after extraction finishes.

## [1.1.2] - 2025-12-22

### Added
- Settings: **Clear Data** action to reset app state while preserving bookmarks.
- Debrid: ability to fetch and display **supported hosters** from the configured provider.

### Changed
- Downloads: download save path is now enforced early and the download directory is created automatically when missing.
- Downloads/Torrents UI: reduced flicker by stabilizing updates (memoized list items, callback stabilization) and preventing duplicate entries from being added to state.

### Fixed
- Downloads: avoid prompting for a save location by ensuring a save path is set consistently across sessions.
- State corruption recovery: added a one-click way to clear stuck downloads/torrents/library without wiping bookmarks.

---

## Notes
- “Clear Data” preserves bookmarks; bookmarks can still be reset separately via the existing reset option.
