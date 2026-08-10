use std::path::PathBuf;

pub fn pick_folder(title: &str, default_path: Option<&str>) -> Option<PathBuf> {
    let mut dialog = rfd::FileDialog::new().set_title(title);
    if let Some(path) = default_path {
        dialog = dialog.set_directory(path);
    }
    dialog.pick_folder()
}

pub fn pick_file(title: &str, filters: &[(&str, &[&str])]) -> Option<PathBuf> {
    apply_filters(rfd::FileDialog::new().set_title(title), filters).pick_file()
}

pub fn pick_files(title: &str, filters: &[(&str, &[&str])]) -> Vec<PathBuf> {
    apply_filters(rfd::FileDialog::new().set_title(title), filters)
        .pick_files()
        .unwrap_or_default()
}

pub fn save_file(title: &str, default_name: &str, filters: &[(&str, &[&str])]) -> Option<PathBuf> {
    let dialog = rfd::FileDialog::new()
        .set_title(title)
        .set_file_name(default_name);
    apply_filters(dialog, filters).save_file()
}

fn apply_filters<'a>(
    mut dialog: rfd::FileDialog,
    filters: &[(&'a str, &'a [&'a str])],
) -> rfd::FileDialog {
    for (name, extensions) in filters {
        dialog = dialog.add_filter(*name, extensions);
    }
    dialog
}
