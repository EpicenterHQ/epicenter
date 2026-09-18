//! Flat-file publication shared by native capture and standalone fixtures.
//!
//! A caller supplies the complete saved key independently of its capture ID.
//! Publication creates a hard link without replacing an occupied destination.
//! The caller owns the directory and its ancestors; path-based stdlib operations
//! do not defend against an adversary concurrently replacing those directories.
//! No startup sweep or historical-data conversion is performed here.
//!
//! Windows uses a write-through writable file handle and FlushFileBuffers via
//! File::sync_all before and after CreateHardLink. Microsoft documents the
//! GENERIC_WRITE requirement and write-through metadata behavior:
//! https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers
//! https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew
//! This does not establish a Windows equivalent of the Unix directory barriers;
//! abrupt-power-loss namespace durability needs execution evidence on Windows.

use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);
const MAX_SIZE: u64 = 9_007_199_254_740_991;

/// Match the isolated TypeScript parser: one dot and a bounded ASCII suffix.
pub fn validate_key(key: &str) -> io::Result<()> {
    let Some((body, extension)) = key.strip_prefix("blob_").and_then(|s| s.split_once('.')) else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Invalid complete blob key",
        ));
    };
    let alphanumeric = |byte: u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
    if body.len() != 21
        || !body.bytes().all(alphanumeric)
        || !(1..=10).contains(&extension.len())
        || !extension.bytes().all(alphanumeric)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Invalid complete blob key",
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublishedBlob {
    pub key: String,
    pub size: u64,
}

/// One native producer's pending bytes and retained publication receipt.
/// Keep this value after a failed commit so the exact outcome can be retried.
#[derive(Debug)]
pub struct StagedBlob {
    key: String,
    root: PathBuf,
    staging: PathBuf,
    file: File,
    sealed: bool,
    published: Option<PublishedBlob>,
    #[cfg(test)]
    fail_file_sync_once: bool,
    #[cfg(test)]
    fail_directory_sync_once: bool,
}

impl StagedBlob {
    pub(crate) fn data_path(&self) -> &Path {
        &self.staging
    }

    pub fn stage(root: &Path, key: &str) -> io::Result<Self> {
        validate_key(key)?;
        if !cfg!(any(unix, windows)) {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "Flat native publication is not verified on this platform",
            ));
        }
        // The configured root is trusted and may use a platform alias such as
        // /tmp. Pin its physical destination once before creating staging.
        fs::create_dir_all(root)?;
        let root = fs::canonicalize(root)?;
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(io::Error::other)?
            .as_nanos();
        let staging = root.join(format!(
            ".rust-{}-{nonce}-{}.tmp",
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        ));
        let mut options = OpenOptions::new();
        options.read(true).write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            // FILE_FLAG_WRITE_THROUGH requests data and metadata write-through.
            options.custom_flags(0x80000000);
        }
        let file = options.open(&staging)?;
        Ok(Self {
            key: key.into(),
            root,
            staging,
            file,
            sealed: false,
            published: None,
            #[cfg(test)]
            fail_file_sync_once: false,
            #[cfg(test)]
            fail_directory_sync_once: false,
        })
    }

    /// The producer must flush its encoder before the first commit.
    /// A commit attempt seals the writer even if durability must be retried.
    pub fn writer(&mut self) -> io::Result<&mut File> {
        if self.sealed {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Blob publication has sealed its writer",
            ));
        }
        Ok(&mut self.file)
    }

    /// Make the completed bytes visible and establish their durability.
    /// After linking, retain the receipt before any fallible directory sync.
    pub fn commit(&mut self) -> io::Result<PublishedBlob> {
        self.sealed = true;
        let final_path = self.root.join(&self.key);
        let owned = self.file.metadata()?;
        if self.published.is_none() {
            if !owns_path(&self.file, &self.staging)? {
                return Err(io::Error::other(
                    "Staging entry no longer belongs to this publisher",
                ));
            }
            if owned.len() > MAX_SIZE {
                return Err(io::Error::other(
                    "Blob exceeds the shared integer size limit",
                ));
            }
            #[cfg(test)]
            if std::mem::take(&mut self.fail_file_sync_once) {
                return Err(io::Error::other(
                    "Injected pre-publication file sync failure",
                ));
            }
            self.file.sync_all()?;
            // hard_link fails for every occupied name, including dangling links
            // and directories. An existence check followed by rename would race.
            fs::hard_link(&self.staging, &final_path)?;
            self.published = Some(PublishedBlob {
                key: self.key.clone(),
                size: owned.len(),
            });
        }
        let final_metadata = fs::symlink_metadata(&final_path)?;
        if !owns_path(&self.file, &final_path)?
            || final_metadata.len() != self.published.as_ref().unwrap().size
        {
            return Err(io::Error::other(
                "Saved blob no longer matches its publication receipt",
            ));
        }
        #[cfg(test)]
        if std::mem::take(&mut self.fail_directory_sync_once) {
            return Err(io::Error::other(
                "Injected post-publication directory sync failure",
            ));
        }
        // Sync every ancestor, including any newly created app/blob directories.
        // Keep the staging name until the final name has passed these barriers.
        #[cfg(unix)]
        for directory in self.root.ancestors() {
            let metadata = fs::symlink_metadata(directory)?;
            if !metadata.is_dir() {
                return Err(io::Error::other("Blob ancestor is not a directory"));
            }
            File::open(directory)?.sync_all()?;
        }
        // Windows has no documented equivalent of fsync(directory) available
        // through stdlib. Flush the write-through file again after CreateHardLink;
        // namespace survival under abrupt power loss still needs Windows evidence.
        #[cfg(windows)]
        self.file.sync_all()?;
        self.remove_staging()?;
        Ok(self.published.as_ref().unwrap().clone())
    }

    /// Cancel removes only this producer's temporary name, even after commit.
    pub fn discard(self) -> io::Result<()> {
        self.remove_staging()
    }

    fn remove_staging(&self) -> io::Result<()> {
        match fs::symlink_metadata(&self.staging) {
            Ok(_) => (),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        }
        if !owns_path(&self.file, &self.staging)? {
            return Err(io::Error::other(
                "Refusing to remove another publisher's staging entry",
            ));
        }
        fs::remove_file(&self.staging)
    }
}

impl Drop for StagedBlob {
    fn drop(&mut self) {
        // Best effort only; callers use discard when they need cleanup errors.
        // A committed final path is never a cleanup target.
        let _ = self.remove_staging();
    }
}

#[cfg(unix)]
fn owns_path(file: &File, path: &Path) -> io::Result<bool> {
    use std::os::unix::fs::MetadataExt;
    let left = file.metadata()?;
    let right = fs::symlink_metadata(path)?;
    Ok(left.is_file() && right.is_file() && left.dev() == right.dev() && left.ino() == right.ino())
}

#[cfg(windows)]
fn owns_path(file: &File, path: &Path) -> io::Result<bool> {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    let other = OpenOptions::new()
        .read(true)
        .custom_flags(0x00200000) // FILE_FLAG_OPEN_REPARSE_POINT: never follow a link.
        .open(path)?;
    let metadata = other.metadata()?;
    if !metadata.is_file() || metadata.file_attributes() & 0x400 != 0 {
        return Ok(false);
    }
    Ok(windows_file_identity(file)? == windows_file_identity(&other)?)
}

#[cfg(windows)]
fn windows_file_identity(file: &File) -> io::Result<(u64, [u8; 16])> {
    use std::os::windows::io::AsRawHandle;
    #[repr(C)]
    #[derive(Default)]
    struct FileInformation {
        volume: u64,
        id: [u8; 16],
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetFileInformationByHandleEx(
            handle: *mut std::ffi::c_void,
            class: i32,
            information: *mut FileInformation,
            size: u32,
        ) -> i32;
    }
    let mut information = FileInformation::default();
    // The owned File keeps its handle valid, and the repr(C) output matches
    // FILE_ID_INFO in the documented Win32 API. FileIdInfo (18) retains the
    // complete 128-bit identity on ReFS as well as on NTFS.
    if unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            18,
            &mut information,
            std::mem::size_of::<FileInformation>() as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok((information.volume, information.id))
}

#[cfg(not(any(unix, windows)))]
fn owns_path(_: &File, _: &Path) -> io::Result<bool> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Blob file identity is unavailable",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    #[cfg(unix)]
    use std::os::unix::fs::symlink;
    use std::sync::{Arc, Barrier};

    const KEY: &str = "blob_aaaaaaaaaaaaaaaaaaaaa.wav";

    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let root = fs::canonicalize(std::env::temp_dir())
                .unwrap()
                .join(format!(
                    "epicenter-flat-rust-{}-{}",
                    std::process::id(),
                    NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
                ));
            fs::create_dir(&root).unwrap();
            Self(root)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn staged(root: &Path, bytes: &[u8]) -> StagedBlob {
        let mut blob = StagedBlob::stage(root, KEY).unwrap();
        blob.writer().unwrap().write_all(bytes).unwrap();
        blob
    }

    #[test]
    fn complete_key_grammar_rejects_paths_and_extensionless_ids() {
        for extension in ["wav", "bin", "mp4", "a123456789"] {
            validate_key(&format!("blob_aaaaaaaaaaaaaaaaaaaaa.{extension}")).unwrap();
        }
        for key in [
            "blob_aaaaaaaaaaaaaaaaaaaaa",
            "blob_aaaaaaaaaaaaaaaaaaaaa.",
            "blob_aaaaaaaaaaaaaaaaaaaaa.WAV",
            "blob_aaaaaaaaaaaaaaaaaaaaa.a1234567890",
            "blob_aaaaaaaaaaaaaaaaaaaaa.wav.more",
            "blob_aaaaaaaaaaaaaaaaaaaaa.wav/../x",
            "blob_aaaaaaaaaaaaaaaaaaaaa.wav?x",
            "blob_aaaaaaaaaaaaaaaaaaaaa.wav#x",
            "blob_aaaaaaaaaaaaaaaaaaaaa.%2e",
            "blob_aaaaaaaaaaaaaaaaaaaaa.é",
            "blob_aaaaaaaaaaaaaaaaaaaaa.wav\n",
            "blob_aaaaaaaaaaaaaaaaaaaa.wav",
        ] {
            assert!(validate_key(key).is_err(), "{key:?}");
        }
    }

    #[test]
    fn commit_returns_saved_key_and_leaves_one_ordinary_file_after_teardown() {
        let temp = Temp::new();
        let root = temp.0.join("app/blobs");
        let mut blob = staged(&root, b"completed bytes");
        assert!(!root.join(KEY).exists());
        let receipt = blob.commit().unwrap();
        assert_eq!(
            receipt,
            PublishedBlob {
                key: KEY.into(),
                size: 15
            }
        );
        assert!(blob.writer().is_err());
        assert_eq!(blob.commit().unwrap(), receipt);
        drop(blob);
        assert_eq!(fs::read(root.join(KEY)).unwrap(), b"completed bytes");
        assert_eq!(fs::read_dir(root).unwrap().count(), 1);
    }

    #[test]
    fn zero_byte_publication_is_a_complete_object() {
        let temp = Temp::new();
        let mut blob = staged(&temp.0, b"");
        assert_eq!(blob.commit().unwrap().size, 0);
        drop(blob);
        assert_eq!(fs::metadata(temp.0.join(KEY)).unwrap().len(), 0);
        assert_eq!(fs::read_dir(&temp.0).unwrap().count(), 1);
    }

    #[test]
    fn publishers_racing_the_same_key_cannot_replace_each_other() {
        let temp = Temp::new();
        let barrier = Arc::new(Barrier::new(2));
        let threads: Vec<_> = [b"first".as_slice(), b"second".as_slice()]
            .into_iter()
            .map(|bytes| {
                let root = temp.0.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    let mut blob = staged(&root, bytes);
                    barrier.wait();
                    (bytes.to_vec(), blob.commit())
                })
            })
            .collect();
        let outcomes: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
        assert_eq!(
            outcomes.iter().filter(|(_, result)| result.is_ok()).count(),
            1
        );
        let winner = outcomes.iter().find(|(_, result)| result.is_ok()).unwrap();
        let loser = outcomes.iter().find(|(_, result)| result.is_err()).unwrap();
        assert_eq!(
            loser.1.as_ref().unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
        assert_eq!(fs::read(temp.0.join(KEY)).unwrap(), winner.0);
        assert_eq!(fs::read_dir(&temp.0).unwrap().count(), 1);
    }

    #[test]
    #[cfg(unix)]
    fn directory_symlink_and_dangling_symlink_are_collisions() {
        for kind in ["directory", "symlink", "dangling"] {
            let temp = Temp::new();
            let target = temp.0.join(KEY);
            let external = temp.0.join("untouched");
            fs::write(&external, b"original").unwrap();
            match kind {
                "directory" => fs::create_dir(&target).unwrap(),
                "symlink" => symlink(&external, &target).unwrap(),
                _ => symlink(temp.0.join("absent"), &target).unwrap(),
            }
            let mut blob = staged(&temp.0, b"new");
            assert!(blob.commit().is_err());
            drop(blob);
            assert!(fs::symlink_metadata(target).is_ok());
            assert_eq!(fs::read(external).unwrap(), b"original");
        }
    }

    #[test]
    fn retry_after_directory_sync_failure_retains_the_same_published_object() {
        let temp = Temp::new();
        let mut blob = staged(&temp.0, b"finalized");
        blob.fail_directory_sync_once = true;
        assert!(blob.commit().is_err());
        assert_eq!(fs::read(temp.0.join(KEY)).unwrap(), b"finalized");
        assert!(blob.staging.exists());
        assert!(blob.writer().is_err());
        assert_eq!(blob.commit().unwrap().size, 9);
        assert!(!blob.staging.exists());
        blob.discard().unwrap();
        assert_eq!(fs::read(temp.0.join(KEY)).unwrap(), b"finalized");
    }

    #[test]
    fn cancel_after_post_publication_failure_never_deletes_saved_bytes() {
        let temp = Temp::new();
        let mut blob = staged(&temp.0, b"saved");
        blob.fail_directory_sync_once = true;
        assert!(blob.commit().is_err());
        blob.discard().unwrap();
        assert_eq!(fs::read(temp.0.join(KEY)).unwrap(), b"saved");
        assert_eq!(fs::read_dir(&temp.0).unwrap().count(), 1);
    }

    #[test]
    fn cancellation_removes_only_owned_staging_and_keeps_historical_files() {
        let temp = Temp::new();
        let historical = temp.0.join("blob_aaaaaaaaaaaaaaaaaaaaa");
        fs::create_dir(&historical).unwrap();
        fs::write(historical.join("data"), b"legacy").unwrap();
        fs::write(temp.0.join(".bun-live.tmp"), b"bun").unwrap();
        fs::write(temp.0.join(".rust-other.tmp"), b"other").unwrap();
        staged(&temp.0, b"unfinished").discard().unwrap();
        assert!(!temp.0.join(KEY).exists());
        assert_eq!(fs::read(historical.join("data")).unwrap(), b"legacy");
        assert_eq!(fs::read(temp.0.join(".bun-live.tmp")).unwrap(), b"bun");
        assert_eq!(fs::read_dir(&temp.0).unwrap().count(), 3);
    }

    #[test]
    #[cfg(unix)]
    fn staged_symlink_replacement_is_neither_published_nor_unlinked() {
        let temp = Temp::new();
        let mut blob = staged(&temp.0, b"own");
        let staging = blob.staging.clone();
        fs::remove_file(&staging).unwrap();
        let foreign = temp.0.join("foreign");
        fs::write(&foreign, b"foreign").unwrap();
        symlink(&foreign, &staging).unwrap();
        assert!(blob.commit().is_err());
        assert!(blob.discard().is_err());
        assert!(fs::symlink_metadata(staging).unwrap().is_symlink());
        assert_eq!(fs::read(foreign).unwrap(), b"foreign");
        assert!(!temp.0.join(KEY).exists());
    }

    #[test]
    #[cfg(unix)]
    fn configured_root_alias_preserves_the_same_physical_destination() {
        let temp = Temp::new();
        let actual = temp.0.join("actual");
        fs::create_dir(&actual).unwrap();
        let alias = temp.0.join("alias");
        symlink(&actual, &alias).unwrap();
        let mut blob = staged(&alias.join("nested"), b"saved through configured alias");
        assert_eq!(blob.root, actual.join("nested"));
        blob.commit().unwrap();
        drop(blob);
        assert_eq!(
            fs::read(actual.join("nested").join(KEY)).unwrap(),
            b"saved through configured alias"
        );
        assert_eq!(fs::read_dir(alias.join("nested")).unwrap().count(), 1);
    }

    #[test]
    fn file_sync_failure_keeps_finalized_bytes_private_until_retry() {
        let temp = Temp::new();
        let mut blob = staged(&temp.0, b"finalized before sync");
        let staging = blob.staging.clone();
        blob.fail_file_sync_once = true;
        assert!(blob.commit().is_err());
        assert!(blob.published.is_none());
        assert!(blob.writer().is_err());
        assert!(!temp.0.join(KEY).exists());
        assert_eq!(fs::read(&staging).unwrap(), b"finalized before sync");
        let receipt = blob.commit().unwrap();
        assert_eq!(receipt.key, KEY);
        assert_eq!(receipt.size, 21);
        assert!(!staging.exists());
        drop(blob);
        assert_eq!(
            fs::read(temp.0.join(KEY)).unwrap(),
            b"finalized before sync"
        );
    }

    #[test]
    fn retry_refuses_a_replaced_final_entry_and_preserves_the_replacement() {
        let temp = Temp::new();
        let mut blob = staged(&temp.0, b"original");
        blob.fail_directory_sync_once = true;
        assert!(blob.commit().is_err());
        fs::remove_file(temp.0.join(KEY)).unwrap();
        fs::write(temp.0.join(KEY), b"external replacement").unwrap();
        assert!(blob.commit().is_err());
        drop(blob);
        assert_eq!(fs::read(temp.0.join(KEY)).unwrap(), b"external replacement");
    }
}
