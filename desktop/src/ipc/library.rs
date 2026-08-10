use sabine::{BridgeError, SabineWindow};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use uuid::Uuid;

use crate::os;
use crate::store::schema::LibraryItem;

use super::{App, err, ok, param_bool, param_str, register};

pub fn attach(mut window: SabineWindow, app: App) -> SabineWindow {
    window = register(window, "limbo.getLibrary", app.clone(), |app, _| {
        ok(app.store.with(|d| d.library.clone()))
    });
    window = register(window, "limbo.addToLibrary", app.clone(), |app, cmd| {
        let Some(path) = param_str(&cmd.params, "path") else {
            return err("path required");
        };
        let path = validated_library_path(&app, &path)?;
        let item = LibraryItem {
            id: Uuid::new_v4().to_string(),
            name: param_str(&cmd.params, "name").unwrap_or_else(|| "Item".into()),
            path: path.to_string_lossy().into_owned(),
            size: cmd.params.get("size").and_then(|v| v.as_u64()).unwrap_or(0),
            date_added: chrono::Utc::now().to_rfc3339(),
            icon: param_str(&cmd.params, "icon"),
            category: param_str(&cmd.params, "category"),
            trusted: true,
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
    window = register(
        window,
        "limbo.removeFromLibrary",
        app.clone(),
        |app, cmd| {
            let Some(id) = param_str(&cmd.params, "id") else {
                return err("id required");
            };
            let delete_files = param_bool(&cmd.params, "deleteFiles").unwrap_or(false);
            let path = app.store.with(|d| {
                d.library
                    .iter()
                    .find(|i| i.id == id)
                    .map(|i| i.path.clone())
            });
            if delete_files {
                let path = path.ok_or_else(|| BridgeError::new("library item not found"))?;
                let target = authorized_path(&app, &path, false)?;
                let metadata = std::fs::symlink_metadata(&target)
                    .map_err(|error| BridgeError::new(error.to_string()))?;
                if metadata.file_type().is_dir() {
                    std::fs::remove_dir_all(&target)
                        .map_err(|error| BridgeError::new(error.to_string()))?;
                } else {
                    std::fs::remove_file(&target)
                        .map_err(|error| BridgeError::new(error.to_string()))?;
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
        },
    );
    window = register(window, "limbo.openFileLocation", app.clone(), |app, cmd| {
        let Some(path) = param_str(&cmd.params, "path") else {
            return err("path required");
        };
        let target = authorized_path(&app, &path, true)?;
        os::shell::show_in_folder(&target.to_string_lossy())
            .map_err(|e| BridgeError::new(e.to_string()))?;
        ok(json!({ "success": true }))
    });
    window = register(window, "limbo.openFile", app.clone(), |app, cmd| {
        let Some(path) = param_str(&cmd.params, "path") else {
            return err("path required");
        };
        let target = authorized_path(&app, &path, true)?;
        os::shell::open_path(&target.to_string_lossy())
            .map_err(|e| BridgeError::new(e.to_string()))?;
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
            trusted: true,
        };
        app.store
            .with_mut(|d| d.library.push(item.clone()))
            .map_err(|e| BridgeError::new(e.to_string()))?;
        app.push_event(
            "library-updated",
            serde_json::to_value(app.store.with(|data| data.library.clone())).unwrap_or_default(),
        );
        ok(item)
    });
    window
}

fn authorized_path(
    app: &App,
    requested: &str,
    allow_library_item: bool,
) -> Result<PathBuf, BridgeError> {
    let target = Path::new(requested)
        .canonicalize()
        .map_err(|error| BridgeError::new(error.to_string()))?;
    let download_root = app.store.with(|data| data.settings.download_path.clone());
    let download_root = Path::new(&download_root)
        .canonicalize()
        .map_err(|error| BridgeError::new(error.to_string()))?;
    if target == download_root && !allow_library_item {
        return Err(BridgeError::new("path is outside Limbo's managed files"));
    }
    if !target.starts_with(&download_root) {
        let managed_paths = app.store.with(|data| {
            let mut paths = data
                .downloads
                .iter()
                .map(|item| item.path.clone())
                .collect::<Vec<_>>();
            if allow_library_item {
                paths.extend(
                    data.library
                        .iter()
                        .filter(|item| item.trusted)
                        .map(|item| item.path.clone()),
                );
            }
            paths
        });
        if !managed_paths
            .iter()
            .any(|path| Path::new(path).canonicalize().ok().as_ref() == Some(&target))
        {
            return Err(BridgeError::new("path is outside Limbo's managed files"));
        }
    }
    Ok(target)
}

fn validated_library_path(app: &App, requested: &str) -> Result<PathBuf, BridgeError> {
    let target = Path::new(requested)
        .canonicalize()
        .map_err(|error| BridgeError::new(error.to_string()))?;
    let (download_root, download_paths) = app.store.with(|data| {
        (
            data.settings.download_path.clone(),
            data.downloads
                .iter()
                .map(|item| item.path.clone())
                .collect::<Vec<_>>(),
        )
    });
    let download_root = Path::new(&download_root)
        .canonicalize()
        .map_err(|error| BridgeError::new(error.to_string()))?;
    if !target.starts_with(download_root)
        && !download_paths
            .iter()
            .any(|path| Path::new(path).canonicalize().ok().as_ref() == Some(&target))
    {
        return Err(BridgeError::new("path is outside Limbo's managed files"));
    }
    Ok(target)
}
