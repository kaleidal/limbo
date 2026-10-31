use sabine::{BridgeEvent, SabineWindow};
use serde::Serialize;
use specta::Type;

use crate::api::approval::{ApprovalExpired, TorrentApprovalRequest};
use crate::store::schema::{Download, LibraryItem, TorrentInfo};

#[derive(Debug, Clone, Serialize, Type)]
pub struct Removed {
    pub id: String,
}

pub const DOWNLOAD_UPDATED: BridgeEvent<Download> = BridgeEvent::new("download.updated");
pub const DOWNLOAD_REMOVED: BridgeEvent<Removed> = BridgeEvent::new("download.removed");
pub const TORRENT_UPDATED: BridgeEvent<TorrentInfo> = BridgeEvent::new("torrent.updated");
pub const TORRENT_REMOVED: BridgeEvent<Removed> = BridgeEvent::new("torrent.removed");
pub const LIBRARY_UPDATED: BridgeEvent<Vec<LibraryItem>> = BridgeEvent::new("library.updated");
pub const CLIPBOARD_LINKS: BridgeEvent<Vec<String>> = BridgeEvent::new("clipboard.links");
pub const APPROVAL_REQUESTED: BridgeEvent<TorrentApprovalRequest> =
    BridgeEvent::new("approval.requested");
pub const APPROVAL_EXPIRED: BridgeEvent<ApprovalExpired> = BridgeEvent::new("approval.expired");

pub fn declare(window: SabineWindow) -> SabineWindow {
    window
        .bridge_event(&DOWNLOAD_UPDATED)
        .bridge_event(&DOWNLOAD_REMOVED)
        .bridge_event(&TORRENT_UPDATED)
        .bridge_event(&TORRENT_REMOVED)
        .bridge_event(&LIBRARY_UPDATED)
        .bridge_event(&CLIPBOARD_LINKS)
        .bridge_event(&APPROVAL_REQUESTED)
        .bridge_event(&APPROVAL_EXPIRED)
}
