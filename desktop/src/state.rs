use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use parking_lot::{Mutex, RwLock};
use sabine::{BridgeEventEmitter, SabineProcessHandle};
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
    bridge_events_ready: AtomicBool,
    pub download_manager: DownloadManager,
    pub torrent_engine: TorrentEngine,
    pub debrid: DebridService,
    pub api_token: RwLock<Option<String>>,
    pub api_port: Mutex<Option<u16>>,
    pub api_rotation: Mutex<()>,
    pub api_shutdown: Mutex<Option<oneshot::Sender<()>>>,
    pub api_task: AsyncMutex<Option<JoinHandle<()>>>,
    pub approvals: ApprovalManager,
    bridge_emitter: RwLock<Option<BridgeEventEmitter>>,
    process_handle: RwLock<Option<SabineProcessHandle>>,
    process_ready: tokio::sync::Notify,
    clipboard_watcher: Mutex<Option<ClipboardWatcher>>,
}

const EVENT_QUEUE_CAPACITY: usize = 1_024;

impl AppState {
    pub fn new(store: Store, runtime: Handle) -> Result<Self, reqwest::Error> {
        Ok(Self {
            store,
            runtime,
            events: Mutex::new(VecDeque::new()),
            bridge_events_ready: AtomicBool::new(false),
            download_manager: DownloadManager::new()?,
            torrent_engine: TorrentEngine::new(),
            debrid: DebridService::new()?,
            api_token: RwLock::new(None),
            api_port: Mutex::new(None),
            api_rotation: Mutex::new(()),
            api_shutdown: Mutex::new(None),
            api_task: AsyncMutex::new(None),
            approvals: ApprovalManager::default(),
            bridge_emitter: RwLock::new(None),
            process_handle: RwLock::new(None),
            process_ready: tokio::sync::Notify::new(),
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
        let name = name.into();
        if self.bridge_events_ready.load(Ordering::Acquire)
            && self.emit_bridge_event(name.clone(), payload.clone())
        {
            return;
        }
        let mut events = self.events.lock();
        if self.bridge_events_ready.load(Ordering::Acquire)
            && self.emit_bridge_event(name.clone(), payload.clone())
        {
            return;
        }
        if events.len() == EVENT_QUEUE_CAPACITY
            && let Some((dropped_event, _)) = events.pop_front()
        {
            tracing::warn!(%dropped_event, capacity = EVENT_QUEUE_CAPACITY, "event queue overflow; evicted oldest event");
        }
        events.push_back((name, payload));
    }

    pub fn activate_event_delivery(&self) -> Vec<(String, Value)> {
        let mut events = self.events.lock();
        let pending = events.drain(..).collect();
        self.bridge_events_ready.store(true, Ordering::Release);
        pending
    }

    pub fn set_bridge_emitter(&self, emitter: BridgeEventEmitter) {
        *self.bridge_emitter.write() = Some(emitter);
    }

    pub fn set_process_handle(&self, handle: SabineProcessHandle) {
        *self.process_handle.write() = Some(handle);
        self.process_ready.notify_waiters();
    }

    pub async fn process_handle(&self) -> Option<SabineProcessHandle> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            let ready = self.process_ready.notified();
            if let Some(handle) = self.process_handle.read().clone() {
                return Some(handle);
            }
            if tokio::time::timeout_at(deadline, ready).await.is_err() {
                return None;
            }
        }
    }

    pub fn emit_bridge_event(&self, name: impl Into<String>, payload: Value) -> bool {
        self.bridge_emitter
            .read()
            .as_ref()
            .is_some_and(|emitter| emitter.emit(name, payload))
    }

    pub fn quit(&self) -> Result<(), crate::store::StoreError> {
        self.store.save()?;
        let emitter = self.bridge_emitter.read().clone();
        self.runtime.spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            if let Some(emitter) = emitter {
                emitter.quit();
            }
        });
        Ok(())
    }
}
