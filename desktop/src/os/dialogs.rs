use std::path::PathBuf;

use rfd::AsyncFileDialog;

pub async fn pick_folder(title: &str, start: Option<&str>) -> Option<PathBuf> {
    let dialog = AsyncFileDialog::new().set_title(title);
    let dialog = match start {
        Some(path) => dialog.set_directory(path),
        None => dialog,
    };
    dialog
        .pick_folder()
        .await
        .map(|handle| handle.path().to_path_buf())
}

pub async fn pick_json(title: &str) -> Option<PathBuf> {
    AsyncFileDialog::new()
        .set_title(title)
        .add_filter("JSON", &["json"])
        .pick_file()
        .await
        .map(|handle| handle.path().to_path_buf())
}

pub async fn save_json(title: &str, file_name: &str) -> Option<PathBuf> {
    AsyncFileDialog::new()
        .set_title(title)
        .set_file_name(file_name)
        .add_filter("JSON", &["json"])
        .save_file()
        .await
        .map(|handle| handle.path().to_path_buf())
}
