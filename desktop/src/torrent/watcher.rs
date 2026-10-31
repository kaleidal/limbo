use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use librqbit::{ManagedTorrent, TorrentStats};

use crate::events::TORRENT_UPDATED;
use crate::library;
use crate::state::AppState;
use crate::store::schema::{TorrentInfo, TorrentStatus};

const BYTES_PER_MEGABIT: f64 = 125_000.0;

/// Mirrors a torrent's progress into its record once a second, stops
/// finished torrents unless seeding is on, and adds finished downloads to the
/// library.
pub fn spawn(app: Arc<AppState>, id: String, handle: Arc<ManagedTorrent>) {
    app.clone().spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        loop {
            interval.tick().await;
            let Some(record) = app.torrent_engine.get(&app, &id).ok() else {
                break;
            };
            if handle.is_paused() {
                continue;
            }
            let stats = handle.stats();
            if stats.finished && !record.status.is_done() && record.client_id.is_none() {
                add_to_library(&app, &record, &handle).await;
            }
            let keeps_seeding =
                record.client_id.is_some() || app.store.with(|data| data.settings.enable_seeding);
            let status = if stats.error.is_some() {
                TorrentStatus::Error
            } else if stats.finished && keeps_seeding {
                TorrentStatus::Seeding
            } else if stats.finished {
                TorrentStatus::Completed
            } else {
                TorrentStatus::Downloading
            };
            if status == TorrentStatus::Completed
                && let Ok(session) = app.torrent_engine.session()
                && let Err(error) = session.pause(&handle).await
            {
                tracing::warn!(torrent_id = %id, %error, "failed to stop finished torrent");
            }
            let next = with_stats(record.clone(), &stats, status);
            if same_progress(&record, &next) {
                continue;
            }
            let persisted = if next.status == record.status {
                app.store.with_mut_volatile(|data| replace(data, &next));
                true
            } else {
                app.store.with_mut(|data| replace(data, &next)).is_ok()
            };
            if persisted {
                app.send(&TORRENT_UPDATED, &next);
            }
        }
    });
}

fn with_stats(mut info: TorrentInfo, stats: &TorrentStats, status: TorrentStatus) -> TorrentInfo {
    let (download_speed, upload_speed, peers) = match (&stats.live, status) {
        (Some(live), TorrentStatus::Downloading | TorrentStatus::Seeding) => (
            live.download_speed.mbps * BYTES_PER_MEGABIT,
            live.upload_speed.mbps * BYTES_PER_MEGABIT,
            live.snapshot.peer_stats.live,
        ),
        _ => (0.0, 0.0, 0),
    };
    info.size = stats.total_bytes;
    info.downloaded = stats.progress_bytes;
    info.uploaded = stats.uploaded_bytes;
    info.progress = if stats.total_bytes > 0 {
        stats.progress_bytes as f64 / stats.total_bytes as f64
    } else {
        0.0
    };
    info.download_speed = download_speed;
    info.upload_speed = upload_speed;
    info.peers = peers;
    info.status = status;
    info.last_error = stats.error.clone();
    info
}

fn same_progress(previous: &TorrentInfo, next: &TorrentInfo) -> bool {
    previous.status == next.status
        && previous.downloaded == next.downloaded
        && previous.uploaded == next.uploaded
        && previous.size == next.size
        && previous.peers == next.peers
        && previous.download_speed == next.download_speed
        && previous.upload_speed == next.upload_speed
}

fn replace(data: &mut crate::store::schema::StoreData, next: &TorrentInfo) {
    if let Some(item) = data.torrents.iter_mut().find(|item| item.id == next.id) {
        *item = next.clone();
    }
}

async fn add_to_library(app: &Arc<AppState>, record: &TorrentInfo, handle: &ManagedTorrent) {
    let Some(path) = content_path(app, record, handle) else {
        return;
    };
    let app = app.clone();
    let result = tokio::task::spawn_blocking(move || library::add(&app, &path)).await;
    if let Ok(Err(error)) = result {
        tracing::error!(%error, "failed to add torrent to library");
    }
}

/// The file a single-file torrent wrote, or the folder holding a multi-file
/// torrent's files.
fn content_path(app: &AppState, record: &TorrentInfo, handle: &ManagedTorrent) -> Option<PathBuf> {
    let metadata = handle.metadata.load();
    let files = &metadata.as_ref()?.file_infos;
    let folder = PathBuf::from(&record.path);
    match files.as_slice() {
        [single] => Some(folder.join(&single.relative_filename)),
        _ => {
            let download_root = app.store.with(|data| data.settings.download_path.clone());
            (folder.as_os_str() != download_root.as_str()).then_some(folder)
        }
    }
}
