//! A directory's identity on this computer: its inode and its birth time
//! (ADR-0822). The device number is no part of it: it changes when a drive
//! remounts. A copy gets a new inode and birth time, so it is a new folder;
//! a rename or a move on one disk keeps both, so it is the same one.
//!
//! An inode alone is no proof: a file system without birth times can give a
//! new directory a deleted one's inode. So two identities prove one
//! directory only when their inodes match and both carry the same real birth
//! time (`proves`).

use std::fs::Metadata;
use std::io;
use std::path::Path;
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use specta::Type;

/// A directory's identity: its inode and its birth time, each in decimal, so
/// JSON keeps every digit. `{ inode: string; birthtime: string | null }` to
/// TypeScript.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FolderIdentity {
    /// `st_ino`, in decimal.
    pub inode: String,
    /// Nanoseconds from the Unix epoch to the directory's birth, in decimal,
    /// or `None` where the file system records none.
    pub birthtime: Option<String>,
}

/// The identity of the file or directory `metadata` describes, or `None` on
/// a platform without inodes.
///
/// `birthtime` is `Metadata::created()` in nanoseconds since the Unix epoch:
/// on macOS `st_birthtimespec`, `tv_sec * 1e9 + tv_nsec`. It is `None` when
/// the system reports no birth time (`created()` fails), a birth time of
/// zero, or one before the epoch. It must equal what Node answers for the
/// same directory, `(await fs.promises.stat(path, { bigint: true }))
/// .birthtimeNs.toString()`, read as `null` where that is `0n` or negative
/// (libuv answers zero where Linux's `statx` has no birth time, where Rust
/// answers an error). The TypeScript twin keeps that contract.
pub fn identity_of(metadata: &Metadata) -> Option<FolderIdentity> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Some(FolderIdentity {
            inode: metadata.ino().to_string(),
            birthtime: birthtime_of(metadata),
        })
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        None
    }
}

/// The birth time `identity_of` records, or `None`.
#[cfg_attr(not(unix), allow(dead_code))]
fn birthtime_of(metadata: &Metadata) -> Option<String> {
    let born = metadata.created().ok()?;
    let since = born.duration_since(UNIX_EPOCH).ok()?;
    let nanos = since.as_nanos();
    (nanos > 0).then(|| nanos.to_string())
}

/// The identity of the directory at `path`, a link there followed.
pub fn identity_at(path: &Path) -> io::Result<Option<FolderIdentity>> {
    std::fs::metadata(path).map(|metadata| identity_of(&metadata))
}

/// The name a cache keyed by identity uses: `<inode>-<birthtime>`, or
/// `<inode>` where there is no birth time. The page names its hash caches
/// `hashes/<key>.json` by the same rule.
pub fn identity_key(identity: &FolderIdentity) -> String {
    match &identity.birthtime {
        Some(birthtime) => format!("{}-{birthtime}", identity.inode),
        None => identity.inode.clone(),
    }
}

/// Whether `a` and `b` are one directory: the same inode and the same real
/// birth time. Never when either side has no birth time, since an inode
/// alone can be a deleted directory's, reused.
pub fn proves(a: &FolderIdentity, b: &FolderIdentity) -> bool {
    a.inode == b.inode && a.birthtime.is_some() && a.birthtime == b.birthtime
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(inode: &str, birthtime: Option<&str>) -> FolderIdentity {
        FolderIdentity {
            inode: inode.to_string(),
            birthtime: birthtime.map(str::to_string),
        }
    }

    #[test]
    fn only_a_real_birth_time_and_the_same_inode_prove_a_directory() {
        let born = identity("12", Some("1700000000123456789"));
        assert!(proves(&born, &born.clone()));
        assert!(!proves(&born, &identity("13", Some("1700000000123456789"))));
        assert!(!proves(&born, &identity("12", Some("1700000000123456788"))));
        assert!(!proves(&born, &identity("12", None)));
        assert!(!proves(&identity("12", None), &identity("12", None)));
    }

    #[test]
    fn a_key_names_the_inode_and_the_birth_time_when_there_is_one() {
        assert_eq!(identity_key(&identity("12", Some("34"))), "12-34");
        assert_eq!(identity_key(&identity("12", None)), "12");
    }

    #[test]
    fn it_serializes_as_the_page_reads_it() {
        assert_eq!(
            serde_json::to_value(identity("12", None)).unwrap(),
            serde_json::json!({ "inode": "12", "birthtime": null })
        );
    }

    /// A directory's identity follows it through a rename, and a new
    /// directory at the old name is another, here where the system records
    /// birth times.
    #[cfg(unix)]
    #[test]
    fn a_renamed_directory_keeps_its_identity() {
        let temp = crate::testing::TempDir::new("identity");
        let first = temp.folder("first");
        let before = identity_at(&first).unwrap().unwrap();
        let moved = temp.path().join("moved");
        std::fs::rename(&first, &moved).unwrap();
        let after = identity_at(&moved).unwrap().unwrap();
        assert_eq!(before, after);
        std::fs::create_dir(&first).unwrap();
        let again = identity_at(&first).unwrap().unwrap();
        assert_ne!(again.inode, after.inode);
        #[cfg(target_os = "macos")]
        {
            use std::os::unix::fs::MetadataExt;
            let metadata = std::fs::metadata(&moved).unwrap();
            assert!(proves(&before, &after));
            // `st_birthtimespec`, as Node's `birthtimeNs` reads it.
            let born = metadata.created().unwrap();
            let nanos = born.duration_since(UNIX_EPOCH).unwrap().as_nanos();
            assert_eq!(after.birthtime, Some(nanos.to_string()));
            assert_eq!(after.inode, metadata.ino().to_string());
        }
    }
}
