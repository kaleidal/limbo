use serde_json::Value;

use super::{DebridError, DebridResult};

const BASE: &str = "https://api.alldebrid.com/v4";
const STATUS_BASE: &str = "https://api.alldebrid.com/v4.1";

pub async fn unrestrict(
    client: &reqwest::Client,
    api_key: &str,
    url: &str,
) -> Result<DebridResult, DebridError> {
    let data: Value = client
        .get(format!("{BASE}/link/unlock"))
        .bearer_auth(api_key)
        .query(&[("agent", "limbo"), ("link", url)])
        .send()
        .await?
        .json()
        .await?;

    if is_error(&data) {
        return Ok(DebridResult {
            url: None,
            error: Some(format!("AllDebrid: {}", error_message(&data))),
        });
    }
    match data.pointer("/data/link").and_then(Value::as_str) {
        Some(link) => Ok(DebridResult {
            url: Some(link.to_string()),
            error: None,
        }),
        None => Ok(DebridResult {
            url: None,
            error: Some("AllDebrid: No download link returned.".to_string()),
        }),
    }
}

pub async fn convert_magnet(
    client: &reqwest::Client,
    api_key: &str,
    magnet: &str,
) -> Result<Vec<String>, DebridError> {
    let upload: Value = client
        .post(format!("{BASE}/magnet/upload"))
        .bearer_auth(api_key)
        .form(&[("agent", "limbo"), ("magnets[]", magnet)])
        .send()
        .await?
        .json()
        .await?;

    let Some(id) = upload.pointer("/data/magnets/0/id").and_then(Value::as_i64) else {
        return Err(DebridError::Message(format!(
            "AllDebrid: {}",
            error_message(&upload)
        )));
    };
    wait_for_links(client, api_key, id).await
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
    let form = reqwest::multipart::Form::new().part("files[]", part);
    let upload: Value = client
        .post(format!("{BASE}/magnet/upload/file"))
        .bearer_auth(api_key)
        .multipart(form)
        .send()
        .await?
        .json()
        .await?;

    let Some(id) = upload.pointer("/data/files/0/id").and_then(Value::as_i64) else {
        return Err(DebridError::Message(format!(
            "AllDebrid: {}",
            error_message(&upload)
        )));
    };

    wait_for_links(client, api_key, id).await
}

pub async fn hosts(client: &reqwest::Client, api_key: &str) -> Result<Vec<String>, DebridError> {
    let data: Value = client
        .get(format!("{BASE}/hosts"))
        .bearer_auth(api_key)
        .query(&[("agent", "limbo")])
        .send()
        .await?
        .json()
        .await?;

    if is_error(&data) {
        return Err(DebridError::Message(format!(
            "AllDebrid: {}",
            error_message(&data)
        )));
    }

    let mut hosts = Vec::new();
    if let Some(map) = data.pointer("/data/hosts").and_then(Value::as_object) {
        for entry in map.values() {
            if let Some(domain) = entry.get("domain").and_then(Value::as_str) {
                hosts.push(domain.to_string());
            }
        }
    } else if let Some(arr) = data.pointer("/data/hosts").and_then(Value::as_array) {
        for entry in arr {
            if let Some(domain) = entry.get("domain").and_then(Value::as_str) {
                hosts.push(domain.to_string());
            }
        }
    }
    Ok(hosts)
}

fn is_error(data: &Value) -> bool {
    data.get("status").and_then(Value::as_str) == Some("error") || data.get("error").is_some()
}

fn error_message(data: &Value) -> String {
    data.pointer("/error/message")
        .and_then(Value::as_str)
        .or_else(|| data.get("error").and_then(Value::as_str))
        .unwrap_or("Unknown error")
        .to_string()
}

fn flatten_links(value: &Value) -> Vec<String> {
    if let Some(link) = value.get("l").and_then(Value::as_str) {
        return vec![link.to_string()];
    }
    if let Some(files) = value.get("e").and_then(Value::as_array) {
        return files.iter().flat_map(flatten_links).collect();
    }
    Vec::new()
}

async fn wait_for_links(
    client: &reqwest::Client,
    api_key: &str,
    id: i64,
) -> Result<Vec<String>, DebridError> {
    for _ in 0..24 {
        let status: Value = client
            .post(format!("{STATUS_BASE}/magnet/status"))
            .bearer_auth(api_key)
            .form(&[("id", id.to_string())])
            .send()
            .await?
            .json()
            .await?;
        if is_error(&status) {
            return Err(DebridError::Message(format!(
                "AllDebrid: {}",
                error_message(&status)
            )));
        }
        let magnet = status.pointer("/data/magnets").and_then(|value| {
            value
                .as_array()
                .and_then(|items| items.first())
                .or(Some(value))
        });
        let status_code = magnet
            .and_then(|item| item.get("statusCode"))
            .and_then(Value::as_i64);
        if status_code == Some(4) {
            let files: Value = client
                .post(format!("{BASE}/magnet/files"))
                .bearer_auth(api_key)
                .form(&[("id[]", id.to_string())])
                .send()
                .await?
                .json()
                .await?;
            if is_error(&files) {
                return Err(DebridError::Message(format!(
                    "AllDebrid: {}",
                    error_message(&files)
                )));
            }
            let links = files
                .pointer("/data/magnets")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .flat_map(|magnet| {
                    magnet
                        .get("files")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .flat_map(flatten_links)
                })
                .collect::<Vec<_>>();
            if links.is_empty() {
                return Err(DebridError::Message(
                    "AllDebrid torrent completed without downloadable links".to_string(),
                ));
            }
            return Ok(links);
        }
        if status_code.is_some_and(|code| (5..=15).contains(&code)) {
            let message = magnet
                .and_then(|item| item.get("status"))
                .and_then(Value::as_str)
                .unwrap_or("torrent failed");
            return Err(DebridError::Message(format!("AllDebrid: {message}")));
        }
        tokio::time::sleep(std::time::Duration::from_millis(2500)).await;
    }
    Err(DebridError::Message(
        "AllDebrid torrent did not become ready in time".to_string(),
    ))
}
