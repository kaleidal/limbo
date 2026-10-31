use std::path::Path;
#[cfg(any(target_os = "windows", target_os = "macos"))]
use std::process::Command;

#[derive(Debug, thiserror::Error)]
pub enum ShellError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("unsupported URL scheme")]
    UnsupportedScheme,
}

pub fn open_path(path: &Path) -> Result<(), ShellError> {
    Ok(open::that_detached(path)?)
}

pub fn open_external(url: &str) -> Result<(), ShellError> {
    let parsed = reqwest::Url::parse(url).map_err(|_| ShellError::UnsupportedScheme)?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(ShellError::UnsupportedScheme);
    }
    Ok(open::that_detached(parsed.as_str())?)
}

#[cfg(target_os = "windows")]
pub fn show_in_folder(path: &Path) -> Result<(), ShellError> {
    Command::new("explorer")
        .arg(format!("/select,{}", path.display()))
        .spawn()?;
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn show_in_folder(path: &Path) -> Result<(), ShellError> {
    Command::new("open").arg("-R").arg(path).spawn()?;
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
pub fn show_in_folder(path: &Path) -> Result<(), ShellError> {
    let folder = if path.is_dir() {
        path
    } else {
        path.parent().unwrap_or(path)
    };
    Ok(open::that_detached(folder)?)
}
