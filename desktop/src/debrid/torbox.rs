use serde_json::Value;

use super::{DebridError, DebridResult};

const BASE: &str = "https://api.torbox.app/v1/api";

pub async fn unrestrict(client: &reqwest::Client, api_key: &str, url: &str) -> Result<DebridResult, DebridError> {
    let form = reqwest::multipart::Form::new().text("link", url.to_string());
    let created: Value = client
        .post(format!("{BASE}/webdl/createwebdownload"))
        .bearer_auth(api_key)
        .multipart(form)
        .send()
        .await?
        .json()
        .await?;

    let ok = created.get("success").and_then(Value::as_bool).unwrap_or(false);
    let web_id = created.pointer("/data/webdownload_id").and_then(value_as_id);
    let Some(web_id) = web_id.filter(|_| ok) else {
        return Ok(DebridResult {
            url: None,
            error: Some(format!("TorBox: {}", error_message(&created))),
        });
    };

    let info = match wait_ready(client, api_key, "webdl", web_id).await {
        Ok(info) => info,
        Err(message) => {
            return Ok(DebridResult {
                url: None,
                error: Some(format!("TorBox: {message}")),
            });
        }
    };
    let file_id = info.pointer("/files/0/id").and_then(Value::as_i64);

    match request_link(client, api_key, "webdl", web_id, file_id).await? {
        Some(link) => Ok(DebridResult {
            url: Some(link),
            error: None,
        }),
        None => Ok(DebridResult {
            url: None,
            error: Some("TorBox: No download link returned.".to_string()),
        }),
    }
}

pub async fn convert_magnet(
    client: &reqwest::Client,
    api_key: &str,
    magnet: &str,
) -> Result<Vec<String>, DebridError> {
    let form = reqwest::multipart::Form::new().text("magnet", magnet.to_string());
    let created: Value = client
        .post(format!("{BASE}/torrents/createtorrent"))
        .bearer_auth(api_key)
        .multipart(form)
        .send()
        .await?
        .json()
        .await?;
    finish_torrent_creation(client, api_key, created).await
}

pub async fn convert_torrent_file(
    client: &reqwest::Client,
    api_key: &str,
    filename: &str,
    bytes: Vec<u8>,
) -> Result<Vec<String>, DebridError> {
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(filename.to_string())
        .mime_str("application/x-bittorrent")
        .map_err(|e| DebridError::Message(e.to_string()))?;
    let form = reqwest::multipart::Form::new().part("file", part);
    let created: Value = client
        .post(format!("{BASE}/torrents/createtorrent"))
        .bearer_auth(api_key)
        .multipart(form)
        .send()
        .await?
        .json()
        .await?;
    finish_torrent_creation(client, api_key, created).await
}

pub async fn hosts(client: &reqwest::Client, api_key: &str) -> Result<Vec<String>, DebridError> {
    let data: Value = client
        .get(format!("{BASE}/webdl/hosters"))
        .bearer_auth(api_key)
        .send()
        .await?
        .json()
        .await?;

    if !data.get("success").and_then(Value::as_bool).unwrap_or(false) {
        return Err(DebridError::Message(format!("TorBox: {}", error_message(&data))));
    }

    let mut hosts: Vec<String> = Vec::new();
    if let Some(arr) = data.get("data").and_then(Value::as_array) {
        for entry in arr {
            let up = entry.get("status").and_then(Value::as_bool).unwrap_or(false)
                || entry
                    .get("status")
                    .and_then(Value::as_str)
                    .is_some_and(|s| s == "up" || s == "green");
            if !up {
                continue;
            }
            if let Some(domains) = entry.get("domains").and_then(Value::as_array) {
                for domain in domains {
                    if let Some(d) = domain.as_str() {
                        if d.contains('.') {
                            hosts.push(d.to_string());
                        }
                    }
                }
            }
        }
    }
    hosts.sort();
    hosts.dedup();
    Ok(hosts)
}

async fn finish_torrent_creation(
    client: &reqwest::Client,
    api_key: &str,
    created: Value,
) -> Result<Vec<String>, DebridError> {
    let ok = created.get("success").and_then(Value::as_bool).unwrap_or(false);
    let torrent_id = created.pointer("/data/torrent_id").and_then(value_as_id);
    let Some(torrent_id) = torrent_id.filter(|_| ok) else {
        return Err(DebridError::Message(format!("TorBox: {}", error_message(&created))));
    };

    let info = wait_ready(client, api_key, "torrents", torrent_id)
        .await
        .map_err(DebridError::Message)?;
    let files = info.get("files").and_then(Value::as_array).cloned().unwrap_or_default();

    let mut links = Vec::new();
    for file in files {
        if let Some(file_id) = file.get("id").and_then(Value::as_i64) {
            if let Some(link) = request_link(client, api_key, "torrents", torrent_id, Some(file_id)).await? {
                links.push(link);
            }
        }
    }
    Ok(links)
}

async fn wait_ready(client: &reqwest::Client, api_key: &str, kind: &str, id: i64) -> Result<Value, String> {
    let mut last_state = String::new();
    for _ in 0..12 {
        let info: Value = client
            .get(format!("{BASE}/{kind}/mylist"))
            .bearer_auth(api_key)
            .query(&[("id", id.to_string().as_str()), ("bypass_cache", "true")])
            .send()
            .await
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?;

        if let Some(entry) = pick_entry(&info, id) {
            let state = entry
                .get("download_state")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_lowercase();
            last_state = state.clone();
            let finished = entry.get("download_finished").and_then(Value::as_bool).unwrap_or(false)
                || entry.get("download_present").and_then(Value::as_bool).unwrap_or(false)
                || state.contains("cached")
                || state.contains("completed")
                || state.contains("uploading");
            if finished {
                return Ok(entry);
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(2500)).await;
    }
    Err(if last_state.is_empty() {
        "torrent not ready yet".to_string()
    } else {
        format!("torrent not ready yet ({last_state})")
    })
}

fn pick_entry(payload: &Value, id: i64) -> Option<Value> {
    let data = payload.get("data")?;
    if let Some(arr) = data.as_array() {
        return arr
            .iter()
            .find(|item| item.get("id").and_then(Value::as_i64) == Some(id))
            .or_else(|| arr.first())
            .cloned();
    }
    Some(data.clone())
}

async fn request_link(
    client: &reqwest::Client,
    api_key: &str,
    kind: &str,
    id: i64,
    file_id: Option<i64>,
) -> Result<Option<String>, DebridError> {
    let id_field = if kind == "webdl" { "web_id" } else { "torrent_id" };
    let mut query = vec![
        ("token".to_string(), api_key.to_string()),
        (id_field.to_string(), id.to_string()),
    ];
    match file_id {
        Some(fid) => query.push(("file_id".to_string(), fid.to_string())),
        None => query.push(("zip_link".to_string(), "true".to_string())),
    }

    let data: Value = client
        .get(format!("{BASE}/{kind}/requestdl"))
        .query(&query)
        .send()
        .await?
        .json()
        .await?;
    if !data.get("success").and_then(Value::as_bool).unwrap_or(false) {
        return Ok(None);
    }
    Ok(data.get("data").and_then(Value::as_str).map(str::to_string))
}

fn value_as_id(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| value.as_str().and_then(|s| s.parse().ok()))
}

fn error_message(payload: &Value) -> String {
    payload
        .get("error")
        .and_then(Value::as_str)
        .or_else(|| payload.get("detail").and_then(Value::as_str))
        .unwrap_or("request failed")
        .to_string()
}
