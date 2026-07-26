use fenestra_cef::{BridgeError, FenestraWindow};
use serde_json::{json, Value};

use crate::os;

use super::{err, ok, param_bool, param_str, register, App};

pub fn attach(mut window: FenestraWindow, app: App) -> FenestraWindow {
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
            .block_on(async {
                let response = reqwest::Client::new().get(&url).send().await?;
                response.error_for_status()?.bytes().await
            })
            .map_err(|e: reqwest::Error| BridgeError::new(e.to_string()))?;
        app.runtime
            .block_on(app.torrent_engine.add_file_bytes(app.clone(), bytes.to_vec(), None))
            .map_err(|e| BridgeError::new(e.to_string()))
            .and_then(ok)
    });
    window = register(window, "limbo.pauseTorrent", app.clone(), |app, cmd| {
        let Some(id) = param_str(&cmd.params, "id") else {
            return err("id required");
        };
        app.runtime
            .block_on(app.torrent_engine.pause(&id))
            .map_err(|e| BridgeError::new(e.to_string()))?;
        ok(json!({ "success": true }))
    });
    window = register(window, "limbo.resumeTorrent", app.clone(), |app, cmd| {
        let Some(id) = param_str(&cmd.params, "id") else {
            return err("id required");
        };
        app.runtime
            .block_on(app.torrent_engine.resume(&id))
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
    window = register(window, "limbo.isTorrentSupported", app.clone(), |_app, _| {
        ok(true)
    });
    window = register(window, "limbo.getStreamServerPort", app.clone(), |app, _| {
        ok(*app.stream_port.lock())
    });
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
        let port = *app.stream_port.lock();
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
                        format!("http://127.0.0.1:{port}/stream/{torrent_id}/{}", file.index)
                    } else {
                        String::new()
                    },
                })
            })
            .collect::<Vec<_>>())
    });
    window = register(window, "limbo.pauseAllTorrents", app.clone(), |app, _| {
        let ids = app.store.with(|d| d.torrents.iter().map(|t| t.id.clone()).collect::<Vec<_>>());
        for id in ids {
            let _ = app.runtime.block_on(app.torrent_engine.pause(&id));
        }
        ok(json!({ "success": true }))
    });
    window = register(window, "limbo.resumeAllTorrents", app.clone(), |app, _| {
        let ids = app.store.with(|d| d.torrents.iter().map(|t| t.id.clone()).collect::<Vec<_>>());
        for id in ids {
            let _ = app.runtime.block_on(app.torrent_engine.resume(&id));
        }
        ok(json!({ "success": true }))
    });
    window = register(window, "limbo.checkVpnStatus", app.clone(), |_app, _| {
        ok(os::vpn::is_vpn_connected())
    });
    window
}
