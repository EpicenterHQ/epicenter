//! App-local immutable files, shared by native recording and decoding.
//! Saved keys are complete filenames. Descriptive information belongs to rows.

#[path = "flat_blobs.rs"]
mod publication;

use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

use log::warn;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// The application captured before a native writer creates its temporary file.
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

const BLOB_ID_ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
const BLOB_ID_BODY_LEN: usize = 21;

/// Native capture produces WAV, so its saved key can be pinned at admission.
/// Rejection sampling preserves the shared generator's uniform random body.
pub(crate) fn mint_wav_blob_id() -> Result<String, BlobError> {
    const MASK: u8 = 63;
    let mut id = String::with_capacity(30);
    id.push_str("blob_");
    let mut buffer = [0u8; 32];
    while id.len() < "blob_".len() + BLOB_ID_BODY_LEN {
        getrandom::fill(&mut buffer)
            .map_err(|error| BlobError::failed(format!("draw blob id bytes: {error}")))?;
        for byte in buffer {
            let index = (byte & MASK) as usize;
            if index < BLOB_ID_ALPHABET.len() {
                id.push(BLOB_ID_ALPHABET[index] as char);
                if id.len() == "blob_".len() + BLOB_ID_BODY_LEN {
                    break;
                }
            }
        }
    }
    id.push_str(".wav");
    Ok(id)
}

pub(crate) fn validate_blob_id(id: &str) -> Result<(), BlobError> {
    publication::validate_key(id).map_err(Into::into)
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

/// Native composition adds app scoping and typed errors to file publication.
#[derive(Debug)]
pub struct StagedBlob(publication::StagedBlob);

impl StagedBlob {
    pub(crate) fn for_app(
        app: &AppHandle,
        destination: &BlobDestination,
        id: &str,
    ) -> Result<Self, BlobError> {
        Self::stage(
            blobs_directory(
                &app.state::<crate::app_data::DesktopPaths>().data_dir,
                destination,
            )?,
            id,
        )
    }

    pub(crate) fn stage(root: PathBuf, id: &str) -> Result<Self, BlobError> {
        Ok(Self(publication::StagedBlob::stage(&root, id)?))
    }

    /// The encoder owns this handle and must finalize it before publication.
    pub(crate) fn writer(&mut self) -> Result<File, BlobError> {
        Ok(self.0.writer()?.try_clone()?)
    }

    /// Internal staging location, never returned across IPC.
    pub(crate) fn data_path(&self) -> PathBuf {
        self.0.data_path().to_path_buf()
    }

    pub(crate) fn commit(&mut self) -> Result<u64, BlobError> {
        Ok(self.0.commit()?.size)
    }

    #[cfg(test)]
    pub fn publish(mut self) -> Result<u64, BlobError> {
        self.commit()
    }

    pub fn discard(self) {
        if let Err(error) = self.0.discard() {
            warn!("Failed to discard native blob staging: {error}");
        }
    }
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
    use std::io::Write;

    #[test]
    fn identical_blob_keys_publish_independently_for_each_account() {
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
            let mut staged = StagedBlob::stage(path.clone(), id).unwrap();
            staged
                .writer()
                .unwrap()
                .write_all(person.as_bytes())
                .unwrap();
            staged.commit().unwrap();
            assert_eq!(read_file(&path, id).unwrap(), person.as_bytes());
        }
    }

    #[test]
    fn native_mint_produces_unique_complete_wav_keys() {
        let mut ids = HashSet::new();
        for _ in 0..10000 {
            let id = mint_wav_blob_id().unwrap();
            validate_blob_id(&id).unwrap();
            assert_eq!(id.len(), 30);
            assert!(id.ends_with(".wav"));
            assert!(ids.insert(id));
        }
    }

    #[test]
    fn native_reader_opens_flat_published_bytes_after_teardown() {
        let root = tempfile::tempdir().unwrap();
        let id = mint_wav_blob_id().unwrap();
        let mut staged = StagedBlob::stage(root.path().into(), &id).unwrap();
        staged.writer().unwrap().write_all(b"native bytes").unwrap();
        assert_eq!(staged.commit().unwrap(), 12);
        staged.discard();
        assert_eq!(read_file(root.path(), &id).unwrap(), b"native bytes");
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
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
        let id = mint_wav_blob_id().unwrap();
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
