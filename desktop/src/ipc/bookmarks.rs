use fenestra_cef::{BridgeError, FenestraWindow};
use serde_json::Value;
use uuid::Uuid;

use crate::os;
use crate::store::schema::{Bookmark, StoreData};

use super::{err, ok, param_str, register, App};

pub fn attach(mut window: FenestraWindow, app: App) -> FenestraWindow {
    window = register(window, "limbo.getBookmarks", app.clone(), |app, _| {
        ok(app.store.with(|d| d.bookmarks.clone()))
    });
    window = register(window, "limbo.addBookmark", app.clone(), |app, cmd| {
        let bookmark = Bookmark {
            id: Uuid::new_v4().to_string(),
            name: param_str(&cmd.params, "name").unwrap_or_else(|| "Bookmark".into()),
            url: param_str(&cmd.params, "url").unwrap_or_default(),
            favicon: param_str(&cmd.params, "favicon").unwrap_or_default(),
        };
        app.store
            .with_mut(|d| d.bookmarks.push(bookmark.clone()))
            .map_err(|e| BridgeError::new(e.to_string()))?;
        ok(bookmark)
    });
    window = register(window, "limbo.removeBookmark", app.clone(), |app, cmd| {
        let Some(id) = param_str(&cmd.params, "id") else {
            return err("id required");
        };
        app.store
            .with_mut(|d| d.bookmarks.retain(|b| b.id != id))
            .map_err(|e| BridgeError::new(e.to_string()))?;
        ok(app.store.with(|d| d.bookmarks.clone()))
    });
    window = register(window, "limbo.updateBookmark", app.clone(), |app, cmd| {
        let Ok(bookmark) = serde_json::from_value::<Bookmark>(cmd.params.clone()) else {
            return err("invalid bookmark");
        };
        app.store
            .with_mut(|d| {
                if let Some(existing) = d.bookmarks.iter_mut().find(|b| b.id == bookmark.id) {
                    *existing = bookmark;
                }
            })
            .map_err(|e| BridgeError::new(e.to_string()))?;
        ok(app.store.with(|d| d.bookmarks.clone()))
    });
    window = register(window, "limbo.resetBookmarks", app.clone(), |app, _| {
        let defaults = StoreData::default().bookmarks;
        app.store
            .with_mut(|d| d.bookmarks = defaults.clone())
            .map_err(|e| BridgeError::new(e.to_string()))?;
        ok(defaults)
    });
    window = register(window, "limbo.exportBookmarks", app.clone(), |app, _| {
        let Some(path) = os::dialogs::save_file(
            "Export bookmarks",
            "limbo-bookmarks.json",
            &[("JSON", &["json"])],
        ) else {
            return ok(Value::Null);
        };
        let bookmarks = app.store.with(|d| d.bookmarks.clone());
        let json = serde_json::to_string_pretty(&bookmarks).map_err(|e| BridgeError::new(e.to_string()))?;
        std::fs::write(&path, json).map_err(|e| BridgeError::new(e.to_string()))?;
        ok(path.to_string_lossy().to_string())
    });
    window = register(window, "limbo.importBookmarks", app.clone(), |app, _| {
        let Some(path) = os::dialogs::pick_file("Import bookmarks", &[("JSON", &["json"])]) else {
            return ok(Value::Null);
        };
        let raw = std::fs::read_to_string(path).map_err(|e| BridgeError::new(e.to_string()))?;
        let bookmarks: Vec<Bookmark> =
            serde_json::from_str(&raw).map_err(|e| BridgeError::new(e.to_string()))?;
        app.store
            .with_mut(|d| d.bookmarks = bookmarks.clone())
            .map_err(|e| BridgeError::new(e.to_string()))?;
        ok(bookmarks)
    });
    window
}
