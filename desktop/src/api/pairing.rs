use std::time::{Duration, Instant};

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use parking_lot::Mutex;
use rand::TryRng;
use serde::{Deserialize, Serialize};
use serde_json::json;
use specta::Type;
use uuid::Uuid;

use super::torrents::error;
use super::{ApiError, ApiState, Identity, check_auth, generate_token, unauthorized};
use crate::events::DEVICES_UPDATED;
use crate::state::AppState;
use crate::store::StoreError;
use crate::store::schema::PairedDevice;

const CODE_LIFETIME: Duration = Duration::from_secs(5 * 60);
const MAX_ATTEMPTS: u32 = 5;
const MAX_DEVICE_NAME: usize = 64;

struct PairingCode {
    code: String,
    expires_at: Instant,
    attempts_left: u32,
}

enum Redeemed {
    Accepted,
    WrongCode,
    NotOpen,
}

#[derive(Default)]
pub struct Pairing {
    active: Mutex<Option<PairingCode>>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PairingCodeInfo {
    pub code: String,
    pub expires_in_seconds: u32,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSummary {
    pub id: String,
    pub name: String,
    pub paired_at: String,
}

impl Pairing {
    pub fn open(&self) -> Result<PairingCodeInfo, ApiError> {
        let mut bytes = [0_u8; 4];
        rand::rngs::SysRng
            .try_fill_bytes(&mut bytes)
            .map_err(|error| ApiError::Token(error.to_string()))?;
        let code = format!("{:06}", u32::from_le_bytes(bytes) % 1_000_000);
        *self.active.lock() = Some(PairingCode {
            code: code.clone(),
            expires_at: Instant::now() + CODE_LIFETIME,
            attempts_left: MAX_ATTEMPTS,
        });
        Ok(PairingCodeInfo {
            code,
            expires_in_seconds: CODE_LIFETIME.as_secs() as u32,
        })
    }

    pub fn close(&self) {
        self.active.lock().take();
    }

    fn redeem(&self, candidate: &str) -> Redeemed {
        let mut active = self.active.lock();
        let Some(pairing) = active.as_mut() else {
            return Redeemed::NotOpen;
        };
        if Instant::now() >= pairing.expires_at {
            *active = None;
            return Redeemed::NotOpen;
        }
        if pairing.code == candidate.trim() {
            *active = None;
            return Redeemed::Accepted;
        }
        pairing.attempts_left -= 1;
        if pairing.attempts_left == 0 {
            *active = None;
        }
        Redeemed::WrongCode
    }
}

pub fn devices(app: &AppState) -> Vec<DeviceSummary> {
    app.store.with(|data| {
        data.paired_devices
            .iter()
            .map(|device| DeviceSummary {
                id: device.id.clone(),
                name: device.name.clone(),
                paired_at: device.paired_at.clone(),
            })
            .collect()
    })
}

pub fn unpair(app: &AppState, device_id: &str) -> Result<(), StoreError> {
    app.store
        .with_mut(|data| data.paired_devices.retain(|device| device.id != device_id))?;
    app.send(&DEVICES_UPDATED, &devices(app));
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairBody {
    code: String,
    #[serde(default)]
    device_name: Option<String>,
}

pub(super) async fn pair(State(state): State<ApiState>, Json(body): Json<PairBody>) -> Response {
    match state.app.api.pairing.redeem(&body.code) {
        Redeemed::Accepted => {}
        Redeemed::WrongCode => {
            return error(
                StatusCode::FORBIDDEN,
                "PAIRING_CODE_INVALID",
                "That code doesn't match the one Limbo is showing.",
            );
        }
        Redeemed::NotOpen => {
            return error(
                StatusCode::GONE,
                "PAIRING_NOT_OPEN",
                "Start pairing in Limbo's settings to get a new code.",
            );
        }
    }

    let token = match generate_token() {
        Ok(token) => token,
        Err(error_value) => {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "TOKEN_ERROR",
                &error_value.to_string(),
            );
        }
    };
    let device = PairedDevice {
        id: Uuid::new_v4().to_string(),
        name: device_name(body.device_name),
        token: token.clone(),
        paired_at: chrono::Utc::now().to_rfc3339(),
    };
    let device_id = device.id.clone();
    let stored = state.app.store.with_mut(|data| {
        data.paired_devices.push(device);
        data.instance_id.clone()
    });
    let instance_id = match stored {
        Ok(instance_id) => instance_id,
        Err(error_value) => {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "STORE_ERROR",
                &error_value.to_string(),
            );
        }
    };
    state.app.send(&DEVICES_UPDATED, &devices(&state.app));
    Json(json!({
        "deviceId": device_id,
        "token": token,
        "instanceId": instance_id,
        "name": super::instance_name(),
    }))
    .into_response()
}

pub(super) async fn unpair_self(State(state): State<ApiState>, headers: HeaderMap) -> Response {
    let Some(Identity::Device(device_id)) =
        check_auth(&headers, &state).map(|caller| caller.identity)
    else {
        return unauthorized();
    };
    match unpair(&state.app, &device_id) {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(error_value) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "STORE_ERROR",
            &error_value.to_string(),
        ),
    }
}

fn device_name(requested: Option<String>) -> String {
    requested
        .map(|name| {
            name.trim()
                .chars()
                .take(MAX_DEVICE_NAME)
                .collect::<String>()
        })
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "Device".to_string())
}
