use sabine::SabineWindow;
use serde::Deserialize;
use specta::Type;
use uuid::Uuid;

use crate::os;
use crate::store::schema::{Bookmark, StoreData};

use super::{App, ById, Empty, command, fail, task};

#[derive(Deserialize, Type)]
struct NewBookmark {
    name: String,
    url: String,
    favicon: String,
}

pub fn attach(window: SabineWindow, app: &App) -> SabineWindow {
    let window = command(window, "bookmarks.list", app, |app, Empty {}| {
        Ok(bookmarks(app))
    });
    let window = command(window, "bookmarks.add", app, |app, new: NewBookmark| {
        let bookmark = Bookmark {
            id: Uuid::new_v4().to_string(),
            name: new.name,
            url: new.url,
            favicon: new.favicon,
        };
        let added = bookmark.clone();
        app.store
            .with_mut(|data| data.bookmarks.push(added))
            .map_err(fail)?;
        Ok(bookmark)
    });
    let window = command(window, "bookmarks.remove", app, |app, ById { id }| {
        replace(app, |bookmarks| {
            bookmarks.retain(|bookmark| bookmark.id != id)
        })
    });
    let window = command(window, "bookmarks.update", app, |app, update: Bookmark| {
        replace(app, |bookmarks| {
            if let Some(existing) = bookmarks.iter_mut().find(|item| item.id == update.id) {
                *existing = update;
            }
        })
    });
    let window = command(window, "bookmarks.reset", app, |app, Empty {}| {
        replace(app, |bookmarks| *bookmarks = StoreData::default().bookmarks)
    });
    let window = task(
        window,
        "bookmarks.export",
        app,
        |app, Empty {}| async move {
            let Some(path) =
                os::dialogs::save_json("Export bookmarks", "limbo-bookmarks.json").await
            else {
                return Ok(None);
            };
            let json = serde_json::to_vec_pretty(&bookmarks(&app)).map_err(fail)?;
            tokio::fs::write(&path, json).await.map_err(fail)?;
            Ok(Some(path.to_string_lossy().into_owned()))
        },
    );
    task(
        window,
        "bookmarks.import",
        app,
        |app, Empty {}| async move {
            let Some(path) = os::dialogs::pick_json("Import bookmarks").await else {
                return Ok(None);
            };
            let raw = tokio::fs::read(path).await.map_err(fail)?;
            let imported: Vec<Bookmark> = serde_json::from_slice(&raw).map_err(fail)?;
            replace(&app, |bookmarks| *bookmarks = imported).map(Some)
        },
    )
}
fn bookmarks(app: &App) -> Vec<Bookmark> {
    app.store.with(|data| data.bookmarks.clone())
}

fn replace(
    app: &App,
    change: impl FnOnce(&mut Vec<Bookmark>),
) -> Result<Vec<Bookmark>, sabine::BridgeError> {
    app.store
        .with_mut(|data| {
            change(&mut data.bookmarks);
            data.bookmarks.clone()
        })
        .map_err(fail)
}
