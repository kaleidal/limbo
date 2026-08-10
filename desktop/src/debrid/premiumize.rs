use serde_json::Value;

use super::{DebridError, DebridResult};

const BASE: &str = "https://www.premiumize.me/api";

pub async fn unrestrict(
    client: &reqwest::Client,
    api_key: &str,
    url: &str,
) -> Result<DebridResult, DebridError> {
    let data: Value = client
        .post(format!("{BASE}/transfer/directdl"))
        .bearer_auth(api_key)
        .form(&[("src", url)])
        .send()
        .await?
        .json()
        .await?;

    if data.get("status").and_then(Value::as_str) != Some("success") {
        return Ok(DebridResult {
            url: None,
            error: Some(format!("Premiumize: {}", error_message(&data))),
        });
    }
    match data.pointer("/content/0/link").and_then(Value::as_str) {
        Some(link) => Ok(DebridResult {
            url: Some(link.to_string()),
            error: None,
        }),
        None => Ok(DebridResult {
            url: None,
            error: Some("Premiumize: No download link returned.".to_string()),
        }),
    }
}

pub async fn convert_magnet(
    client: &reqwest::Client,
    api_key: &str,
    magnet: &str,
) -> Result<Vec<String>, DebridError> {
    let created: Value = client
        .post(format!("{BASE}/transfer/create"))
        .bearer_auth(api_key)
        .form(&[("src", magnet)])
        .send()
        .await?
        .json()
        .await?;

    let Some(id) = created
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_string)
    else {
        return Err(DebridError::Message(format!(
            "Premiumize: {}",
            error_message(&created)
        )));
    };
    let mut folder_id = None;
    for _ in 0..24 {
        let list: Value = client
            .get(format!("{BASE}/transfer/list"))
            .bearer_auth(api_key)
            .send()
            .await?
            .json()
            .await?;
        let transfer = list
            .get("transfers")
            .and_then(Value::as_array)
            .and_then(|items| {
                items
                    .iter()
                    .find(|item| item.get("id").and_then(Value::as_str) == Some(id.as_str()))
            });
        match transfer
            .and_then(|item| item.get("status"))
            .and_then(Value::as_str)
        {
            Some("finished" | "seeding") => {
                folder_id = transfer
                    .and_then(|item| item.get("folder_id"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
                break;
            }
            Some("error") => {
                return Err(DebridError::Message(format!(
                    "Premiumize: {}",
                    transfer
                        .map(error_message)
                        .unwrap_or_else(|| "transfer failed".to_string())
                )));
            }
            _ => tokio::time::sleep(std::time::Duration::from_millis(2500)).await,
        }
    }
    let Some(folder_id) = folder_id else {
        return Err(DebridError::Message(
            "Premiumize transfer did not become ready in time".to_string(),
        ));
    };

    let folder: Value = client
        .get(format!("{BASE}/folder/list"))
        .bearer_auth(api_key)
        .query(&[("id", folder_id.as_str())])
        .send()
        .await?
        .json()
        .await?;

    if folder.get("status").and_then(Value::as_str) == Some("error") {
        return Err(DebridError::Message(format!(
            "Premiumize: {}",
            error_message(&folder)
        )));
    }

    let links = folder
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("link").and_then(Value::as_str).map(str::to_string))
        .collect();
    Ok(links)
}

pub async fn hosts(client: &reqwest::Client, api_key: &str) -> Result<Vec<String>, DebridError> {
    let data: Value = client
        .get(format!("{BASE}/services/list"))
        .bearer_auth(api_key)
        .send()
        .await?
        .json()
        .await?;

    if data.get("status").and_then(Value::as_str) != Some("success") {
        return Err(DebridError::Message(format!(
            "Premiumize: {}",
            error_message(&data)
        )));
    }

    let mut hosts: Vec<String> = Vec::new();
    for key in ["directdl", "cache"] {
        if let Some(arr) = data.get(key).and_then(Value::as_array) {
            for entry in arr {
                if let Some(host) = entry.as_str()
                    && host.contains('.')
                {
                    hosts.push(host.to_string());
                }
            }
        }
    }
    hosts.sort();
    hosts.dedup();
    Ok(hosts)
}

fn error_message(data: &Value) -> String {
    data.get("message")
        .and_then(Value::as_str)
        .unwrap_or("Unknown error")
        .to_string()
}
