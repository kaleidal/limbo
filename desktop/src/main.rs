use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use limbo_desktop::api::ApiServer;
use limbo_desktop::ipc;
use limbo_desktop::state::AppState;
use limbo_desktop::store::Store;
#[cfg(not(target_os = "macos"))]
use sabine::WindowRegionRect;
use sabine::{AutostartEntry, DeepLinkRegistration, SingleInstancePolicy, TrayIcon, TrayMenuItem};
use sabine::{SabineColor, SabineError, SabineLifecyclePolicy, SabineResult, SabineWindow};
use tracing_subscriber::EnvFilter;

const APP_ID: &str = "al.kaleid.limbo";
#[cfg(not(target_os = "macos"))]
const TITLEBAR_HEIGHT: i32 = 40;
#[cfg(not(target_os = "macos"))]
const WINDOW_CONTROLS_WIDTH: i32 = 144;

static APP_RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::from_default_env()
                .add_directive("limbo=info".parse().unwrap())
                .add_directive("limbo_desktop=info".parse().unwrap()),
        )
        .init();

    let launched_app = Arc::new(parking_lot::Mutex::new(None));
    let configured_app = launched_app.clone();
    SabineWindow::main_with_process_mut(
        move |window| configure_window(window, &configured_app),
        move |process| {
            if let Some(app) = launched_app.lock().clone() {
                if let Some(emitter) = process.bridge_event_emitter() {
                    app.set_bridge_emitter(emitter);
                }
                app.set_process_handle(process.handle());
                start_app_services(app);
            }
        },
    );
}

fn configure_window(
    window: SabineWindow,
    launched_app: &parking_lot::Mutex<Option<Arc<AppState>>>,
) -> SabineResult<SabineWindow> {
    let runtime = APP_RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("tokio runtime")
    });
    let handle = runtime.handle().clone();
    let data_dir = data_dir()?;
    let store = Store::load(&data_dir).map_err(startup_error)?;
    let start_on_boot = store.with(|data| data.settings.start_on_boot);
    let app = Arc::new(AppState::new(store, handle).map_err(startup_error)?);
    *launched_app.lock() = Some(app.clone());
    queue_launch_arguments(&app, std::env::args());
    let window = window
        .background_color(SabineColor::rgb8(10, 10, 10))
        .size(1400, 900)
        .min_size(1000, 700)
        .title("Limbo");
    let window = platform_window_chrome(window)
        .hide_on_close(true)
        .tray_icon(tray_icon())
        .deep_link(DeepLinkRegistration::new(APP_ID, ["magnet"]));
    let window = match std::env::current_exe() {
        Ok(executable) => window.autostart(AutostartEntry {
            id: APP_ID.to_string(),
            name: "Limbo".to_string(),
            command: executable.to_string_lossy().into_owned(),
            enabled: start_on_boot,
        }),
        Err(error) => {
            tracing::warn!(%error, "autostart unavailable because executable path could not be resolved");
            window
        }
    };
    Ok(ipc::attach(
        window
            .single_instance_id(APP_ID)
            .single_instance(SingleInstancePolicy::ReuseExisting)
            .lifecycle_policy(SabineLifecyclePolicy::browser_tab().without_hibernation()),
        app,
    ))
}

#[cfg(target_os = "macos")]
fn platform_window_chrome(window: SabineWindow) -> SabineWindow {
    window.system_chrome()
}

#[cfg(not(target_os = "macos"))]
fn platform_window_chrome(window: SabineWindow) -> SabineWindow {
    window
        .frameless()
        .titlebar_drag_region(TITLEBAR_HEIGHT)
        .drag_exclusion_region(WindowRegionRect::new(
            -WINDOW_CONTROLS_WIDTH,
            0,
            WINDOW_CONTROLS_WIDTH,
            TITLEBAR_HEIGHT,
        ))
}

fn start_app_services(app: Arc<AppState>) {
    tracing::info!("opening Limbo with Sabine");
    let runtime = app.runtime.clone();
    let clipboard_monitoring = app.store.with(|data| data.settings.clipboard_monitoring);
    app.set_clipboard_monitoring(clipboard_monitoring);

    {
        let app = Arc::downgrade(&app);
        runtime.spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(5));
            loop {
                interval.tick().await;
                let Some(app) = app.upgrade() else {
                    break;
                };
                if app.store.is_dirty()
                    && let Err(error) = app.store.save()
                {
                    tracing::error!(%error, "failed to flush volatile store updates");
                }
            }
        });
    }

    let data_dir = match app.store.data_dir() {
        Ok(data_dir) => data_dir.to_path_buf(),
        Err(error) => {
            tracing::error!(%error, "could not resolve Limbo data directory");
            return;
        }
    };
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

    runtime.spawn(async move {
        match ApiServer::start(app, data_dir).await {
            Ok(Some(port)) => tracing::info!("companion API listening on 127.0.0.1:{port}"),
            Ok(None) => tracing::info!("companion API disabled"),
            Err(error) => tracing::error!("companion API failed: {error}"),
        }
    });
}

fn tray_icon() -> TrayIcon {
    let mut icon = TrayIcon::new(APP_ID, "Limbo");
    icon.icon_path = resource_path("icon.png");
    icon.tooltip = Some("Limbo".to_string());
    icon.menu = vec![
        TrayMenuItem {
            id: "open".to_string(),
            label: "Open Limbo".to_string(),
            action: Some("open".to_string()),
            enabled: true,
            separator: false,
        },
        TrayMenuItem {
            id: "separator".to_string(),
            label: String::new(),
            action: None,
            enabled: false,
            separator: true,
        },
        TrayMenuItem {
            id: "quit".to_string(),
            label: "Quit Limbo".to_string(),
            action: Some("quit".to_string()),
            enabled: true,
            separator: false,
        },
    ];
    icon
}

fn resource_path(file_name: &str) -> Option<PathBuf> {
    let relative = Path::new(file_name);
    let packaged = std::env::current_exe()
        .ok()
        .and_then(|executable| executable.parent().map(Path::to_path_buf))
        .into_iter()
        .flat_map(|directory| {
            [
                directory.join("resources").join(relative),
                directory.join("..").join("Resources").join(relative),
                directory
                    .join("..")
                    .join("share")
                    .join("sabine")
                    .join(APP_ID)
                    .join(relative),
            ]
        })
        .find(|path| path.is_file());
    packaged.or_else(|| {
        std::env::current_dir()
            .ok()
            .map(|directory| directory.join("public").join(relative))
            .filter(|path| path.is_file())
    })
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
