use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use librqbit::api::TorrentIdOrHash;
use librqbit::{AddTorrent, AddTorrentOptions, ManagedTorrent, Session};
use parking_lot::Mutex;
use uuid::Uuid;

use crate::state::AppState;
use crate::store::schema::TorrentInfo;

#[derive(Debug, thiserror::Error)]
pub enum TorrentError {
    #[error("torrent engine not initialized")]
    NotInitialized,
    #[error("torrent not found: {0}")]
    NotFound(String),
    #[error("store error: {0}")]
    Store(#[from] crate::store::StoreError),
    #[error("{0}")]
    Message(String),
}

impl From<anyhow::Error> for TorrentError {
    fn from(err: anyhow::Error) -> Self {
        TorrentError::Message(err.to_string())
    }
}

#[derive(Debug, Clone)]
pub struct TorrentFile {
    pub index: usize,
    pub name: String,
    pub length: u64,
}

pub struct TorrentEngine {
    session: Mutex<Option<Arc<Session>>>,
    id_map: Mutex<HashMap<String, usize>>,
}

impl Default for TorrentEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl TorrentEngine {
    pub fn new() -> Self {
        Self {
            session: Mutex::new(None),
            id_map: Mutex::new(HashMap::new()),
        }
    }

    pub async fn init(&self, download_path: &str) -> Result<(), TorrentError> {
        std::fs::create_dir_all(download_path).map_err(|e| TorrentError::Message(e.to_string()))?;
        let session = Session::new(PathBuf::from(download_path)).await?;
        *self.session.lock() = Some(session);
        Ok(())
    }

    pub fn stream_port(&self) -> u16 {
        0
    }

    pub fn list(&self, app: &AppState) -> Vec<TorrentInfo> {
        app.store.with(|d| d.torrents.clone())
    }

    pub async fn add_magnet(
        &self,
        app: Arc<AppState>,
        magnet_uri: String,
        name: Option<String>,
    ) -> Result<TorrentInfo, TorrentError> {
        let add = AddTorrent::from_url(magnet_uri.clone());
        self.add(app, add, magnet_uri, name, true).await
    }

    pub async fn add_file_bytes(
        &self,
        app: Arc<AppState>,
        bytes: Vec<u8>,
        name: Option<String>,
    ) -> Result<TorrentInfo, TorrentError> {
        let add = AddTorrent::from_bytes(bytes);
        self.add(app, add, String::new(), name, false).await
    }

    async fn add(
        &self,
        app: Arc<AppState>,
        add: AddTorrent<'static>,
        source: String,
        name: Option<String>,
        is_magnet: bool,
    ) -> Result<TorrentInfo, TorrentError> {
        let session = self.session()?;
        let download_path = app.store.with(|d| d.settings.download_path.clone());
        let opts = AddTorrentOptions {
            output_folder: Some(download_path.clone()),
            ..Default::default()
        };

        let response = session.add_torrent(add, Some(opts)).await?;
        let Some(handle) = response.into_handle() else {
            return Err(TorrentError::Message("Torrent metadata could not be resolved".to_string()));
        };

        let limbo_id = Uuid::new_v4().to_string();
        self.id_map.lock().insert(limbo_id.clone(), handle.id());

        let display_name = name
            .clone()
            .unwrap_or_else(|| handle.name().unwrap_or_else(|| "Untitled torrent".to_string()));

        let info = TorrentInfo {
            id: limbo_id.clone(),
            name: display_name,
            magnet_uri: source,
            source_type: Some(if is_magnet { "magnet" } else { "file" }.to_string()),
            source_value: None,
            size: 0,
            downloaded: 0,
            uploaded: 0,
            progress: 0.0,
            download_speed: 0.0,
            upload_speed: 0.0,
            peers: 0,
            seeds: 0,
            status: "downloading".to_string(),
            path: download_path,
            info_hash: Some(handle.info_hash().as_string()),
            last_error: None,
            selected_file_index: None,
            client_id: None,
            client_name: None,
            client_provided_name: Some(name.is_some()),
            keep_alive: Some(true),
        };

        app.store.with_mut(|d| d.torrents.push(info.clone()))?;
        app.push_event("torrent-added", serde_json::to_value(&info).unwrap_or_default());
        spawn_progress_watcher(app, limbo_id, handle);
        Ok(info)
    }

    pub async fn pause(&self, id: &str) -> Result<(), TorrentError> {
        let session = self.session()?;
        let handle = self.handle_for(&session, id)?;
        session.pause(&handle).await?;
        Ok(())
    }

    pub async fn resume(&self, id: &str) -> Result<(), TorrentError> {
        let session = self.session()?;
        let handle = self.handle_for(&session, id)?;
        session.unpause(&handle).await?;
        Ok(())
    }

    pub async fn remove(&self, app: &AppState, id: &str, delete_files: bool) -> Result<(), TorrentError> {
        let session = self.session()?;
        let rqbit_id = self
            .id_map
            .lock()
            .remove(id)
            .ok_or_else(|| TorrentError::NotFound(id.to_string()))?;
        session.delete(TorrentIdOrHash::Id(rqbit_id), delete_files).await?;
        app.store.with_mut(|d| d.torrents.retain(|t| t.id != id))?;
        app.push_event("torrent-removed", serde_json::json!({ "id": id }));
        Ok(())
    }

    pub fn list_files(&self, id: &str) -> Result<Vec<TorrentFile>, TorrentError> {
        let session = self.session()?;
        let handle = self.handle_for(&session, id)?;
        let metadata = handle.metadata.load();
        let Some(meta) = metadata.as_ref() else {
            return Ok(Vec::new());
        };
        Ok(meta
            .file_infos
            .iter()
            .enumerate()
            .map(|(index, file)| TorrentFile {
                index,
                name: file.relative_filename.to_string_lossy().into_owned(),
                length: file.len,
            })
            .collect())
    }

    fn session(&self) -> Result<Arc<Session>, TorrentError> {
        self.session.lock().clone().ok_or(TorrentError::NotInitialized)
    }

    fn handle_for(&self, session: &Arc<Session>, id: &str) -> Result<Arc<ManagedTorrent>, TorrentError> {
        let rqbit_id = *self
            .id_map
            .lock()
            .get(id)
            .ok_or_else(|| TorrentError::NotFound(id.to_string()))?;
        session
            .get(TorrentIdOrHash::Id(rqbit_id))
            .ok_or_else(|| TorrentError::NotFound(id.to_string()))
    }
}

fn spawn_progress_watcher(app: Arc<AppState>, limbo_id: String, handle: Arc<ManagedTorrent>) {
    app.runtime.clone().spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let stats = handle.stats();

            let (download_speed, upload_speed, peers) = stats
                .live
                .as_ref()
                .map(|live| {
                    (
                        live.download_speed.mbps * 125_000.0,
                        live.upload_speed.mbps * 125_000.0,
                        live.snapshot.peer_stats.live as u32,
                    )
                })
                .unwrap_or((0.0, 0.0, 0));

            let status = if stats.error.is_some() {
                "error"
            } else if stats.finished {
                "completed"
            } else {
                "downloading"
            };

            let progress = if stats.total_bytes > 0 {
                stats.progress_bytes as f64 / stats.total_bytes as f64
            } else {
                0.0
            };

            let updated = app
                .store
                .with_mut(|d| {
                    let item = d.torrents.iter_mut().find(|t| t.id == limbo_id)?;
                    item.size = stats.total_bytes;
                    item.downloaded = stats.progress_bytes;
                    item.uploaded = stats.uploaded_bytes;
                    item.progress = progress;
                    item.download_speed = download_speed;
                    item.upload_speed = upload_speed;
                    item.peers = peers;
                    item.seeds = peers;
                    item.status = status.to_string();
                    item.last_error = stats.error.clone();
                    Some(item.clone())
                })
                .ok()
                .flatten();

            let Some(info) = updated else {
                break;
            };
            app.push_event("torrent-progress", serde_json::to_value(&info).unwrap_or_default());

            if stats.finished || stats.error.is_some() {
                break;
            }
        }
    });
}
