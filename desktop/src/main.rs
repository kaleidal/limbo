use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use fenestra_cef::{
    FenestraLifecyclePolicy, FenestraWindow, RuntimeConfig, RuntimeMode, run_fenestra_host_from_args,
};
use limbo_desktop::api::ApiServer;
use limbo_desktop::ipc;
use limbo_desktop::os::clipboard::ClipboardWatcher;
use limbo_desktop::state::AppState;
use limbo_desktop::store::Store;
use tracing_subscriber::EnvFilter;

const DEV_URL: &str = "http://127.0.0.1:5177";
const DEV_PORT: u16 = 5177;

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
    {
        let app = app.clone();
        let download_path = download_path.clone();
        runtime.spawn(async move {
            if let Err(error) = app.torrent_engine.init(&download_path).await {
                tracing::error!("torrent engine init failed: {error}");
            } else {
                *app.stream_port.lock() = app.torrent_engine.stream_port();
            }
        });
    }

    {
        let app = app.clone();
        let data_dir = data_dir.clone();
        runtime.spawn(async move {
            match ApiServer::start(app, data_dir).await {
                Ok(Some(port)) => tracing::info!("companion API listening on 127.0.0.1:{port}"),
                Ok(None) => tracing::info!("companion API disabled"),
                Err(error) => tracing::error!("companion API failed: {error}"),
            }
        });
    }

    let _clipboard = ClipboardWatcher::start(app.clone(), Duration::from_millis(250));

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| manifest_dir.clone());
    let dist_entry = repo_root.join("dist").join("index.html");
    let dev_mode = std::env::var_os("LIMBO_DEV").is_some()
        || cfg!(debug_assertions)
        || args.iter().any(|arg| arg == "--dev");

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
        .lifecycle_policy(FenestraLifecyclePolicy::browser_tab())
        .runtime(fenestra_runtime);

    let mut vite: Option<Child> = None;
    if dev_mode {
        vite = ensure_vite(&repo_root);
        window = window.dev_url(DEV_URL);
    } else if dist_entry.exists() {
        window = window.entry(dist_entry.to_string_lossy());
    } else {
        vite = ensure_vite(&repo_root);
        window = window.dev_url(DEV_URL);
    }

    window = ipc::attach(window, app.clone());

    tracing::info!("starting Limbo on Fenestra (dev={dev_mode})");
    let result = window.launch_or_install();
    if let Some(mut child) = vite.take() {
        let _ = child.kill();
        let _ = child.wait();
    }

    match result {
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

fn ensure_vite(repo_root: &Path) -> Option<Child> {
    if port_open(DEV_PORT) {
        tracing::info!("vite already listening on {DEV_PORT}");
        return None;
    }

    tracing::info!("starting vite in {}", repo_root.display());
    let child = Command::new("bun")
        .args(["run", "dev"])
        .current_dir(repo_root)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| {
            eprintln!("failed to start vite (`bun run dev`): {error}");
            error
        })
        .ok()?;

    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        if port_open(DEV_PORT) {
            tracing::info!("vite ready on {DEV_PORT}");
            return Some(child);
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    eprintln!("vite did not become ready on port {DEV_PORT} within 30s");
    Some(child)
}

fn port_open(port: u16) -> bool {
    TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_millis(150),
    )
    .is_ok()
}

fn data_dir() -> PathBuf {
    directories::ProjectDirs::from("al", "kaleid", "Limbo")
        .map(|dirs| dirs.data_dir().to_path_buf())
        .unwrap_or_else(|| PathBuf::from(".").join("limbo-data"))
}
