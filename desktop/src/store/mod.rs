pub mod schema;

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use schema::StoreData;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("failed to read store file: {0}")]
    Read(#[source] std::io::Error),
    #[error("failed to write store file: {0}")]
    Write(#[source] std::io::Error),
    #[error("store file was replaced but directory sync failed: {0}")]
    Durability(#[source] std::io::Error),
    #[error("failed to create data directory: {0}")]
    CreateDir(#[source] std::io::Error),
    #[error("failed to serialize store data: {0}")]
    Serialize(#[source] serde_json::Error),
}

pub struct Store {
    path: PathBuf,
    data: Mutex<StoreData>,
    save_lock: Mutex<()>,
    dirty: AtomicBool,
}

impl Store {
    pub fn load(data_dir: impl AsRef<Path>) -> Result<Self, StoreError> {
        let data_dir = data_dir.as_ref();
        fs::create_dir_all(data_dir).map_err(StoreError::CreateDir)?;

        let path = data_dir.join("store.json");
        let data = if path.exists() {
            let raw = fs::read_to_string(&path).map_err(StoreError::Read)?;
            match serde_json::from_str(&raw) {
                Ok(data) => data,
                Err(error) => {
                    let corrupt = available_corrupt_path(&path);
                    fs::rename(&path, &corrupt).map_err(StoreError::Write)?;
                    tracing::error!(
                        path = %corrupt.display(),
                        "invalid store moved aside: {error}"
                    );
                    StoreData::default()
                }
            }
        } else {
            StoreData::default()
        };

        let store = Self {
            path,
            data: Mutex::new(data),
            save_lock: Mutex::new(()),
            dirty: AtomicBool::new(false),
        };
        store.save()?;
        Ok(store)
    }

    pub fn save(&self) -> Result<(), StoreError> {
        let _save = self.save_lock.lock();
        let json = {
            let data = self.data.lock();
            serde_json::to_vec_pretty(&*data).map_err(StoreError::Serialize)?
        };
        write_private_file(&self.path, &json)?;
        self.dirty.store(false, Ordering::Release);
        Ok(())
    }

    pub fn with<T>(&self, f: impl FnOnce(&StoreData) -> T) -> T {
        let data = self.data.lock();
        f(&data)
    }

    pub fn with_mut<T>(&self, f: impl FnOnce(&mut StoreData) -> T) -> Result<T, StoreError> {
        let _save = self.save_lock.lock();
        let (previous, result, json) = {
            let mut data = self.data.lock();
            let previous = data.clone();
            let result = f(&mut data);
            let json = match serde_json::to_vec_pretty(&*data) {
                Ok(json) => json,
                Err(error) => {
                    *data = previous;
                    return Err(StoreError::Serialize(error));
                }
            };
            (previous, result, json)
        };
        if let Err(error) = write_private_file(&self.path, &json) {
            if matches!(error, StoreError::Durability(_)) {
                self.dirty.store(true, Ordering::Release);
            } else {
                *self.data.lock() = previous;
            }
            return Err(error);
        }
        self.dirty.store(false, Ordering::Release);
        Ok(result)
    }

    pub fn with_mut_volatile<T>(&self, f: impl FnOnce(&mut StoreData) -> T) -> T {
        let _save = self.save_lock.lock();
        let mut data = self.data.lock();
        let result = f(&mut data);
        drop(data);
        self.dirty.store(true, Ordering::Release);
        result
    }

    pub fn is_dirty(&self) -> bool {
        self.dirty.load(Ordering::Acquire)
    }

    pub fn snapshot(&self) -> StoreData {
        self.data.lock().clone()
    }

    pub fn data_dir(&self) -> Result<&Path, StoreError> {
        self.path.parent().ok_or_else(|| {
            StoreError::Write(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "store path has no parent",
            ))
        })
    }
}

pub(crate) fn write_private_file(path: &Path, contents: &[u8]) -> Result<(), StoreError> {
    let parent = path.parent().ok_or_else(|| {
        StoreError::Write(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "private file path has no parent",
        ))
    })?;
    fs::create_dir_all(parent).map_err(StoreError::CreateDir)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(StoreError::Write)?;
    temporary.write_all(contents).map_err(StoreError::Write)?;
    temporary.flush().map_err(StoreError::Write)?;
    temporary.as_file().sync_all().map_err(StoreError::Write)?;
    set_private_permissions(temporary.as_file()).map_err(StoreError::Write)?;
    temporary
        .persist(path)
        .map_err(|error| StoreError::Write(error.error))?;
    sync_parent_directory(parent).map_err(StoreError::Durability)?;
    Ok(())
}

#[cfg(unix)]
fn sync_parent_directory(parent: &Path) -> std::io::Result<()> {
    fs::File::open(parent)?.sync_all()
}

#[cfg(not(unix))]
fn sync_parent_directory(_parent: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn set_private_permissions(file: &fs::File) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    file.set_permissions(fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn set_private_permissions(_file: &fs::File) -> std::io::Result<()> {
    Ok(())
}

fn available_corrupt_path(path: &Path) -> PathBuf {
    let first = path.with_file_name("store.json.corrupt");
    if !first.exists() {
        return first;
    }
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    path.with_file_name(format!("store.json.corrupt.{timestamp}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_persist_restores_in_memory_state() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = Store::load(directory.path()).unwrap();
        let original = store.with(|data| data.settings.download_path.clone());
        store.path = directory.path().to_path_buf();

        assert!(
            store
                .with_mut(|data| data.settings.download_path = "unsaved".to_string())
                .is_err()
        );
        assert_eq!(
            store.with(|data| data.settings.download_path.clone()),
            original
        );
    }

    #[test]
    fn volatile_mutation_is_flushed_by_save() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::load(directory.path()).unwrap();
        store.with_mut_volatile(|data| data.settings.download_path = "volatile".to_string());

        assert!(store.is_dirty());
        store.save().unwrap();
        assert!(!store.is_dirty());

        let reloaded = Store::load(directory.path()).unwrap();
        assert_eq!(
            reloaded.with(|data| data.settings.download_path.clone()),
            "volatile"
        );
    }
}
