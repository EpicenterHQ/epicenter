//! Canonical native blob storage, shared by capture and audio readers.
//!
//! A destination captures an application and its local/account dataset. Native
//! writers stage private bytes and atomically publish data and metadata together
//! into the same layout as `packages/blobs`. Unpublished staging is discarded
//! on cancellation or swept at the next host startup.

use std::fs::File;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use log::{info, warn};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const BLOBS_DIRECTORY: &str = "blobs";
const STAGING_DIRECTORY: &str = ".staging";
const RUST_STAGING_DIRECTORY: &str = "rust";
const DATA_FILE: &str = "data";
const METADATA_FILE: &str = "metadata.json";

/// Match the Bun store's metadata codec, including JavaScript's trim set and
/// UTF-16 length bound. A native publication must be readable by that store.
fn normalize_content_type(value: &str) -> &str {
    let value = value.trim_matches(|ch| {
        matches!(ch,
            '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' |
            '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
            '\u{205f}' | '\u{3000}' | '\u{feff}'
        )
    });
    if value.is_empty()
        || value.encode_utf16().count() > 255
        || value.chars().any(|ch| ch <= '\u{001f}' || ch == '\u{007f}')
    {
        "application/octet-stream"
    } else {
        value
    }
}

/// Credential-free actor identity captured with a library replica.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplicaAccount {
    pub authority_id: String,
    pub principal_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "library", rename_all = "camelCase", deny_unknown_fields)]
pub enum LibraryReplica {
    Local {},
    Personal { account: ReplicaAccount },
    Shared { account: ReplicaAccount },
}

/// The app and dataset captured before a native writer opens its staging file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BlobDestination {
    pub app_id: String,
    pub replica: LibraryReplica,
}

/// Storage failures stay independent of the operation using the bytes.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct BlobError(String);

impl BlobError {
    fn failed(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BlobMetadata<'a> {
    content_type: &'a str,
    size: u64,
}

/// `blob_` plus 21 characters of this alphabet, matching `generateBlobId` in
/// `packages/blobs/src/blob-id.ts`. Every character is safe as a filesystem
/// name, an S3 key segment, and a URL path segment, so the id is used verbatim
/// as a storage key.
const BLOB_ID_ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
const BLOB_ID_BODY_LEN: usize = 21;

/// Mint an opaque id before a writer stages its bytes.
///
/// This is the second mint of the one BlobId shape; `generateBlobId` in
/// `packages/blobs` is the other. They must produce the same shape, which
/// `validate_blob_id` and the round-trip test below pin from this side.
///
/// Rejection sampling against a power-of-two mask rather than `byte % 36`,
/// which would bias the first four letters. `getrandom` is the OS CSPRNG, the
/// same source nanoid uses.
pub(crate) fn mint_blob_id() -> Result<String, BlobError> {
    // 36 values need 6 bits; a 63 mask keeps the draw uniform and rejects the
    // 28 of 64 patterns that fall outside the alphabet.
    const MASK: u8 = 63;
    let mut id = String::with_capacity("blob_".len() + BLOB_ID_BODY_LEN);
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
    Ok(id)
}

fn validate_blob_id(id: &str) -> Result<(), BlobError> {
    let body = id
        .strip_prefix("blob_")
        .ok_or_else(|| BlobError::failed("blob id must start with 'blob_'"))?;
    if body.len() != BLOB_ID_BODY_LEN
        || !body
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
    {
        return Err(BlobError::failed("blob id has an invalid shape"));
    }
    Ok(())
}

/// Resolve only validated identifiers beneath the shared startup-selected root.
fn blobs_directory(data_dir: &Path, destination: &BlobDestination) -> Result<PathBuf, BlobError> {
    if !is_app_id(&destination.app_id) {
        return Err(BlobError::failed(
            "blob destination contains an invalid app id",
        ));
    }
    let mut root = data_dir.join("apps").join(&destination.app_id);
    match &destination.replica {
        LibraryReplica::Local {} => root.push("local"),
        LibraryReplica::Personal { account } | LibraryReplica::Shared { account } => {
            if !is_path_segment(&account.authority_id) || !is_path_segment(&account.principal_id) {
                return Err(BlobError::failed(
                    "blob replica contains an invalid account",
                ));
            }
            root.push("accounts");
            root.push(&account.authority_id);
            root.push(&account.principal_id);
            if matches!(destination.replica, LibraryReplica::Shared { .. }) {
                root.push("shared");
            }
        }
    }
    Ok(root.join(BLOBS_DIRECTORY))
}

/// Matches `packages/constants/src/app-id.ts` without a second regex dependency.
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

fn is_path_segment(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && !value.contains('/')
        && !value.contains('\\')
}

fn blob_data_path(
    app: &AppHandle,
    id: &str,
    destination: &BlobDestination,
) -> Result<PathBuf, BlobError> {
    validate_blob_id(id)?;
    Ok(blobs_directory(
        &app.state::<crate::app_data::DesktopPaths>().data_dir,
        destination,
    )?
    .join(id)
    .join(DATA_FILE))
}

/// One blob's bytes, being written, before the blob exists.
///
/// Created when a recording starts and resolved exactly once: [`Self::publish`]
/// makes it the blob at its id, [`Self::discard`] deletes it and the id is never
/// used again. Nothing else can name the directory in between.
#[derive(Debug)]
pub struct StagedBlob {
    id: String,
    /// The captured dataset blobs directory, synced after publication.
    root: PathBuf,
    staged_directory: PathBuf,
    final_directory: PathBuf,
}

impl StagedBlob {
    /// Open a staging directory for a recording that is about to start.
    ///
    /// The id is validated and the destination checked here, at the start of the
    /// recording, so a caller learns its blob cannot be written before it spends
    /// an hour capturing audio for it.
    pub fn create(
        app: &AppHandle,
        id: &str,
        destination: &BlobDestination,
    ) -> Result<Self, BlobError> {
        Self::stage(
            blobs_directory(
                &app.state::<crate::app_data::DesktopPaths>().data_dir,
                destination,
            )?,
            id,
        )
    }

    /// Open a staging directory under a given blobs root.
    ///
    /// The root is a parameter rather than resolved here because "where the
    /// store lives" is the app's fact while "how a blob is staged and published"
    /// is this module's. [`Self::create`] is the one production caller and
    /// supplies the app's own root.
    pub(crate) fn stage(root: PathBuf, id: &str) -> Result<Self, BlobError> {
        validate_blob_id(id)?;
        // Each writer owns a distinct staging subtree. Bun writes under
        // `.staging/bun`; native capture writes here, which is what lets the
        // startup sweep delete this one wholesale without ever mistaking another
        // runtime's active publication for its own debris.
        let staging_root = root.join(STAGING_DIRECTORY).join(RUST_STAGING_DIRECTORY);
        std::fs::create_dir_all(&staging_root).map_err(|error| {
            BlobError::failed(format!(
                "create blob staging directory {}: {error}",
                staging_root.display()
            ))
        })?;

        let final_directory = root.join(id);
        if final_directory.exists() {
            return Err(BlobError::failed(format!("blob '{id}' already exists")));
        }

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| BlobError::failed(format!("read system clock: {error}")))?
            .as_nanos();
        let staged_directory = staging_root.join(format!("{id}-{}-{nonce}", std::process::id()));
        std::fs::create_dir(&staged_directory).map_err(|error| {
            BlobError::failed(format!(
                "create staged blob directory {}: {error}",
                staged_directory.display()
            ))
        })?;

        Ok(Self {
            id: id.to_string(),
            root,
            staged_directory,
            final_directory,
        })
    }

    /// Where the bytes go. The caller owns this file for the recording's whole
    /// life and must have flushed everything it intends to keep before
    /// publishing; `publish` syncs it but cannot invent what was never written.
    pub fn data_path(&self) -> PathBuf {
        self.staged_directory.join(DATA_FILE)
    }

    /// Make these bytes the blob at this id, returning the published file's
    /// exact length.
    ///
    /// The durability ladder, in order, because each rung depends on the one
    /// below it: sync the data, write and sync the metadata, sync the staging
    /// directory so both files' names are durable, rename (the atomic step that
    /// makes the blob exist), then sync the blobs root so the new name is
    /// durable too. Nothing here relies on `Drop`, which cannot report a
    /// failure.
    ///
    pub fn publish(self, content_type: &str) -> Result<u64, BlobError> {
        let mut published = false;
        let result = (|| {
            let data_path = self.data_path();
            sync_file(&data_path)?;
            let size = std::fs::metadata(&data_path)
                .map_err(|error| {
                    BlobError::failed(format!("stat staged blob {}: {error}", data_path.display()))
                })?
                .len();
            if size > 9_007_199_254_740_991 {
                return Err(BlobError::failed(
                    "blob size exceeds the shared metadata integer limit",
                ));
            }
            let metadata_path = self.staged_directory.join(METADATA_FILE);
            let content_type = normalize_content_type(content_type);
            let metadata = serde_json::to_vec(&BlobMetadata { content_type, size })
                .map_err(|error| BlobError::failed(format!("serialize blob metadata: {error}")))?;
            std::fs::write(&metadata_path, metadata).map_err(|error| {
                BlobError::failed(format!(
                    "write blob metadata {}: {error}",
                    metadata_path.display()
                ))
            })?;
            sync_file(&metadata_path)?;
            sync_directory(&self.staged_directory)?;
            std::fs::rename(&self.staged_directory, &self.final_directory).map_err(|error| {
                BlobError::failed(format!(
                    "publish blob {}: {error}",
                    self.final_directory.display()
                ))
            })?;
            published = true;
            sync_directory(&self.root)?;
            Ok(size)
        })();

        match result {
            Ok(size) => Ok(size),
            Err(error) => {
                let cleanup_target = if published {
                    &self.final_directory
                } else {
                    &self.staged_directory
                };
                if let Err(cleanup_error) = std::fs::remove_dir_all(cleanup_target) {
                    return Err(BlobError::failed(format!(
                        "{error}; cleanup blob {}: {cleanup_error}",
                        cleanup_target.display()
                    )));
                }
                if published {
                    let _ = sync_directory(&self.root);
                }
                Err(error)
            }
        }
    }

    /// Delete these bytes. The id is burnt: no blob will ever exist under it.
    ///
    /// Failure is logged rather than returned, because there is nothing a caller
    /// could do with it that the startup sweep does not already do.
    pub fn discard(self) {
        if let Err(error) = std::fs::remove_dir_all(&self.staged_directory) {
            warn!(
                "Failed to discard staged blob {} at {}: {error}",
                self.id,
                self.staged_directory.display()
            );
        }
    }
}

/// Delete abandoned native staging across every application dataset at startup.
///
/// The single-instance host calls this before admitting any native writers.
/// Staging is incomplete data; it is deleted, never promoted into a blob.
/// Bun owns a separate staging subtree, which this sweep leaves untouched.
pub fn delete_stale_staging(app: &AppHandle) {
    delete_apps_staging(&app.state::<crate::app_data::DesktopPaths>().data_dir);
}

fn delete_apps_staging(data_dir: &Path) {
    if let Ok(apps) = std::fs::read_dir(data_dir.join("apps")) {
        for app in apps.flatten() {
            if app.file_type().is_ok_and(|kind| kind.is_dir())
                && app.file_name().to_str().is_some_and(is_app_id)
            {
                delete_partition_staging(&app.path());
            }
        }
    }
}

fn delete_partition_staging(root: &Path) {
    delete_staging_root(&root.join("local").join(BLOBS_DIRECTORY));
    if let Ok(partitions) = std::fs::read_dir(&root) {
        for partition in partitions.flatten() {
            if partition.file_name() == "accounts" {
                if let Ok(authorities) = std::fs::read_dir(partition.path()) {
                    for authority in authorities.flatten() {
                        if let Ok(principals) = std::fs::read_dir(authority.path()) {
                            for principal in principals.flatten() {
                                delete_staging_root(&principal.path().join(BLOBS_DIRECTORY));
                                delete_staging_root(
                                    &principal.path().join("shared").join(BLOBS_DIRECTORY),
                                );
                            }
                        }
                    }
                }
            }
        }
    }
}

/// Delete a blobs root's native staging subtree, whatever it holds.
pub(crate) fn delete_staging_root(root: &Path) {
    let staging_root = root.join(STAGING_DIRECTORY).join(RUST_STAGING_DIRECTORY);
    match std::fs::remove_dir_all(&staging_root) {
        Ok(()) => info!(
            "Deleted stale native blob staging at {}",
            staging_root.display()
        ),
        // Nothing to sweep is the ordinary case: a clean exit leaves none.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => warn!(
            "Failed to delete stale native blob staging at {}: {error}",
            staging_root.display()
        ),
    }
}

/// Read a published blob in the captured app dataset.
pub fn read_blob_bytes(
    app: &AppHandle,
    id: &str,
    destination: &BlobDestination,
) -> Result<Vec<u8>, BlobError> {
    let path = blob_data_path(app, id, destination)?;
    std::fs::read(&path)
        .map_err(|error| BlobError::failed(format!("read blob {}: {error}", path.display())))
}

/// Sync the completed data or metadata after its writer has closed it.
fn sync_file(path: &Path) -> Result<(), BlobError> {
    File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(|error| BlobError::failed(format!("sync {}: {error}", path.display())))
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), BlobError> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| {
            BlobError::failed(format!("sync blob directory {}: {error}", path.display()))
        })
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<(), BlobError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    const ID: &str = "blob_aaaaaaaaaaaaaaaaaaaaa";

    /// The smoke runner consumes these actual native-produced metadata/body
    /// fixtures through createBunBlobStore, rather than recreating the codec.
    #[test]
    fn native_publication_metadata_contract() {
        let long = "x".repeat(256);
        let unicode = "😀".repeat(128);
        for (input, expected) in [
            ("audio/wav", "audio/wav"),
            ("  Text/Plain  ", "Text/Plain"),
            ("\u{feff}audio/wav\u{feff}", "audio/wav"),
            ("", "application/octet-stream"),
            ("audio/\nwave", "application/octet-stream"),
            (long.as_str(), "application/octet-stream"),
            (unicode.as_str(), "application/octet-stream"),
        ] {
            let root = tempfile::tempdir().expect("blob root");
            let staged = StagedBlob::stage(root.path().to_path_buf(), ID).expect("stage");
            std::fs::write(staged.data_path(), b"native bytes").expect("write");
            assert_eq!(staged.publish(input).expect("publish"), 12);
            let metadata = std::fs::read_to_string(root.path().join(ID).join(METADATA_FILE))
                .expect("metadata");
            let parsed: serde_json::Value = serde_json::from_str(&metadata).expect("JSON");
            assert_eq!(parsed["contentType"], expected);
            let data = std::fs::read_to_string(root.path().join(ID).join(DATA_FILE)).expect("body");
            println!(
                "BLOB_CONTRACT {}",
                serde_json::json!({ "id": ID, "metadata": metadata, "data": data })
            );
        }
    }

    #[test]
    fn replica_wire_requires_an_explicit_library_and_actor() {
        for invalid in [
            serde_json::json!(null),
            serde_json::json!({"library": null}),
            serde_json::json!({"library": "personal"}),
            serde_json::json!({"library": "shared", "account": null}),
            serde_json::json!({"library": "local", "account": {"authorityId": "server", "principalId": "alice"}}),
            serde_json::json!({"authorityId": "server", "principalId": "alice"}),
        ] {
            assert!(serde_json::from_value::<LibraryReplica>(invalid).is_err());
        }
    }

    #[test]
    fn destinations_keep_applications_and_account_partitions_separate() {
        let data = tempfile::tempdir().unwrap();
        let mut roots = std::collections::HashSet::new();
        for app_id in ["so.epicenter.whispering", "so.epicenter.notes"] {
            for replica in [
                LibraryReplica::Local {},
                LibraryReplica::Shared {
                    account: ReplicaAccount {
                        authority_id: "authority-a".into(),
                        principal_id: "alice".into(),
                    },
                },
                LibraryReplica::Shared {
                    account: ReplicaAccount {
                        authority_id: "authority-a".into(),
                        principal_id: "bob".into(),
                    },
                },
                LibraryReplica::Personal {
                    account: ReplicaAccount {
                        authority_id: "authority-a".into(),
                        principal_id: "alice".into(),
                    },
                },
                LibraryReplica::Personal {
                    account: ReplicaAccount {
                        authority_id: "authority-b".into(),
                        principal_id: "alice".into(),
                    },
                },
                LibraryReplica::Personal {
                    account: ReplicaAccount {
                        authority_id: "authority-a".into(),
                        principal_id: "bob".into(),
                    },
                },
            ] {
                let destination = BlobDestination {
                    app_id: app_id.into(),
                    replica,
                };
                let root = blobs_directory(data.path(), &destination).unwrap();
                assert!(roots.insert(root.clone()));
                let bytes = serde_json::to_vec(&destination).unwrap();
                publish_bytes(&root, ID, &bytes).unwrap();
                assert_eq!(std::fs::read(root.join(ID).join(DATA_FILE)).unwrap(), bytes);
                let staged = StagedBlob::stage(root.clone(), "blob_bbbbbbbbbbbbbbbbbbbbb").unwrap();
                std::fs::write(staged.data_path(), b"partial").unwrap();
                let bun = root.join(".staging/bun");
                std::fs::create_dir_all(&bun).unwrap();
                std::fs::write(bun.join("retained"), b"bun-owned").unwrap();
            }
        }
        delete_apps_staging(data.path());
        for root in roots {
            assert!(!root.join(".staging/rust").exists());
            assert!(root.join(ID).join(DATA_FILE).exists());
            assert!(root.join(".staging/bun/retained").exists());
        }
    }

    #[test]
    fn destination_rejects_invalid_app_ids_and_partition_traversal() {
        let data = tempfile::tempdir().unwrap();
        for app_id in [
            "",
            "app",
            "../so.app",
            "so/app",
            "so.App",
            ".so.app",
            "so.app.",
            "so..app",
            "so.-app",
            "so.app-",
            "so.app_",
            "so.é",
        ] {
            assert!(
                blobs_directory(
                    data.path(),
                    &BlobDestination {
                        app_id: app_id.into(),
                        replica: LibraryReplica::Local {}
                    }
                )
                .is_err(),
                "accepted {app_id}"
            );
        }
        for app_id in ["so.epicenter.whispering", "a.b", "a-1.b2", "1.2"] {
            assert!(is_app_id(app_id), "rejected {app_id}");
        }
        for segment in ["", ".", "..", "a/b", "a\\b"] {
            for replica in [
                LibraryReplica::Personal {
                    account: ReplicaAccount {
                        authority_id: segment.into(),
                        principal_id: "valid".into(),
                    },
                },
                LibraryReplica::Personal {
                    account: ReplicaAccount {
                        authority_id: "valid".into(),
                        principal_id: segment.into(),
                    },
                },
            ] {
                assert!(blobs_directory(
                    data.path(),
                    &BlobDestination {
                        app_id: "so.app".into(),
                        replica
                    }
                )
                .is_err());
            }
        }
        assert!(!data.path().join("apps").exists());
    }

    #[test]
    fn publication_uses_the_content_type_and_supports_sizes_beyond_riff() {
        let root = tempfile::tempdir().unwrap();
        let staged = StagedBlob::stage(root.path().into(), ID).unwrap();
        let size = u64::from(u32::MAX) + 1;
        // A sparse file exercises the storage size contract without writing 4 GiB.
        File::create(staged.data_path())
            .unwrap()
            .set_len(size)
            .unwrap();
        assert_eq!(staged.publish("application/octet-stream").unwrap(), size);
        let metadata: serde_json::Value = serde_json::from_slice(
            &std::fs::read(root.path().join(ID).join(METADATA_FILE)).unwrap(),
        )
        .unwrap();
        assert_eq!(metadata["contentType"], "application/octet-stream");
        assert_eq!(metadata["size"], size);
    }

    #[test]
    fn a_writer_staged_before_another_publication_cannot_replace_it() {
        let root = tempfile::tempdir().unwrap();
        let first = StagedBlob::stage(root.path().into(), ID).unwrap();
        let second = StagedBlob::stage(root.path().into(), ID).unwrap();
        std::fs::write(first.data_path(), b"first").unwrap();
        std::fs::write(second.data_path(), b"second").unwrap();
        let second_staging = second.staged_directory.clone();
        first.publish("text/plain").unwrap();
        assert!(second.publish("text/plain").is_err());
        assert_eq!(
            std::fs::read(root.path().join(ID).join(DATA_FILE)).unwrap(),
            b"first"
        );
        assert!(!second_staging.exists());
    }

    #[test]
    fn startup_sweeps_local_and_account_staging_without_deleting_published_blobs() {
        let root = tempfile::tempdir().expect("app root");
        for partition in [
            "local",
            "accounts/authority-a/principal",
            "accounts/authority-b/principal",
        ] {
            let blobs = root.path().join(partition).join(BLOBS_DIRECTORY);
            let staging = blobs.join(STAGING_DIRECTORY).join(RUST_STAGING_DIRECTORY);
            std::fs::create_dir_all(&staging).unwrap();
            std::fs::write(staging.join("abandoned"), b"partial").unwrap();
            publish_bytes(&blobs, ID, b"published").unwrap();
        }

        delete_partition_staging(root.path());

        for partition in [
            "local",
            "accounts/authority-a/principal",
            "accounts/authority-b/principal",
        ] {
            let blobs = root.path().join(partition).join(BLOBS_DIRECTORY);
            assert!(!blobs
                .join(STAGING_DIRECTORY)
                .join(RUST_STAGING_DIRECTORY)
                .exists());
            assert_eq!(
                std::fs::read(blobs.join(ID).join(DATA_FILE)).unwrap(),
                b"published"
            );
        }
    }

    /// Stage `bytes` under `id` and publish them, returning the published size.
    fn publish_bytes(root: &Path, id: &str, bytes: &[u8]) -> Result<u64, BlobError> {
        let staged = StagedBlob::stage(root.to_path_buf(), id)?;
        let mut file = File::create(staged.data_path()).expect("create the staged data file");
        file.write_all(bytes).expect("write the staged data file");
        drop(file);
        staged.publish("audio/wav")
    }

    /// A blob's metadata must describe the bytes actually published, because it
    /// is what every reader trusts instead of stat-ing the file.
    #[test]
    fn publishing_writes_the_bytes_and_metadata_that_describe_them() {
        let root = tempfile::tempdir().expect("a blobs root");
        let bytes = b"not really a wav, but exactly this many bytes";

        let size = publish_bytes(root.path(), ID, bytes).expect("publish");
        assert_eq!(size as usize, bytes.len());

        assert_eq!(
            std::fs::read(root.path().join(ID).join(DATA_FILE)).expect("read data"),
            bytes
        );
        let metadata =
            std::fs::read_to_string(root.path().join(ID).join(METADATA_FILE)).expect("read meta");
        assert_eq!(
            metadata,
            format!(r#"{{"contentType":"audio/wav","size":{}}}"#, bytes.len())
        );
    }

    /// ADR-0173's write-once slot, enforced at the one place that could break
    /// it: a second recording can never overwrite a published blob's bytes, and
    /// the refusal comes at `start` rather than after an hour of capture.
    #[test]
    fn a_published_blob_is_never_restaged_over() {
        let root = tempfile::tempdir().expect("a blobs root");
        publish_bytes(root.path(), ID, b"the first bytes").expect("publish");

        let error = StagedBlob::stage(root.path().to_path_buf(), ID)
            .expect_err("staging over a published blob must be refused");
        assert!(
            error.to_string().contains("already exists"),
            "unexpected refusal: {error}"
        );
        assert_eq!(
            std::fs::read(root.path().join(ID).join(DATA_FILE)).expect("read data"),
            b"the first bytes"
        );
    }

    /// A discarded recording leaves nothing: no blob, and no staging for the
    /// next launch's sweep to find.
    #[test]
    fn discarding_leaves_neither_a_blob_nor_staging() {
        let root = tempfile::tempdir().expect("a blobs root");
        let staged = StagedBlob::stage(root.path().to_path_buf(), ID).expect("stage");
        File::create(staged.data_path()).expect("create the staged data file");
        let staged_directory = staged.staged_directory.clone();

        staged.discard();

        assert!(!staged_directory.exists());
        assert!(!root.path().join(ID).exists());
    }

    #[test]
    fn blob_id_validation_accepts_only_the_public_shape() {
        assert!(validate_blob_id("blob_abcdefghijklmnopqrstu").is_ok());
        assert!(validate_blob_id("abcdefghijklmnopqrstu").is_err());
        assert!(validate_blob_id("blob_ABCDEFGHIJKLMNOPQRSTU").is_err());
        assert!(validate_blob_id("blob_abcdefghijklmnopqrs/u").is_err());
    }

    /// The mint/parse round trip, matching `blob-id.test.ts` on the other side
    /// of the same contract. If either mint drifts from the shared shape, one
    /// of the two round-trip tests fails rather than a blob path failing in
    /// production.
    #[test]
    fn minted_ids_round_trip_through_validation() {
        for _ in 0..1_000 {
            let id = mint_blob_id().expect("mint a blob id");
            assert_eq!(id.len(), "blob_".len() + BLOB_ID_BODY_LEN);
            validate_blob_id(&id).expect("a minted id must parse");
        }
    }

    /// Distinctness, and coverage of the whole alphabet. Rejection sampling is
    /// easy to get subtly wrong in a way that silently narrows the alphabet, so
    /// this asserts every character is reachable rather than only that ids
    /// differ.
    #[test]
    fn minted_ids_are_distinct_and_span_the_alphabet() {
        let mut seen_ids = std::collections::HashSet::new();
        let mut seen_chars = std::collections::HashSet::new();
        for _ in 0..2_000 {
            let id = mint_blob_id().expect("mint a blob id");
            seen_chars.extend(id["blob_".len()..].bytes());
            assert!(seen_ids.insert(id), "minted a duplicate blob id");
        }
        assert_eq!(
            seen_chars.len(),
            BLOB_ID_ALPHABET.len(),
            "some alphabet characters are unreachable"
        );
    }
}
