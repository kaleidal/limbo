use std::path::Path;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use tokio::fs::OpenOptions;
use tokio::io::{AsyncSeekExt, AsyncWriteExt};

use super::{DownloadControl, DownloadError, update, update_volatile};
use crate::state::AppState;
use crate::store::schema::DownloadStatus;

const PROGRESS_INTERVAL: Duration = Duration::from_millis(500);

pub struct Request<'a> {
    pub id: &'a str,
    pub url: &'a str,
    pub path: &'a Path,
    pub control: &'a DownloadControl,
}

pub enum Outcome {
    Finished,
    Paused,
    Cancelled,
}

pub async fn run(
    client: &reqwest::Client,
    app: &AppState,
    request: Request<'_>,
) -> Result<Outcome, DownloadError> {
    let Request {
        id,
        url,
        path,
        control,
    } = request;
    let existing = tokio::fs::metadata(path)
        .await
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let mut response = if existing > 0 {
        client
            .get(url)
            .header(reqwest::header::RANGE, format!("bytes={existing}-"))
            .send()
            .await?
    } else {
        client.get(url).send().await?
    };
    let mut offset = existing;
    if existing > 0 && response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
        offset = 0;
        response = client.get(url).send().await?;
    }
    let response = response.error_for_status()?;
    let total = response
        .content_length()
        .map(|length| length + offset)
        .unwrap_or(offset);

    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(offset == 0)
        .open(path)
        .await?;
    if offset > 0 {
        file.seek(std::io::SeekFrom::Start(offset)).await?;
    }

    update(app, id, |download| {
        if download.status == DownloadStatus::Pending {
            download.status = DownloadStatus::Downloading;
        }
        download.downloaded = offset;
        if total > 0 {
            download.size = total;
        }
    });

    let mut downloaded = offset;
    let mut stream = response.bytes_stream();
    let mut window_start = Instant::now();
    let mut window_bytes: u64 = 0;
    loop {
        if control.cancel.load(Ordering::SeqCst) {
            return Ok(Outcome::Cancelled);
        }
        if control.pause.load(Ordering::SeqCst) {
            file.flush().await?;
            return Ok(Outcome::Paused);
        }
        let Some(chunk) = stream.next().await else {
            break;
        };
        let bytes = chunk?;
        file.write_all(&bytes).await?;
        downloaded += bytes.len() as u64;
        window_bytes += bytes.len() as u64;

        let elapsed = window_start.elapsed();
        if elapsed >= PROGRESS_INTERVAL {
            let speed = window_bytes as f64 / elapsed.as_secs_f64();
            let eta = (speed > 0.0).then(|| total.saturating_sub(downloaded) as f64 / speed);
            update_volatile(app, id, |download| {
                download.downloaded = downloaded;
                download.speed = Some(speed);
                download.eta = eta;
            });
            window_start = Instant::now();
            window_bytes = 0;
        }
    }

    file.flush().await?;
    update(app, id, |download| {
        download.downloaded = downloaded;
        if download.size == 0 {
            download.size = downloaded;
        }
    });
    Ok(Outcome::Finished)
}
