use std::collections::VecDeque;

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
    pub events: Mutex<VecDeque<(String, Value)>>,
    pub download_manager: DownloadManager,
    pub torrent_engine: TorrentEngine,
    pub debrid: DebridService,
}

const EVENT_QUEUE_CAPACITY: usize = 1_024;

impl AppState {
    pub fn new(store: Store, runtime: Handle) -> Result<Self, reqwest::Error> {
        Ok(Self {
            store,
            runtime,
            events: Mutex::new(VecDeque::new()),
            download_manager: DownloadManager::new()?,
            torrent_engine: TorrentEngine::new(),
            debrid: DebridService::new()?,
        })
    }

    pub fn push_event(&self, name: impl Into<String>, payload: Value) {
        let mut events = self.events.lock();
        if events.len() == EVENT_QUEUE_CAPACITY {
            events.pop_front();
        }
        events.push_back((name.into(), payload));
    }

    pub fn drain_events(&self) -> Vec<(String, Value)> {
        self.events.lock().drain(..).collect()
    }
}
