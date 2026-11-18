//! The five file operations the page's `Files` makes on the desktop. Each
//! takes the folder and a folder-relative path the path rule accepts, and
//! refuses a link on the way. Bytes only: nothing here reads what a file
//! means.

use std::fs;
use std::io::ErrorKind;
use std::path::Path;
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::beside::replace;
use crate::error::{FilesError, Result};
use crate::path::{is_file_name, make_parents, resolve, resolve_dir};

/// What `read_many` writes for a path with no file, in place of its length.
pub(crate) const MISSING: u32 = u32::MAX;

/// Whether `error` says nothing is at a path: a missing file, a directory
/// where a file was asked for, or a file where a directory is on the way.
fn missing(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        ErrorKind::NotFound | ErrorKind::NotADirectory | ErrorKind::IsADirectory
    )
}

/// The bytes of the file `relative` in `folder`; a missing one is `NotFound`.
pub fn read(folder: &Path, relative: &str) -> Result<Vec<u8>> {
    let path = resolve(folder, relative)?;
    fs::read(&path).map_err(|error| {
        if missing(&error) {
            FilesError::not_found(format!("{relative}: no file is there"))
        } else {
            FilesError::from_io(relative, &error)
        }
    })
}

/// The files at `paths` in `folder`, in one buffer: a `u32` little-endian
/// count, then for each path in order its length as a `u32` little-endian
/// or [`MISSING`] for a file that is not there, then every present file's
/// bytes in order. A path the rule refuses refuses the whole call.
pub fn read_many(folder: &Path, paths: &[String]) -> Result<Vec<u8>> {
    let resolved = paths
        .iter()
        .map(|relative| resolve(folder, relative))
        .collect::<Result<Vec<_>>>()?;
    let count = u32::try_from(paths.len())
        .map_err(|_| FilesError::refused("too many paths for one read"))?;
    let mut lengths = Vec::with_capacity(4 + 4 * paths.len());
    lengths.extend_from_slice(&count.to_le_bytes());
    let mut bodies = Vec::new();
    for (relative, path) in paths.iter().zip(&resolved) {
        match fs::read(path) {
            Ok(bytes) => {
                let length = u32::try_from(bytes.len())
                    .ok()
                    .filter(|length| *length != MISSING)
                    .ok_or_else(|| FilesError::io(format!("{relative} is too large to read")))?;
                lengths.extend_from_slice(&length.to_le_bytes());
                bodies.extend_from_slice(&bytes);
            }
            Err(error) if missing(&error) => lengths.extend_from_slice(&MISSING.to_le_bytes()),
            Err(error) => return Err(FilesError::from_io(relative, &error)),
        }
    }
    lengths.extend_from_slice(&bodies);
    Ok(lengths)
}

/// Replace the file `relative` in `folder` whole with `bytes`, its missing
/// directories made: written and flushed beside it, then renamed over it
/// ([`replace`]).
pub fn write(folder: &Path, relative: &str, bytes: &[u8]) -> Result<()> {
    let target = resolve(folder, relative)?;
    make_parents(folder, relative)?;
    replace(&target, bytes)
        .map_err(|error| FilesError::from_io(format!("{relative} could not be written"), &error))
}

/// Remove the file `relative` in `folder`; one that is not there is not a
/// failure.
pub fn remove(folder: &Path, relative: &str) -> Result<()> {
    let path = resolve(folder, relative)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if matches!(error.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) => {
            Ok(())
        }
        Err(error) => Err(FilesError::from_io(relative, &error)),
    }
}

/// A file a listing found: its name in its directory, its size in bytes,
/// and when it was last modified, in milliseconds since the Unix epoch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub size: u64,
    pub modified_ms: u64,
}

/// The files in the directory `relative` in `folder` (the folder itself for
/// `""`), sorted by name: regular files only, never a directory or a link,
/// and only names the path rule accepts, so a hidden name, such as a
/// write's `.<name>.<random>.tmp`, never lists. A missing directory lists as empty; a missing
/// folder is `NotFound`.
pub fn list(folder: &Path, relative: &str) -> Result<Vec<Entry>> {
    let directory = resolve_dir(folder, relative)?;
    match fs::symlink_metadata(folder) {
        Ok(metadata) if metadata.is_dir() || metadata.file_type().is_symlink() => {}
        Ok(_) => {
            return Err(FilesError::not_found(format!(
                "{} is not a folder",
                folder.display()
            )))
        }
        Err(error) => return Err(FilesError::from_io(folder.display(), &error)),
    }
    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) if missing(&error) && !relative.is_empty() => return Ok(Vec::new()),
        Err(error) => return Err(FilesError::from_io(directory.display(), &error)),
    };
    let mut listed = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| FilesError::from_io(directory.display(), &error))?;
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if !is_file_name(&name) {
            continue;
        }
        let metadata = match fs::symlink_metadata(entry.path()) {
            Ok(metadata) => metadata,
            // Removed since the directory was read.
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(error) => return Err(FilesError::from_io(entry.path().display(), &error)),
        };
        if !metadata.is_file() {
            continue;
        }
        let modified_ms = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |since| since.as_millis() as u64);
        listed.push(Entry {
            name,
            size: metadata.len(),
            modified_ms,
        });
    }
    listed.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(listed)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The paths and their files, read back from a `read_many` buffer.
    fn decode(buffer: &[u8]) -> Vec<Option<Vec<u8>>> {
        let word = |at: usize| u32::from_le_bytes(buffer[at..at + 4].try_into().unwrap());
        let count = word(0) as usize;
        let mut offset = 4 + 4 * count;
        (0..count)
            .map(|index| match word(4 + 4 * index) {
                MISSING => None,
                length => {
                    let bytes = buffer[offset..offset + length as usize].to_vec();
                    offset += length as usize;
                    Some(bytes)
                }
            })
            .collect()
    }

    #[test]
    fn read_many_encodes_counts_lengths_then_bytes() {
        let folder = tempfile::tempdir().unwrap();
        fs::create_dir(folder.path().join("recordings")).unwrap();
        fs::write(folder.path().join("recordings/a.md"), b"alpha").unwrap();
        fs::write(folder.path().join("recordings/c.md"), b"").unwrap();
        fs::write(folder.path().join("settings.md"), b"s").unwrap();
        let paths: Vec<String> = [
            "recordings/a.md",
            "recordings/b.md",
            "recordings/c.md",
            "settings.md",
        ]
        .map(String::from)
        .to_vec();
        let buffer = read_many(folder.path(), &paths).unwrap();
        let mut expected = Vec::new();
        for word in [4u32, 5, MISSING, 0, 1] {
            expected.extend_from_slice(&word.to_le_bytes());
        }
        expected.extend_from_slice(b"alphas");
        assert_eq!(buffer, expected);
        assert_eq!(
            decode(&buffer),
            [
                Some(b"alpha".to_vec()),
                None,
                Some(vec![]),
                Some(b"s".to_vec())
            ]
        );
        assert_eq!(read_many(folder.path(), &[]).unwrap(), 0u32.to_le_bytes());
        assert!(matches!(
            read_many(folder.path(), &["settings.md".into(), "../x.md".into()]),
            Err(FilesError::Refused { .. })
        ));
    }

    #[test]
    fn read_write_and_remove_a_file() {
        let folder = tempfile::tempdir().unwrap();
        assert!(matches!(
            read(folder.path(), "recordings/a.md"),
            Err(FilesError::NotFound { .. })
        ));
        write(folder.path(), "recordings/a.md", b"one").unwrap();
        write(folder.path(), "recordings/a.md", b"two").unwrap();
        assert_eq!(read(folder.path(), "recordings/a.md").unwrap(), b"two");
        assert_eq!(
            fs::read_dir(folder.path().join("recordings"))
                .unwrap()
                .map(|entry| entry.unwrap().file_name())
                .collect::<Vec<_>>(),
            ["a.md"],
            "nothing left beside it"
        );
        assert!(matches!(
            write(folder.path(), ".hidden", b"x"),
            Err(FilesError::Refused { .. })
        ));
        remove(folder.path(), "recordings/a.md").unwrap();
        remove(folder.path(), "recordings/a.md").unwrap();
        remove(folder.path(), "nothing/here.md").unwrap();
        assert!(matches!(
            read(folder.path(), "recordings/a.md"),
            Err(FilesError::NotFound { .. })
        ));
        assert!(matches!(
            read(folder.path(), "recordings"),
            Err(FilesError::NotFound { .. })
        ));
    }

    #[test]
    fn list_answers_plain_regular_files_sorted() {
        let folder = tempfile::tempdir().unwrap();
        let recordings = folder.path().join("recordings");
        fs::create_dir(&recordings).unwrap();
        fs::write(recordings.join("b.webm"), b"12345").unwrap();
        fs::write(recordings.join("a.md"), b"1").unwrap();
        fs::write(recordings.join(".DS_Store"), b"").unwrap();
        fs::write(recordings.join(".a.md.k3x9q0w1.tmp"), b"").unwrap();
        fs::write(recordings.join("a.b.c"), b"").unwrap();
        fs::create_dir(recordings.join("sub")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(recordings.join("a.md"), recordings.join("link.md")).unwrap();
        let listed = list(folder.path(), "recordings").unwrap();
        let names: Vec<_> = listed.iter().map(|entry| entry.name.as_str()).collect();
        assert_eq!(names, ["a.md", "b.webm"]);
        assert_eq!(listed[1].size, 5);
        assert!(listed[1].modified_ms > 1_600_000_000_000);
        let json = serde_json::to_value(&listed[0]).unwrap();
        assert_eq!(
            json.as_object().unwrap().keys().collect::<Vec<_>>(),
            ["modifiedMs", "name", "size"]
        );

        assert_eq!(list(folder.path(), "transcriptions").unwrap(), []);
        assert_eq!(
            list(folder.path(), "").unwrap(),
            [],
            "the folder holds only a directory"
        );
        assert!(matches!(
            list(&folder.path().join("missing"), ""),
            Err(FilesError::NotFound { .. })
        ));
        assert!(matches!(
            list(&folder.path().join("missing"), "recordings"),
            Err(FilesError::NotFound { .. })
        ));
        assert!(matches!(
            list(folder.path(), "a.b"),
            Err(FilesError::Refused { .. })
        ));
    }
}
