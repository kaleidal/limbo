mod advertise;
pub mod approval;
pub mod pairing;
mod stream;
mod torrents;

use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::{Mutex, RwLock};

use axum::Router;
use axum::extract::State;
use axum::http::header::{
    ACCEPT_RANGES, AUTHORIZATION, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, HOST,
};
use axum::http::{HeaderMap, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, post};
use base64::Engine;
use rand::TryRng;
use serde::Serialize;
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::sync::{Mutex as AsyncMutex, oneshot};
use tokio::task::JoinHandle;
use tokio_stream::StreamExt;
use tower_http::cors::{Any, CorsLayer};

use crate::state::AppState;
use crate::store::StoreError;
use advertise::Advertiser;
use pairing::Pairing;

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

#[derive(Default)]
pub struct ApiControl {
    token: RwLock<Option<String>>,
    port: Mutex<Option<u16>>,
    rotation: Mutex<()>,
    shutdown: Mutex<Option<oneshot::Sender<()>>>,
    task: AsyncMutex<Option<JoinHandle<()>>>,
    advertiser: Mutex<Option<Advertiser>>,
    pub pairing: Pairing,
}

pub(super) enum Identity {
    Limbo,
    Device(String),
}

/// Who made a request, and the address and token they reached Limbo with, so stream links work for them.
pub(super) struct Caller {
    pub identity: Identity,
    origin: String,
    token: String,
}

impl Caller {
    pub fn stream_url(&self, torrent_id: &str, file_index: usize) -> Option<String> {
        let mut url = reqwest::Url::parse(&format!(
            "{}/v1/torrents/{torrent_id}/stream/{file_index}",
            self.origin
        ))
        .ok()?;
        url.query_pairs_mut().append_pair("token", &self.token);
        Some(url.into())
    }
}

impl ApiControl {
    pub(super) fn authorize(&self, app: &AppState, candidate: &str) -> Option<Identity> {
        let candidate = candidate.trim();
        if self
            .token
            .read()
            .as_deref()
            .is_some_and(|token| candidate == token)
        {
            return Some(Identity::Limbo);
        }
        app.store.with(|data| {
            data.paired_devices
                .iter()
                .find(|device| device.token == candidate)
                .map(|device| Identity::Device(device.id.clone()))
        })
    }

    fn local_origin(&self) -> String {
        let port = self
            .port
            .lock()
            .unwrap_or(crate::store::schema::DEFAULT_API_PORT);
        format!("http://127.0.0.1:{port}")
    }
}

#[derive(Clone)]
pub(super) struct ApiState {
    app: Arc<AppState>,
}

pub struct ApiServer;

impl ApiServer {
    pub async fn start(app: Arc<AppState>, data_dir: PathBuf) -> Result<Option<u16>, ApiError> {
        Self::stop(&app, &data_dir).await;
        let (enabled, lan_enabled, preferred_port) = app.store.with(|d| {
            (
                d.settings.api_enabled,
                d.settings.api_lan_enabled,
                d.settings.api_port,
            )
        });
        if !enabled {
            return Ok(None);
        }

        let token = ensure_api_token(&app)?;
        let state = ApiState { app: app.clone() };

        let router = build_router(state);

        let address = if lan_enabled {
            Ipv4Addr::UNSPECIFIED
        } else {
            Ipv4Addr::LOCALHOST
        };
        let listener = match TcpListener::bind(SocketAddr::from((address, preferred_port))).await {
            Ok(listener) => listener,
            Err(_) if preferred_port != 0 => {
                TcpListener::bind(SocketAddr::from((address, 0))).await?
            }
            Err(err) => return Err(err.into()),
        };
        let port = listener.local_addr()?.port();
        write_discovery(&data_dir, port, &token)?;
        if lan_enabled {
            let instance_id = app.store.with(|d| d.instance_id.clone());
            match Advertiser::start(&instance_id, &instance_name(), port) {
                Ok(advertiser) => *app.api.advertiser.lock() = Some(advertiser),
                Err(error) => tracing::warn!(%error, "could not announce Limbo on the network"),
            }
        }
        *app.api.token.write() = Some(token);
        *app.api.port.lock() = Some(port);

        let (shutdown_sender, shutdown_receiver) = oneshot::channel();
        *app.api.shutdown.lock() = Some(shutdown_sender);
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
        *app.api.task.lock().await = Some(task);

        Ok(Some(port))
    }

    pub async fn reconfigure(app: Arc<AppState>) -> Result<Option<u16>, ApiError> {
        let data_dir = app.store.data_dir()?.to_path_buf();
        Self::start(app, data_dir).await
    }

    async fn stop(app: &AppState, data_dir: &Path) {
        if let Some(shutdown) = app.api.shutdown.lock().take() {
            let _ = shutdown.send(());
        }
        if let Some(mut task) = app.api.task.lock().await.take()
            && tokio::time::timeout(Duration::from_secs(2), &mut task)
                .await
                .is_err()
        {
            task.abort();
            let _ = task.await;
        }
        app.api.advertiser.lock().take();
        app.api.pairing.close();
        *app.api.port.lock() = None;
        if let Err(error) = std::fs::remove_file(discovery_path(data_dir))
            && error.kind() != std::io::ErrorKind::NotFound
        {
            tracing::warn!(%error, "failed to remove API discovery file");
        }
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
            get(stream::stream_torrent).head(stream::stream_torrent),
        )
        .route("/v1/events", get(events))
        .route("/v1/pair", post(pairing::pair).delete(pairing::unpair_self))
        .layer(cors)
        .with_state(state)
}

impl ApiServer {
    pub fn rotate_token(app: &AppState) -> Result<(), ApiError> {
        let _rotation = app.api.rotation.lock();
        let previous = app.store.with(|data| data.settings.api_token.clone());
        let token = generate_token()?;
        let port = *app.api.port.lock();
        if let Some(port) = port {
            write_discovery(app.store.data_dir()?, port, &token)?;
        }
        let persisted = token.clone();
        if let Err(error) = app
            .store
            .with_mut(|data| data.settings.api_token = persisted)
        {
            if let Some(port) = port
                && let Err(rollback_error) = write_discovery(app.store.data_dir()?, port, &previous)
            {
                tracing::error!(%rollback_error, "failed to restore API discovery token");
            }
            return Err(error.into());
        }
        *app.api.token.write() = Some(token);
        Ok(())
    }
}

pub(super) fn check_auth(headers: &HeaderMap, state: &ApiState) -> Option<Caller> {
    let token = headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))?;
    let identity = state.app.api.authorize(&state.app, token)?;
    let origin = headers
        .get(HOST)
        .and_then(|host| host.to_str().ok())
        .filter(|host| {
            reqwest::Url::parse(&format!("http://{host}")).is_ok_and(|url| url.path() == "/")
        })
        .map(|host| format!("http://{host}"))
        .unwrap_or_else(|| state.app.api.local_origin());
    Some(Caller {
        identity,
        origin,
        token: token.trim().to_string(),
    })
}

/// The name devices see for this computer.
pub(super) fn instance_name() -> String {
    whoami::devicename()
        .or_else(|_| whoami::hostname())
        .ok()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "Limbo".to_string())
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

async fn events(State(state): State<ApiState>, headers: HeaderMap) -> Response {
    let Some(caller) = check_auth(&headers, &state) else {
        return unauthorized();
    };

    let app = state.app.clone();
    let stream =
        tokio_stream::wrappers::IntervalStream::new(tokio::time::interval(Duration::from_secs(1)))
            .map(move |_| {
                let state = ApiState { app: app.clone() };
                let torrents = app
                    .torrent_engine
                    .list(&app)
                    .into_iter()
                    .filter_map(|torrent| torrents::status_for(&state, &caller, torrent).ok())
                    .collect::<Vec<_>>();
                let event = Event::default()
                    .event("progress")
                    .json_data(json!({ "torrents": torrents }))
                    .unwrap_or_else(|_| Event::default());
                Ok::<_, std::convert::Infallible>(event)
            });

    Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response()
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
    if token_is_strong(&existing) {
        return Ok(existing);
    }
    let token = generate_token()?;
    let persisted = token.clone();
    app.store.with_mut(|d| d.settings.api_token = persisted)?;
    Ok(token)
}

pub(super) fn generate_token() -> Result<String, ApiError> {
    let mut bytes = [0_u8; 32];
    rand::rngs::SysRng
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
