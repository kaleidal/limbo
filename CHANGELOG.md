# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
