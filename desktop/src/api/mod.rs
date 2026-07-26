use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path as AxumPath, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{delete, get};
use axum::Router;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio_stream::{Stream, StreamExt};
use tower_http::cors::{Any, CorsLayer};
use uuid::Uuid;

use crate::state::AppState;
use crate::store::schema::DEFAULT_API_PORT;

const API_VERSION: u32 = 1;

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Clone)]
struct ApiState {
    app: Arc<AppState>,
    token: String,
}

pub struct ApiServer;

impl ApiServer {
    pub async fn start(app: Arc<AppState>, data_dir: PathBuf) -> Result<Option<u16>, ApiError> {
        let (enabled, preferred_port) = app.store.with(|d| {
            (
                d.settings.api_enabled.unwrap_or(true),
                d.settings.api_port.unwrap_or(DEFAULT_API_PORT),
            )
        });

        if !enabled {
            let _ = std::fs::remove_file(discovery_path(&data_dir));
            return Ok(None);
        }

        let token = ensure_api_token(&app);
        let state = ApiState { app: app.clone(), token: token.clone() };

        let cors = CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any);
        let router = Router::new()
            .route("/v1/health", get(health))
            .route("/v1/torrents", get(list_torrents).post(add_torrent))
            .route("/v1/torrents/{id}", delete(remove_torrent))
            .route("/v1/events", get(events))
            .layer(cors)
            .with_state(state);

        let listener = match TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], preferred_port))).await {
            Ok(listener) => listener,
            Err(_) if preferred_port != 0 => {
                TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).await?
            }
            Err(err) => return Err(err.into()),
        };
        let port = listener.local_addr()?.port();
        write_discovery(&data_dir, port, &token)?;

        app.runtime.clone().spawn(async move {
            let _ = axum::serve(listener, router).await;
        });

        Ok(Some(port))
    }
}

fn check_auth(headers: &HeaderMap, state: &ApiState) -> bool {
    headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|token| token.trim() == state.token)
        .unwrap_or(false)
}

fn unauthorized() -> Response {
    (StatusCode::UNAUTHORIZED, Json(json!({ "error": "Unauthorized" }))).into_response()
}

async fn health() -> Json<Value> {
    Json(json!({
        "ok": true,
        "service": "limbo",
        "version": env!("CARGO_PKG_VERSION"),
        "apiVersion": API_VERSION,
        "apiTokenRequired": true,
    }))
}

async fn list_torrents(State(state): State<ApiState>, headers: HeaderMap) -> Response {
    if !check_auth(&headers, &state) {
        return unauthorized();
    }
    let torrents = state.app.store.with(|d| d.torrents.clone());
    Json(json!({ "torrents": torrents })).into_response()
}

#[derive(Debug, Deserialize)]
struct AddTorrentBody {
    #[serde(default)]
    magnet: Option<String>,
    #[serde(default, rename = "magnetUri")]
    magnet_uri: Option<String>,
}

async fn add_torrent(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(body): Json<AddTorrentBody>,
) -> Response {
    if !check_auth(&headers, &state) {
        return unauthorized();
    }

    let magnet = body
        .magnet
        .or(body.magnet_uri)
        .filter(|m| m.starts_with("magnet:"));
    let Some(magnet) = magnet else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "magnet is required" }))).into_response();
    };

    match state.app.torrent_engine.add_magnet(state.app.clone(), magnet, None).await {
        Ok(info) => (
            StatusCode::CREATED,
            Json(serde_json::to_value(info).unwrap_or(Value::Null)),
        )
            .into_response(),
        Err(err) => (StatusCode::BAD_REQUEST, Json(json!({ "error": err.to_string() }))).into_response(),
    }
}

async fn remove_torrent(
    State(state): State<ApiState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    if !check_auth(&headers, &state) {
        return unauthorized();
    }
    match state.app.torrent_engine.remove(&state.app, &id, false).await {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(err) => (StatusCode::NOT_FOUND, Json(json!({ "error": err.to_string() }))).into_response(),
    }
}

async fn events(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>>, Response> {
    if !check_auth(&headers, &state) {
        return Err(unauthorized());
    }

    let app = state.app.clone();
    let stream = tokio_stream::wrappers::IntervalStream::new(tokio::time::interval(Duration::from_secs(1)))
        .map(move |_| {
            let torrents = app.store.with(|d| d.torrents.clone());
            let event = Event::default()
                .event("progress")
                .json_data(json!({ "torrents": torrents }))
                .unwrap_or_else(|_| Event::default());
            Ok(event)
        });

    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

fn discovery_path(data_dir: &Path) -> PathBuf {
    data_dir.join("api.json")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Discovery {
    version: u32,
    port: u16,
    token: String,
    host: String,
    base_url: String,
    updated_at: String,
}

fn write_discovery(data_dir: &Path, port: u16, token: &str) -> Result<(), ApiError> {
    let discovery = Discovery {
        version: API_VERSION,
        port,
        token: token.to_string(),
        host: "127.0.0.1".to_string(),
        base_url: format!("http://127.0.0.1:{port}"),
        updated_at: chrono::Utc::now().to_rfc3339(),
    };
    std::fs::create_dir_all(data_dir)?;
    std::fs::write(discovery_path(data_dir), serde_json::to_string_pretty(&discovery)?)?;
    Ok(())
}

fn ensure_api_token(app: &AppState) -> String {
    let existing = app.store.with(|d| d.settings.api_token.clone());
    if let Some(token) = existing {
        if token.len() >= 16 {
            return token;
        }
    }
    let token = generate_token();
    let persisted = token.clone();
    app.store.with_mut(|d| d.settings.api_token = Some(persisted)).ok();
    token
}

fn generate_token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}
