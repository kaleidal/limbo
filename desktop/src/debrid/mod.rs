mod alldebrid;
mod premiumize;
mod realdebrid;
mod torbox;

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use serde::Serialize;

use crate::state::AppState;
use crate::store::schema::DebridSettings;

#[derive(Debug, thiserror::Error)]
pub enum DebridError {
    #[error("no debrid service configured")]
    NotConfigured,
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("store error: {0}")]
    Store(#[from] crate::store::StoreError),
    #[error("{0}")]
    Message(String),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebridResult {
    pub url: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RdDeviceStart {
    pub user_code: String,
    pub verification_url: String,
    pub interval: u64,
    pub expires_in: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status")]
pub enum RdDevicePoll {
    #[serde(rename = "idle")]
    Idle,
    #[serde(rename = "pending")]
    Pending,
    #[serde(rename = "expired")]
    Expired { error: String },
    #[serde(rename = "error")]
    Error { error: String },
    #[serde(rename = "success")]
    Success {
        #[serde(rename = "accessToken")]
        access_token: String,
    },
}

#[derive(Debug, Clone)]
struct RdDeviceState {
    device_code: String,
    expires_at: Instant,
}

pub struct DebridService {
    client: reqwest::Client,
    rd_device: Mutex<Option<RdDeviceState>>,
}

impl DebridService {
    pub fn new() -> Result<Self, reqwest::Error> {
        Ok(Self {
            client: reqwest::Client::builder()
                .use_rustls_tls()
                .connect_timeout(Duration::from_secs(15))
                .timeout(Duration::from_secs(60))
                .build()?,
            rd_device: Mutex::new(None),
        })
    }

    pub fn is_configured(&self, app: &AppState) -> bool {
        app.store
            .with(|d| d.settings.debrid.service.is_some() && !d.settings.debrid.api_key.is_empty())
    }

    pub fn is_torrent_supported(&self, app: &AppState) -> bool {
        app.store.with(|d| {
            matches!(
                d.settings.debrid.service.as_deref(),
                Some("realdebrid") | Some("alldebrid") | Some("torbox")
            ) && !d.settings.debrid.api_key.is_empty()
        })
    }

    pub async fn is_url_supported(&self, app: &AppState, url: &str) -> bool {
        let Ok(hosts) = self.get_supported_hosts(app).await else {
            return false;
        };
        if hosts.is_empty() {
            return false;
        }
        let Some(host) = reqwest::Url::parse(url)
            .ok()
            .and_then(|u| u.host_str().map(str::to_lowercase))
        else {
            return false;
        };
        hosts.iter().any(|h| {
            let h = h.to_lowercase();
            host == h || host.ends_with(&format!(".{h}"))
        })
    }

    pub async fn unrestrict_link(
        &self,
        app: &AppState,
        url: &str,
    ) -> Result<DebridResult, DebridError> {
        let cfg = self.resolved_config(app).await?;
        match cfg.service.as_deref() {
            Some("realdebrid") => self.rd_unrestrict(app, &cfg, url).await,
            Some("alldebrid") => alldebrid::unrestrict(&self.client, &cfg.api_key, url).await,
            Some("premiumize") => premiumize::unrestrict(&self.client, &cfg.api_key, url).await,
            Some("torbox") => torbox::unrestrict(&self.client, &cfg.api_key, url).await,
            _ => Err(DebridError::NotConfigured),
        }
    }

    pub async fn convert_magnet(
        &self,
        app: &AppState,
        magnet_uri: &str,
    ) -> Result<Vec<String>, DebridError> {
        let cfg = self.resolved_config(app).await?;
        match cfg.service.as_deref() {
            Some("realdebrid") => self.rd_convert_magnet(app, cfg, magnet_uri).await,
            Some("alldebrid") => {
                alldebrid::convert_magnet(&self.client, &cfg.api_key, magnet_uri).await
            }
            Some("premiumize") => {
                premiumize::convert_magnet(&self.client, &cfg.api_key, magnet_uri).await
            }
            Some("torbox") => torbox::convert_magnet(&self.client, &cfg.api_key, magnet_uri).await,
            _ => Err(DebridError::NotConfigured),
        }
    }

    pub async fn convert_torrent_file(
        &self,
        app: &AppState,
        torrent_url: &str,
    ) -> Result<Vec<String>, DebridError> {
        let cfg = self.resolved_config(app).await?;
        if !matches!(
            cfg.service.as_deref(),
            Some("realdebrid") | Some("alldebrid") | Some("torbox")
        ) {
            return Err(DebridError::Message(
                "Debrid service does not support torrent files".to_string(),
            ));
        }

        let filename = derive_torrent_filename(torrent_url);
        let bytes = crate::net::fetch_public_bounded(
            torrent_url,
            10 * 1024 * 1024,
            Duration::from_secs(60),
        )
        .await
        .map_err(|error| DebridError::Message(format!("Unable to fetch torrent: {error}")))?
        .bytes;
        if bytes.is_empty() {
            return Err(DebridError::Message(
                "Fetched torrent file was empty".to_string(),
            ));
        }

        match cfg.service.as_deref() {
            Some("realdebrid") => self.rd_convert_torrent_file(app, cfg, bytes).await,
            Some("alldebrid") => {
                alldebrid::convert_torrent_file(&self.client, &cfg.api_key, &filename, bytes).await
            }
            Some("torbox") => {
                torbox::convert_torrent_file(&self.client, &cfg.api_key, &filename, bytes).await
            }
            _ => Err(DebridError::NotConfigured),
        }
    }

    pub async fn get_supported_hosts(&self, app: &AppState) -> Result<Vec<String>, DebridError> {
        let cfg = self.resolved_config(app).await?;
        match cfg.service.as_deref() {
            Some("realdebrid") => Ok(realdebrid::hosts(&self.client, &cfg.api_key).await?),
            Some("alldebrid") => alldebrid::hosts(&self.client, &cfg.api_key).await,
            Some("premiumize") => premiumize::hosts(&self.client, &cfg.api_key).await,
            Some("torbox") => torbox::hosts(&self.client, &cfg.api_key).await,
            _ => Err(DebridError::NotConfigured),
        }
    }

    pub async fn start_realdebrid_device(&self) -> Result<RdDeviceStart, DebridError> {
        let data = realdebrid::device_code(&self.client).await?;
        let (Some(device_code), Some(user_code), Some(verification_url)) =
            (data.device_code, data.user_code, data.verification_url)
        else {
            return Err(DebridError::Message(
                "Real-Debrid: Unexpected device code response".to_string(),
            ));
        };

        let interval = data.interval.unwrap_or(5);
        let expires_in = data.expires_in.unwrap_or(600);
        *self.rd_device.lock() = Some(RdDeviceState {
            device_code,
            expires_at: Instant::now() + Duration::from_secs(expires_in),
        });

        Ok(RdDeviceStart {
            user_code,
            verification_url,
            interval,
            expires_in,
        })
    }

    pub fn cancel_realdebrid_device(&self) {
        *self.rd_device.lock() = None;
    }

    pub async fn poll_realdebrid_device(
        &self,
        app: &AppState,
    ) -> Result<RdDevicePoll, DebridError> {
        let Some(state) = self.rd_device.lock().clone() else {
            return Ok(RdDevicePoll::Idle);
        };

        if Instant::now() >= state.expires_at {
            *self.rd_device.lock() = None;
            return Ok(RdDevicePoll::Expired {
                error: "Real-Debrid: Device code expired".to_string(),
            });
        }

        let Some(creds) = realdebrid::device_credentials(&self.client, &state.device_code).await?
        else {
            return Ok(RdDevicePoll::Pending);
        };
        let (Some(client_id), Some(client_secret)) = (creds.client_id, creds.client_secret) else {
            return Ok(RdDevicePoll::Pending);
        };

        let token = realdebrid::exchange_device_code(
            &self.client,
            &client_id,
            &client_secret,
            &state.device_code,
        )
        .await?;
        let Some(access_token) = token.access_token.clone() else {
            return Ok(RdDevicePoll::Error {
                error: "Real-Debrid: No access_token returned".to_string(),
            });
        };

        let expires_at = now_ms() + token.expires_in.unwrap_or(0) * 1000;
        app.store.with_mut(|d| {
            d.settings.debrid = DebridSettings {
                service: Some("realdebrid".to_string()),
                api_key: access_token.clone(),
                refresh_token: token.refresh_token.clone(),
                expires_at: Some(expires_at),
                client_id: Some(client_id),
                client_secret: Some(client_secret),
            };
        })?;

        *self.rd_device.lock() = None;
        Ok(RdDevicePoll::Success { access_token })
    }

    async fn resolved_config(&self, app: &AppState) -> Result<DebridSettings, DebridError> {
        let cfg = app.store.with(|d| d.settings.debrid.clone());
        if cfg.service.is_none() {
            return Err(DebridError::NotConfigured);
        }
        if cfg.service.as_deref() != Some("realdebrid") {
            return Ok(cfg);
        }
        let Some(expires_at) = cfg.expires_at else {
            return Ok(cfg);
        };
        if now_ms() < expires_at - 5 * 60 * 1000 {
            return Ok(cfg);
        }
        Ok(self.try_refresh_realdebrid(app, &cfg).await?.unwrap_or(cfg))
    }

    async fn try_refresh_realdebrid(
        &self,
        app: &AppState,
        cfg: &DebridSettings,
    ) -> Result<Option<DebridSettings>, DebridError> {
        let (Some(refresh_token), Some(client_id), Some(client_secret)) = (
            cfg.refresh_token.clone(),
            cfg.client_id.clone(),
            cfg.client_secret.clone(),
        ) else {
            return Ok(None);
        };

        let token =
            realdebrid::refresh_token(&self.client, &client_id, &client_secret, &refresh_token)
                .await?;
        let (Some(access_token), Some(new_refresh)) = (token.access_token, token.refresh_token)
        else {
            return Ok(None);
        };

        let mut next = cfg.clone();
        next.api_key = access_token;
        next.refresh_token = Some(new_refresh);
        next.expires_at = Some(now_ms() + token.expires_in.unwrap_or(0) * 1000);
        let persisted = next.clone();
        app.store.with_mut(|d| d.settings.debrid = persisted)?;
        Ok(Some(next))
    }

    async fn rd_unrestrict(
        &self,
        app: &AppState,
        cfg: &DebridSettings,
        url: &str,
    ) -> Result<DebridResult, DebridError> {
        let mut api_key = cfg.api_key.clone();
        let mut data = realdebrid::unrestrict(&self.client, &api_key, url).await?;
        if matches!(
            data.error.as_deref(),
            Some("bad_token") | Some("bad_token_check")
        ) && let Some(refreshed) = self.try_refresh_realdebrid(app, cfg).await?
        {
            api_key = refreshed.api_key;
            data = realdebrid::unrestrict(&self.client, &api_key, url).await?;
        }

        if let Some(err) = data.error {
            return Ok(DebridResult {
                url: None,
                error: Some(realdebrid::friendly_error(&err)),
            });
        }
        Ok(DebridResult {
            url: data.download,
            error: None,
        })
    }

    async fn rd_convert_magnet(
        &self,
        app: &AppState,
        cfg: DebridSettings,
        magnet: &str,
    ) -> Result<Vec<String>, DebridError> {
        let add = realdebrid::add_magnet(&self.client, &cfg.api_key, magnet).await?;
        let Some(id) = add.id else {
            return Err(DebridError::Message(add.error.unwrap_or_else(|| {
                "Real-Debrid: magnet upload failed".to_string()
            })));
        };
        realdebrid::select_files(&self.client, &cfg.api_key, &id).await?;
        let links = self.wait_for_realdebrid_torrent(&cfg.api_key, &id).await?;
        self.unrestrict_all(app, links).await
    }

    async fn rd_convert_torrent_file(
        &self,
        app: &AppState,
        cfg: DebridSettings,
        bytes: Vec<u8>,
    ) -> Result<Vec<String>, DebridError> {
        let add = realdebrid::add_torrent_file(&self.client, &cfg.api_key, bytes).await?;
        let Some(id) = add.id else {
            return Err(DebridError::Message(add.error.unwrap_or_else(|| {
                "Real-Debrid: torrent upload failed".to_string()
            })));
        };
        realdebrid::select_files(&self.client, &cfg.api_key, &id).await?;
        let links = self.wait_for_realdebrid_torrent(&cfg.api_key, &id).await?;
        self.unrestrict_all(app, links).await
    }

    async fn wait_for_realdebrid_torrent(
        &self,
        api_key: &str,
        id: &str,
    ) -> Result<Vec<String>, DebridError> {
        for _ in 0..24 {
            let info = realdebrid::torrent_info(&self.client, api_key, id).await?;
            if let Some(error) = info.error {
                return Err(DebridError::Message(format!("Real-Debrid: {error}")));
            }
            let status = info.status.as_deref().unwrap_or_default();
            if matches!(status, "magnet_error" | "error" | "virus" | "dead") {
                return Err(DebridError::Message(format!(
                    "Real-Debrid torrent failed: {status}"
                )));
            }
            if status == "downloaded" {
                let links = info.links.unwrap_or_default();
                if links.is_empty() {
                    return Err(DebridError::Message(
                        "Real-Debrid torrent completed without downloadable links".to_string(),
                    ));
                }
                return Ok(links);
            }
            tokio::time::sleep(Duration::from_millis(2500)).await;
        }
        Err(DebridError::Message(
            "Real-Debrid torrent did not become ready in time".to_string(),
        ))
    }

    async fn unrestrict_all(
        &self,
        app: &AppState,
        links: Vec<String>,
    ) -> Result<Vec<String>, DebridError> {
        let mut resolved = Vec::new();
        for link in links {
            let cfg = self.resolved_config(app).await?;
            match self.rd_unrestrict(app, &cfg, &link).await {
                Ok(result) => match (result.url, result.error) {
                    (Some(url), _) => resolved.push(url),
                    (_, Some(error)) => {
                        tracing::warn!(%error, "failed to unrestrict Real-Debrid link")
                    }
                    _ => tracing::warn!("Real-Debrid returned no URL for link"),
                },
                Err(error) => tracing::warn!(%error, "failed to unrestrict Real-Debrid link"),
            }
        }
        Ok(resolved)
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn derive_torrent_filename(url: &str) -> String {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|u| {
            u.path_segments()
                .and_then(|mut segs| segs.next_back().map(str::to_string))
        })
        .filter(|s| !s.is_empty())
        .map(|name| {
            if name.to_lowercase().ends_with(".torrent") {
                name
            } else {
                format!("{name}.torrent")
            }
        })
        .unwrap_or_else(|| "remote.torrent".to_string())
}
