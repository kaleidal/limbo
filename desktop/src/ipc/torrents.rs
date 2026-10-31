use std::time::Duration;

use sabine::{BridgeError, SabineWindow};
use serde::Deserialize;
use specta::Type;

use crate::os::vpn;
use crate::store::schema::TorrentInfo;

use super::{App, ById, Empty, command, fail, task};

const MAX_TORRENT_FILE_BYTES: usize = 10 * 1024 * 1024;

#[derive(Deserialize, Type)]
#[serde(rename_all = "camelCase")]
struct AddMagnet {
    magnet_uri: String,
}

#[derive(Deserialize, Type)]
struct AddFile {
    path: String,
}

#[derive(Deserialize, Type)]
struct AddRemote {
    url: String,
}

#[derive(Deserialize, Type)]
#[serde(rename_all = "camelCase")]
struct RemoveTorrent {
    id: String,
    delete_files: bool,
}

pub fn attach(window: SabineWindow, app: &App) -> SabineWindow {
    let window = command(window, "torrents.list", app, |app, Empty {}| {
        Ok(app.torrent_engine.list(app))
    });
    let window = task(
        window,
        "torrents.add",
        app,
        |app, request: AddMagnet| async move {
            require_vpn(&app)?;
            app.torrent_engine
                .add_magnet(&app, request.magnet_uri)
                .await
                .map_err(fail)
        },
    );
    let window = task(
        window,
        "torrents.addFile",
        app,
        |app, request: AddFile| async move {
            require_vpn(&app)?;
            let bytes = tokio::fs::read(&request.path).await.map_err(fail)?;
            app.torrent_engine
                .add_file_bytes(&app, bytes)
                .await
                .map_err(fail)
        },
    );
    let window = task(
        window,
        "torrents.addRemote",
        app,
        |app, request: AddRemote| async move {
            require_vpn(&app)?;
            let bytes = crate::net::fetch_public_bounded(
                &request.url,
                MAX_TORRENT_FILE_BYTES,
                Duration::from_secs(60),
            )
            .await
            .map_err(fail)?
            .bytes;
            app.torrent_engine
                .add_file_bytes(&app, bytes)
                .await
                .map_err(fail)
        },
    );
    let window = task(
        window,
        "torrents.pause",
        app,
        |app, ById { id }| async move { app.torrent_engine.pause(&app, &id).await.map_err(fail) },
    );
    let window = task(
        window,
        "torrents.resume",
        app,
        |app, ById { id }| async move { app.torrent_engine.resume(&app, &id).await.map_err(fail) },
    );
    let window = task(
        window,
        "torrents.remove",
        app,
        |app, request: RemoveTorrent| async move {
            app.torrent_engine
                .remove(&app, &request.id, request.delete_files)
                .await
                .map_err(fail)?;
            Ok::<Vec<TorrentInfo>, BridgeError>(app.torrent_engine.list(&app))
        },
    );
    let window = task(
        window,
        "torrents.pauseAll",
        app,
        |app, Empty {}| async move {
            for torrent in app.torrent_engine.list(&app) {
                if let Err(error) = app.torrent_engine.pause(&app, &torrent.id).await {
                    tracing::warn!(torrent_id = %torrent.id, %error, "failed to pause torrent");
                }
            }
            Ok(())
        },
    );
    task(
        window,
        "torrents.resumeAll",
        app,
        |app, Empty {}| async move {
            for torrent in app.torrent_engine.list(&app) {
                if let Err(error) = app.torrent_engine.resume(&app, &torrent.id).await {
                    tracing::warn!(torrent_id = %torrent.id, %error, "failed to resume torrent");
                }
            }
            Ok(())
        },
    )
}

fn require_vpn(app: &App) -> Result<(), BridgeError> {
    if app.store.with(|data| data.settings.require_vpn) && !vpn::is_vpn_connected() {
        return Err(fail("VPN_REQUIRED"));
    }
    Ok(())
}
