use std::io::SeekFrom;
use std::net::SocketAddr;
use std::path::Path;

use axum::body::Body;
use axum::extract::{ConnectInfo, Path as AxumPath, Query, State};
use axum::http::header::{
    ACCEPT_RANGES, CACHE_CONTROL, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, RANGE,
};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;

use super::approval::{ApprovalOutcome, TorrentApprovalInput};
use super::{ApiState, check_auth, unauthorized};
use crate::os::vpn;
use crate::store::schema::TorrentInfo;
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

#[derive(Debug, Deserialize)]
pub struct StreamQuery {
    token: Option<String>,
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
    status: String,
    stage: &'static str,
    progress: f64,
    download_speed: f64,
    upload_speed: f64,
    peers: u32,
    seeds: u32,
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
    let display_name = name.clone().unwrap_or_else(|| magnet_label(&magnet));
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
            state.app.clone(),
            magnet,
            CompanionTorrentOptions {
                name,
                selected_file_index: body.file_index,
                client_id: Some(client_id),
                client_name: Some(client_name),
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
        Err(response) => return response,
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
        if let Err(error_value) =
            state
                .app
                .torrent_engine
                .prime_file(&torrent.id, selected, READY_BYTES)
        {
            return torrent_error(error_value);
        }
        let updated = state.app.store.with_mut(|data| {
            let item = data
                .torrents
                .iter_mut()
                .find(|item| item.id == torrent.id)?;
            item.selected_file_index = Some(selected as i64);
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

pub async fn stream_torrent(
    State(state): State<ApiState>,
    headers: HeaderMap,
    AxumPath((id, file_index)): AxumPath<(String, usize)>,
    Query(query): Query<StreamQuery>,
) -> Response {
    if !check_stream_auth(&state, &headers, query.token.as_deref()) {
        return unauthorized();
    }
    let files = match state.app.torrent_engine.list_files(&id) {
        Ok(files) => files,
        Err(error_value) => return torrent_error(error_value),
    };
    let Some(file) = files.into_iter().find(|file| file.index == file_index) else {
        return error(StatusCode::NOT_FOUND, "NOT_FOUND", "Torrent file not found");
    };
    let (mut stream, stream_length) = match state.app.torrent_engine.stream(&id, file_index) {
        Ok(stream) => stream,
        Err(error_value) => return torrent_error(error_value),
    };
    let range = match parse_range(headers.get(RANGE), stream_length) {
        Ok(range) => range,
        Err(()) => return unsatisfiable(stream_length),
    };
    if range.start > 0 && stream.seek(SeekFrom::Start(range.start)).await.is_err() {
        return error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "STREAM_ERROR",
            "Could not seek torrent stream",
        );
    }
    let count = range.end - range.start + 1;
    let status = if range.partial {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    };
    let reader = stream.take(count);
    let body = Body::from_stream(ReaderStream::with_capacity(reader, 64 * 1024));
    let mut response = (status, body).into_response();
    let response_headers = response.headers_mut();
    response_headers.insert(ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    response_headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response_headers.insert(
        CONTENT_LENGTH,
        HeaderValue::from_str(&count.to_string()).unwrap(),
    );
    if let Ok(value) = HeaderValue::from_str(
        mime_guess::from_path(&file.name)
            .first_or_octet_stream()
            .as_ref(),
    ) {
        response_headers.insert(CONTENT_TYPE, value);
    }
    if range.partial
        && let Ok(value) = HeaderValue::from_str(&format!(
            "bytes {}-{}/{}",
            range.start, range.end, range.length
        ))
    {
        response_headers.insert(CONTENT_RANGE, value);
    }
    response
}

pub fn status_for(
    state: &ApiState,
    torrent: TorrentInfo,
) -> Result<ApiTorrentStatus, TorrentError> {
    let files = state.app.torrent_engine.list_files(&torrent.id)?;
    let stats = state.app.torrent_engine.stats(&torrent.id)?;
    let selected_file_index = torrent
        .selected_file_index
        .and_then(|index| usize::try_from(index).ok())
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
    let done = torrent.status == "completed" || torrent.status == "seeding";
    let ready = done
        || selected.is_some_and(|file| {
            file.length > 0
                && (file.downloaded >= READY_BYTES.min(file.length)
                    || file.progress >= READY_PROGRESS)
        });
    let stage = if torrent.status == "error" {
        "error"
    } else if done {
        "done"
    } else if files.is_empty() || torrent.info_hash.is_none() {
        "metadata"
    } else if ready {
        "ready"
    } else {
        "downloading"
    };
    let stream_url = selected_file_index.map(|index| {
        let port = state.app.api_port.lock().unwrap_or_default();
        let token = state.app.api_token.read().clone().unwrap_or_default();
        format!(
            "http://127.0.0.1:{port}/v1/torrents/{}/stream/{index}?token={}",
            torrent.id,
            url_encode(&token)
        )
    });
    Ok(ApiTorrentStatus {
        id: torrent.id,
        info_hash: torrent.info_hash,
        name: torrent.name,
        status: torrent.status,
        stage,
        progress: selected
            .map(|file| file.progress)
            .unwrap_or(torrent.progress),
        download_speed: torrent.download_speed,
        upload_speed: torrent.upload_speed,
        peers: torrent.peers,
        seeds: torrent.seeds,
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

fn magnet_label(magnet: &str) -> String {
    magnet
        .split('&')
        .find_map(|part| part.strip_prefix("dn="))
        .map(url_decode)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "Torrent from companion app".to_string())
}

fn select_file(files: &[TorrentFile], requested: Option<usize>) -> Result<Option<usize>, Response> {
    if files.is_empty() {
        return Ok(None);
    }
    if let Some(requested) = requested {
        return files
            .iter()
            .any(|file| file.index == requested)
            .then_some(Some(requested))
            .ok_or_else(|| {
                error(
                    StatusCode::BAD_REQUEST,
                    "INVALID_FILE",
                    "fileIndex does not exist in this torrent",
                )
            });
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

fn torrent_error(error_value: TorrentError) -> Response {
    let status = match error_value {
        TorrentError::NotFound(_) => StatusCode::NOT_FOUND,
        TorrentError::NotInitialized => StatusCode::SERVICE_UNAVAILABLE,
        _ => StatusCode::BAD_REQUEST,
    };
    error(status, "TORRENT_ERROR", &error_value.to_string())
}

fn error(status: StatusCode, code: &str, message: &str) -> Response {
    (status, Json(json!({ "error": code, "message": message }))).into_response()
}

fn check_stream_auth(state: &ApiState, headers: &HeaderMap, query_token: Option<&str>) -> bool {
    check_auth(headers, state)
        || query_token.is_some_and(|candidate| {
            state
                .app
                .api_token
                .read()
                .as_deref()
                .is_some_and(|token| candidate == token)
        })
}

struct ByteRange {
    start: u64,
    end: u64,
    length: u64,
    partial: bool,
}

fn parse_range(header: Option<&HeaderValue>, length: u64) -> Result<ByteRange, ()> {
    if length == 0 {
        return Err(());
    }
    let Some(header) = header else {
        return Ok(ByteRange {
            start: 0,
            end: length - 1,
            length,
            partial: false,
        });
    };
    let value = header
        .to_str()
        .map_err(|_| ())?
        .strip_prefix("bytes=")
        .ok_or(())?;
    if value.contains(',') {
        return Err(());
    }
    let (start, end) = value.split_once('-').ok_or(())?;
    let (start, end) = if start.is_empty() {
        let suffix = end.parse::<u64>().map_err(|_| ())?.min(length);
        if suffix == 0 {
            return Err(());
        }
        (length - suffix, length - 1)
    } else {
        let start = start.parse::<u64>().map_err(|_| ())?;
        if start >= length {
            return Err(());
        }
        let end = if end.is_empty() {
            length - 1
        } else {
            end.parse::<u64>().map_err(|_| ())?.min(length - 1)
        };
        if end < start {
            return Err(());
        }
        (start, end)
    };
    Ok(ByteRange {
        start,
        end,
        length,
        partial: true,
    })
}

fn unsatisfiable(length: u64) -> Response {
    let mut response = StatusCode::RANGE_NOT_SATISFIABLE.into_response();
    if let Ok(value) = HeaderValue::from_str(&format!("bytes */{length}")) {
        response.headers_mut().insert(CONTENT_RANGE, value);
    }
    response
}

fn url_encode(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

fn url_decode(value: &str) -> String {
    let value = value.replace('+', " ");
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && index + 2 < bytes.len()
            && let Ok(byte) = u8::from_str_radix(&value[index + 1..index + 3], 16)
        {
            output.push(byte);
            index += 3;
            continue;
        }
        output.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&output).into_owned()
}

#[cfg(test)]
mod tests {
    use axum::http::HeaderValue;

    use super::{parse_range, select_file};
    use crate::torrent::TorrentFile;

    #[test]
    fn parses_open_and_suffix_ranges() {
        let open = HeaderValue::from_static("bytes=100-");
        let range = parse_range(Some(&open), 1_000).unwrap();
        assert_eq!((range.start, range.end), (100, 999));
        let suffix = HeaderValue::from_static("bytes=-200");
        let range = parse_range(Some(&suffix), 1_000).unwrap();
        assert_eq!((range.start, range.end), (800, 999));
    }

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
