use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use limbo_desktop::api::ApiServer;
use limbo_desktop::ipc;
use limbo_desktop::os::clipboard::ClipboardWatcher;
use limbo_desktop::state::AppState;
use limbo_desktop::store::Store;
use sabine::{AutostartEntry, DeepLinkRegistration, SingleInstancePolicy};
use sabine::{SabineError, SabineLifecyclePolicy, SabineResult, SabineWindow, WindowRegionRect};
use tracing_subscriber::EnvFilter;

const APP_ID: &str = "al.kaleid.limbo";
const TITLEBAR_HEIGHT: i32 = 40;
const WINDOW_CONTROLS_WIDTH: i32 = 144;

static APP_RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
static CLIPBOARD_WATCHER: OnceLock<ClipboardWatcher> = OnceLock::new();

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::from_default_env()
                .add_directive("limbo=info".parse().unwrap())
                .add_directive("limbo_desktop=info".parse().unwrap()),
        )
        .init();

    SabineWindow::main(configure_window);
}

fn configure_window(window: SabineWindow) -> SabineResult<SabineWindow> {
    let runtime = APP_RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("tokio runtime")
    });
    let handle = runtime.handle().clone();
    let data_dir = data_dir()?;
    let store = Store::load(&data_dir).map_err(startup_error)?;
    let (start_on_boot, clipboard_monitoring) = store.with(|data| {
        (
            data.settings.start_on_boot,
            data.settings.clipboard_monitoring,
        )
    });
    let app = Arc::new(AppState::new(store, handle).map_err(startup_error)?);
    queue_launch_arguments(&app, std::env::args());

    let download_path = app.store.with(|data| data.settings.download_path.clone());
    {
        let app = app.clone();
        let torrent_state_dir = data_dir.join("torrents");
        runtime.spawn(async move {
            if let Err(error) = app
                .torrent_engine
                .init(app.clone(), &download_path, torrent_state_dir)
                .await
            {
                tracing::error!("torrent engine init failed: {error}");
            }
        });
    }

    {
        let app = app.clone();
        runtime.spawn(async move {
            match ApiServer::start(app, data_dir).await {
                Ok(Some(port)) => tracing::info!("companion API listening on 127.0.0.1:{port}"),
                Ok(None) => tracing::info!("companion API disabled"),
                Err(error) => tracing::error!("companion API failed: {error}"),
            }
        });
    }

    if clipboard_monitoring {
        CLIPBOARD_WATCHER
            .set(ClipboardWatcher::start(
                app.clone(),
                Duration::from_millis(250),
            ))
            .map_err(|_| startup_error("clipboard watcher initialized more than once"))?;
    }

    tracing::info!("opening Limbo with Sabine");
    Ok(ipc::attach(
        window
            .size(1400, 900)
            .min_size(1000, 700)
            .frameless()
            .titlebar_drag_region(TITLEBAR_HEIGHT)
            .drag_exclusion_region(WindowRegionRect::new(
                -WINDOW_CONTROLS_WIDTH,
                0,
                WINDOW_CONTROLS_WIDTH,
                TITLEBAR_HEIGHT,
            ))
            .deep_link(DeepLinkRegistration::new(APP_ID, ["magnet"]))
            .autostart(AutostartEntry {
                id: APP_ID.to_string(),
                name: "Limbo".to_string(),
                command: std::env::current_exe()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned(),
                enabled: start_on_boot,
            })
            .single_instance_id(APP_ID)
            .single_instance(SingleInstancePolicy::FocusExisting)
            .lifecycle_policy(SabineLifecyclePolicy::browser_tab()),
        app,
    ))
}

fn queue_launch_arguments(app: &AppState, arguments: impl IntoIterator<Item = String>) {
    for argument in arguments {
        if argument.starts_with("magnet:") {
            app.push_event("magnet-link-opened", serde_json::Value::String(argument));
        } else if argument.to_ascii_lowercase().ends_with(".torrent") {
            app.push_event("torrent-file-opened", serde_json::Value::String(argument));
        }
    }
}

fn data_dir() -> SabineResult<PathBuf> {
    if let Some(dirs) = directories::ProjectDirs::from("al", "kaleid", "Limbo") {
        return Ok(dirs.data_dir().to_path_buf());
    }
    let executable = std::env::current_exe().map_err(startup_error)?;
    let parent = executable
        .parent()
        .ok_or_else(|| startup_error("application executable has no parent directory"))?;
    Ok(parent.join("limbo-data"))
}

fn startup_error(error: impl std::fmt::Display) -> SabineError {
    SabineError::CreationFailed {
        message: error.to_string(),
    }
}
