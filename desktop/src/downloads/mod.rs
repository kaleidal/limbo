use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use parking_lot::Mutex;
use tokio::fs::OpenOptions;
use tokio::io::{AsyncSeekExt, AsyncWriteExt};
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
    #[error("download paused")]
    Paused,
    #[error("download cancelled")]
    Cancelled,
}

#[derive(Clone)]
struct DownloadControl {
    cancel: Arc<AtomicBool>,
    pause: Arc<AtomicBool>,
}

struct DownloadTask {
    id: String,
    url: String,
    path: PathBuf,
    offset: u64,
    control: DownloadControl,
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
    active: Arc<Mutex<HashMap<String, DownloadControl>>>,
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
            active: Arc::new(Mutex::new(HashMap::new())),
        })
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

        let name = sanitize_filename(&filename.unwrap_or_else(|| derive_filename(&url)));
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
        spawn_download(
            app,
            client,
            self.active.clone(),
            DownloadTask {
                id,
                url,
                path: full_path,
                offset: 0,
                control,
            },
        );

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

        let path = PathBuf::from(&record.path);
        let offset = std::fs::metadata(&path)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        let control = DownloadControl::new();
        self.active.lock().insert(id.to_string(), control.clone());
        update_download(&app, id, |d| {
            d.downloaded = offset;
            d.status = "downloading".to_string();
        });

        let client = self.client.clone();
        spawn_download(
            app,
            client,
            self.active.clone(),
            DownloadTask {
                id: id.to_string(),
                url: record.url.clone(),
                path,
                offset,
                control,
            },
        );
        Ok(())
    }

    pub fn cancel(&self, app: &AppState, id: &str) {
        let record = app.store.with(|data| {
            data.downloads
                .iter()
                .find(|download| download.id == id)
                .cloned()
        });
        let was_active = if let Some(control) = self.active.lock().remove(id) {
            control.cancel.store(true, Ordering::SeqCst);
            true
        } else {
            false
        };
        app.store
            .with_mut(|data| data.downloads.retain(|d| d.id != id))
            .ok();
        if !was_active
            && let Some(record) = record
            && let Err(error) = std::fs::remove_file(&record.path)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            tracing::error!(path = %record.path, "failed to remove partial download: {error}");
        }
        app.push_event(
            "download-complete",
            serde_json::json!({ "id": id, "status": "cancelled" }),
        );
    }

    pub fn cancel_all(&self, app: &AppState) {
        let ids: Vec<String> = app.store.with(|data| {
            data.downloads
                .iter()
                .map(|download| download.id.clone())
                .collect()
        });
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

fn sanitize_filename(raw: &str) -> String {
    let candidate = Path::new(raw)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let cleaned: String = candidate
        .chars()
        .filter(|character| !matches!(character, '/' | '\\' | ':' | '\0'))
        .collect();
    let trimmed = cleaned.trim().trim_matches('.');
    if trimmed.is_empty() {
        "download".to_string()
    } else {
        trimmed.to_string()
    }
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
    active: Arc<Mutex<HashMap<String, DownloadControl>>>,
    task: DownloadTask,
) {
    app.runtime.clone().spawn(async move {
        let result = run_download(
            &client,
            &app,
            &task.id,
            &task.url,
            &task.path,
            task.offset,
            &task.control,
        )
        .await;
        {
            let mut active = active.lock();
            if active
                .get(&task.id)
                .is_some_and(|current| Arc::ptr_eq(&current.cancel, &task.control.cancel))
            {
                active.remove(&task.id);
            }
        }
        match result {
            Ok(()) => {
                if let Some(download) = update_download(&app, &task.id, |d| {
                    d.status = "completed".to_string();
                    d.speed = None;
                    d.eta = None;
                }) {
                    app.push_event(
                        "download-complete",
                        serde_json::json!({ "id": task.id, "status": "completed" }),
                    );
                    let _ = download;
                }
            }
            Err(DownloadError::Cancelled) => {
                if let Err(error) = tokio::fs::remove_file(&task.path).await
                    && error.kind() != std::io::ErrorKind::NotFound
                {
                    tracing::error!(path = %task.path.display(), "failed to remove partial download: {error}");
                }
            }
            Err(DownloadError::Paused) => {}
            Err(err) => {
                update_download(&app, &task.id, |d| {
                    d.status = "error".to_string();
                    d.extract_status = Some(err.to_string());
                });
                app.push_event(
                    "download-complete",
                    serde_json::json!({ "id": task.id, "status": "error", "error": err.to_string() }),
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
    let mut effective_offset = offset;
    let mut response = if effective_offset > 0 {
        client
            .get(url)
            .header("Range", format!("bytes={effective_offset}-"))
            .send()
            .await?
    } else {
        client.get(url).send().await?
    };
    if effective_offset > 0 && response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
        effective_offset = 0;
        response = client.get(url).send().await?;
    }
    let response = response.error_for_status()?;

    let total = response
        .content_length()
        .map(|len| len + effective_offset)
        .unwrap_or(effective_offset);

    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(effective_offset == 0)
        .open(path)
        .await?;
    if effective_offset > 0 {
        file.seek(std::io::SeekFrom::Start(effective_offset))
            .await?;
    }

    let mut downloaded = effective_offset;
    let mut stream = response.bytes_stream();
    let mut last_emit = Instant::now();
    let mut bytes_since_emit: u64 = 0;

    update_download(app, id, |d| {
        d.status = "downloading".to_string();
        if total > 0 {
            d.size = total;
        }
    });

    loop {
        if control.cancel.load(Ordering::SeqCst) {
            return Err(DownloadError::Cancelled);
        }
        if control.pause.load(Ordering::SeqCst) {
            return Err(DownloadError::Paused);
        }
        let Some(chunk) = stream.next().await else {
            break;
        };

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

#[cfg(test)]
mod tests {
    use super::sanitize_filename;

    #[test]
    fn filename_is_reduced_to_one_safe_component() {
        assert_eq!(sanitize_filename("../../secret.txt"), "secret.txt");
        assert_eq!(sanitize_filename("/etc/passwd"), "passwd");
        assert_eq!(sanitize_filename(".."), "download");
        assert_eq!(sanitize_filename("C:\\temp\\file:name"), "Ctempfilename");
    }
}
