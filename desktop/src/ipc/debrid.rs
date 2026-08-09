use sabine::{BridgeError, SabineWindow};
use serde_json::json;

use super::{App, err, ok, param_str, register};

pub fn attach(mut window: SabineWindow, app: App) -> SabineWindow {
    window = register(window, "limbo.isDebridConfigured", app.clone(), |app, _| {
        ok(app.debrid.is_configured(&app))
    });
    window = register(
        window,
        "limbo.isDebridUrlSupported",
        app.clone(),
        |app, cmd| {
            let Some(url) = param_str(&cmd.params, "url") else {
                return ok(false);
            };
            ok(app
                .runtime
                .block_on(app.debrid.is_url_supported(&app, &url)))
        },
    );
    window = register(
        window,
        "limbo.isDebridTorrentSupported",
        app.clone(),
        |app, _| ok(app.debrid.is_torrent_supported(&app)),
    );
    window = register(
        window,
        "limbo.convertMagnetDebrid",
        app.clone(),
        |app, cmd| {
            let Some(magnet) = param_str(&cmd.params, "magnetUri") else {
                return err("magnetUri required");
            };
            app.runtime
                .block_on(app.debrid.convert_magnet(&app, &magnet))
                .map_err(|e| BridgeError::new(e.to_string()))
                .and_then(ok)
        },
    );
    window = register(
        window,
        "limbo.convertTorrentFileDebrid",
        app.clone(),
        |app, cmd| {
            let Some(url) = param_str(&cmd.params, "torrentUrl") else {
                return err("torrentUrl required");
            };
            app.runtime
                .block_on(app.debrid.convert_torrent_file(&app, &url))
                .map_err(|e| BridgeError::new(e.to_string()))
                .and_then(ok)
        },
    );
    window = register(
        window,
        "limbo.getSupportedHosts",
        app.clone(),
        |app, _| match app.runtime.block_on(app.debrid.get_supported_hosts(&app)) {
            Ok(hosts) => ok(json!({ "hosts": hosts })),
            Err(error) => ok(json!({ "hosts": [], "error": error.to_string() })),
        },
    );
    window = register(
        window,
        "limbo.realDebridDeviceStart",
        app.clone(),
        |app, _| match app.runtime.block_on(app.debrid.start_realdebrid_device()) {
            Ok(start) => ok(json!({
                "success": true,
                "userCode": start.user_code,
                "verificationUrl": start.verification_url,
                "interval": start.interval,
                "expiresIn": start.expires_in,
            })),
            Err(error) => ok(json!({ "success": false, "error": error.to_string() })),
        },
    );
    window = register(
        window,
        "limbo.realDebridDevicePoll",
        app.clone(),
        |app, _| {
            app.runtime
                .block_on(app.debrid.poll_realdebrid_device(&app))
                .map_err(|e| BridgeError::new(e.to_string()))
                .and_then(ok)
        },
    );
    window = register(
        window,
        "limbo.realDebridDeviceCancel",
        app.clone(),
        |app, _| {
            app.debrid.cancel_realdebrid_device();
            ok(json!({ "success": true }))
        },
    );
    window
}
