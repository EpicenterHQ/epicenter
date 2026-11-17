//! Where Epicenter's own files are (ADR-0822): a folder holds only its
//! content.
//!
//! A write in progress waits beside its target under a reserved name, on the
//! target's own file system:
//!
//! - a save stages its bytes in `.ep-<random>.save` (`staged_name`), then
//!   renames it over the target. Opening a folder removes one a stopped save
//!   left (`sweep`).
//! - a recording grows in `.ep-<8 base36 characters>-<base>.recording`
//!   (`pending_recording`) beside its final path `<base>.webm`, which the
//!   name carries (`recording_final`), so recovery after a crash knows where
//!   it goes. Nothing but the recorder ever removes one.
//!
//! No listing, watcher, or sync describes a reserved name (`is_reserved`),
//! at any depth; each is hidden too (`paths::is_hidden_path`).
//!
//! `.epicenter` (`DIRECTORY`) is the Epicenter folder's own: its records,
//! `synced/<folder-id>.json`, and its hash caches, `hashes/<key>.json`. In a
//! folder an older build wrote, `.epicenter` holds what that build left
//! (`saves/`, `recordings/`, `synced.json`, `hashes.json`), which opening the
//! folder empties and removes (`sweep`). This module is the one place Rust
//! spells these names; `fixtures/reserved-names.json` holds it and
//! `@epicenter/folder` to the same ones.

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use sha2::{Digest, Sha256};

/// The Epicenter folder's own directory (its records and hash caches), and in
/// a folder an older build wrote, that build's unfinished writes.
pub const DIRECTORY: &str = ".epicenter";

/// The part of an older build's `DIRECTORY` in a folder where saves staged.
pub const LEGACY_SAVES: &str = "saves";

/// The part of an older build's `DIRECTORY` in a folder where a recording
/// grew, at `<its folder-relative stem>.webm`.
pub const LEGACY_RECORDINGS: &str = "recordings";

/// Every reserved name starts with this.
const PREFIX: &str = ".ep-";
/// A staged save's suffix.
const SAVE: &str = ".save";
/// A recording in progress's suffix.
const RECORDING: &str = ".recording";
/// How many base 36 characters a recording's random part has, so its name
/// reads back to its base.
pub const RECORDING_RANDOM: usize = 8;

/// `.epicenter` inside `directory`: the Epicenter folder's own, or an older
/// build's in a folder.
pub fn directory(directory: &Path) -> PathBuf {
    directory.join(DIRECTORY)
}

/// Whether the name `name` (one segment) is reserved: `.ep-`, at least one
/// character, then `.save` or `.recording`.
pub fn is_reserved_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix(PREFIX) else {
        return false;
    };
    let middle = rest
        .strip_suffix(SAVE)
        .or_else(|| rest.strip_suffix(RECORDING));
    middle.is_some_and(|middle| !middle.is_empty() && !middle.contains('/'))
}

/// Whether the folder-relative `path` names a reserved name, by its last
/// segment.
pub fn is_reserved(path: &str) -> bool {
    is_reserved_name(path.rsplit('/').next().unwrap_or(path))
}

/// Whether the name `name` is a staged save's.
pub fn is_staged_save(name: &str) -> bool {
    is_reserved_name(name) && name.ends_with(SAVE)
}

/// A new staged save's name: `.ep-` and 16 random lowercase hexadecimal
/// characters, then `.save`.
pub fn staged_name() -> String {
    format!("{PREFIX}{}{SAVE}", random(16, b"0123456789abcdef"))
}

/// The folder-relative path a recording of the folder-relative `stem` (its
/// final path without `.webm`) grows at: `.ep-<random>-<base>.recording`
/// beside `<stem>.webm`, where `<random>` is `RECORDING_RANDOM` lowercase
/// base 36 characters.
pub fn pending_recording(stem: &str) -> String {
    let (directory, base) = match stem.rsplit_once('/') {
        Some((directory, base)) => (Some(directory), base),
        None => (None, stem),
    };
    let name = format!(
        "{PREFIX}{}-{base}{RECORDING}",
        random(RECORDING_RANDOM, b"0123456789abcdefghijklmnopqrstuvwxyz")
    );
    match directory {
        Some(directory) => format!("{directory}/{name}"),
        None => name,
    }
}

/// The folder-relative final path of the recording growing at the
/// folder-relative `pending`, `<directory>/<base>.webm`, or `None` when its
/// last segment is not a recording's name: `.ep-`, `RECORDING_RANDOM`
/// lowercase base 36 characters, `-`, a nonempty base, `.recording`.
pub fn recording_final(pending: &str) -> Option<String> {
    let (directory, name) = match pending.rsplit_once('/') {
        Some((directory, name)) => (Some(directory), name),
        None => (None, pending),
    };
    let rest = name.strip_prefix(PREFIX)?.strip_suffix(RECORDING)?;
    let random = rest.get(..RECORDING_RANDOM)?;
    if !random
        .bytes()
        .all(|byte| byte.is_ascii_digit() || byte.is_ascii_lowercase())
    {
        return None;
    }
    let base = rest[RECORDING_RANDOM..].strip_prefix('-')?;
    if base.is_empty() {
        return None;
    }
    Some(match directory {
        Some(directory) => format!("{directory}/{base}.webm"),
        None => format!("{base}.webm"),
    })
}

/// `count` characters drawn from `alphabet`, unpredictable across processes
/// and distinct within one: a digest of this process, the time, a counter,
/// and the standard library's per-process random keys.
fn random(count: usize, alphabet: &[u8]) -> String {
    static DRAWN: AtomicU64 = AtomicU64::new(0);
    let mut seed = Sha256::new();
    seed.update(std::process::id().to_le_bytes());
    seed.update(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
            .to_le_bytes(),
    );
    seed.update(DRAWN.fetch_add(1, Ordering::SeqCst).to_le_bytes());
    let mut keyed = RandomState::new().build_hasher();
    keyed.write_u64(0);
    seed.update(keyed.finish().to_le_bytes());
    seed.finalize()
        .iter()
        .take(count)
        .map(|byte| char::from(alphabet[usize::from(*byte) % alphabet.len()]))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Names {
        legacy_directory: String,
        reserved: Vec<String>,
        not_reserved: Vec<String>,
        recordings: Vec<Recording>,
    }

    #[derive(serde::Deserialize)]
    struct Recording {
        pending: String,
        #[serde(rename = "final")]
        landed: String,
    }

    /// The names `@epicenter/folder` reads too, so both languages agree.
    #[test]
    fn the_names_follow_the_shared_fixture() {
        let names: Names =
            serde_json::from_str(include_str!("../../fixtures/reserved-names.json")).unwrap();
        assert_eq!(DIRECTORY, names.legacy_directory);
        for path in &names.reserved {
            assert!(is_reserved(path), "{path:?} is not reserved");
            assert!(crate::paths::is_hidden_path(path), "{path:?} is not hidden");
        }
        for path in &names.not_reserved {
            assert!(!is_reserved(path), "{path:?} is reserved");
        }
        assert!(!names.recordings.is_empty());
        for recording in &names.recordings {
            assert!(is_reserved(&recording.pending), "{}", recording.pending);
            assert_eq!(
                recording_final(&recording.pending).as_deref(),
                Some(recording.landed.as_str())
            );
        }
    }

    #[test]
    fn a_new_name_is_reserved_and_reads_back_to_its_target() {
        let staged = staged_name();
        assert!(is_staged_save(&staged), "{staged}");
        assert_eq!(staged.len(), ".ep-".len() + 16 + ".save".len());
        assert_ne!(staged, staged_name());
        for stem in ["a", "recordings/2026-11-06 take", "x/y/.hidden"] {
            let pending = pending_recording(stem);
            assert!(is_reserved(&pending), "{pending}");
            assert!(!is_staged_save(pending.rsplit('/').next().unwrap()));
            assert_eq!(recording_final(&pending), Some(format!("{stem}.webm")));
        }
        for refused in [
            ".ep-k3j9x2a-a.recording",
            ".ep-K3J9X2AB-a.recording",
            ".ep-k3j9x2ab-.recording",
            ".ep-k3j9x2aba.recording",
            ".ep-k3j9x2ab-a.save",
            "ep-k3j9x2ab-a.recording",
        ] {
            assert_eq!(recording_final(refused), None, "{refused}");
        }
    }
}
