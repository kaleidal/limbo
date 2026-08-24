use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU16, Ordering};
use std::time::Duration;

use librqbit::api::TorrentIdOrHash;
use librqbit::http_api::{HttpApi, HttpApiOptions};
use librqbit::{
    AddTorrent, AddTorrentOptions, Api, ManagedTorrent, Session, SessionOptions,
    SessionPersistenceConfig, TorrentStats,
};
use parking_lot::Mutex;
use tokio::sync::Mutex as AsyncMutex;
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

pub struct CompanionTorrentOptions {
    pub name: Option<String>,
    pub selected_file_index: Option<usize>,
    pub client_id: Option<String>,
    pub client_name: Option<String>,
}

pub struct TorrentEngine {
    session: Mutex<Option<Arc<Session>>>,
    id_map: Mutex<HashMap<String, usize>>,
    stream_port: AtomicU16,
    state_dir: Mutex<Option<PathBuf>>,
    add_lock: AsyncMutex<()>,
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
            stream_port: AtomicU16::new(0),
            state_dir: Mutex::new(None),
            add_lock: AsyncMutex::new(()),
        }
    }

    pub async fn init(
        &self,
        app: Arc<AppState>,
        download_path: &str,
        state_dir: PathBuf,
    ) -> Result<(), TorrentError> {
        tokio::fs::create_dir_all(download_path)
            .await
            .map_err(|error| TorrentError::Message(error.to_string()))?;
        tokio::fs::create_dir_all(&state_dir)
            .await
            .map_err(|error| TorrentError::Message(error.to_string()))?;
        let session = Session::new_with_opts(
            PathBuf::from(download_path),
            SessionOptions {
                fastresume: true,
                persistence: Some(SessionPersistenceConfig::Json {
                    folder: Some(state_dir.clone()),
                }),
                ..Default::default()
            },
        )
        .await?;
        *self.state_dir.lock() = Some(state_dir);
        *self.session.lock() = Some(session.clone());
        self.restore_records(app.clone(), &session).await?;
        self.start_stream_server(session).await?;
        Ok(())
    }

    async fn restore_records(
        &self,
        app: Arc<AppState>,
        session: &Arc<Session>,
    ) -> Result<(), TorrentError> {
        let restored = session.with_torrents(|items| {
            items
                .map(|(id, handle)| (id, handle.clone(), handle.info_hash().as_string()))
                .collect::<Vec<_>>()
        });
        let records = app.store.with(|data| data.torrents.clone());
        for record in records {
            if let Some((id, handle, _)) = restored
                .iter()
                .find(|(_, _, hash)| record.info_hash.as_deref() == Some(hash))
            {
                self.id_map.lock().insert(record.id.clone(), *id);
                spawn_progress_watcher(app.clone(), record.id, handle.clone());
                continue;
            }
            let add = match record.source_type.as_deref() {
                Some("magnet") if !record.magnet_uri.is_empty() => {
                    AddTorrent::from_url(record.magnet_uri.clone())
                }
                Some("file") => {
                    let Some(source) = record.source_value.as_deref() else {
                        continue;
                    };
                    match tokio::fs::read(source).await {
                        Ok(bytes) => AddTorrent::from_bytes(bytes),
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                            app.store.with_mut(|data| {
                                data.torrents.retain(|item| item.id != record.id)
                            })?;
                            app.push_event(
                                "torrent-removed",
                                serde_json::json!({ "id": record.id }),
                            );
                            continue;
                        }
                        Err(error) => {
                            tracing::error!(torrent_id = %record.id, %error, "failed to read torrent source during restore");
                            continue;
                        }
                    }
                }
                _ => continue,
            };
            let opts = AddTorrentOptions {
                output_folder: Some(record.path.clone()),
                ..Default::default()
            };
            match session.add_torrent(add, Some(opts)).await {
                Ok(response) => {
                    if let Some(handle) = response.into_handle() {
                        self.id_map.lock().insert(record.id.clone(), handle.id());
                        let hash = handle.info_hash().as_string();
                        app.store.with_mut(|data| {
                            if let Some(item) =
                                data.torrents.iter_mut().find(|item| item.id == record.id)
                            {
                                item.info_hash = Some(hash);
                            }
                        })?;
                        spawn_progress_watcher(app.clone(), record.id, handle);
                    }
                }
                Err(error) => {
                    tracing::error!(torrent_id = %record.id, %error, "failed to restore torrent")
                }
            }
        }
        Ok(())
    }

    async fn start_stream_server(&self, session: Arc<Session>) -> Result<(), TorrentError> {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|error| TorrentError::Message(error.to_string()))?;
        let port = listener
            .local_addr()
            .map_err(|error| TorrentError::Message(error.to_string()))?
            .port();
        let server = HttpApi::new(
            Api::new(session, None, None),
            Some(HttpApiOptions {
                read_only: true,
                basic_auth: None,
            }),
        );
        tokio::spawn(async move {
            if let Err(error) = server.make_http_api_and_run(listener, None).await {
                tracing::error!(%error, "torrent stream server stopped");
            }
        });
        self.stream_port.store(port, Ordering::Release);
        Ok(())
    }

    pub fn stream_port(&self) -> u16 {
        self.stream_port.load(Ordering::Acquire)
    }

    pub fn is_ready(&self) -> bool {
        self.session.lock().is_some() && self.stream_port() > 0
    }

    pub fn list(&self, app: &AppState) -> Vec<TorrentInfo> {
        app.store.with(|data| data.torrents.clone())
    }

    pub async fn add_magnet(
        &self,
        app: Arc<AppState>,
        magnet_uri: String,
        name: Option<String>,
    ) -> Result<TorrentInfo, TorrentError> {
        self.add(
            app,
            AddTorrent::from_url(magnet_uri.clone()),
            magnet_uri,
            name,
            true,
            None,
            None,
        )
        .await
    }

    pub async fn add_file_bytes(
        &self,
        app: Arc<AppState>,
        bytes: Vec<u8>,
        name: Option<String>,
    ) -> Result<TorrentInfo, TorrentError> {
        self.add(
            app,
            AddTorrent::from_bytes(bytes.clone()),
            String::new(),
            name,
            false,
            Some(bytes),
            None,
        )
        .await
    }

    pub async fn add_companion_magnet(
        &self,
        app: Arc<AppState>,
        magnet_uri: String,
        options: CompanionTorrentOptions,
    ) -> Result<TorrentInfo, TorrentError> {
        let requested_name = options.name.clone();
        let info = self
            .add(
                app.clone(),
                AddTorrent::from_url(magnet_uri.clone()),
                magnet_uri,
                options.name,
                true,
                None,
                options.selected_file_index.map(|index| vec![index]),
            )
            .await?;
        app.store.with_mut(|data| {
            let item = data
                .torrents
                .iter_mut()
                .find(|item| item.id == info.id)
                .ok_or_else(|| TorrentError::NotFound(info.id.clone()))?;
            item.selected_file_index = options.selected_file_index.map(|index| index as i64);
            item.client_id = options.client_id;
            item.client_name = options.client_name;
            if let Some(name) = requested_name {
                item.name = name;
                item.client_provided_name = Some(true);
            }
            item.keep_alive = Some(true);
            Ok::<_, TorrentError>(item.clone())
        })?
    }

    async fn add(
        &self,
        app: Arc<AppState>,
        add: AddTorrent<'static>,
        source: String,
        name: Option<String>,
        is_magnet: bool,
        source_bytes: Option<Vec<u8>>,
        only_files: Option<Vec<usize>>,
    ) -> Result<TorrentInfo, TorrentError> {
        let _guard = self.add_lock.lock().await;
        let session = self.session()?;
        let download_path = app.store.with(|data| data.settings.download_path.clone());
        let response = session
            .add_torrent(
                add,
                Some(AddTorrentOptions {
                    output_folder: Some(download_path.clone()),
                    only_files,
                    ..Default::default()
                }),
            )
            .await?;
        let Some(handle) = response.into_handle() else {
            return Err(TorrentError::Message(
                "Torrent metadata could not be resolved".to_string(),
            ));
        };
        let info_hash = handle.info_hash().as_string();
        if let Some(existing) = app.store.with(|data| {
            data.torrents
                .iter()
                .find(|item| item.info_hash.as_deref() == Some(&info_hash))
                .cloned()
        }) {
            let watcher_needed = self
                .id_map
                .lock()
                .insert(existing.id.clone(), handle.id())
                .is_none();
            if watcher_needed {
                spawn_progress_watcher(app, existing.id.clone(), handle);
            }
            return Ok(existing);
        }

        let source_value = if let Some(bytes) = source_bytes {
            let state_dir = self
                .state_dir
                .lock()
                .clone()
                .ok_or(TorrentError::NotInitialized)?;
            let metainfo_dir = state_dir.join("metainfo");
            tokio::fs::create_dir_all(&metainfo_dir)
                .await
                .map_err(|error| TorrentError::Message(error.to_string()))?;
            let path = metainfo_dir.join(format!("{info_hash}.torrent"));
            tokio::fs::write(&path, bytes)
                .await
                .map_err(|error| TorrentError::Message(error.to_string()))?;
            Some(path.to_string_lossy().into_owned())
        } else {
            None
        };
        let limbo_id = Uuid::new_v4().to_string();
        self.id_map.lock().insert(limbo_id.clone(), handle.id());
        let info = TorrentInfo {
            id: limbo_id.clone(),
            name: name.clone().unwrap_or_else(|| {
                handle
                    .name()
                    .unwrap_or_else(|| "Untitled torrent".to_string())
            }),
            magnet_uri: source,
            source_type: Some(if is_magnet { "magnet" } else { "file" }.to_string()),
            source_value,
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
            info_hash: Some(info_hash),
            last_error: None,
            selected_file_index: None,
            client_id: None,
            client_name: None,
            client_provided_name: Some(name.is_some()),
            keep_alive: Some(true),
        };
        app.store
            .with_mut(|data| data.torrents.push(info.clone()))?;
        app.push_event(
            "torrent-added",
            serde_json::to_value(&info).unwrap_or_default(),
        );
        spawn_progress_watcher(app, limbo_id, handle);
        Ok(info)
    }

    pub async fn pause(&self, app: &AppState, id: &str) -> Result<(), TorrentError> {
        let session = self.session()?;
        let handle = self.handle_for(&session, id)?;
        session.pause(&handle).await?;
        self.set_status(app, id, "paused")
    }

    pub async fn resume(&self, app: &AppState, id: &str) -> Result<(), TorrentError> {
        let session = self.session()?;
        let handle = self.handle_for(&session, id)?;
        session.unpause(&handle).await?;
        self.set_status(app, id, "downloading")
    }

    fn set_status(&self, app: &AppState, id: &str, status: &str) -> Result<(), TorrentError> {
        let info = app.store.with_mut(|data| {
            let item = data
                .torrents
                .iter_mut()
                .find(|item| item.id == id)
                .ok_or_else(|| TorrentError::NotFound(id.to_string()))?;
            item.status = status.to_string();
            Ok::<_, TorrentError>(item.clone())
        })??;
        app.push_event(
            "torrent-progress",
            serde_json::to_value(info).unwrap_or_default(),
        );
        Ok(())
    }

    pub async fn remove(
        &self,
        app: &AppState,
        id: &str,
        delete_files: bool,
    ) -> Result<(), TorrentError> {
        let rqbit_id = self.id_map.lock().remove(id);
        let session = self.session.lock().clone();
        if let (Some(session), Some(rqbit_id)) = (session, rqbit_id) {
            session
                .delete(TorrentIdOrHash::Id(rqbit_id), delete_files)
                .await?;
        }
        app.store
            .with_mut(|data| data.torrents.retain(|item| item.id != id))?;
        app.push_event("torrent-removed", serde_json::json!({ "id": id }));
        Ok(())
    }

    pub fn get(&self, app: &AppState, id: &str) -> Result<TorrentInfo, TorrentError> {
        app.store
            .with(|data| data.torrents.iter().find(|item| item.id == id).cloned())
            .ok_or_else(|| TorrentError::NotFound(id.to_string()))
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

    pub fn stream(
        &self,
        id: &str,
        file_index: usize,
    ) -> Result<
        (
            impl tokio::io::AsyncRead + tokio::io::AsyncSeek + Unpin + Send + 'static,
            u64,
        ),
        TorrentError,
    > {
        let session = self.session()?;
        let stream = self
            .handle_for(&session, id)?
            .stream(file_index)
            .map_err(|error| TorrentError::Message(error.to_string()))?;
        let length = stream.len();
        Ok((stream, length))
    }

    pub fn stats(&self, id: &str) -> Result<TorrentStats, TorrentError> {
        let session = self.session()?;
        Ok(self.handle_for(&session, id)?.stats())
    }

    pub fn prime_file(&self, id: &str, file_index: usize, bytes: u64) -> Result<(), TorrentError> {
        let (mut stream, length) = self.stream(id, file_index)?;
        tokio::spawn(async move {
            use tokio::io::AsyncReadExt;

            let mut remaining = bytes.min(length);
            let mut buffer = vec![0_u8; 64 * 1024];
            while remaining > 0 {
                let count = buffer.len().min(remaining as usize);
                match stream.read(&mut buffer[..count]).await {
                    Ok(0) | Err(_) => break,
                    Ok(read) => remaining -= read as u64,
                }
            }
        });
        Ok(())
    }

    pub async fn select_file(&self, id: &str, file_index: usize) -> Result<(), TorrentError> {
        let session = self.session()?;
        let handle = self.handle_for(&session, id)?;
        session
            .update_only_files(&handle, &[file_index].into_iter().collect())
            .await?;
        Ok(())
    }

    fn session(&self) -> Result<Arc<Session>, TorrentError> {
        self.session
            .lock()
            .clone()
            .ok_or(TorrentError::NotInitialized)
    }

    fn handle_for(
        &self,
        session: &Arc<Session>,
        id: &str,
    ) -> Result<Arc<ManagedTorrent>, TorrentError> {
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
            if !app
                .store
                .with(|data| data.torrents.iter().any(|item| item.id == limbo_id))
            {
                break;
            }
            if handle.is_paused() {
                continue;
            }
            let stats = handle.stats();
            let (download_speed, upload_speed, peers) = stats.live.as_ref().map(|live| (
                live.download_speed.mbps * 125_000.0,
                live.upload_speed.mbps * 125_000.0,
                live.snapshot.peer_stats.live as u32,
            )).unwrap_or((0.0, 0.0, 0));
            let status = if stats.error.is_some() { "error" } else if stats.finished { "completed" } else { "downloading" };
            let progress = if stats.total_bytes > 0 { stats.progress_bytes as f64 / stats.total_bytes as f64 } else { 0.0 };
            let terminal = stats.finished || stats.error.is_some();
            let update = |data: &mut crate::store::schema::StoreData| {
                let item = data.torrents.iter_mut().find(|item| item.id == limbo_id)?;
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
            };
            let updated = if terminal {
                app.store.with_mut(update)
            } else {
                Ok(app.store.with_mut_volatile(update))
            };
            let info = match updated {
                Ok(Some(info)) => info,
                Ok(None) => break,
                Err(error) => {
                    tracing::error!(torrent_id = %limbo_id, %error, "failed to persist torrent progress");
                    continue;
                }
            };
            app.push_event("torrent-progress", serde_json::to_value(&info).unwrap_or_default());
            if stats.finished {
                app.push_event("torrent-complete", serde_json::to_value(&info).unwrap_or_default());
                break;
            }
            if let Some(error) = stats.error {
                app.push_event("torrent-error", serde_json::json!({ "id": limbo_id, "error": error }));
                break;
            }
        }
    });
}
