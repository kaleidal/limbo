use std::io::SeekFrom;

use axum::body::Body;
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::header::{
    ACCEPT_RANGES, CACHE_CONTROL, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, RANGE,
};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;

use super::torrents::{error, torrent_error};
use super::{ApiState, check_auth, unauthorized};

#[derive(Debug, Deserialize)]
pub struct StreamQuery {
    token: Option<String>,
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
    let (mut stream, stream_length) = match state.app.torrent_engine.stream(&id, file_index).await {
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

fn check_stream_auth(state: &ApiState, headers: &HeaderMap, query_token: Option<&str>) -> bool {
    check_auth(headers, state).is_some()
        || query_token
            .is_some_and(|candidate| state.app.api.authorize(&state.app, candidate).is_some())
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

#[cfg(test)]
mod tests {
    use axum::http::HeaderValue;

    use super::parse_range;

    #[test]
    fn parses_open_and_suffix_ranges() {
        let open = HeaderValue::from_static("bytes=100-");
        let range = parse_range(Some(&open), 1_000).unwrap();
        assert_eq!((range.start, range.end), (100, 999));
        let suffix = HeaderValue::from_static("bytes=-200");
        let range = parse_range(Some(&suffix), 1_000).unwrap();
        assert_eq!((range.start, range.end), (800, 999));
    }
}
