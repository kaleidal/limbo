use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use futures_util::StreamExt;
use parking_lot::Mutex;
use tokio::fs::OpenOptions;
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

use crate::state::AppState;
use crate::store::schema::Download;

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

#[derive(Clone)]
struct DownloadControl {
    cancel: Arc<AtomicBool>,
    pause: Arc<AtomicBool>,
}

impl DownloadControl {
    fn new() -> Self {
        Self {
            cancel: Arc::new(AtomicBool::new(false)),
            pause: Arc::new(AtomicBool::new(false)),
        }
    }
}

pub struct DownloadManager {
    client: reqwest::Client,
    active: Mutex<HashMap<String, DownloadControl>>,
}

impl Default for DownloadManager {
    fn default() -> Self {
        Self::new()
    }
}

impl DownloadManager {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .use_rustls_tls()
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            client,
            active: Mutex::new(HashMap::new()),
        }
    }

    pub fn list(&self, app: &AppState) -> Vec<Download> {
        app.store.with(|data| data.downloads.clone())
    }

    pub fn start(
        &self,
        app: Arc<AppState>,
        url: String,
        filename: Option<String>,
        dest_dir: Option<String>,
    ) -> Result<Download, DownloadError> {
        let settings = app.store.with(|data| data.settings.clone());
        let download_dir = dest_dir.unwrap_or(settings.download_path);
        std::fs::create_dir_all(&download_dir)?;

        let name = filename.unwrap_or_else(|| derive_filename(&url));
        let full_path = PathBuf::from(&download_dir).join(&name);
        let id = Uuid::new_v4().to_string();

        let record = Download {
            id: id.clone(),
            filename: name,
            url: url.clone(),
            path: full_path.to_string_lossy().into_owned(),
            size: 0,
            downloaded: 0,
            status: "pending".to_string(),
            speed: None,
            eta: None,
            extract_progress: None,
            extract_status: None,
            group_id: None,
            group_name: None,
        };

        app.store
            .with_mut(|data| data.downloads.push(record.clone()))?;
        app.push_event(
            "download-started",
            serde_json::to_value(&record).unwrap_or_default(),
        );

        let control = DownloadControl::new();
        self.active.lock().insert(id.clone(), control.clone());

        let client = self.client.clone();
        spawn_download(app, client, id, url, full_path, 0, control);

        Ok(record)
    }

    pub fn pause(&self, app: &AppState, id: &str) {
        if let Some(control) = self.active.lock().get(id) {
            control.pause.store(true, Ordering::SeqCst);
        }
        update_download(app, id, |d| {
            d.status = "paused".to_string();
            d.speed = None;
            d.eta = None;
        });
    }

    pub fn resume(&self, app: Arc<AppState>, id: &str) -> Result<(), DownloadError> {
        if let Some(control) = self.active.lock().get(id) {
            control.pause.store(false, Ordering::SeqCst);
            update_download(&app, id, |d| d.status = "downloading".to_string());
            return Ok(());
        }

        let record = app
            .store
            .with(|data| data.downloads.iter().find(|d| d.id == id).cloned())
            .ok_or_else(|| DownloadError::NotFound(id.to_string()))?;

        let control = DownloadControl::new();
        self.active.lock().insert(id.to_string(), control.clone());
        update_download(&app, id, |d| d.status = "downloading".to_string());

        let client = self.client.clone();
        let offset = record.downloaded;
        let path = PathBuf::from(&record.path);
        spawn_download(
            app,
            client,
            id.to_string(),
            record.url.clone(),
            path,
            offset,
            control,
        );
        Ok(())
    }

    pub fn cancel(&self, app: &AppState, id: &str) {
        if let Some(control) = self.active.lock().remove(id) {
            control.cancel.store(true, Ordering::SeqCst);
        }
        app.store
            .with_mut(|data| data.downloads.retain(|d| d.id != id))
            .ok();
        app.push_event(
            "download-complete",
            serde_json::json!({ "id": id, "status": "cancelled" }),
        );
    }

    pub fn cancel_all(&self, app: &AppState) {
        let ids: Vec<String> = self.active.lock().keys().cloned().collect();
        for id in ids {
            self.cancel(app, &id);
        }
    }

    pub fn pause_all(&self, app: &AppState) {
        let ids: Vec<String> = self.active.lock().keys().cloned().collect();
        for id in ids {
            self.pause(app, &id);
        }
    }

    pub fn resume_all(&self, app: Arc<AppState>) {
        let ids: Vec<String> = app.store.with(|data| {
            data.downloads
                .iter()
                .filter(|d| d.status == "paused" || d.status == "pending")
                .map(|d| d.id.clone())
                .collect()
        });
        for id in ids {
            let _ = self.resume(app.clone(), &id);
        }
    }

    pub fn clear_completed(&self, app: &AppState) {
        app.store
            .with_mut(|data| {
                data.downloads
                    .retain(|d| d.status != "completed" && d.status != "error")
            })
            .ok();
    }
}

fn derive_filename(url: &str) -> String {
    url.rsplit('/')
        .find(|segment| !segment.is_empty())
        .map(|segment| segment.split(['?', '#']).next().unwrap_or(segment))
        .filter(|segment| !segment.is_empty())
        .unwrap_or("download")
        .to_string()
}

fn update_download(app: &AppState, id: &str, f: impl FnOnce(&mut Download)) -> Option<Download> {
    app.store
        .with_mut(|data| {
            let item = data.downloads.iter_mut().find(|d| d.id == id)?;
            f(item);
            Some(item.clone())
        })
        .ok()
        .flatten()
}

fn spawn_download(
    app: Arc<AppState>,
    client: reqwest::Client,
    id: String,
    url: String,
    path: PathBuf,
    offset: u64,
    control: DownloadControl,
) {
    app.runtime.clone().spawn(async move {
        let result = run_download(&client, &app, &id, &url, &path, offset, &control).await;
        match result {
            Ok(()) => {
                if let Some(download) = update_download(&app, &id, |d| {
                    d.status = "completed".to_string();
                    d.speed = None;
                    d.eta = None;
                }) {
                    app.push_event(
                        "download-complete",
                        serde_json::json!({ "id": id, "status": "completed" }),
                    );
                    let _ = download;
                }
            }
            Err(err) if control.cancel.load(Ordering::SeqCst) => {
                let _ = err;
            }
            Err(err) => {
                update_download(&app, &id, |d| {
                    d.status = "error".to_string();
                    d.extract_status = Some(err.to_string());
                });
                app.push_event(
                    "download-complete",
                    serde_json::json!({ "id": id, "status": "error", "error": err.to_string() }),
                );
            }
        }
    });
}

async fn run_download(
    client: &reqwest::Client,
    app: &Arc<AppState>,
    id: &str,
    url: &str,
    path: &Path,
    offset: u64,
    control: &DownloadControl,
) -> Result<(), DownloadError> {
    let mut request = client.get(url);
    if offset > 0 {
        request = request.header("Range", format!("bytes={offset}-"));
    }
    let response = request.send().await?.error_for_status()?;

    let total = response
        .content_length()
        .map(|len| len + offset)
        .unwrap_or(offset);

    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .append(offset > 0)
        .truncate(offset == 0)
        .open(path)
        .await?;

    let mut downloaded = offset;
    let mut stream = response.bytes_stream();
    let mut last_emit = Instant::now();
    let mut bytes_since_emit: u64 = 0;

    update_download(app, id, |d| {
        d.status = "downloading".to_string();
        if total > 0 {
            d.size = total;
        }
    });

    while let Some(chunk) = stream.next().await {
        if control.cancel.load(Ordering::SeqCst) {
            return Err(DownloadError::NotFound("cancelled".to_string()));
        }
        while control.pause.load(Ordering::SeqCst) {
            if control.cancel.load(Ordering::SeqCst) {
                return Err(DownloadError::NotFound("cancelled".to_string()));
            }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }

        let bytes = chunk?;
        file.write_all(&bytes).await?;
        downloaded += bytes.len() as u64;
        bytes_since_emit += bytes.len() as u64;

        if last_emit.elapsed().as_millis() >= 500 {
            let secs = last_emit.elapsed().as_secs_f64().max(0.001);
            let speed = bytes_since_emit as f64 / secs;
            let remaining = total.saturating_sub(downloaded);
            let eta = if speed > 0.0 {
                Some(remaining as f64 / speed)
            } else {
                None
            };

            update_download(app, id, |d| {
                d.downloaded = downloaded;
                d.speed = Some(speed);
                d.eta = eta;
            });
            app.push_event(
                "download-progress",
                serde_json::json!({
                    "id": id,
                    "downloaded": downloaded,
                    "total": total,
                    "speed": speed,
                }),
            );
            last_emit = Instant::now();
            bytes_since_emit = 0;
        }
    }

    file.flush().await?;
    update_download(app, id, |d| {
        d.downloaded = downloaded;
        if d.size == 0 {
            d.size = downloaded;
        }
    });
    Ok(())
}
