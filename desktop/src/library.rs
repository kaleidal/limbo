use std::path::{Path, PathBuf};

use uuid::Uuid;

use crate::events::LIBRARY_UPDATED;
use crate::state::AppState;
use crate::store::StoreError;
use crate::store::schema::LibraryItem;

#[derive(Debug, thiserror::Error)]
pub enum PathError {
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("path is outside Limbo's managed files")]
    Unmanaged,
}

pub fn add(app: &AppState, path: &Path) -> Result<LibraryItem, StoreError> {
    let path_text = path.to_string_lossy().into_owned();
    if let Some(existing) = app.store.with(|data| {
        data.library
            .iter()
            .find(|item| item.path == path_text)
            .cloned()
    }) {
        return Ok(existing);
    }
    let item = LibraryItem {
        id: Uuid::new_v4().to_string(),
        name: path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| path_text.clone()),
        path: path_text,
        size: disk_usage(path),
        date_added: chrono::Utc::now().to_rfc3339(),
    };
    let added = item.clone();
    let library = app.store.with_mut(|data| {
        data.library.push(added);
        data.library.clone()
    })?;
    app.send(&LIBRARY_UPDATED, &library);
    Ok(item)
}

pub fn prune_missing(app: &AppState) -> Result<(), StoreError> {
    let missing = app.store.with(|data| {
        data.library
            .iter()
            .any(|item| !Path::new(&item.path).exists())
    });
    if missing {
        app.store.with_mut(|data| {
            data.library.retain(|item| Path::new(&item.path).exists());
        })?;
    }
    Ok(())
}

/// Resolves a path the page asked for, accepting only files Limbo downloaded
/// or holds in its library.
pub fn managed_path(app: &AppState, requested: &str) -> Result<PathBuf, PathError> {
    let target = Path::new(requested).canonicalize()?;
    let (download_root, known) = app.store.with(|data| {
        let known = data
            .downloads
            .iter()
            .map(|item| item.path.clone())
            .chain(data.library.iter().map(|item| item.path.clone()))
            .collect::<Vec<_>>();
        (data.settings.download_path.clone(), known)
    });
    let inside_downloads = Path::new(&download_root)
        .canonicalize()
        .is_ok_and(|root| target.starts_with(root));
    let is_known = known
        .iter()
        .any(|path| Path::new(path).canonicalize().ok().as_ref() == Some(&target));
    if inside_downloads || is_known {
        Ok(target)
    } else {
        Err(PathError::Unmanaged)
    }
}

fn disk_usage(path: &Path) -> u64 {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return 0;
    };
    if !metadata.is_dir() {
        return metadata.len();
    }
    std::fs::read_dir(path)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| disk_usage(&entry.path()))
        .sum()
}
