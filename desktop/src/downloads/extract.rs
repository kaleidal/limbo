use std::fs::File;
use std::io::{self, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use super::naming::ArchiveKind;

#[derive(Debug, thiserror::Error)]
pub enum ExtractError {
    #[error("{0}")]
    Io(#[from] io::Error),
    #[error("{0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("{0}")]
    SevenZip(#[from] sevenz_rust2::Error),
    #[error("{0}")]
    Rar(#[from] unrar::error::UnrarError),
}

pub struct Extraction {
    pub kind: ArchiveKind,
    /// Every volume in order, starting with the first.
    pub volumes: Vec<PathBuf>,
    pub output: PathBuf,
}

impl Extraction {
    pub fn run(&self, progress: impl FnMut(f64)) -> Result<(), ExtractError> {
        std::fs::create_dir_all(&self.output)?;
        match self.kind {
            ArchiveKind::Zip => {
                let reader = ProgressReader::new(Volumes::open(&self.volumes)?, progress);
                zip::ZipArchive::new(BufReader::new(reader))?.extract(&self.output)?;
            }
            ArchiveKind::SevenZip => {
                let reader = ProgressReader::new(Volumes::open(&self.volumes)?, progress);
                sevenz_rust2::decompress(BufReader::new(reader), &self.output)?;
            }
            ArchiveKind::Rar => extract_rar(&self.volumes[0], &self.output, progress)?,
        }
        Ok(())
    }
}

fn extract_rar(
    first_volume: &Path,
    output: &Path,
    mut progress: impl FnMut(f64),
) -> Result<(), ExtractError> {
    let total = unrar::Archive::new(first_volume)
        .open_for_listing()?
        .count()
        .max(1);
    let mut archive = unrar::Archive::new(first_volume).open_for_processing()?;
    let mut done = 0;
    while let Some(entry) = archive.read_header()? {
        archive = if entry.entry().is_file() {
            entry.extract_with_base(output)?
        } else {
            entry.skip()?
        };
        done += 1;
        progress(done as f64 / total as f64);
    }
    Ok(())
}

/// Reads split volumes (`name.7z.001`, `name.7z.002`, …) as the one archive
/// they were cut from.
struct Volumes {
    files: Vec<(File, u64)>,
    position: u64,
    length: u64,
}

impl Volumes {
    fn open(paths: &[PathBuf]) -> io::Result<Self> {
        let files = paths
            .iter()
            .map(|path| {
                let file = File::open(path)?;
                let length = file.metadata()?.len();
                Ok((file, length))
            })
            .collect::<io::Result<Vec<_>>>()?;
        let length = files.iter().map(|(_, length)| length).sum();
        Ok(Self {
            files,
            position: 0,
            length,
        })
    }

    fn locate(&self) -> Option<(usize, u64)> {
        let mut start = 0;
        for (index, (_, length)) in self.files.iter().enumerate() {
            if self.position < start + length {
                return Some((index, self.position - start));
            }
            start += length;
        }
        None
    }
}

impl Read for Volumes {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let Some((index, offset)) = self.locate() else {
            return Ok(0);
        };
        let (file, length) = &mut self.files[index];
        let wanted = buffer.len().min((*length - offset) as usize);
        file.seek(SeekFrom::Start(offset))?;
        let read = file.read(&mut buffer[..wanted])?;
        self.position += read as u64;
        Ok(read)
    }
}

impl Seek for Volumes {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        let target = match position {
            SeekFrom::Start(offset) => Some(offset),
            SeekFrom::End(offset) => self.length.checked_add_signed(offset),
            SeekFrom::Current(offset) => self.position.checked_add_signed(offset),
        };
        self.position = target.ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "seek before start of archive")
        })?;
        Ok(self.position)
    }
}

struct ProgressReader<F> {
    inner: Volumes,
    report: F,
    reported: u32,
}

impl<F: FnMut(f64)> ProgressReader<F> {
    fn new(inner: Volumes, report: F) -> Self {
        Self {
            inner,
            report,
            reported: 0,
        }
    }
}

impl<F: FnMut(f64)> Read for ProgressReader<F> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let read = self.inner.read(buffer)?;
        let fraction = self.inner.position as f64 / self.inner.length.max(1) as f64;
        let percent = (fraction * 100.0) as u32;
        if percent > self.reported {
            self.reported = percent;
            (self.report)(fraction);
        }
        Ok(read)
    }
}

impl<F: FnMut(f64)> Seek for ProgressReader<F> {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        self.inner.seek(position)
    }
}
