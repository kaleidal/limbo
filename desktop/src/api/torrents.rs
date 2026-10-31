use std::net::SocketAddr;
use std::path::Path;

use axum::extract::{ConnectInfo, Path as AxumPath, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::approval::{ApprovalOutcome, TorrentApprovalInput};
use super::{ApiState, check_auth, unauthorized};
use crate::os::vpn;
use crate::store::schema::{TorrentInfo, TorrentStatus};
use crate::torrent::{CompanionTorrentOptions, TorrentError, TorrentFile};

const READY_BYTES: u64 = 5 * 1024 * 1024;
const READY_PROGRESS: f64 = 0.02;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddTorrentBody {
    #[serde(default)]
    magnet: Option<String>,
    #[serde(default)]
    magnet_uri: Option<String>,
    #[serde(default)]
    file_index: Option<usize>,
    #[serde(default = "default_sequential")]
    sequential: bool,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    client_id: Option<String>,
    #[serde(default)]
    client_name: Option<String>,
    #[serde(default)]
    client_version: Option<String>,
    #[serde(default)]
    client_icon_data_url: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveTorrentQuery {
    #[serde(default)]
    delete_files: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiTorrentFile {
    index: usize,
    name: String,
    path: String,
    length: u64,
    downloaded: u64,
    progress: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiTorrentStatus {
    id: String,
    info_hash: Option<String>,
    name: String,
    status: TorrentStatus,
    stage: &'static str,
    progress: f64,
    download_speed: f64,
    upload_speed: f64,
    peers: u32,
    size: u64,
    downloaded: u64,
    files: Vec<ApiTorrentFile>,
    selected_file_index: Option<usize>,
    stream_url: Option<String>,
    ready: bool,
    contiguous_bytes: u64,
    client_id: Option<String>,
    last_error: Option<String>,
}

pub async fn list_torrents(State(state): State<ApiState>, headers: HeaderMap) -> Response {
    if !check_auth(&headers, &state) {
        return unauthorized();
    }
    let statuses = state
        .app
        .torrent_engine
        .list(&state.app)
        .into_iter()
        .filter_map(|torrent| status_for(&state, torrent).ok())
        .collect::<Vec<_>>();
    Json(json!({ "torrents": statuses })).into_response()
}

pub async fn add_torrent(
    State(state): State<ApiState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<AddTorrentBody>,
) -> Response {
    if !check_auth(&headers, &state) {
        return unauthorized();
    }
    if !state.app.torrent_engine.is_ready() {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "TORRENT_NOT_READY",
            "Torrent support is still starting.",
        );
    }
    if vpn_required(&state) {
        return vpn_error();
    }

    let magnet = body
        .magnet
        .or(body.magnet_uri)
        .map(|value| value.trim().to_string())
        .filter(|value| value.starts_with("magnet:"));
    let Some(magnet) = magnet else {
        return error(
            StatusCode::BAD_REQUEST,
            "INVALID_REQUEST",
            "magnet is required",
        );
    };
    let client_id = clean_text(body.client_id).unwrap_or_else(|| "unknown".to_string());
    let client_name = clean_text(body.client_name).unwrap_or_else(|| client_id.clone());
    let name = clean_text(body.name);
    let display_name = name
        .clone()
        .or_else(|| crate::torrent::magnet_name(&magnet))
        .unwrap_or_else(|| "Torrent from companion app".to_string());
    let approval = state
        .app
        .approvals
        .request(
            &state.app,
            TorrentApprovalInput {
                client_id: client_id.clone(),
                client_name: client_name.clone(),
                client_version: clean_text(body.client_version),
                client_icon_data_url: clean_text(body.client_icon_data_url),
                magnet: magnet.clone(),
                display_name: display_name.clone(),
                file_index: body.file_index,
                sequential: body.sequential,
                peer,
            },
        )
        .await;
    match approval {
        ApprovalOutcome::Denied => {
            return error(
                StatusCode::FORBIDDEN,
                "APPROVAL_DENIED",
                "User denied the torrent request",
            );
        }
        ApprovalOutcome::TimedOut => {
            return error(
                StatusCode::FORBIDDEN,
                "APPROVAL_DENIED",
                "Approval timed out",
            );
        }
        ApprovalOutcome::Approved => {}
    }
    if vpn_required(&state) {
        return vpn_error();
    }

    let added = state
        .app
        .torrent_engine
        .add_companion_magnet(
            &state.app,
            magnet,
            CompanionTorrentOptions {
                name,
                selected_file_index: body.file_index,
                client_id,
                client_name,
            },
        )
        .await;
    let mut torrent = match added {
        Ok(torrent) => torrent,
        Err(error_value) => return torrent_error(error_value),
    };
    let files = match state.app.torrent_engine.list_files(&torrent.id) {
        Ok(files) => files,
        Err(error_value) => return torrent_error(error_value),
    };
    let selected = match select_file(&files, body.file_index) {
        Ok(selected) => selected,
        Err(message) => return error(StatusCode::BAD_REQUEST, "INVALID_FILE", message),
    };
    if let Some(selected) = selected {
        if let Err(error_value) = state
            .app
            .torrent_engine
            .select_file(&torrent.id, selected)
            .await
        {
            return torrent_error(error_value);
        }
        if let Err(error_value) = state
            .app
            .torrent_engine
            .prime_file(&torrent.id, selected, READY_BYTES)
            .await
        {
            return torrent_error(error_value);
        }
        let updated = state.app.store.with_mut(|data| {
            let item = data
                .torrents
                .iter_mut()
                .find(|item| item.id == torrent.id)?;
            item.selected_file_index = Some(selected as u32);
            Some(item.clone())
        });
        match updated {
            Ok(Some(updated)) => torrent = updated,
            Ok(None) => return error(StatusCode::NOT_FOUND, "NOT_FOUND", "Torrent not found"),
            Err(error_value) => {
                return error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "STORE_ERROR",
                    &error_value.to_string(),
                );
            }
        }
    }
    match status_for(&state, torrent) {
        Ok(status) => (StatusCode::CREATED, Json(status)).into_response(),
        Err(error_value) => torrent_error(error_value),
    }
}

pub async fn get_torrent(
    State(state): State<ApiState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    if !check_auth(&headers, &state) {
        return unauthorized();
    }
    let torrent = match state.app.torrent_engine.get(&state.app, &id) {
        Ok(torrent) => torrent,
        Err(error_value) => return torrent_error(error_value),
    };
    match status_for(&state, torrent) {
        Ok(status) => Json(status).into_response(),
        Err(error_value) => torrent_error(error_value),
    }
}

pub async fn remove_torrent(
    State(state): State<ApiState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<RemoveTorrentQuery>,
) -> Response {
    if !check_auth(&headers, &state) {
        return unauthorized();
    }
    match state
        .app
        .torrent_engine
        .remove(&state.app, &id, query.delete_files)
        .await
    {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(error_value) => torrent_error(error_value),
    }
}

pub fn status_for(
    state: &ApiState,
    torrent: TorrentInfo,
) -> Result<ApiTorrentStatus, TorrentError> {
    let files = state.app.torrent_engine.list_files(&torrent.id)?;
    let stats = state.app.torrent_engine.stats(&torrent.id)?;
    let selected_file_index = torrent
        .selected_file_index
        .map(|index| index as usize)
        .filter(|index| files.iter().any(|file| file.index == *index));
    let api_files = files
        .iter()
        .map(|file| {
            let downloaded = stats
                .file_progress
                .get(file.index)
                .copied()
                .unwrap_or(0)
                .min(file.length);
            ApiTorrentFile {
                index: file.index,
                name: file.name.clone(),
                path: file.name.clone(),
                length: file.length,
                downloaded,
                progress: fraction(downloaded, file.length),
            }
        })
        .collect::<Vec<_>>();
    let selected =
        selected_file_index.and_then(|index| api_files.iter().find(|file| file.index == index));
    let size = selected.map(|file| file.length).unwrap_or(torrent.size);
    let downloaded = selected
        .map(|file| file.downloaded)
        .unwrap_or(torrent.downloaded);
    let done = torrent.status.is_done();
    let ready = done
        || selected.is_some_and(|file| {
            file.length > 0
                && (file.downloaded >= READY_BYTES.min(file.length)
                    || file.progress >= READY_PROGRESS)
        });
    let stage = if torrent.status == TorrentStatus::Error {
        "error"
    } else if done {
        "done"
    } else if files.is_empty() || torrent.info_hash.is_empty() {
        "metadata"
    } else if ready {
        "ready"
    } else {
        "downloading"
    };
    let stream_url =
        selected_file_index.and_then(|index| state.app.api.stream_url(&torrent.id, index));
    Ok(ApiTorrentStatus {
        id: torrent.id,
        info_hash: Some(torrent.info_hash).filter(|hash| !hash.is_empty()),
        name: torrent.name,
        status: torrent.status,
        stage,
        progress: selected
            .map(|file| file.progress)
            .unwrap_or(torrent.progress),
        download_speed: torrent.download_speed,
        upload_speed: torrent.upload_speed,
        peers: torrent.peers,
        size,
        downloaded,
        files: api_files,
        selected_file_index,
        stream_url,
        ready,
        contiguous_bytes: downloaded,
        client_id: torrent.client_id,
        last_error: torrent.last_error,
    })
}

fn default_sequential() -> bool {
    true
}

fn clean_text(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn select_file(
    files: &[TorrentFile],
    requested: Option<usize>,
) -> Result<Option<usize>, &'static str> {
    if files.is_empty() {
        return Ok(None);
    }
    if let Some(requested) = requested {
        return files
            .iter()
            .any(|file| file.index == requested)
            .then_some(Some(requested))
            .ok_or("fileIndex does not exist in this torrent");
    }
    Ok(files
        .iter()
        .filter(|file| is_video(&file.name))
        .max_by_key(|file| file.length)
        .or_else(|| files.iter().max_by_key(|file| file.length))
        .map(|file| file.index))
}

fn is_video(name: &str) -> bool {
    matches!(
        Path::new(name)
            .extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("mkv" | "mp4" | "webm" | "avi" | "mov" | "m4v" | "ts" | "m2ts")
    )
}

fn fraction(downloaded: u64, length: u64) -> f64 {
    if length == 0 {
        0.0
    } else {
        downloaded as f64 / length as f64
    }
}

fn vpn_required(state: &ApiState) -> bool {
    state.app.store.with(|data| data.settings.require_vpn) && !vpn::is_vpn_connected()
}

fn vpn_error() -> Response {
    error(
        StatusCode::FORBIDDEN,
        "VPN_REQUIRED",
        "Limbo requires a VPN for torrents. Connect a VPN or disable the check in Settings.",
    )
}

pub(super) fn torrent_error(error_value: TorrentError) -> Response {
    let status = match error_value {
        TorrentError::NotFound(_) => StatusCode::NOT_FOUND,
        TorrentError::NotInitialized => StatusCode::SERVICE_UNAVAILABLE,
        _ => StatusCode::BAD_REQUEST,
    };
    error(status, "TORRENT_ERROR", &error_value.to_string())
}

pub(super) fn error(status: StatusCode, code: &str, message: &str) -> Response {
    (status, Json(json!({ "error": code, "message": message }))).into_response()
}

#[cfg(test)]
mod tests {
    use super::select_file;
    use crate::torrent::TorrentFile;

    #[test]
    fn auto_selects_largest_video() {
        let files = vec![
            TorrentFile {
                index: 0,
                name: "sample.mkv".into(),
                length: 10,
            },
            TorrentFile {
                index: 1,
                name: "movie.mp4".into(),
                length: 100,
            },
            TorrentFile {
                index: 2,
                name: "archive.bin".into(),
                length: 1_000,
            },
        ];
        assert_eq!(select_file(&files, None).unwrap(), Some(1));
    }
}
