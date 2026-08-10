pub mod schema;

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use schema::StoreData;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("failed to read store file: {0}")]
    Read(#[source] std::io::Error),
    #[error("failed to write store file: {0}")]
    Write(#[source] std::io::Error),
    #[error("failed to create data directory: {0}")]
    CreateDir(#[source] std::io::Error),
    #[error("failed to serialize store data: {0}")]
    Serialize(#[source] serde_json::Error),
}

pub struct Store {
    path: PathBuf,
    data: Mutex<StoreData>,
    save_lock: Mutex<()>,
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
        write_private_file(&self.path, &json)
    }

    pub fn with<T>(&self, f: impl FnOnce(&StoreData) -> T) -> T {
        let data = self.data.lock();
        f(&data)
    }

    pub fn with_mut<T>(&self, f: impl FnOnce(&mut StoreData) -> T) -> Result<T, StoreError> {
        let _save = self.save_lock.lock();
        let (result, json) = {
            let mut data = self.data.lock();
            let result = f(&mut data);
            let json = serde_json::to_vec_pretty(&*data).map_err(StoreError::Serialize)?;
            (result, json)
        };
        write_private_file(&self.path, &json)?;
        Ok(result)
    }

    pub fn snapshot(&self) -> StoreData {
        self.data.lock().clone()
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
