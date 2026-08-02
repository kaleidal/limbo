use fenestra_cef::{BridgeError, FenestraWindow};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::os;
use crate::store::schema::LibraryItem;

use super::{err, ok, param_bool, param_str, register, App};

pub fn attach(mut window: FenestraWindow, app: App) -> FenestraWindow {
    window = register(window, "limbo.getLibrary", app.clone(), |app, _| {
        ok(app.store.with(|d| d.library.clone()))
    });
    window = register(window, "limbo.addToLibrary", app.clone(), |app, cmd| {
        let item = LibraryItem {
            id: Uuid::new_v4().to_string(),
            name: param_str(&cmd.params, "name").unwrap_or_else(|| "Item".into()),
            path: param_str(&cmd.params, "path").unwrap_or_default(),
            size: cmd.params.get("size").and_then(|v| v.as_u64()).unwrap_or(0),
            date_added: chrono::Utc::now().to_rfc3339(),
            icon: param_str(&cmd.params, "icon"),
            category: param_str(&cmd.params, "category"),
        };
        app.store
            .with_mut(|d| d.library.push(item.clone()))
            .map_err(|e| BridgeError::new(e.to_string()))?;
        app.push_event(
            "library-updated",
            serde_json::to_value(app.store.with(|d| d.library.clone())).unwrap_or_default(),
        );
        ok(item)
    });
    window = register(window, "limbo.removeFromLibrary", app.clone(), |app, cmd| {
        let Some(id) = param_str(&cmd.params, "id") else {
            return err("id required");
        };
        let delete_files = param_bool(&cmd.params, "deleteFiles").unwrap_or(false);
        let path = app
            .store
            .with(|d| d.library.iter().find(|i| i.id == id).map(|i| i.path.clone()));
        if delete_files {
            if let Some(path) = path {
                let _ = std::fs::remove_file(&path);
                let _ = std::fs::remove_dir_all(&path);
            }
        }
        app.store
            .with_mut(|d| d.library.retain(|i| i.id != id))
            .map_err(|e| BridgeError::new(e.to_string()))?;
        let library = app.store.with(|d| d.library.clone());
        app.push_event(
            "library-updated",
            serde_json::to_value(&library).unwrap_or_default(),
        );
        ok(library)
    });
    window = register(window, "limbo.openFileLocation", app.clone(), |_app, cmd| {
        let Some(path) = param_str(&cmd.params, "path") else {
            return err("path required");
        };
        os::shell::show_in_folder(&path).map_err(|e| BridgeError::new(e.to_string()))?;
        ok(json!({ "success": true }))
    });
    window = register(window, "limbo.openFile", app.clone(), |_app, cmd| {
        let Some(path) = param_str(&cmd.params, "path") else {
            return err("path required");
        };
        os::shell::open_path(&path).map_err(|e| BridgeError::new(e.to_string()))?;
        ok(json!({ "success": true }))
    });
    window = register(window, "limbo.addFolderToLibrary", app.clone(), |app, _| {
        let Some(path) = os::dialogs::pick_folder("Add folder to library", None) else {
            return ok(Value::Null);
        };
        let meta = std::fs::metadata(&path).ok();
        let item = LibraryItem {
            id: Uuid::new_v4().to_string(),
            name: path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.to_string_lossy().into_owned()),
            path: path.to_string_lossy().into_owned(),
            size: meta.map(|m| m.len()).unwrap_or(0),
            date_added: chrono::Utc::now().to_rfc3339(),
            icon: None,
            category: Some("folder".into()),
        };
        app.store
            .with_mut(|d| d.library.push(item.clone()))
            .map_err(|e| BridgeError::new(e.to_string()))?;
        ok(item)
    });
    window
}
