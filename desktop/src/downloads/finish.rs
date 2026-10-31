use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::extract::Extraction;
use super::naming::{ArchiveKind, archive_kind, archive_set, extraction_folder};
use super::{update, update_volatile};
use crate::library;
use crate::state::AppState;
use crate::store::schema::{Download, DownloadStatus};

/// Extracts a finished archive when every volume of it is in, and adds what
/// the download produced to the library.
pub async fn completed(app: &Arc<AppState>, download: Download) {
    let (auto_extract, delete_archives) = app.store.with(|data| {
        (
            data.settings.auto_extract,
            data.settings.delete_archive_after_extract,
        )
    });
    let path = PathBuf::from(&download.path);
    let Some(kind) = archive_kind(&download.filename) else {
        add_to_library(app, path).await;
        return;
    };
    let volumes = volumes_of(app, &download);
    let is_multi_volume = volumes.is_some();
    if !auto_extract {
        if !is_multi_volume {
            add_to_library(app, path).await;
        }
        return;
    }
    let (key, volumes) = match volumes {
        Some(Volumes::Waiting) => return,
        Some(Volumes::Ready { key, paths }) => (key, paths),
        None => (format!("file:{}", download.path), vec![path.clone()]),
    };
    if app
        .store
        .with(|data| data.extracted_archives.contains(&key))
    {
        return;
    }
    let Some(output) = extraction_folder(&volumes[0]) else {
        return;
    };

    update(app, &download.id, |item| {
        item.status = DownloadStatus::Extracting;
        item.extract_progress = Some(0.0);
        item.extract_status = None;
    });
    let extraction = Extraction {
        kind,
        volumes: volumes.clone(),
        output: output.clone(),
    };
    let progress_app = app.clone();
    let id = download.id.clone();
    let result = tokio::task::spawn_blocking(move || {
        extraction.run(|fraction| {
            update_volatile(&progress_app, &id, |item| {
                item.extract_progress = Some((fraction * 100.0).round());
            });
        })
    })
    .await;

    let failure = match result {
        Ok(Ok(())) => None,
        Ok(Err(error)) => Some(error.to_string()),
        Err(error) => Some(error.to_string()),
    };
    update(app, &download.id, |item| {
        item.status = DownloadStatus::Completed;
        item.extract_progress = None;
        item.extract_status = Some(match &failure {
            None => "Extracted".to_string(),
            Some(error) => format!("Extraction failed: {error}"),
        });
    });
    if let Some(error) = failure {
        tracing::warn!(archive = %volumes[0].display(), %error, "extraction failed");
        if !is_multi_volume {
            add_to_library(app, path).await;
        }
        return;
    }
    if let Err(error) = app.store.with_mut(|data| data.extracted_archives.push(key)) {
        tracing::error!(%error, "failed to remember extracted archive");
    }
    if delete_archives {
        for volume in &volumes {
            if let Err(error) = std::fs::remove_file(volume) {
                tracing::warn!(path = %volume.display(), %error, "failed to delete archive");
            }
        }
    }
    add_to_library(app, output).await;
}

enum Volumes {
    Waiting,
    Ready { key: String, paths: Vec<PathBuf> },
}

/// Finds the other volumes of a multi-volume archive among Limbo's downloads.
/// Returns `None` for an archive that stands alone.
fn volumes_of(app: &AppState, download: &Download) -> Option<Volumes> {
    let path = Path::new(&download.path);
    let folder = path.parent()?;
    let (base, kind) = match archive_set(&download.filename) {
        Some(set) => (set.base, set.kind),
        None if archive_kind(&download.filename) == Some(ArchiveKind::Rar) => (
            download.filename.rsplit_once('.')?.0.to_string(),
            ArchiveKind::Rar,
        ),
        None => return None,
    };
    let is_volume = |filename: &str| match archive_set(filename) {
        Some(set) => set.kind == kind && set.base.eq_ignore_ascii_case(&base),
        None => kind == ArchiveKind::Rar && filename.eq_ignore_ascii_case(&format!("{base}.rar")),
    };
    let mut members = app.store.with(|data| {
        data.downloads
            .iter()
            .filter(|item| {
                Path::new(&item.path).parent() == Some(folder) && is_volume(&item.filename)
            })
            .map(|item| {
                (
                    item.filename.clone(),
                    PathBuf::from(&item.path),
                    item.status,
                )
            })
            .collect::<Vec<_>>()
    });
    let has_other_volumes = members
        .iter()
        .any(|(filename, ..)| archive_set(filename).is_some());
    if !has_other_volumes {
        return None;
    }
    if members
        .iter()
        .any(|(.., status)| *status != DownloadStatus::Completed)
    {
        return Some(Volumes::Waiting);
    }
    members.sort_by_key(|(filename, ..)| volume_order(filename));
    let first_is_present = members
        .first()
        .is_some_and(|(filename, ..)| archive_set(filename).is_none_or(|set| set.first));
    if !first_is_present {
        return Some(Volumes::Waiting);
    }
    Some(Volumes::Ready {
        key: format!("set:{}", folder.join(&base).display()).to_lowercase(),
        paths: members.into_iter().map(|(_, path, _)| path).collect(),
    })
}

fn volume_order(filename: &str) -> (bool, String) {
    let first = archive_set(filename).is_none_or(|set| set.first);
    (!first, filename.to_lowercase())
}

async fn add_to_library(app: &Arc<AppState>, path: PathBuf) {
    let app = app.clone();
    let result = tokio::task::spawn_blocking(move || library::add(&app, &path)).await;
    if let Ok(Err(error)) = result {
        tracing::error!(%error, "failed to add download to library");
    }
}
