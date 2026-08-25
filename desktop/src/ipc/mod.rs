mod bookmarks;
mod debrid;
mod downloads;
mod library;
mod settings;
mod torrents;

use std::sync::Arc;

use sabine::{
    BridgeCommand, BridgeCommandDescriptor, BridgeError, BridgeResponse, BridgeResult, SabineWindow,
};
use serde_json::{Value, json};

use crate::os;
use crate::state::AppState;

pub(crate) type App = Arc<AppState>;

pub(crate) fn ok(value: impl serde::Serialize) -> BridgeResult {
    serde_json::to_value(value)
        .map(BridgeResponse::json)
        .map_err(|err| BridgeError::new(err.to_string()))
}

pub(crate) fn err(message: impl Into<String>) -> BridgeResult {
    Err(BridgeError::new(message))
}

pub(crate) fn param_str(params: &Value, key: &str) -> Option<String> {
    params.get(key).and_then(|v| v.as_str()).map(str::to_string)
}

pub(crate) fn param_bool(params: &Value, key: &str) -> Option<bool> {
    params.get(key).and_then(|v| v.as_bool())
}

pub(crate) fn register<F>(window: SabineWindow, name: &str, app: App, handler: F) -> SabineWindow
where
    F: Fn(App, BridgeCommand) -> BridgeResult + Send + Sync + 'static,
{
    let app = app.clone();
    window.bridge_descriptor_handler(
        BridgeCommandDescriptor::new(name).target("desktop"),
        move |command| handler(app.clone(), command),
    )
}

pub fn attach(window: SabineWindow, app: Arc<AppState>) -> SabineWindow {
    let mut window = window;
    window = register(window, "limbo.drainEvents", app.clone(), |app, _| {
        let events = app.drain_events();
        ok(events
            .into_iter()
            .map(|(name, payload)| json!({ "name": name, "payload": payload }))
            .collect::<Vec<_>>())
    });

    window = register(window, "limbo.openExternal", app.clone(), |_app, cmd| {
        let Some(url) = param_str(&cmd.params, "url") else {
            return ok(json!({ "success": false, "error": "url required" }));
        };
        match os::shell::open_external(&url) {
            Ok(()) => ok(json!({ "success": true })),
            Err(error) => ok(json!({ "success": false, "error": error.to_string() })),
        }
    });

    window = register(window, "limbo.quit", app.clone(), |app, _| {
        app.quit()
            .map_err(|error| BridgeError::new(error.to_string()))?;
        ok(())
    });

    window = register(
        window,
        "limbo.getPendingApiApproval",
        app.clone(),
        |app, _| ok(app.approvals.active()),
    );

    window = register(
        window,
        "limbo.decideApiApproval",
        app.clone(),
        |app, cmd| {
            let Some(request_id) = param_str(&cmd.params, "requestId") else {
                return ok(json!({ "accepted": false }));
            };
            let decision = serde_json::from_value(cmd.params.clone())
                .map_err(|error| BridgeError::new(format!("invalid approval decision: {error}")))?;
            ok(json!({
                "accepted": app.approvals.decide(&request_id, decision),
            }))
        },
    );

    window = bookmarks::attach(window, app.clone());
    window = library::attach(window, app.clone());
    window = downloads::attach(window, app.clone());
    window = torrents::attach(window, app.clone());
    window = settings::attach(window, app.clone());
    window = debrid::attach(window, app);
    window
}
