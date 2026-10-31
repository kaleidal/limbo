use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use crate::events::CLIPBOARD_LINKS;
use crate::state::AppState;

pub struct ClipboardWatcher {
    stop: Arc<AtomicBool>,
}

impl ClipboardWatcher {
    pub fn start(app: Weak<AppState>, interval: Duration) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let stop_flag = stop.clone();

        std::thread::spawn(move || {
            let Ok(mut clipboard) = arboard::Clipboard::new() else {
                return;
            };
            let mut last = String::new();

            while !stop_flag.load(Ordering::SeqCst) {
                let text = clipboard.get_text();
                if stop_flag.load(Ordering::SeqCst) {
                    break;
                }
                if let Ok(text) = text
                    && !text.is_empty()
                    && text != last
                {
                    last = text.clone();
                    let urls = extract_downloadable_urls(&text);
                    if !urls.is_empty() {
                        let Some(app) = app.upgrade() else {
                            break;
                        };
                        app.send(&CLIPBOARD_LINKS, &urls);
                    }
                }
                std::thread::sleep(interval);
            }
        });

        Self { stop }
    }
}

impl Drop for ClipboardWatcher {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

fn extract_downloadable_urls(text: &str) -> Vec<String> {
    let mut urls = Vec::new();
    for token in text.split_whitespace() {
        let trimmed = token.trim_matches(|c: char| {
            matches!(
                c,
                '"' | '\'' | '<' | '>' | '(' | ')' | '[' | ']' | '{' | '}' | ','
            )
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
