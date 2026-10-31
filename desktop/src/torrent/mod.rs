mod watcher;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use librqbit::api::TorrentIdOrHash;
use librqbit::{
    AddTorrent, AddTorrentOptions, ManagedTorrent, Session, SessionOptions,
    SessionPersistenceConfig, TorrentStats,
};
use parking_lot::Mutex;
use tokio::sync::Mutex as AsyncMutex;
use uuid::Uuid;

use crate::events::{Removed, TORRENT_REMOVED, TORRENT_UPDATED};
use crate::state::AppState;
use crate::store::schema::{TorrentInfo, TorrentSourceKind, TorrentStatus};

#[derive(Debug, thiserror::Error)]
pub enum TorrentError {
    #[error("torrent engine not initialized")]
    NotInitialized,
    #[error("torrent not found: {0}")]
    NotFound(String),
    #[error("store error: {0}")]
    Store(#[from] crate::store::StoreError),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
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
    pub client_id: String,
    pub client_name: String,
}

struct TorrentAddRequest {
    add: AddTorrent<'static>,
    magnet_uri: String,
    source_bytes: Option<Vec<u8>>,
    only_files: Option<Vec<usize>>,
}

pub struct TorrentEngine {
    session: Mutex<Option<Arc<Session>>>,
    id_map: Mutex<HashMap<String, usize>>,
    session_root: Mutex<PathBuf>,
    state_dir: Mutex<Option<PathBuf>>,
    add_lock: AsyncMutex<()>,
}

impl Default for TorrentEngine {
    fn default() -> Self {
        Self::new()
    }
}

/// The `dn` name a magnet link carries, if any.
pub fn magnet_name(magnet: &str) -> Option<String> {
    reqwest::Url::parse(magnet)
        .ok()?
        .query_pairs()
        .find(|(key, _)| key == "dn")
        .map(|(_, value)| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

impl TorrentEngine {
    pub fn new() -> Self {
        Self {
            session: Mutex::new(None),
            id_map: Mutex::new(HashMap::new()),
            session_root: Mutex::new(PathBuf::new()),
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
        tokio::fs::create_dir_all(download_path).await?;
        tokio::fs::create_dir_all(&state_dir).await?;
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
        *self.session_root.lock() = PathBuf::from(download_path);
        *self.state_dir.lock() = Some(state_dir);
        *self.session.lock() = Some(session.clone());
        self.restore_records(app, &session).await
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
        for record in self.list(&app) {
            if let Some((id, handle, _)) = restored
                .iter()
                .find(|(_, _, hash)| record.info_hash == *hash)
            {
                self.id_map.lock().insert(record.id.clone(), *id);
                watcher::spawn(app.clone(), record.id, handle.clone());
                continue;
            }
            let add = match record.source_type {
                TorrentSourceKind::Magnet if !record.magnet_uri.is_empty() => {
                    AddTorrent::from_url(record.magnet_uri.clone())
                }
                TorrentSourceKind::File => {
                    let Some(source) = record.source_value.as_deref() else {
                        continue;
                    };
                    match tokio::fs::read(source).await {
                        Ok(bytes) => AddTorrent::from_bytes(bytes),
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                            self.forget(&app, &record.id)?;
                            continue;
                        }
                        Err(error) => {
                            tracing::error!(torrent_id = %record.id, %error, "failed to read torrent source during restore");
                            continue;
                        }
                    }
                }
                TorrentSourceKind::Magnet => continue,
            };
            let options = AddTorrentOptions {
                output_folder: Some(record.path.clone()),
                overwrite: true,
                ..Default::default()
            };
            match session.add_torrent(add, Some(options)).await {
                Ok(response) => {
                    if let Some(handle) = response.into_handle() {
                        self.id_map.lock().insert(record.id.clone(), handle.id());
                        let hash = handle.info_hash().as_string();
                        app.store.with_mut(|data| {
                            if let Some(item) =
                                data.torrents.iter_mut().find(|item| item.id == record.id)
                            {
                                item.info_hash = hash;
                            }
                        })?;
                        watcher::spawn(app.clone(), record.id, handle);
                    }
                }
                Err(error) => {
                    tracing::error!(torrent_id = %record.id, %error, "failed to restore torrent")
                }
            }
        }
        Ok(())
    }

    pub fn is_ready(&self) -> bool {
        self.session.lock().is_some()
    }

    pub fn list(&self, app: &AppState) -> Vec<TorrentInfo> {
        app.store.with(|data| data.torrents.clone())
    }

    pub async fn add_magnet(
        &self,
        app: &Arc<AppState>,
        magnet_uri: String,
    ) -> Result<TorrentInfo, TorrentError> {
        self.add(
            app,
            TorrentAddRequest {
                add: AddTorrent::from_url(magnet_uri.clone()),
                magnet_uri,
                source_bytes: None,
                only_files: None,
            },
        )
        .await
    }

    pub async fn add_file_bytes(
        &self,
        app: &Arc<AppState>,
        bytes: Vec<u8>,
    ) -> Result<TorrentInfo, TorrentError> {
        self.add(
            app,
            TorrentAddRequest {
                add: AddTorrent::from_bytes(bytes.clone()),
                magnet_uri: String::new(),
                source_bytes: Some(bytes),
                only_files: None,
            },
        )
        .await
    }

    pub async fn add_companion_magnet(
        &self,
        app: &Arc<AppState>,
        magnet_uri: String,
        options: CompanionTorrentOptions,
    ) -> Result<TorrentInfo, TorrentError> {
        let info = self
            .add(
                app,
                TorrentAddRequest {
                    add: AddTorrent::from_url(magnet_uri.clone()),
                    magnet_uri,
                    source_bytes: None,
                    only_files: options.selected_file_index.map(|index| vec![index]),
                },
            )
            .await?;
        let info = app.store.with_mut(|data| {
            let item = data
                .torrents
                .iter_mut()
                .find(|item| item.id == info.id)
                .ok_or_else(|| TorrentError::NotFound(info.id.clone()))?;
            item.selected_file_index = options.selected_file_index.map(|index| index as u32);
            item.client_id = Some(options.client_id);
            item.client_name = Some(options.client_name);
            if let Some(name) = options.name {
                item.name = name;
            }
            Ok::<_, TorrentError>(item.clone())
        })??;
        app.send(&TORRENT_UPDATED, &info);
        Ok(info)
    }

    async fn add(
        &self,
        app: &Arc<AppState>,
        request: TorrentAddRequest,
    ) -> Result<TorrentInfo, TorrentError> {
        let _guard = self.add_lock.lock().await;
        let session = self.session()?;
        let download_path = app.store.with(|data| data.settings.download_path.clone());
        let in_session_root = self.session_root.lock().as_os_str() == download_path.as_str();
        let response = session
            .add_torrent(
                request.add,
                Some(AddTorrentOptions {
                    output_folder: (!in_session_root).then_some(download_path),
                    only_files: request.only_files,
                    overwrite: true,
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
                .find(|item| item.info_hash == info_hash)
                .cloned()
        }) {
            let watcher_needed = self
                .id_map
                .lock()
                .insert(existing.id.clone(), handle.id())
                .is_none();
            if watcher_needed {
                watcher::spawn(app.clone(), existing.id.clone(), handle);
            }
            return Ok(existing);
        }

        let source_value = match request.source_bytes {
            Some(bytes) => Some(self.keep_metainfo(&info_hash, bytes).await?),
            None => None,
        };
        let id = Uuid::new_v4().to_string();
        self.id_map.lock().insert(id.clone(), handle.id());
        let info = TorrentInfo {
            id: id.clone(),
            name: handle
                .name()
                .unwrap_or_else(|| "Untitled torrent".to_string()),
            source_type: if source_value.is_some() {
                TorrentSourceKind::File
            } else {
                TorrentSourceKind::Magnet
            },
            magnet_uri: request.magnet_uri,
            source_value,
            size: 0,
            downloaded: 0,
            uploaded: 0,
            progress: 0.0,
            download_speed: 0.0,
            upload_speed: 0.0,
            peers: 0,
            status: TorrentStatus::Downloading,
            path: handle.output_folder().to_string_lossy().into_owned(),
            info_hash,
            last_error: None,
            selected_file_index: None,
            client_id: None,
            client_name: None,
        };
        app.store
            .with_mut(|data| data.torrents.push(info.clone()))?;
        app.send(&TORRENT_UPDATED, &info);
        watcher::spawn(app.clone(), id, handle);
        Ok(info)
    }

    async fn keep_metainfo(&self, info_hash: &str, bytes: Vec<u8>) -> Result<String, TorrentError> {
        let state_dir = self
            .state_dir
            .lock()
            .clone()
            .ok_or(TorrentError::NotInitialized)?;
        let metainfo_dir = state_dir.join("metainfo");
        tokio::fs::create_dir_all(&metainfo_dir).await?;
        let path = metainfo_dir.join(format!("{info_hash}.torrent"));
        tokio::fs::write(&path, bytes).await?;
        Ok(path.to_string_lossy().into_owned())
    }

    pub async fn pause(&self, app: &AppState, id: &str) -> Result<(), TorrentError> {
        let session = self.session()?;
        let handle = self.handle_for(&session, id)?;
        if !handle.is_paused() {
            session.pause(&handle).await?;
        }
        self.set_status(app, id, TorrentStatus::Paused)
    }

    pub async fn resume(&self, app: &AppState, id: &str) -> Result<(), TorrentError> {
        let session = self.session()?;
        let handle = self.handle_for(&session, id)?;
        if handle.is_paused() {
            session.unpause(&handle).await?;
        }
        let status = if handle.stats().finished {
            TorrentStatus::Seeding
        } else {
            TorrentStatus::Downloading
        };
        self.set_status(app, id, status)
    }

    fn set_status(
        &self,
        app: &AppState,
        id: &str,
        status: TorrentStatus,
    ) -> Result<(), TorrentError> {
        let info = app.store.with_mut(|data| {
            let item = data
                .torrents
                .iter_mut()
                .find(|item| item.id == id)
                .ok_or_else(|| TorrentError::NotFound(id.to_string()))?;
            item.status = status;
            item.download_speed = 0.0;
            item.upload_speed = 0.0;
            Ok::<_, TorrentError>(item.clone())
        })??;
        app.send(&TORRENT_UPDATED, &info);
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
        self.forget(app, id)
    }

    fn forget(&self, app: &AppState, id: &str) -> Result<(), TorrentError> {
        app.store
            .with_mut(|data| data.torrents.retain(|item| item.id != id))?;
        app.send(&TORRENT_REMOVED, &Removed { id: id.to_string() });
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

    pub async fn stream(
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
            .await
            .map_err(|error| TorrentError::Message(error.to_string()))?;
        let length = stream.len();
        Ok((stream, length))
    }

    pub fn stats(&self, id: &str) -> Result<TorrentStats, TorrentError> {
        let session = self.session()?;
        Ok(self.handle_for(&session, id)?.stats())
    }

    pub async fn prime_file(
        &self,
        id: &str,
        file_index: usize,
        bytes: u64,
    ) -> Result<(), TorrentError> {
        let (mut stream, length) = self.stream(id, file_index).await?;
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
        handle.wait_until_initialized().await?;
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
