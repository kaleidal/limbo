use std::path::Path;

use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct DownloadGroup {
    pub id: String,
    pub name: String,
}

impl DownloadGroup {
    pub fn for_magnet(magnet: &str) -> Self {
        Self::named(crate::torrent::magnet_name(magnet).unwrap_or_else(|| "Torrent".into()))
    }

    pub fn for_url(url: &str) -> Self {
        let name = derive_filename(url);
        let name = name.strip_suffix(".torrent").unwrap_or(&name);
        Self::named(name.to_string())
    }

    fn named(name: String) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            name,
        }
    }

    pub fn for_archive_set(set: &ArchiveSet) -> Self {
        Self {
            id: format!("archive:{}", set.base.to_lowercase()),
            name: set.base.clone(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveKind {
    Zip,
    SevenZip,
    Rar,
}

/// Where a file sits in a multi-volume archive: `name.part2.rar`, `name.r00`,
/// `name.7z.001` and `name.zip.001` all belong to the set named `name`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveSet {
    pub base: String,
    pub kind: ArchiveKind,
    pub first: bool,
}

pub fn archive_kind(filename: &str) -> Option<ArchiveKind> {
    let lower = filename.to_lowercase();
    if lower.ends_with(".zip") {
        Some(ArchiveKind::Zip)
    } else if lower.ends_with(".7z") {
        Some(ArchiveKind::SevenZip)
    } else if lower.ends_with(".rar") {
        Some(ArchiveKind::Rar)
    } else {
        archive_set(filename).map(|set| set.kind)
    }
}

pub fn archive_set(filename: &str) -> Option<ArchiveSet> {
    let (stem, extension) = filename.rsplit_once('.')?;
    let lower_extension = extension.to_lowercase();
    if lower_extension == "rar"
        && let Some((base, part)) = stem.rsplit_once('.')
        && let Some(number) = part.to_lowercase().strip_prefix("part")
        && let Ok(number) = number.parse::<u32>()
    {
        return Some(ArchiveSet {
            base: base.to_string(),
            kind: ArchiveKind::Rar,
            first: number == 1,
        });
    }
    if let Some(digits) = lower_extension.strip_prefix('r')
        && digits.len() >= 2
        && digits.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Some(ArchiveSet {
            base: stem.to_string(),
            kind: ArchiveKind::Rar,
            first: false,
        });
    }
    if lower_extension.len() == 3 && lower_extension.bytes().all(|byte| byte.is_ascii_digit()) {
        let (base, inner) = stem.rsplit_once('.')?;
        let kind = match inner.to_lowercase().as_str() {
            "7z" => ArchiveKind::SevenZip,
            "zip" => ArchiveKind::Zip,
            _ => return None,
        };
        return Some(ArchiveSet {
            base: base.to_string(),
            kind,
            first: lower_extension == "001",
        });
    }
    None
}

pub fn derive_filename(url: &str) -> String {
    url.rsplit('/')
        .find(|segment| !segment.is_empty())
        .map(|segment| segment.split(['?', '#']).next().unwrap_or(segment))
        .filter(|segment| !segment.is_empty())
        .unwrap_or("download")
        .to_string()
}

pub fn sanitize_filename(raw: &str) -> String {
    let candidate = raw.rsplit(['/', '\\']).next().unwrap_or_default();
    let cleaned: String = candidate
        .chars()
        .filter(|character| !matches!(character, '/' | '\\' | ':' | '\0'))
        .collect();
    let trimmed = cleaned.trim().trim_matches('.');
    let stem = trimmed.split('.').next().unwrap_or_default().trim();
    const WINDOWS_RESERVED_NAMES: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if trimmed.is_empty()
        || WINDOWS_RESERVED_NAMES
            .iter()
            .any(|name| stem.eq_ignore_ascii_case(name))
    {
        "download".to_string()
    } else {
        trimmed.to_string()
    }
}

pub fn extraction_folder(archive: &Path) -> Option<std::path::PathBuf> {
    let filename = archive.file_name()?.to_string_lossy();
    let name = match archive_set(&filename) {
        Some(set) => set.base,
        None => filename.rsplit_once('.')?.0.to_string(),
    };
    Some(archive.with_file_name(name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filename_is_reduced_to_one_safe_component() {
        assert_eq!(sanitize_filename("../../secret.txt"), "secret.txt");
        assert_eq!(sanitize_filename("/etc/passwd"), "passwd");
        assert_eq!(sanitize_filename(".."), "download");
        assert_eq!(sanitize_filename("C:\\temp\\file:name"), "filename");
        assert_eq!(sanitize_filename("con.txt"), "download");
        assert_eq!(sanitize_filename(" LPT9 .log"), "download");
    }

    #[test]
    fn recognizes_volume_names() {
        let set = |base: &str, kind, first| {
            Some(ArchiveSet {
                base: base.to_string(),
                kind,
                first,
            })
        };
        assert_eq!(
            archive_set("Game.part01.rar"),
            set("Game", ArchiveKind::Rar, true)
        );
        assert_eq!(
            archive_set("Game.part2.rar"),
            set("Game", ArchiveKind::Rar, false)
        );
        assert_eq!(
            archive_set("Game.r00"),
            set("Game", ArchiveKind::Rar, false)
        );
        assert_eq!(
            archive_set("Disc.7z.001"),
            set("Disc", ArchiveKind::SevenZip, true)
        );
        assert_eq!(
            archive_set("Disc.zip.003"),
            set("Disc", ArchiveKind::Zip, false)
        );
        assert_eq!(archive_set("Game.rar"), None);
        assert_eq!(archive_set("movie.mp4"), None);
    }
}
