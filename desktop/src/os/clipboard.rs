use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use crate::state::AppState;

#[derive(Debug, thiserror::Error)]
pub enum ClipboardError {
    #[error("clipboard unavailable: {0}")]
    Unavailable(String),
}

pub fn read_text() -> Result<String, ClipboardError> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| ClipboardError::Unavailable(e.to_string()))?;
    clipboard.get_text().map_err(|e| ClipboardError::Unavailable(e.to_string()))
}

pub fn write_text(text: &str) -> Result<(), ClipboardError> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| ClipboardError::Unavailable(e.to_string()))?;
    clipboard
        .set_text(text.to_string())
        .map_err(|e| ClipboardError::Unavailable(e.to_string()))
}

pub struct ClipboardWatcher {
    stop: Arc<AtomicBool>,
}

impl ClipboardWatcher {
    pub fn start(app: Arc<AppState>, interval: Duration) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let stop_flag = stop.clone();

        std::thread::spawn(move || {
            let Ok(mut clipboard) = arboard::Clipboard::new() else {
                return;
            };
            let mut last = String::new();

            while !stop_flag.load(Ordering::SeqCst) {
                if let Ok(text) = clipboard.get_text() {
                    if !text.is_empty() && text != last {
                        last = text.clone();
                        let urls = extract_downloadable_urls(&text);
                        if !urls.is_empty() {
                            app.push_event(
                                "clipboard-download-detected",
                                serde_json::to_value(&urls).unwrap_or_default(),
                            );
                        }
                    }
                }
                std::thread::sleep(interval);
            }
        });

        Self { stop }
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

impl Drop for ClipboardWatcher {
    fn drop(&mut self) {
        self.stop();
    }
}

fn extract_downloadable_urls(text: &str) -> Vec<String> {
    let mut urls = Vec::new();
    for token in text.split_whitespace() {
        let trimmed = token.trim_matches(|c: char| {
            matches!(c, '"' | '\'' | '<' | '>' | '(' | ')' | '[' | ']' | '{' | '}' | ',')
        });
        if trimmed.starts_with("magnet:")
            || trimmed.starts_with("http://")
            || trimmed.starts_with("https://")
        {
            urls.push(trimmed.to_string());
        }
    }
    urls
}
