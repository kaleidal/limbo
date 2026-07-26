use std::path::Path;
use std::process::Command;

#[derive(Debug, thiserror::Error)]
pub enum ShellError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("failed to open: {0}")]
    Open(String),
}

pub fn open_path(path: &str) -> Result<(), ShellError> {
    open::that(path).map_err(|e| ShellError::Open(e.to_string()))
}

pub fn open_external(url: &str) -> Result<(), ShellError> {
    open::that(url).map_err(|e| ShellError::Open(e.to_string()))
}

pub fn show_in_folder(path: &str) -> Result<(), ShellError> {
    let target = Path::new(path);

    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(format!("/select,{}", target.display()))
            .spawn()?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open").args(["-R", &target.to_string_lossy()]).spawn()?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let dir = if target.is_dir() {
            target
        } else {
            target.parent().unwrap_or(target)
        };
        return open::that(dir).map_err(|e| ShellError::Open(e.to_string()));
    }
}
