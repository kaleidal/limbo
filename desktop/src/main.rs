use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use fenestra_cef::{
    FenestraLifecyclePolicy, FenestraWindow, RuntimeConfig, RuntimeMode, run_fenestra_host_from_args,
};
use limbo_desktop::api::ApiServer;
use limbo_desktop::ipc;
use limbo_desktop::os::clipboard::ClipboardWatcher;
use limbo_desktop::state::AppState;
use limbo_desktop::store::Store;
use tracing_subscriber::EnvFilter;

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("limbo=info".parse().unwrap()))
        .init();

    let args = std::env::args().collect::<Vec<_>>();
    if run_fenestra_host_from_args(&args) {
        return;
    }

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let handle = runtime.handle().clone();

    let data_dir = data_dir();
    let store = Store::load(&data_dir).expect("load store");
    let app = Arc::new(AppState::new(store, handle.clone()));

    let download_path = app.store.with(|d| d.settings.download_path.clone());
    if let Err(error) = runtime.block_on(app.torrent_engine.init(&download_path)) {
        tracing::error!("torrent engine init failed: {error}");
    }
    *app.stream_port.lock() = app.torrent_engine.stream_port();

    match runtime.block_on(ApiServer::start(app.clone(), data_dir.clone())) {
        Ok(Some(port)) => tracing::info!("companion API listening on 127.0.0.1:{port}"),
        Ok(None) => tracing::info!("companion API disabled"),
        Err(error) => tracing::error!("companion API failed: {error}"),
    }

    let _clipboard = ClipboardWatcher::start(app.clone(), Duration::from_millis(100));

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| manifest_dir.clone());
    let dist_entry = repo_root.join("dist").join("index.html");

    let fenestra_runtime = RuntimeConfig {
        mode: RuntimeMode::SharedPreferred,
        allow_user_install: true,
        bundled_dir: Some(manifest_dir.clone()),
        ..RuntimeConfig::default()
    };

    let mut window = FenestraWindow::new()
        .app_id("al.kaleid.limbo")
        .title("Limbo")
        .size(1400, 900)
        .frameless()
        .titlebar_drag_region(40)
        .lifecycle_policy(FenestraLifecyclePolicy::browser_tab())
        .runtime(fenestra_runtime)
        .dev_url("http://localhost:5177")
        .dev_command(format!(
            "bun run --cwd \"{}\" dev",
            repo_root.display()
        ));

    if dist_entry.exists() {
        window = window.entry(dist_entry.to_string_lossy());
    }

    window = ipc::attach(window, app.clone());

    tracing::info!("starting Limbo on Fenestra");
    match window.launch_or_install() {
        Ok(process) => {
            tracing::info!("Limbo window closed (pid {})", process.id());
            let _ = process.wait();
        }
        Err(error) => {
            eprintln!("failed to launch Limbo: {error}");
            std::process::exit(1);
        }
    }
}

fn data_dir() -> PathBuf {
    directories::ProjectDirs::from("al", "kaleid", "Limbo")
        .map(|dirs| dirs.data_dir().to_path_buf())
        .unwrap_or_else(|| PathBuf::from(".").join("limbo-data"))
}
