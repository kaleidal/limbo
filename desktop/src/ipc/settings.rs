use fenestra_cef::{BridgeError, FenestraWindow};
use serde_json::{json, Value};

use crate::os;
use crate::store::schema::{Settings, StoreData};

use super::{ok, register, App};

pub fn attach(mut window: FenestraWindow, app: App) -> FenestraWindow {
    window = register(window, "limbo.getSettings", app.clone(), |app, _| {
        ok(app.store.with(|d| d.settings.clone()))
    });
    window = register(window, "limbo.updateSettings", app.clone(), |app, cmd| {
        let patch = cmd.params;
        app.store
            .with_mut(|d| {
                if let Ok(partial) = serde_json::from_value::<Settings>(merge_settings(
                    &d.settings,
                    &patch,
                )) {
                    d.settings = partial;
                }
            })
            .map_err(|e| BridgeError::new(e.to_string()))?;
        ok(app.store.with(|d| d.settings.clone()))
    });
    window = register(window, "limbo.selectDownloadPath", app.clone(), |app, _| {
        let current = app.store.with(|d| d.settings.download_path.clone());
        let path = os::dialogs::pick_folder("Select download folder", Some(&current));
        ok(path.map(|p| p.to_string_lossy().to_string()))
    });
    window = register(window, "limbo.clearData", app.clone(), |app, _| {
        app.download_manager.cancel_all(&app);
        let ids = app.store.with(|d| d.torrents.iter().map(|t| t.id.clone()).collect::<Vec<_>>());
        for id in ids {
            let _ = app.runtime.block_on(app.torrent_engine.remove(&app, &id, false));
        }
        let defaults = StoreData::default();
        app.store
            .with_mut(|d| {
                d.downloads.clear();
                d.torrents.clear();
                d.library.clear();
                d.extracted_groups.clear();
                d.settings = defaults.settings.clone();
            })
            .map_err(|e| BridgeError::new(e.to_string()))?;
        ok(json!({
            "downloads": app.download_manager.list(&app),
            "torrents": app.torrent_engine.list(&app),
            "library": app.store.with(|d| d.library.clone()),
            "settings": app.store.with(|d| d.settings.clone()),
        }))
    });
    window
}

fn merge_settings(current: &Settings, patch: &Value) -> Value {
    let mut value = serde_json::to_value(current).unwrap_or(json!({}));
    if let (Some(obj), Some(patch_obj)) = (value.as_object_mut(), patch.as_object()) {
        for (key, patch_value) in patch_obj {
            if key == "debrid" {
                if let (Some(debrid), Some(patch_debrid)) =
                    (obj.get_mut("debrid").and_then(|v| v.as_object_mut()), patch_value.as_object())
                {
                    for (dkey, dval) in patch_debrid {
                        debrid.insert(dkey.clone(), dval.clone());
                    }
                    continue;
                }
            }
            obj.insert(key.clone(), patch_value.clone());
        }
    }
    value
}
