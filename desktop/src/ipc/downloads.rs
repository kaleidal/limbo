use sabine::{BridgeError, SabineWindow};
use serde_json::json;

use super::{App, err, ok, param_bool, param_str, register};

pub fn attach(mut window: SabineWindow, app: App) -> SabineWindow {
    window = register(window, "limbo.getDownloads", app.clone(), |app, _| {
        ok(app.download_manager.list(&app))
    });
    window = register(window, "limbo.startDownload", app.clone(), |app, cmd| {
        let Some(url) = param_str(&cmd.params, "url") else {
            return err("url required");
        };
        let filename = param_str(&cmd.params, "filename");
        let use_debrid = param_bool(&cmd.params, "useDebrid").unwrap_or(false);

        let mut final_url = url;
        let mut debrid_error = None;
        let mut warning = None;

        if use_debrid {
            match app
                .runtime
                .block_on(app.debrid.unrestrict_link(&app, &final_url))
            {
                Ok(result) => {
                    if let Some(resolved) = result.url {
                        final_url = resolved;
                    } else if let Some(error) = result.error {
                        debrid_error = Some(error);
                    }
                }
                Err(error) => debrid_error = Some(error.to_string()),
            }
        }

        if debrid_error.is_some() {
            warning = Some("Falling back to direct download".to_string());
        }

        match app
            .download_manager
            .start(app.clone(), final_url, filename, None)
        {
            Ok(_) => ok(json!({
                "success": true,
                "debridError": debrid_error,
                "warning": warning,
            })),
            Err(error) => ok(json!({
                "success": false,
                "debridError": error.to_string(),
            })),
        }
    });
    window = register(window, "limbo.pauseDownload", app.clone(), |app, cmd| {
        let Some(id) = param_str(&cmd.params, "id") else {
            return err("id required");
        };
        app.download_manager.pause(&app, &id);
        ok(json!({ "success": true }))
    });
    window = register(window, "limbo.resumeDownload", app.clone(), |app, cmd| {
        let Some(id) = param_str(&cmd.params, "id") else {
            return err("id required");
        };
        app.download_manager
            .resume(app.clone(), &id)
            .map_err(|e| BridgeError::new(e.to_string()))?;
        ok(json!({ "success": true }))
    });
    window = register(window, "limbo.cancelDownload", app.clone(), |app, cmd| {
        let Some(id) = param_str(&cmd.params, "id") else {
            return err("id required");
        };
        app.download_manager.cancel(&app, &id);
        ok(app.download_manager.list(&app))
    });
    window = register(window, "limbo.cancelAllDownloads", app.clone(), |app, _| {
        app.download_manager.cancel_all(&app);
        ok(app.download_manager.list(&app))
    });
    window = register(
        window,
        "limbo.clearCompletedDownloads",
        app.clone(),
        |app, _| {
            app.download_manager.clear_completed(&app);
            ok(app.download_manager.list(&app))
        },
    );
    window = register(window, "limbo.pauseAllDownloads", app.clone(), |app, _| {
        app.download_manager.pause_all(&app);
        ok(json!({ "success": true }))
    });
    window = register(window, "limbo.resumeAllDownloads", app.clone(), |app, _| {
        app.download_manager.resume_all(app.clone());
        ok(json!({ "success": true }))
    });
    window
}
