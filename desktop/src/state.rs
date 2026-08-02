use parking_lot::Mutex;
use serde_json::Value;
use tokio::runtime::Handle;

use crate::debrid::DebridService;
use crate::downloads::DownloadManager;
use crate::store::Store;
use crate::torrent::TorrentEngine;

pub struct AppState {
    pub store: Store,
    pub runtime: Handle,
    pub events: Mutex<Vec<(String, Value)>>,
    pub download_manager: DownloadManager,
    pub torrent_engine: TorrentEngine,
    pub debrid: DebridService,
    pub stream_port: Mutex<u16>,
}

impl AppState {
    pub fn new(store: Store, runtime: Handle) -> Self {
        Self {
            store,
            runtime,
            events: Mutex::new(Vec::new()),
            download_manager: DownloadManager::new(),
            torrent_engine: TorrentEngine::new(),
            debrid: DebridService::new(),
            stream_port: Mutex::new(0),
        }
    }

    pub fn push_event(&self, name: impl Into<String>, payload: Value) {
        self.events.lock().push((name.into(), payload));
    }

    pub fn drain_events(&self) -> Vec<(String, Value)> {
        std::mem::take(&mut *self.events.lock())
    }
}
