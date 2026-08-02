pub mod schema;

use std::fs;
use std::path::{Path, PathBuf};

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
    #[error("failed to parse store file: {0}")]
    Parse(#[source] serde_json::Error),
    #[error("failed to serialize store data: {0}")]
    Serialize(#[source] serde_json::Error),
}

pub struct Store {
    path: PathBuf,
    data: Mutex<StoreData>,
}

impl Store {
    pub fn load(data_dir: impl AsRef<Path>) -> Result<Self, StoreError> {
        let data_dir = data_dir.as_ref();
        fs::create_dir_all(data_dir).map_err(StoreError::CreateDir)?;

        let path = data_dir.join("store.json");
        let data = if path.exists() {
            let raw = fs::read_to_string(&path).map_err(StoreError::Read)?;
            serde_json::from_str(&raw).map_err(StoreError::Parse)?
        } else {
            StoreData::default()
        };

        let store = Self {
            path,
            data: Mutex::new(data),
        };
        store.save()?;
        Ok(store)
    }

    pub fn save(&self) -> Result<(), StoreError> {
        let data = self.data.lock();
        let json = serde_json::to_string_pretty(&*data).map_err(StoreError::Serialize)?;
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(StoreError::CreateDir)?;
        }
        fs::write(&self.path, json).map_err(StoreError::Write)
    }

    pub fn with<T>(&self, f: impl FnOnce(&StoreData) -> T) -> T {
        let data = self.data.lock();
        f(&data)
    }

    pub fn with_mut<T>(&self, f: impl FnOnce(&mut StoreData) -> T) -> Result<T, StoreError> {
        let result = {
            let mut data = self.data.lock();
            f(&mut data)
        };
        self.save()?;
        Ok(result)
    }

    pub fn snapshot(&self) -> StoreData {
        self.data.lock().clone()
    }
}
