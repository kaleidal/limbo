use serde::Deserialize;

pub const CLIENT_ID: &str = "X245A4XAIBGVM";
const BASE: &str = "https://api.real-debrid.com";
const OAUTH_BASE: &str = "https://api.real-debrid.com/oauth/v2";

#[derive(Debug, Deserialize, Default)]
pub struct UnrestrictResponse {
    pub error: Option<String>,
    pub download: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
pub struct TorrentAddResponse {
    pub id: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
pub struct TorrentInfoResponse {
    pub links: Option<Vec<String>>,
    pub status: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
pub struct TokenResponse {
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub expires_in: Option<i64>,
}

#[derive(Debug, Deserialize, Default)]
pub struct DeviceCodeResponse {
    pub device_code: Option<String>,
    pub user_code: Option<String>,
    pub verification_url: Option<String>,
    pub interval: Option<u64>,
    pub expires_in: Option<u64>,
}

#[derive(Debug, Deserialize, Default)]
pub struct DeviceCredentialsResponse {
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
}

pub fn friendly_error(error: &str) -> String {
    if error.starts_with("ip_not_allowed") {
        "Real-Debrid: IP not allowed. Regenerate API key from current IP or disable VPN."
            .to_string()
    } else if error == "hoster_unavailable" || error == "link_host_not_supported" {
        "Real-Debrid: This file host is not supported.".to_string()
    } else if error == "bad_token" || error == "bad_token_check" {
        "Real-Debrid: Auth token invalid or expired. Please re-link account.".to_string()
    } else {
        error.to_string()
    }
}

pub async fn unrestrict(
    client: &reqwest::Client,
    api_key: &str,
    url: &str,
) -> Result<UnrestrictResponse, reqwest::Error> {
    client
        .post(format!("{BASE}/rest/1.0/unrestrict/link"))
        .bearer_auth(api_key)
        .form(&[("link", url)])
        .send()
        .await?
        .json()
        .await
}

pub async fn add_magnet(
    client: &reqwest::Client,
    api_key: &str,
    magnet: &str,
) -> Result<TorrentAddResponse, reqwest::Error> {
    client
        .post(format!("{BASE}/rest/1.0/torrents/addMagnet"))
        .bearer_auth(api_key)
        .form(&[("magnet", magnet)])
        .send()
        .await?
        .json()
        .await
}

pub async fn add_torrent_file(
    client: &reqwest::Client,
    api_key: &str,
    bytes: Vec<u8>,
) -> Result<TorrentAddResponse, reqwest::Error> {
    client
        .put(format!("{BASE}/rest/1.0/torrents/addTorrent"))
        .bearer_auth(api_key)
        .body(bytes)
        .send()
        .await?
        .json()
        .await
}

pub async fn select_files(
    client: &reqwest::Client,
    api_key: &str,
    id: &str,
) -> Result<(), reqwest::Error> {
    client
        .post(format!("{BASE}/rest/1.0/torrents/selectFiles/{id}"))
        .bearer_auth(api_key)
        .form(&[("files", "all")])
        .send()
        .await?
        .error_for_status()?;
    Ok(())
}

pub async fn torrent_info(
    client: &reqwest::Client,
    api_key: &str,
    id: &str,
) -> Result<TorrentInfoResponse, reqwest::Error> {
    client
        .get(format!("{BASE}/rest/1.0/torrents/info/{id}"))
        .bearer_auth(api_key)
        .send()
        .await?
        .json()
        .await
}

pub async fn hosts(client: &reqwest::Client, api_key: &str) -> Result<Vec<String>, reqwest::Error> {
    let data: serde_json::Map<String, serde_json::Value> = client
        .get(format!("{BASE}/rest/1.0/hosts"))
        .bearer_auth(api_key)
        .send()
        .await?
        .json()
        .await?;
    Ok(data.keys().filter(|h| h.contains('.')).cloned().collect())
}

pub async fn device_code(client: &reqwest::Client) -> Result<DeviceCodeResponse, reqwest::Error> {
    client
        .get(format!("{OAUTH_BASE}/device/code"))
        .query(&[("client_id", CLIENT_ID), ("new_credentials", "yes")])
        .send()
        .await?
        .json()
        .await
}

pub async fn device_credentials(
    client: &reqwest::Client,
    device_code: &str,
) -> Result<Option<DeviceCredentialsResponse>, reqwest::Error> {
    let response = client
        .get(format!("{OAUTH_BASE}/device/credentials"))
        .query(&[("client_id", CLIENT_ID), ("code", device_code)])
        .send()
        .await?;
    if !response.status().is_success() {
        return Ok(None);
    }
    Ok(response.json().await.ok())
}

pub async fn exchange_device_code(
    client: &reqwest::Client,
    client_id: &str,
    client_secret: &str,
    device_code: &str,
) -> Result<TokenResponse, reqwest::Error> {
    let form = [
        ("client_id", client_id),
        ("client_secret", client_secret),
        ("code", device_code),
        ("grant_type", "http://oauth.net/grant_type/device/1.0"),
    ];
    post_token(client, &form).await
}

pub async fn refresh_token(
    client: &reqwest::Client,
    client_id: &str,
    client_secret: &str,
    refresh_token: &str,
) -> Result<TokenResponse, reqwest::Error> {
    let form = [
        ("client_id", client_id),
        ("client_secret", client_secret),
        ("code", refresh_token),
        ("grant_type", "http://oauth.net/grant_type/device/1.0"),
    ];
    post_token(client, &form).await
}

async fn post_token(
    client: &reqwest::Client,
    form: &[(&str, &str)],
) -> Result<TokenResponse, reqwest::Error> {
    client
        .post(format!("{OAUTH_BASE}/token"))
        .form(form)
        .send()
        .await?
        .json()
        .await
}
