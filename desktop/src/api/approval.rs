use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use sabine::{SabineResult, SabineWindow};
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex as AsyncMutex, oneshot};
use uuid::Uuid;

use crate::state::AppState;

const APPROVAL_TIMEOUT: Duration = Duration::from_secs(90);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedPeerIdentity {
    pub pid: Option<u32>,
    pub exe_path: Option<String>,
    pub display_name: Option<String>,
    pub trust_key: Option<String>,
    pub method: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TorrentApprovalRequest {
    pub request_id: String,
    pub client_id: String,
    pub client_name: String,
    pub client_version: Option<String>,
    pub client_icon_data_url: Option<String>,
    pub magnet: String,
    pub display_name: String,
    pub file_index: Option<usize>,
    pub sequential: bool,
    pub verified: VerifiedPeerIdentity,
}

pub struct TorrentApprovalInput {
    pub client_id: String,
    pub client_name: String,
    pub client_version: Option<String>,
    pub client_icon_data_url: Option<String>,
    pub magnet: String,
    pub display_name: String,
    pub file_index: Option<usize>,
    pub sequential: bool,
    pub peer: SocketAddr,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TorrentApprovalDecision {
    pub approved: bool,
    #[serde(default)]
    pub remember: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalOutcome {
    Approved,
    Denied,
    TimedOut,
}

pub struct ApprovalManager {
    pending: Mutex<HashMap<String, oneshot::Sender<TorrentApprovalDecision>>>,
    active: Mutex<Option<TorrentApprovalRequest>>,
    queue: AsyncMutex<()>,
}

impl Default for ApprovalManager {
    fn default() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
            active: Mutex::new(None),
            queue: AsyncMutex::new(()),
        }
    }
}

impl ApprovalManager {
    pub async fn request(
        &self,
        app: &Arc<AppState>,
        input: TorrentApprovalInput,
    ) -> ApprovalOutcome {
        let verified = resolve_peer_identity(input.peer).await;
        let prompt_policy = app
            .store
            .with(|data| data.settings.api_prompt_policy.clone());
        if prompt_policy == "off" || is_trusted(app, &verified) {
            return ApprovalOutcome::Approved;
        }

        let _queue = self.queue.lock().await;
        let request_id = Uuid::new_v4().to_string();
        let request = TorrentApprovalRequest {
            request_id: request_id.clone(),
            client_id: input.client_id,
            client_name: input.client_name,
            client_version: input.client_version,
            client_icon_data_url: input.client_icon_data_url,
            magnet: input.magnet,
            display_name: input.display_name,
            file_index: input.file_index,
            sequential: input.sequential,
            verified: verified.clone(),
        };
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().insert(request_id.clone(), sender);
        *self.active.lock() = Some(request.clone());
        let Some(process) = app.process_handle().await else {
            self.pending.lock().remove(&request_id);
            self.clear_active(&request_id);
            tracing::error!("approval window unavailable because the Limbo process is not ready");
            return ApprovalOutcome::Denied;
        };
        let window = tokio::task::spawn_blocking(move || {
            approval_window().and_then(|window| process.open_window(window))
        })
        .await;
        match window {
            Ok(Ok(_)) => {}
            Ok(Err(error)) => {
                self.pending.lock().remove(&request_id);
                self.clear_active(&request_id);
                tracing::error!(%error, "approval window could not open");
                return ApprovalOutcome::Denied;
            }
            Err(error) => {
                self.pending.lock().remove(&request_id);
                self.clear_active(&request_id);
                tracing::error!(%error, "approval window task failed");
                return ApprovalOutcome::Denied;
            }
        }
        app.emit_bridge_event(
            "api-approval-requested",
            serde_json::to_value(&request).unwrap_or_default(),
        );

        let decision = tokio::time::timeout(APPROVAL_TIMEOUT, receiver).await;
        self.pending.lock().remove(&request_id);
        self.clear_active(&request_id);
        let Ok(Ok(decision)) = decision else {
            app.emit_bridge_event(
                "api-approval-expired",
                serde_json::json!({ "requestId": request_id }),
            );
            return ApprovalOutcome::TimedOut;
        };
        if !decision.approved {
            return ApprovalOutcome::Denied;
        }
        if decision.remember
            && let Some(trust_key) = verified.trust_key
            && let Err(error) = app.store.with_mut(|data| {
                if !data.settings.trusted_api_clients.contains(&trust_key) {
                    data.settings.trusted_api_clients.push(trust_key);
                }
            })
        {
            tracing::error!(%error, "failed to remember trusted companion app");
        }
        ApprovalOutcome::Approved
    }

    pub fn decide(&self, request_id: &str, decision: TorrentApprovalDecision) -> bool {
        let accepted = self
            .pending
            .lock()
            .remove(request_id)
            .is_some_and(|sender| sender.send(decision).is_ok());
        if accepted {
            self.clear_active(request_id);
        }
        accepted
    }

    pub fn active(&self) -> Option<TorrentApprovalRequest> {
        self.active.lock().clone()
    }

    fn clear_active(&self, request_id: &str) {
        let mut active = self.active.lock();
        if active
            .as_ref()
            .is_some_and(|request| request.request_id == request_id)
        {
            *active = None;
        }
    }
}

fn approval_window() -> SabineResult<SabineWindow> {
    Ok(SabineWindow::for_current_app()?
        .content_suffix("?window=approval")
        .title("Limbo Torrent Approval")
        .fixed_size(480, 520)
        .opaque()
        .no_chrome()
        .hidden()
        .active(false)
        .always_on_top(true))
}

fn is_trusted(app: &AppState, identity: &VerifiedPeerIdentity) -> bool {
    identity.trust_key.as_ref().is_some_and(|trust_key| {
        app.store
            .with(|data| data.settings.trusted_api_clients.contains(trust_key))
    })
}

async fn resolve_peer_identity(peer: SocketAddr) -> VerifiedPeerIdentity {
    tokio::task::spawn_blocking(move || resolve_peer_identity_sync(peer))
        .await
        .unwrap_or_else(|_| unknown_identity())
}

fn resolve_peer_identity_sync(peer: SocketAddr) -> VerifiedPeerIdentity {
    let pid = resolve_peer_pid(peer.port());
    let exe_path = pid.and_then(resolve_executable);
    let display_name = exe_path
        .as_ref()
        .and_then(|path| Path::new(path).file_stem())
        .map(|name| name.to_string_lossy().into_owned());
    let trust_key = exe_path.as_ref().map(|path| {
        format!(
            "exe:{}",
            normalize_path(path).to_string_lossy().to_lowercase()
        )
    });
    VerifiedPeerIdentity {
        pid,
        exe_path,
        display_name,
        trust_key,
        method: if pid.is_some() { "tcp-peer" } else { "unknown" },
    }
}

#[cfg(target_os = "linux")]
fn resolve_peer_pid(peer_port: u16) -> Option<u32> {
    let inode = ["/proc/net/tcp", "/proc/net/tcp6"]
        .into_iter()
        .find_map(|path| socket_inode(path, peer_port));
    let inode = inode?;
    let socket_target = format!("socket:[{inode}]");
    for entry in std::fs::read_dir("/proc").ok()?.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        let fds = match std::fs::read_dir(entry.path().join("fd")) {
            Ok(fds) => fds,
            Err(_) => continue,
        };
        for fd in fds.flatten() {
            if std::fs::read_link(fd.path())
                .ok()
                .is_some_and(|target| target == Path::new(&socket_target))
            {
                return Some(pid);
            }
        }
    }
    None
}

#[cfg(target_os = "linux")]
fn socket_inode(path: &str, peer_port: u16) -> Option<String> {
    let contents = std::fs::read_to_string(path).ok()?;
    let expected_port = format!("{peer_port:04X}");
    contents.lines().skip(1).find_map(|line| {
        let fields = line.split_whitespace().collect::<Vec<_>>();
        let local_port = fields.get(1)?.rsplit_once(':')?.1;
        if local_port.eq_ignore_ascii_case(&expected_port) && fields.get(3) == Some(&"01") {
            fields.get(9).map(|inode| (*inode).to_string())
        } else {
            None
        }
    })
}

#[cfg(target_os = "linux")]
fn resolve_executable(pid: u32) -> Option<String> {
    std::fs::read_link(format!("/proc/{pid}/exe"))
        .ok()
        .map(|path| path.to_string_lossy().into_owned())
}

#[cfg(target_os = "windows")]
fn resolve_peer_pid(peer_port: u16) -> Option<u32> {
    let output = std::process::Command::new("netstat")
        .args(["-ano", "-p", "tcp"])
        .output()
        .ok()?;
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(|line| {
            let fields = line.split_whitespace().collect::<Vec<_>>();
            let local = fields.get(1)?;
            if local.rsplit_once(':')?.1 == peer_port.to_string()
                && fields.get(3) == Some(&"ESTABLISHED")
            {
                fields.last()?.parse().ok()
            } else {
                None
            }
        })
}

#[cfg(target_os = "windows")]
fn resolve_executable(pid: u32) -> Option<String> {
    let output = std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &format!("(Get-Process -Id {pid} -ErrorAction Stop).Path"),
        ])
        .output()
        .ok()?;
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!path.is_empty()).then_some(path)
}

#[cfg(target_os = "macos")]
fn resolve_peer_pid(peer_port: u16) -> Option<u32> {
    let output = std::process::Command::new("lsof")
        .args([
            "-nP",
            &format!("-iTCP:{peer_port}"),
            "-sTCP:ESTABLISHED",
            "-Fp",
        ])
        .output()
        .ok()?;
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.strip_prefix('p')?.parse().ok())
        .find(|pid| *pid != std::process::id())
}

#[cfg(target_os = "macos")]
fn resolve_executable(pid: u32) -> Option<String> {
    let output = std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "comm="])
        .output()
        .ok()?;
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!path.is_empty()).then_some(path)
}

fn normalize_path(path: &str) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path))
}

fn unknown_identity() -> VerifiedPeerIdentity {
    VerifiedPeerIdentity {
        pid: None,
        exe_path: None,
        display_name: None,
        trust_key: None,
        method: "unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::socket_inode;

    #[test]
    #[cfg(target_os = "linux")]
    fn missing_socket_table_has_no_match() {
        assert_eq!(socket_inode("/definitely/missing", 43173), None);
    }
}
