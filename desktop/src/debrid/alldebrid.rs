use serde_json::Value;

use super::{DebridError, DebridResult};

const BASE: &str = "https://api.alldebrid.com/v4";

pub async fn unrestrict(client: &reqwest::Client, api_key: &str, url: &str) -> Result<DebridResult, DebridError> {
    let data: Value = client
        .get(format!("{BASE}/link/unlock"))
        .query(&[("agent", "limbo"), ("apikey", api_key), ("link", url)])
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
        .get(format!("{BASE}/magnet/upload"))
        .query(&[("agent", "limbo"), ("apikey", api_key), ("magnets[]", magnet)])
        .send()
        .await?
        .json()
        .await?;

    let Some(id) = upload.pointer("/data/magnets/0/id").and_then(Value::as_i64) else {
        return Ok(Vec::new());
    };
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;

    let status: Value = client
        .get(format!("{BASE}/magnet/status"))
        .query(&[("agent", "limbo"), ("apikey", api_key), ("id", &id.to_string())])
        .send()
        .await?
        .json()
        .await?;

    let links = status
        .pointer("/data/magnets/links")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.get("link").and_then(Value::as_str).map(str::to_string))
        .collect();
    Ok(links)
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
        return Err(DebridError::Message(format!("AllDebrid: {}", error_message(&upload))));
    };

    let files_form = reqwest::multipart::Form::new().text("id[]", id.to_string());
    let files: Value = client
        .post(format!("{BASE}/magnet/files"))
        .bearer_auth(api_key)
        .multipart(files_form)
        .send()
        .await?
        .json()
        .await?;

    let mut links: Vec<String> = files
        .pointer("/data/magnets")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|magnet| magnet.get("files").and_then(Value::as_array).cloned().unwrap_or_default())
        .flat_map(|file| flatten_links(&file))
        .collect();
    if !links.is_empty() {
        return Ok(links);
    }

    let status_form = reqwest::multipart::Form::new().text("id", id.to_string());
    let status: Value = client
        .post("https://api.alldebrid.com/v4.1/magnet/status")
        .bearer_auth(api_key)
        .multipart(status_form)
        .send()
        .await?
        .json()
        .await?;

    links = status
        .pointer("/data/magnets")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|magnet| magnet.get("links").and_then(Value::as_array).cloned().unwrap_or_default())
        .filter_map(|entry| entry.get("link").and_then(Value::as_str).map(str::to_string))
        .collect();
    Ok(links)
}

pub async fn hosts(client: &reqwest::Client, api_key: &str) -> Result<Vec<String>, DebridError> {
    let data: Value = client
        .get(format!("{BASE}/hosts"))
        .query(&[("agent", "limbo"), ("apikey", api_key)])
        .send()
        .await?
        .json()
        .await?;

    if is_error(&data) {
        return Err(DebridError::Message(format!("AllDebrid: {}", error_message(&data))));
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
    if let Some(link) = value.get("link").and_then(Value::as_str) {
        return vec![link.to_string()];
    }
    if let Some(files) = value.get("files").and_then(Value::as_array) {
        return files.iter().flat_map(flatten_links).collect();
    }
    Vec::new()
}
