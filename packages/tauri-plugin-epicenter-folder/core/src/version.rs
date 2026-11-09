//! A file's version (ADR-0824): the SHA-256 of its bytes, for every path,
//! as `versionOf` in `packages/folder/src/hash.ts` names it.

use std::fs;
use std::io::{self, Read};
use std::path::Path;

use sha2::{Digest, Sha256};

/// Files up to this size are hashed whole in a listing; a larger one is
/// named by its stamp, which the page turns into its version through its
/// stamp cache (`HASHED_WHOLE_BYTES` in `packages/folder/src/hash.ts`).
pub const HASHED_WHOLE_BYTES: u64 = 64 * 1024;

fn hex(digest: impl AsRef<[u8]>) -> String {
    digest
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// The version of `bytes`.
pub fn version_of(bytes: &[u8]) -> String {
    hex(Sha256::digest(bytes))
}

/// The version of the file at `target`, read through once: a file that
/// changed length while it was read is named by the bytes read.
pub fn file_version(target: &Path) -> io::Result<String> {
    let mut file = fs::File::open(target)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex(hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_bytes_by_their_sha256() {
        // `printf '' | shasum -a 256` and `printf 'hello\n' | shasum -a 256`.
        assert_eq!(
            version_of(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            version_of(b"hello\n"),
            "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03"
        );
    }

    #[test]
    fn a_file_is_named_as_its_bytes_are() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.bin");
        let bytes = vec![7u8; 200_000];
        fs::write(&path, &bytes).unwrap();
        assert_eq!(file_version(&path).unwrap(), version_of(&bytes));
    }
}
