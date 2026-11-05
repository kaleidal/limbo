use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::{Mutex, RwLock};
use sabine::{BridgeEvent, BridgeEventEmitter, SabineProcessHandle};
use serde::Serialize;
use tokio::runtime::Handle;
use tokio::task::JoinHandle;

use crate::api::ApiControl;
use crate::api::approval::ApprovalManager;
use crate::debrid::DebridService;
use crate::downloads::DownloadManager;
use crate::os::clipboard::ClipboardWatcher;
use crate::store::Store;
use crate::torrent::TorrentEngine;

pub struct AppState {
    pub store: Store,
    pub runtime: Handle,
    pub download_manager: DownloadManager,
    pub torrent_engine: TorrentEngine,
    pub debrid: DebridService,
    pub api: ApiControl,
    pub approvals: ApprovalManager,
    emitter: RwLock<Option<BridgeEventEmitter>>,
    process_handle: RwLock<Option<SabineProcessHandle>>,
    process_ready: tokio::sync::Notify,
    clipboard_watcher: Mutex<Option<ClipboardWatcher>>,
}

impl AppState {
    pub fn new(store: Store, runtime: Handle) -> Result<Self, reqwest::Error> {
        Ok(Self {
            store,
            runtime,
            download_manager: DownloadManager::new()?,
            torrent_engine: TorrentEngine::new(),
            debrid: DebridService::new()?,
            api: ApiControl::default(),
            approvals: ApprovalManager::default(),
            emitter: RwLock::new(None),
            process_handle: RwLock::new(None),
            process_ready: tokio::sync::Notify::new(),
            clipboard_watcher: Mutex::new(None),
        })
    }

    pub fn spawn<F>(&self, future: F) -> JoinHandle<F::Output>
    where
        F: Future + Send + 'static,
        F::Output: Send + 'static,
    {
        self.runtime.spawn(future)
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

    pub fn send<T: Serialize>(&self, event: &BridgeEvent<T>, payload: &T) {
        if let Some(emitter) = self.emitter.read().as_ref() {
            emitter.send(event, payload);
        }
    }

    pub fn set_bridge_emitter(&self, emitter: BridgeEventEmitter) {
        *self.emitter.write() = Some(emitter);
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

    pub fn quit(&self) -> Result<(), crate::store::StoreError> {
        self.store.save()?;
        let process = self.process_handle.read().clone();
        self.runtime.spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            if let Some(process) = process {
                process.quit();
            }
        });
        Ok(())
    }
}
