use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Bookmark {
    pub id: String,
    pub name: String,
    pub url: String,
    pub favicon: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LibraryItem {
    pub id: String,
    pub name: String,
    pub path: String,
    pub size: u64,
    pub date_added: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum DownloadStatus {
    Pending,
    Downloading,
    Paused,
    Extracting,
    Completed,
    Error,
}

impl DownloadStatus {
    pub fn is_finished(self) -> bool {
        matches!(self, Self::Completed | Self::Error)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Download {
    pub id: String,
    pub filename: String,
    pub url: String,
    pub path: String,
    pub size: u64,
    pub downloaded: u64,
    pub status: DownloadStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speed: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub eta: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extract_progress: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extract_status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_name: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum TorrentStatus {
    Downloading,
    Seeding,
    Paused,
    Completed,
    Error,
}

impl TorrentStatus {
    pub fn is_done(self) -> bool {
        matches!(self, Self::Completed | Self::Seeding)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum TorrentSourceKind {
    #[default]
    Magnet,
    File,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TorrentInfo {
    pub id: String,
    pub name: String,
    pub magnet_uri: String,
    #[serde(default)]
    pub source_type: TorrentSourceKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_value: Option<String>,
    pub size: u64,
    pub downloaded: u64,
    pub uploaded: u64,
    pub progress: f64,
    pub download_speed: f64,
    pub upload_speed: f64,
    pub peers: u32,
    pub status: TorrentStatus,
    pub path: String,
    #[serde(default)]
    pub info_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_file_index: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_name: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum DebridProvider {
    RealDebrid,
    AllDebrid,
    Premiumize,
    TorBox,
}

impl DebridProvider {
    pub fn supports_torrents(self) -> bool {
        !matches!(self, Self::Premiumize)
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DebridSettings {
    pub service: Option<DebridProvider>,
    pub api_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_secret: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum ApiPromptPolicy {
    #[default]
    Always,
    Off,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub download_path: String,
    pub max_concurrent_downloads: u32,
    pub enable_seeding: bool,
    pub start_on_boot: bool,
    pub require_vpn: bool,
    pub clipboard_monitoring: bool,
    pub auto_extract: bool,
    pub delete_archive_after_extract: bool,
    pub api_enabled: bool,
    pub api_port: u16,
    pub api_token: String,
    pub api_prompt_policy: ApiPromptPolicy,
    pub trusted_api_clients: Vec<String>,
    pub debrid: DebridSettings,
}

pub const DEFAULT_API_PORT: u16 = 17890;

fn default_download_path() -> String {
    directories::UserDirs::new()
        .and_then(|dirs| dirs.download_dir().map(|p| p.join("Limbo")))
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Limbo".to_string())
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            download_path: default_download_path(),
            max_concurrent_downloads: 3,
            enable_seeding: false,
            start_on_boot: false,
            require_vpn: false,
            clipboard_monitoring: false,
            auto_extract: true,
            delete_archive_after_extract: false,
            api_enabled: true,
            api_port: DEFAULT_API_PORT,
            api_token: String::new(),
            api_prompt_policy: ApiPromptPolicy::default(),
            trusted_api_clients: Vec::new(),
            debrid: DebridSettings::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StoreData {
    pub bookmarks: Vec<Bookmark>,
    pub library: Vec<LibraryItem>,
    pub downloads: Vec<Download>,
    pub torrents: Vec<TorrentInfo>,
    pub extracted_archives: Vec<String>,
    pub settings: Settings,
}

fn default_bookmark() -> Bookmark {
    Bookmark {
        id: "1".to_string(),
        name: "Internet Archive".to_string(),
        url: "https://archive.org".to_string(),
        favicon: "https://www.google.com/s2/favicons?domain=archive.org&sz=64".to_string(),
    }
}

impl Default for StoreData {
    fn default() -> Self {
        Self {
            bookmarks: vec![default_bookmark()],
            library: Vec::new(),
            downloads: Vec::new(),
            torrents: Vec::new(),
            extracted_archives: Vec::new(),
            settings: Settings::default(),
        }
    }
}
