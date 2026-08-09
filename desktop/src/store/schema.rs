use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bookmark {
    pub id: String,
    pub name: String,
    pub url: String,
    pub favicon: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryItem {
    pub id: String,
    pub name: String,
    pub path: String,
    pub size: u64,
    #[serde(rename = "dateAdded")]
    pub date_added: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Download {
    pub id: String,
    pub filename: String,
    pub url: String,
    pub path: String,
    pub size: u64,
    pub downloaded: u64,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speed: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub eta: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extract_progress: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extract_status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TorrentInfo {
    pub id: String,
    pub name: String,
    pub magnet_uri: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_value: Option<String>,
    pub size: u64,
    pub downloaded: u64,
    pub uploaded: u64,
    pub progress: f64,
    pub download_speed: f64,
    pub upload_speed: f64,
    pub peers: u32,
    pub seeds: u32,
    pub status: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub info_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_file_index: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_provided_name: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keep_alive: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebridSettings {
    pub service: Option<String>,
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

impl Default for DebridSettings {
    fn default() -> Self {
        Self {
            service: None,
            api_key: String::new(),
            refresh_token: None,
            expires_at: None,
            client_id: None,
            client_secret: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub download_path: String,
    pub max_concurrent_downloads: u32,
    pub enable_seeding: bool,
    pub start_on_boot: bool,
    pub require_vpn: bool,
    pub auto_extract: bool,
    pub delete_archive_after_extract: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_token: Option<String>,
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
            auto_extract: true,
            delete_archive_after_extract: false,
            api_enabled: Some(true),
            api_port: Some(DEFAULT_API_PORT),
            api_token: Some(String::new()),
            debrid: DebridSettings::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreData {
    pub bookmarks: Vec<Bookmark>,
    pub library: Vec<LibraryItem>,
    pub downloads: Vec<Download>,
    pub torrents: Vec<TorrentInfo>,
    pub extracted_groups: Vec<String>,
    #[serde(default)]
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
            extracted_groups: Vec::new(),
            settings: Settings::default(),
        }
    }
}
