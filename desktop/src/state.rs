use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::{Mutex, RwLock};
use serde_json::Value;
use tokio::runtime::Handle;
use tokio::sync::{Mutex as AsyncMutex, oneshot};
use tokio::task::JoinHandle;

use crate::api::approval::ApprovalManager;
use crate::debrid::DebridService;
use crate::downloads::DownloadManager;
use crate::os::clipboard::ClipboardWatcher;
use crate::store::Store;
use crate::torrent::TorrentEngine;

pub struct AppState {
    pub store: Store,
    pub runtime: Handle,
    pub events: Mutex<VecDeque<(String, Value)>>,
    pub download_manager: DownloadManager,
    pub torrent_engine: TorrentEngine,
    pub debrid: DebridService,
    pub api_token: RwLock<Option<String>>,
    pub api_port: Mutex<Option<u16>>,
    pub api_rotation: Mutex<()>,
    pub api_shutdown: Mutex<Option<oneshot::Sender<()>>>,
    pub api_task: AsyncMutex<Option<JoinHandle<()>>>,
    pub approvals: ApprovalManager,
    clipboard_watcher: Mutex<Option<ClipboardWatcher>>,
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
            api_token: RwLock::new(None),
            api_port: Mutex::new(None),
            api_rotation: Mutex::new(()),
            api_shutdown: Mutex::new(None),
            api_task: AsyncMutex::new(None),
            approvals: ApprovalManager::default(),
            clipboard_watcher: Mutex::new(None),
        })
    }

    pub fn set_clipboard_monitoring(self: &Arc<Self>, enabled: bool) {
        let mut watcher = self.clipboard_watcher.lock();
        if enabled && watcher.is_none() {
            *watcher = Some(ClipboardWatcher::start(
                Arc::downgrade(self),
                Duration::from_millis(250),
            ));
        } else if !enabled {
            watcher.take();
        }
    }

    pub fn push_event(&self, name: impl Into<String>, payload: Value) {
        let mut events = self.events.lock();
        if events.len() == EVENT_QUEUE_CAPACITY
            && let Some((dropped_event, _)) = events.pop_front()
        {
            tracing::warn!(%dropped_event, capacity = EVENT_QUEUE_CAPACITY, "event queue overflow; evicted oldest event");
        }
        events.push_back((name.into(), payload));
    }

    pub fn drain_events(&self) -> Vec<(String, Value)> {
        self.events.lock().drain(..).collect()
    }
}
