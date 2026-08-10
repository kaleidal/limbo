use sabine::{BridgeError, SabineWindow};
use serde_json::{Value, json};

use crate::os;

use super::{App, err, ok, param_bool, param_str, register};

pub fn attach(mut window: SabineWindow, app: App) -> SabineWindow {
    window = register(window, "limbo.getTorrents", app.clone(), |app, _| {
        ok(app.torrent_engine.list(&app))
    });
    window = register(window, "limbo.addTorrent", app.clone(), |app, cmd| {
        let Some(magnet) = param_str(&cmd.params, "magnetUri") else {
            return err("magnetUri required");
        };
        if app.store.with(|d| d.settings.require_vpn) && !os::vpn::is_vpn_connected() {
            return err("VPN_REQUIRED");
        }
        app.runtime
            .block_on(app.torrent_engine.add_magnet(app.clone(), magnet, None))
            .map_err(|e| BridgeError::new(e.to_string()))
            .and_then(ok)
    });
    window = register(window, "limbo.addTorrentFile", app.clone(), |app, cmd| {
        let Some(path) = param_str(&cmd.params, "filePath") else {
            return err("filePath required");
        };
        if app.store.with(|d| d.settings.require_vpn) && !os::vpn::is_vpn_connected() {
            return err("VPN_REQUIRED");
        }
        let bytes = std::fs::read(&path).map_err(|e| BridgeError::new(e.to_string()))?;
        app.runtime
            .block_on(app.torrent_engine.add_file_bytes(app.clone(), bytes, None))
            .map_err(|e| BridgeError::new(e.to_string()))
            .and_then(ok)
    });
    window = register(window, "limbo.addRemoteTorrent", app.clone(), |app, cmd| {
        let Some(url) = param_str(&cmd.params, "url") else {
            return err("url required");
        };
        if app.store.with(|d| d.settings.require_vpn) && !os::vpn::is_vpn_connected() {
            return err("VPN_REQUIRED");
        }
        let bytes = app
            .runtime
            .block_on(crate::net::fetch_public_bounded(
                &url,
                10 * 1024 * 1024,
                std::time::Duration::from_secs(60),
            ))
            .map_err(|error| BridgeError::new(error.to_string()))?
            .bytes;
        app.runtime
            .block_on(app.torrent_engine.add_file_bytes(app.clone(), bytes, None))
            .map_err(|e| BridgeError::new(e.to_string()))
            .and_then(ok)
    });
    window = register(window, "limbo.pauseTorrent", app.clone(), |app, cmd| {
        let Some(id) = param_str(&cmd.params, "id") else {
            return err("id required");
        };
        app.runtime
            .block_on(app.torrent_engine.pause(&app, &id))
            .map_err(|e| BridgeError::new(e.to_string()))?;
        ok(json!({ "success": true }))
    });
    window = register(window, "limbo.resumeTorrent", app.clone(), |app, cmd| {
        let Some(id) = param_str(&cmd.params, "id") else {
            return err("id required");
        };
        app.runtime
            .block_on(app.torrent_engine.resume(&app, &id))
            .map_err(|e| BridgeError::new(e.to_string()))?;
        ok(json!({ "success": true }))
    });
    window = register(window, "limbo.removeTorrent", app.clone(), |app, cmd| {
        let Some(id) = param_str(&cmd.params, "id") else {
            return err("id required");
        };
        let delete_files = param_bool(&cmd.params, "deleteFiles").unwrap_or(false);
        app.runtime
            .block_on(app.torrent_engine.remove(&app, &id, delete_files))
            .map_err(|e| BridgeError::new(e.to_string()))?;
        ok(app.torrent_engine.list(&app))
    });
    window = register(
        window,
        "limbo.isTorrentSupported",
        app.clone(),
        |_app, _| ok(true),
    );
    window = register(
        window,
        "limbo.getStreamServerPort",
        app.clone(),
        |app, _| ok(app.torrent_engine.stream_port()),
    );
    window = register(window, "limbo.getTorrentFiles", app.clone(), |app, cmd| {
        let Some(info_hash) = param_str(&cmd.params, "infoHash") else {
            return err("infoHash required");
        };
        let torrent_id = app.store.with(|d| {
            d.torrents
                .iter()
                .find(|t| t.info_hash.as_deref() == Some(info_hash.as_str()) || t.id == info_hash)
                .map(|t| t.id.clone())
        });
        let Some(torrent_id) = torrent_id else {
            return ok(Vec::<Value>::new());
        };
        let port = app.torrent_engine.stream_port();
        let info_hash = app.store.with(|data| {
            data.torrents
                .iter()
                .find(|torrent| torrent.id == torrent_id)
                .and_then(|torrent| torrent.info_hash.clone())
                .unwrap_or_else(|| torrent_id.clone())
        });
        let files = app
            .torrent_engine
            .list_files(&torrent_id)
            .map_err(|e| BridgeError::new(e.to_string()))?;
        ok(files
            .into_iter()
            .map(|file| {
                json!({
                    "index": file.index,
                    "name": file.name,
                    "path": file.name,
                    "length": file.length,
                    "downloaded": 0,
                    "progress": 0.0,
                    "streamUrl": if port > 0 {
                        format!("http://127.0.0.1:{port}/torrents/{info_hash}/stream/{}", file.index)
                    } else {
                        String::new()
                    },
                })
            })
            .collect::<Vec<_>>())
    });
    window = register(window, "limbo.pauseAllTorrents", app.clone(), |app, _| {
        let ids = app
            .store
            .with(|d| d.torrents.iter().map(|t| t.id.clone()).collect::<Vec<_>>());
        for id in ids {
            let _ = app.runtime.block_on(app.torrent_engine.pause(&app, &id));
        }
        ok(json!({ "success": true }))
    });
    window = register(window, "limbo.resumeAllTorrents", app.clone(), |app, _| {
        let ids = app
            .store
            .with(|d| d.torrents.iter().map(|t| t.id.clone()).collect::<Vec<_>>());
        for id in ids {
            let _ = app.runtime.block_on(app.torrent_engine.resume(&app, &id));
        }
        ok(json!({ "success": true }))
    });
    window = register(window, "limbo.checkVpnStatus", app.clone(), |_app, _| {
        ok(os::vpn::is_vpn_connected())
    });
    window
}
