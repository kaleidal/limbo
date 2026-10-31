use sabine::SabineWindow;
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::store::schema::Download;

use super::{App, ById, Empty, command, fail, task};

#[derive(Deserialize, Type)]
#[serde(rename_all = "camelCase")]
struct StartDownload {
    url: String,
    #[serde(default)]
    filename: Option<String>,
    #[serde(default)]
    use_debrid: bool,
}

#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
struct StartedDownload {
    debrid_error: Option<String>,
}

pub fn attach(window: SabineWindow, app: &App) -> SabineWindow {
    let window = command(window, "downloads.list", app, |app, Empty {}| {
        Ok(app.download_manager.list(app))
    });
    let window = task(
        window,
        "downloads.start",
        app,
        |app, request: StartDownload| async move {
            let (url, debrid_error) = if request.use_debrid {
                match app.debrid.unrestrict_link(&app, &request.url).await {
                    Ok(result) => match result.url {
                        Some(url) => (url, None),
                        None => (request.url, result.error),
                    },
                    Err(error) => (request.url, Some(error.to_string())),
                }
            } else {
                (request.url, None)
            };
            app.download_manager
                .start(&app, url, request.filename, None)
                .map_err(fail)?;
            Ok(StartedDownload { debrid_error })
        },
    );
    let window = command(window, "downloads.pause", app, |app, ById { id }| {
        app.download_manager.pause(app, &id);
        Ok(())
    });
    let window = command(window, "downloads.resume", app, |app, ById { id }| {
        app.download_manager.resume(app, &id).map_err(fail)
    });
    let window = command(window, "downloads.cancel", app, |app, ById { id }| {
        app.download_manager.cancel(app, &id);
        Ok(app.download_manager.list(app))
    });
    let window = command(window, "downloads.cancelAll", app, |app, Empty {}| {
        app.download_manager.cancel_all(app);
        Ok(app.download_manager.list(app))
    });
    let window = command(
        window,
        "downloads.clearFinished",
        app,
        |app, Empty {}| -> Result<Vec<Download>, _> {
            app.download_manager.clear_finished(app);
            Ok(app.download_manager.list(app))
        },
    );
    let window = command(window, "downloads.pauseAll", app, |app, Empty {}| {
        app.download_manager.pause_all(app);
        Ok(())
    });
    command(window, "downloads.resumeAll", app, |app, Empty {}| {
        app.download_manager.resume_all(app);
        Ok(())
    })
}
