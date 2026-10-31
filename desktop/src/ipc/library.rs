use sabine::SabineWindow;
use serde::Deserialize;
use specta::Type;

use crate::events::LIBRARY_UPDATED;
use crate::library;
use crate::os;

use super::{App, ById, Empty, command, fail, task};

#[derive(Deserialize, Type)]
struct FilePath {
    path: String,
}

pub fn attach(window: SabineWindow, app: &App) -> SabineWindow {
    let window = command(window, "library.list", app, |app, Empty {}| {
        Ok(app.store.with(|data| data.library.clone()))
    });
    let window = command(window, "library.remove", app, |app, ById { id }| {
        let library = app
            .store
            .with_mut(|data| {
                data.library.retain(|item| item.id != id);
                data.library.clone()
            })
            .map_err(fail)?;
        app.send(&LIBRARY_UPDATED, &library);
        Ok(library)
    });
    let window = task(
        window,
        "library.addFolder",
        app,
        |app, Empty {}| async move {
            let Some(path) = os::dialogs::pick_folder("Add folder to library", None).await else {
                return Ok(None);
            };
            tokio::task::spawn_blocking(move || library::add(&app, &path))
                .await
                .map_err(fail)?
                .map(Some)
                .map_err(fail)
        },
    );
    let window = command(window, "files.open", app, |app, request: FilePath| {
        let target = library::managed_path(app, &request.path).map_err(fail)?;
        os::shell::open_path(&target).map_err(fail)
    });
    command(window, "files.reveal", app, |app, request: FilePath| {
        let target = library::managed_path(app, &request.path).map_err(fail)?;
        os::shell::show_in_folder(&target).map_err(fail)
    })
}
