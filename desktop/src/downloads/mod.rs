mod extract;
mod finish;
mod naming;
mod transfer;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use parking_lot::Mutex;
use uuid::Uuid;

use crate::events::{DOWNLOAD_REMOVED, DOWNLOAD_UPDATED, Removed};
use crate::state::AppState;
use crate::store::schema::{Download, DownloadStatus};

pub use naming::DownloadGroup;
use naming::{archive_set, derive_filename, sanitize_filename};

#[derive(Debug, thiserror::Error)]
pub enum DownloadError {
    #[error("download not found: {0}")]
    NotFound(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("store error: {0}")]
    Store(#[from] crate::store::StoreError),
}

struct Queued {
    id: String,
    url: String,
    path: PathBuf,
}

#[derive(Default)]
struct DownloadControl {
    cancel: AtomicBool,
    pause: AtomicBool,
}

pub struct DownloadManager {
    client: reqwest::Client,
    active: Mutex<HashMap<String, Arc<DownloadControl>>>,
}

impl DownloadManager {
    pub fn new() -> Result<Self, reqwest::Error> {
        let client = reqwest::Client::builder()
            .use_rustls_tls()
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(Duration::from_secs(60))
            .build()?;
        Ok(Self {
            client,
            active: Mutex::new(HashMap::new()),
        })
    }

    /// Queues the downloads the last session left running and starts as many
    /// as the concurrency limit allows.
    pub fn restore(&self, app: &Arc<AppState>) {
        app.store.with_mut_volatile(|data| {
            for download in &mut data.downloads {
                match download.status {
                    DownloadStatus::Downloading => download.status = DownloadStatus::Pending,
                    DownloadStatus::Extracting => {
                        download.status = DownloadStatus::Completed;
                        download.extract_progress = None;
                        download.extract_status = None;
                    }
                    _ => {}
                }
                download.speed = None;
                download.eta = None;
            }
        });
        self.fill_slots(app);
    }

    pub fn list(&self, app: &AppState) -> Vec<Download> {
        app.store.with(|data| data.downloads.clone())
    }

    pub fn start(
        &self,
        app: &Arc<AppState>,
        url: String,
        filename: Option<String>,
        group: Option<DownloadGroup>,
    ) -> Result<Download, DownloadError> {
        let download_dir =
            PathBuf::from(app.store.with(|data| data.settings.download_path.clone()));
        std::fs::create_dir_all(&download_dir)?;
        let requested = sanitize_filename(&filename.unwrap_or_else(|| derive_filename(&url)));
        let group = group
            .or_else(|| archive_set(&requested).map(|set| DownloadGroup::for_archive_set(&set)));
        let record = app.store.with_mut(|data| {
            let path = unused_path(&download_dir, &requested, |path| {
                data.downloads
                    .iter()
                    .any(|download| Path::new(&download.path) == path)
            });
            let record = Download {
                id: Uuid::new_v4().to_string(),
                filename: path
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or(requested),
                url,
                path: path.to_string_lossy().into_owned(),
                size: 0,
                downloaded: 0,
                status: DownloadStatus::Pending,
                speed: None,
                eta: None,
                error: None,
                extract_progress: None,
                extract_status: None,
                group_id: group.as_ref().map(|group| group.id.clone()),
                group_name: group.map(|group| group.name),
            };
            data.downloads.push(record.clone());
            record
        })?;
        app.send(&DOWNLOAD_UPDATED, &record);
        self.fill_slots(app);
        Ok(record)
    }

    pub fn pause(&self, app: &AppState, id: &str) {
        if let Some(control) = self.active.lock().get(id) {
            control.pause.store(true, Ordering::SeqCst);
        }
        update(app, id, |download| {
            if matches!(
                download.status,
                DownloadStatus::Downloading | DownloadStatus::Pending
            ) {
                download.status = DownloadStatus::Paused;
                download.speed = None;
                download.eta = None;
            }
        });
    }

    pub fn resume(&self, app: &Arc<AppState>, id: &str) -> Result<(), DownloadError> {
        if let Some(control) = self.active.lock().get(id) {
            control.pause.store(false, Ordering::SeqCst);
            update(app, id, |download| {
                download.status = DownloadStatus::Downloading
            });
            return Ok(());
        }
        update(app, id, |download| {
            if matches!(
                download.status,
                DownloadStatus::Paused | DownloadStatus::Error
            ) {
                download.status = DownloadStatus::Pending;
                download.error = None;
            }
        })
        .ok_or_else(|| DownloadError::NotFound(id.to_string()))?;
        self.fill_slots(app);
        Ok(())
    }

    pub fn cancel(&self, app: &Arc<AppState>, id: &str) {
        let removed = app
            .store
            .with_mut(|data| {
                let index = data
                    .downloads
                    .iter()
                    .position(|download| download.id == id)?;
                Some(data.downloads.remove(index))
            })
            .ok()
            .flatten();
        let active = self.active.lock().remove(id);
        if let Some(control) = &active {
            control.cancel.store(true, Ordering::SeqCst);
        }
        if active.is_none()
            && let Some(download) = removed
            && !download.status.is_finished()
        {
            remove_partial_file(Path::new(&download.path));
        }
        app.send(&DOWNLOAD_REMOVED, &Removed { id: id.to_string() });
        self.fill_slots(app);
    }

    pub fn cancel_all(&self, app: &Arc<AppState>) {
        for download in self.list(app) {
            self.cancel(app, &download.id);
        }
    }

    pub fn pause_all(&self, app: &AppState) {
        for download in self.list(app) {
            self.pause(app, &download.id);
        }
    }

    pub fn resume_all(&self, app: &Arc<AppState>) {
        for download in self.list(app) {
            if download.status == DownloadStatus::Paused
                && let Err(error) = self.resume(app, &download.id)
            {
                tracing::warn!(download_id = %download.id, %error, "failed to resume download");
            }
        }
    }

    pub fn clear_finished(&self, app: &AppState) {
        if let Err(error) = app.store.with_mut(|data| {
            data.downloads
                .retain(|download| !download.status.is_finished())
        }) {
            tracing::error!(%error, "failed to clear finished downloads");
        }
    }

    /// Starts queued downloads until the concurrency limit is reached.
    pub fn fill_slots(&self, app: &Arc<AppState>) {
        let limit =
            app.store
                .with(|data| data.settings.max_concurrent_downloads.max(1)) as usize;
        let mut active = self.active.lock();
        let queued = app.store.with(|data| {
            data.downloads
                .iter()
                .filter(|download| {
                    download.status == DownloadStatus::Pending && !active.contains_key(&download.id)
                })
                .take(limit.saturating_sub(active.len()))
                .map(|download| Queued {
                    id: download.id.clone(),
                    url: download.url.clone(),
                    path: PathBuf::from(&download.path),
                })
                .collect::<Vec<_>>()
        });
        for queued in queued {
            let control = Arc::new(DownloadControl::default());
            active.insert(queued.id.clone(), control.clone());
            self.spawn(app.clone(), queued, control);
        }
    }

    fn spawn(&self, app: Arc<AppState>, queued: Queued, control: Arc<DownloadControl>) {
        let Queued { id, url, path } = queued;
        let client = self.client.clone();
        app.clone().spawn(async move {
            let request = transfer::Request {
                id: &id,
                url: &url,
                path: &path,
                control: &control,
            };
            let result = transfer::run(&client, &app, request).await;
            {
                let mut active = app.download_manager.active.lock();
                if active
                    .get(&id)
                    .is_some_and(|current| Arc::ptr_eq(current, &control))
                {
                    active.remove(&id);
                }
            }
            app.download_manager.fill_slots(&app);
            match result {
                Ok(transfer::Outcome::Finished) => {
                    if let Some(download) = update(&app, &id, |download| {
                        download.status = DownloadStatus::Completed;
                        download.speed = None;
                        download.eta = None;
                    }) {
                        finish::completed(&app, download).await;
                    }
                }
                Ok(transfer::Outcome::Paused) => {}
                Ok(transfer::Outcome::Cancelled) => remove_partial_file(&path),
                Err(error) => {
                    update(&app, &id, |download| {
                        download.status = DownloadStatus::Error;
                        download.error = Some(error.to_string());
                        download.speed = None;
                        download.eta = None;
                    });
                }
            }
        });
    }
}

fn update(app: &AppState, id: &str, change: impl FnOnce(&mut Download)) -> Option<Download> {
    let download = app
        .store
        .with_mut(|data| {
            let download = data
                .downloads
                .iter_mut()
                .find(|download| download.id == id)?;
            change(download);
            Some(download.clone())
        })
        .ok()
        .flatten()?;
    app.send(&DOWNLOAD_UPDATED, &download);
    Some(download)
}

fn update_volatile(app: &AppState, id: &str, change: impl FnOnce(&mut Download)) {
    let download = app.store.with_mut_volatile(|data| {
        let download = data
            .downloads
            .iter_mut()
            .find(|download| download.id == id)?;
        change(download);
        Some(download.clone())
    });
    if let Some(download) = download {
        app.send(&DOWNLOAD_UPDATED, &download);
    }
}

fn unused_path(dir: &Path, filename: &str, taken: impl Fn(&Path) -> bool) -> PathBuf {
    let (stem, extension) = match filename.split_once('.') {
        Some((stem, extension)) if !stem.is_empty() => (stem, format!(".{extension}")),
        _ => (filename, String::new()),
    };
    (0..)
        .map(|copy| match copy {
            0 => dir.join(filename),
            copy => dir.join(format!("{stem} ({copy}){extension}")),
        })
        .find(|path| !path.exists() && !taken(path))
        .expect("an unused file name exists")
}

fn remove_partial_file(path: &Path) {
    if let Err(error) = std::fs::remove_file(path)
        && error.kind() != std::io::ErrorKind::NotFound
    {
        tracing::error!(path = %path.display(), "failed to remove partial download: {error}");
    }
}
