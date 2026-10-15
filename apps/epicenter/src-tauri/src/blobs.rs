//! App-local immutable files, read by native decoding and transcription.
//! Saved keys are complete filenames. Descriptive information belongs to rows.
//!
//! Nothing native writes here any more: a recording is a file in its folder
//! (`tauri-plugin-epicenter-recorder`, ADR-0543). The Bun host still saves
//! blobs into this directory, and these commands read them.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// Which application's blobs, and whose: the directory a read resolves to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BlobDestination {
    pub app_id: String,
    pub account: Option<crate::device_owner::AccountIdentity>,
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct BlobError(String);

impl BlobError {
    fn failed(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl From<std::io::Error> for BlobError {
    fn from(error: std::io::Error) -> Self {
        Self::failed(error.to_string())
    }
}

/// A complete blob key: `blob_`, 21 lowercase letters or digits, a dot, and
/// an extension of one to ten of them. The same shape the TypeScript parser
/// accepts.
pub(crate) fn validate_blob_id(id: &str) -> Result<(), BlobError> {
    let invalid = || BlobError::failed("Invalid complete blob key");
    let (body, extension) = id
        .strip_prefix("blob_")
        .and_then(|rest| rest.split_once('.'))
        .ok_or_else(invalid)?;
    let alphanumeric = |byte: u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
    if body.len() != 21
        || !body.bytes().all(alphanumeric)
        || !(1..=10).contains(&extension.len())
        || !extension.bytes().all(alphanumeric)
    {
        return Err(invalid());
    }
    Ok(())
}

/// Resolve only validated identifiers beneath the shared startup-selected root.
pub(crate) fn blobs_directory(
    data_dir: &Path,
    destination: &BlobDestination,
) -> Result<PathBuf, BlobError> {
    if !is_app_id(&destination.app_id) {
        return Err(BlobError::failed(
            "blob destination contains an invalid app id",
        ));
    }
    Ok(data_dir
        .join("apps")
        .join(&destination.app_id)
        .join("device")
        .join(crate::device_owner::path(destination.account.as_ref()).map_err(BlobError::failed)?)
        .join("blobs"))
}

/// Matches the application ID owner in packages/constants without another regex.
fn is_app_id(value: &str) -> bool {
    let labels: Vec<_> = value.split('.').collect();
    labels.len() >= 2
        && labels.iter().all(|label| {
            let bytes = label.as_bytes();
            let alphanumeric = |byte: u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
            bytes.first().is_some_and(|byte| alphanumeric(*byte))
                && bytes.last().is_some_and(|byte| alphanumeric(*byte))
                && bytes
                    .iter()
                    .all(|byte| alphanumeric(*byte) || *byte == b'-')
        })
}

/// Read one regular final file; a symlink is never a native audio source.
fn read_file(root: &Path, id: &str) -> Result<Vec<u8>, BlobError> {
    validate_blob_id(id)?;
    let path = root.join(id);
    let before = fs::symlink_metadata(&path)?;
    if !before.is_file() {
        return Err(BlobError::failed("Blob entry is not a regular file"));
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    let mut file = options.open(&path)?;
    let opened = file.metadata()?;
    let after = fs::symlink_metadata(&path)?;
    if !opened.is_file() || !after.is_file() {
        return Err(BlobError::failed("Blob entry is not a regular file"));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if opened.file_attributes() & 0x400 != 0 {
            return Err(BlobError::failed("Blob entry is a reparse point"));
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.dev() != opened.dev()
            || before.ino() != opened.ino()
            || after.dev() != opened.dev()
            || after.ino() != opened.ino()
        {
            return Err(BlobError::failed("Blob entry changed while opening"));
        }
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok(bytes)
}

pub fn read_blob_bytes(
    app: &AppHandle,
    id: &str,
    destination: &BlobDestination,
) -> Result<Vec<u8>, BlobError> {
    let root = blobs_directory(
        &app.state::<crate::app_data::DesktopPaths>().data_dir,
        destination,
    )?;
    read_file(&root, id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn identical_blob_keys_resolve_independently_for_each_account() {
        let root = tempfile::tempdir().unwrap();
        let id = "blob_aaaaaaaaaaaaaaaaaaaaa.wav";
        let mut paths = HashSet::new();
        for (authority, person) in [("one", "alice"), ("one", "bob"), ("two", "alice")] {
            let destination = BlobDestination {
                app_id: "so.epicenter.test".into(),
                account: Some(crate::device_owner::AccountIdentity {
                    authority_id: authority.into(),
                    principal_id: person.into(),
                }),
            };
            let path = blobs_directory(root.path(), &destination).unwrap();
            assert!(paths.insert(path.clone()));
            fs::create_dir_all(&path).unwrap();
            fs::write(path.join(id), person.as_bytes()).unwrap();
            assert_eq!(read_file(&path, id).unwrap(), person.as_bytes());
        }
    }

    #[test]
    fn complete_keys_are_validated_by_shape() {
        validate_blob_id("blob_aaaaaaaaaaaaaaaaaaaaa.wav").unwrap();
        validate_blob_id("blob_0123456789abcdefghijk.webm").unwrap();
        for id in [
            "blob_aaaaaaaaaaaaaaaaaaaaa",
            "blob_aaaaaaaaaaaaaaaaaaaa.wav",
            "blob_AAAAAAAAAAAAAAAAAAAAA.wav",
            "blob_aaaaaaaaaaaaaaaaaaaaa.",
            "blob_aaaaaaaaaaaaaaaaaaaaa.abcdefghijk",
            "attachment.recordings.aaaaaaaaaaaaaaaaaaaaaaaa",
        ] {
            assert!(validate_blob_id(id).is_err(), "{id}");
        }
    }

    #[test]
    fn app_roots_include_the_captured_storage_owner() {
        let root = Path::new("data");
        assert_eq!(
            blobs_directory(
                root,
                &BlobDestination {
                    app_id: "so.epicenter.notes".into(),
                    account: None,
                }
            )
            .unwrap(),
            root.join("apps/so.epicenter.notes/device/no-account/blobs")
        );
        for app_id in ["../outside", "invalid", "so.Epicenter.notes", "so..notes"] {
            assert!(blobs_directory(
                root,
                &BlobDestination {
                    app_id: app_id.into(),
                    account: None,
                }
            )
            .is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn native_reader_refuses_symlinks_directories_and_legacy_keys() {
        let root = tempfile::tempdir().unwrap();
        let id = "blob_aaaaaaaaaaaaaaaaaaaaa.wav";
        let outside = root.path().join("outside");
        fs::write(&outside, b"private").unwrap();
        std::os::unix::fs::symlink(&outside, root.path().join(&id)).unwrap();
        assert!(read_file(root.path(), &id).is_err());
        fs::remove_file(root.path().join(&id)).unwrap();
        fs::create_dir(root.path().join(&id)).unwrap();
        assert!(read_file(root.path(), &id).is_err());
        assert!(read_file(root.path(), "blob_aaaaaaaaaaaaaaaaaaaaa").is_err());
        assert!(read_file(
            root.path(),
            "attachment.recordings.aaaaaaaaaaaaaaaaaaaaaaaa"
        )
        .is_err());
        assert_eq!(fs::read(outside).unwrap(), b"private");
    }
}
