use sabine::{BridgeError, SabineWindow};
use serde::Deserialize;
use specta::Type;

use crate::downloads::DownloadGroup;

use super::{App, Empty, command, fail, task};

#[derive(Deserialize, Type)]
struct Link {
    url: String,
}

#[derive(Deserialize, Type)]
#[serde(rename_all = "camelCase")]
struct Magnet {
    magnet_uri: String,
}

pub fn attach(window: SabineWindow, app: &App) -> SabineWindow {
    let window = command(window, "debrid.configured", app, |app, Empty {}| {
        Ok(app.debrid.is_configured(app))
    });
    let window = command(window, "debrid.torrentSupported", app, |app, Empty {}| {
        Ok(app.debrid.is_torrent_supported(app))
    });
    let window = task(
        window,
        "debrid.urlSupported",
        app,
        |app, link: Link| async move { Ok(app.debrid.is_url_supported(&app, &link.url).await) },
    );
    let window = task(window, "debrid.hosts", app, |app, Empty {}| async move {
        app.debrid.get_supported_hosts(&app).await.map_err(fail)
    });
    let window = task(
        window,
        "debrid.downloadMagnet",
        app,
        |app, magnet: Magnet| async move {
            let links = app
                .debrid
                .convert_magnet(&app, &magnet.magnet_uri)
                .await
                .map_err(fail)?;
            start_all(&app, links, DownloadGroup::for_magnet(&magnet.magnet_uri))
        },
    );
    let window = task(
        window,
        "debrid.downloadTorrentFile",
        app,
        |app, link: Link| async move {
            let links = app
                .debrid
                .convert_torrent_file(&app, &link.url)
                .await
                .map_err(fail)?;
            start_all(&app, links, DownloadGroup::for_url(&link.url))
        },
    );
    let window = task(
        window,
        "debrid.realDebridLinkStart",
        app,
        |app, Empty {}| async move { app.debrid.start_realdebrid_device().await.map_err(fail) },
    );
    let window = task(
        window,
        "debrid.realDebridLinkPoll",
        app,
        |app, Empty {}| async move { app.debrid.poll_realdebrid_device(&app).await.map_err(fail) },
    );
    command(
        window,
        "debrid.realDebridLinkCancel",
        app,
        |app, Empty {}| {
            app.debrid.cancel_realdebrid_device();
            Ok(())
        },
    )
}

fn start_all(app: &App, links: Vec<String>, group: DownloadGroup) -> Result<u32, BridgeError> {
    let grouped = links.len() > 1;
    let mut started = 0;
    for link in links {
        app.download_manager
            .start(app, link, None, grouped.then(|| group.clone()))
            .map_err(fail)?;
        started += 1;
    }
    Ok(started)
}
