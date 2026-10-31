use sabine::SabineWindow;
use serde::Serialize;
use specta::Type;

use crate::api::ApiServer;
use crate::os;
use crate::store::schema::{Download, LibraryItem, Settings, TorrentInfo};

use super::{App, Empty, command, fail, task};

#[derive(Serialize, Type)]
struct ClearedData {
    downloads: Vec<Download>,
    torrents: Vec<TorrentInfo>,
    library: Vec<LibraryItem>,
    settings: Settings,
}

pub fn attach(window: SabineWindow, app: &App) -> SabineWindow {
    let window = command(window, "settings.get", app, |app, Empty {}| {
        Ok(app.store.with(|data| data.settings.clone()))
    });
    let window = task(
        window,
        "settings.update",
        app,
        |app, update: Settings| async move {
            let (previous, settings) = app
                .store
                .with_mut(|data| {
                    let previous = data.settings.clone();
                    data.settings = Settings {
                        api_token: previous.api_token.clone(),
                        ..update
                    };
                    (previous, data.settings.clone())
                })
                .map_err(fail)?;
            app.set_clipboard_monitoring(settings.clipboard_monitoring);
            if (
                previous.api_enabled,
                previous.api_lan_enabled,
                previous.api_port,
            ) != (
                settings.api_enabled,
                settings.api_lan_enabled,
                settings.api_port,
            ) {
                ApiServer::reconfigure(app.clone()).await.map_err(fail)?;
            }
            if previous.max_concurrent_downloads != settings.max_concurrent_downloads {
                app.download_manager.fill_slots(&app);
            }
            Ok(settings)
        },
    );
    let window = command(window, "settings.rotateApiToken", app, |app, Empty {}| {
        ApiServer::rotate_token(app).map_err(fail)
    });
    let window = task(
        window,
        "settings.selectDownloadPath",
        app,
        |app, Empty {}| async move {
            let current = app.store.with(|data| data.settings.download_path.clone());
            let path = os::dialogs::pick_folder("Select download folder", Some(&current)).await;
            Ok(path.map(|path| path.to_string_lossy().into_owned()))
        },
    );
    task(
        window,
        "settings.clearData",
        app,
        |app, Empty {}| async move {
            app.download_manager.cancel_all(&app);
            for torrent in app.torrent_engine.list(&app) {
                if let Err(error) = app.torrent_engine.remove(&app, &torrent.id, false).await {
                    tracing::warn!(torrent_id = %torrent.id, %error, "failed to remove torrent");
                }
            }
            app.store
                .with_mut(|data| {
                    data.downloads.clear();
                    data.torrents.clear();
                    data.library.clear();
                    data.extracted_archives.clear();
                    data.paired_devices.clear();
                    data.settings = Settings {
                        download_path: data.settings.download_path.clone(),
                        ..Settings::default()
                    };
                })
                .map_err(fail)?;
            app.set_clipboard_monitoring(false);
            ApiServer::reconfigure(app.clone()).await.map_err(fail)?;
            Ok(ClearedData {
                downloads: app.download_manager.list(&app),
                torrents: app.torrent_engine.list(&app),
                library: Vec::new(),
                settings: app.store.with(|data| data.settings.clone()),
            })
        },
    )
}
