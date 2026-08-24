pub mod approval;
mod torrents;

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::extract::State;
use axum::http::header::{ACCEPT_RANGES, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE};
use axum::http::{HeaderMap, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::get;
use base64::Engine;
use rand::TryRngCore;
use serde::Serialize;
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio_stream::{Stream, StreamExt};
use tower_http::cors::{Any, CorsLayer};

use crate::state::AppState;
use crate::store::StoreError;
use crate::store::schema::DEFAULT_API_PORT;

const API_VERSION: u32 = 2;

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("store error: {0}")]
    Store(#[from] StoreError),
    #[error("token generation failed: {0}")]
    Token(String),
}

#[derive(Clone)]
pub(super) struct ApiState {
    app: Arc<AppState>,
}

pub struct ApiServer;

impl ApiServer {
    pub async fn start(app: Arc<AppState>, data_dir: PathBuf) -> Result<Option<u16>, ApiError> {
        Self::stop(&app, &data_dir).await;
        let (enabled, preferred_port) = app.store.with(|d| {
            (
                d.settings.api_enabled.unwrap_or(true),
                d.settings.api_port.unwrap_or(DEFAULT_API_PORT),
            )
        });

        if !enabled {
            let _ = std::fs::remove_file(discovery_path(&data_dir));
            *app.api_port.lock() = None;
            return Ok(None);
        }

        let token = ensure_api_token(&app)?;
        let state = ApiState { app: app.clone() };

        let router = build_router(state);

        let listener =
            match TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], preferred_port))).await {
                Ok(listener) => listener,
                Err(_) if preferred_port != 0 => {
                    TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).await?
                }
                Err(err) => return Err(err.into()),
            };
        let port = listener.local_addr()?.port();
        write_discovery(&data_dir, port, &token)?;
        *app.api_token.write() = Some(token);
        *app.api_port.lock() = Some(port);

        let (shutdown_sender, shutdown_receiver) = oneshot::channel();
        *app.api_shutdown.lock() = Some(shutdown_sender);
        let task = app.runtime.clone().spawn(async move {
            if let Err(error) = axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(async move {
                let _ = shutdown_receiver.await;
            })
            .await
            {
                tracing::error!(%error, "companion API stopped unexpectedly");
            }
        });
        *app.api_task.lock().await = Some(task);

        Ok(Some(port))
    }

    pub async fn reconfigure(app: Arc<AppState>) -> Result<Option<u16>, ApiError> {
        let data_dir = app.store.data_dir()?.to_path_buf();
        Self::start(app, data_dir).await
    }

    async fn stop(app: &AppState, data_dir: &Path) {
        if let Some(shutdown) = app.api_shutdown.lock().take() {
            let _ = shutdown.send(());
        }
        if let Some(mut task) = app.api_task.lock().await.take()
            && tokio::time::timeout(Duration::from_secs(2), &mut task)
                .await
                .is_err()
        {
            task.abort();
            let _ = task.await;
        }
        *app.api_port.lock() = None;
        let _ = std::fs::remove_file(discovery_path(data_dir));
    }
}

fn build_router(state: ApiState) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any)
        .expose_headers([ACCEPT_RANGES, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE]);
    Router::new()
        .route("/v1/health", get(health))
        .route(
            "/v1/torrents",
            get(torrents::list_torrents).post(torrents::add_torrent),
        )
        .route(
            "/v1/torrents/{id}",
            get(torrents::get_torrent).delete(torrents::remove_torrent),
        )
        .route(
            "/v1/torrents/{id}/stream/{file_index}",
            get(torrents::stream_torrent).head(torrents::stream_torrent),
        )
        .route("/v1/events", get(events))
        .layer(cors)
        .with_state(state)
}

impl ApiServer {
    pub fn rotate_token(app: &AppState) -> Result<(), ApiError> {
        let _rotation = app.api_rotation.lock();
        let previous = app.store.with(|data| data.settings.api_token.clone());
        let token = generate_token()?;
        let port = *app.api_port.lock();
        if let Some(port) = port {
            write_discovery(app.store.data_dir()?, port, &token)?;
        }
        let persisted = token.clone();
        if let Err(error) = app
            .store
            .with_mut(|data| data.settings.api_token = Some(persisted))
        {
            if let (Some(port), Some(previous)) = (port, previous.as_deref())
                && let Err(rollback_error) = write_discovery(app.store.data_dir()?, port, previous)
            {
                tracing::error!(%rollback_error, "failed to restore API discovery token");
            }
            return Err(error.into());
        }
        *app.api_token.write() = Some(token);
        Ok(())
    }
}

pub(super) fn check_auth(headers: &HeaderMap, state: &ApiState) -> bool {
    let token = state.app.api_token.read();
    headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|candidate| {
            token
                .as_deref()
                .is_some_and(|token| candidate.trim() == token)
        })
        .unwrap_or(false)
}

pub(super) fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "error": "Unauthorized" })),
    )
        .into_response()
}

async fn health(State(state): State<ApiState>) -> Json<Value> {
    Json(json!({
        "ok": true,
        "service": "limbo",
        "version": env!("CARGO_PKG_VERSION"),
        "apiVersion": API_VERSION,
        "torrentReady": state.app.torrent_engine.is_ready(),
        "apiTokenRequired": true,
    }))
}

async fn events(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>>, Response> {
    if !check_auth(&headers, &state) {
        return Err(unauthorized());
    }

    let app = state.app.clone();
    let stream =
        tokio_stream::wrappers::IntervalStream::new(tokio::time::interval(Duration::from_secs(1)))
            .map(move |_| {
                let state = ApiState { app: app.clone() };
                let torrents = app
                    .torrent_engine
                    .list(&app)
                    .into_iter()
                    .filter_map(|torrent| torrents::status_for(&state, torrent).ok())
                    .collect::<Vec<_>>();
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
    let contents = serde_json::to_vec_pretty(&discovery)?;
    crate::store::write_private_file(&discovery_path(data_dir), &contents)?;
    Ok(())
}

fn ensure_api_token(app: &AppState) -> Result<String, ApiError> {
    let existing = app.store.with(|d| d.settings.api_token.clone());
    if let Some(token) = existing.filter(|token| token_is_strong(token)) {
        return Ok(token);
    }
    let token = generate_token()?;
    let persisted = token.clone();
    app.store
        .with_mut(|d| d.settings.api_token = Some(persisted))?;
    Ok(token)
}

fn generate_token() -> Result<String, ApiError> {
    let mut bytes = [0_u8; 32];
    rand::rngs::OsRng
        .try_fill_bytes(&mut bytes)
        .map_err(|error| ApiError::Token(error.to_string()))?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes))
}

fn token_is_strong(token: &str) -> bool {
    if token.len() < 43 {
        return false;
    }
    let mut distinct = [false; 256];
    let mut distinct_count = 0;
    for byte in token.bytes() {
        if !distinct[byte as usize] {
            distinct[byte as usize] = true;
            distinct_count += 1;
        }
    }
    distinct_count >= 12
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    use super::{ApiState, build_router};
    use crate::state::AppState;
    use crate::store::Store;

    #[tokio::test]
    async fn single_torrent_get_is_registered() {
        let directory = tempfile::tempdir().unwrap();
        let app = Arc::new(
            AppState::new(
                Store::load(directory.path()).unwrap(),
                tokio::runtime::Handle::current(),
            )
            .unwrap(),
        );
        *app.api_token.write() = Some("test-token".to_string());
        let response = build_router(ApiState { app })
            .oneshot(
                Request::builder()
                    .uri("/v1/torrents/missing")
                    .header("authorization", "Bearer test-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
}
