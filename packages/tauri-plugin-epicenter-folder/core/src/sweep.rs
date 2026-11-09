//! What opening a folder clears away: saves a stopped writer left, and what
//! an older build kept in the folder's `.epicenter` (ADR-0822).
//!
//! `sweep` walks the whole folder, following no link and skipping `.git`,
//! and removes each regular file named as a staged save (`state::is_staged_save`)
//! last changed more than an hour ago: a save renames or removes its staged
//! file right after writing it, so one that old was left by a save that
//! stopped, and a younger one may belong to a save still running in another
//! process. It never touches a recording in progress (its recorder recovers
//! it) nor any other hidden file.
//!
//! In a folder an older build wrote, it then clears that build's
//! `.epicenter`: stale staged files in `saves/` are removed; each recording
//! in `recordings/` last changed over an hour ago is moved beside its final
//! path under a recording's reserved name (`state::pending_recording`),
//! where the recorder's recovery finishes it, or left where it is when it
//! cannot be; then every empty directory in `saves/` and `recordings/` is
//! removed, and `.epicenter` once it is empty. A recording, `synced.json`,
//! and `hashes.json` are never deleted: the page imports and removes the last
//! two itself, and the next open removes the empty `.epicenter`.
//!
//! What cannot be read or removed stays: it is inert.

use std::fs;
use std::path::Path;
use std::time::{Duration, SystemTime};

use crate::page_files;
use crate::state;
use crate::storage::place;

/// How long ago a file must have last changed before a sweep takes it for
/// one a stopped writer left.
pub const STALE: Duration = Duration::from_secs(60 * 60);

/// Whether the entry `metadata` describes last changed more than `STALE`
/// before `now`.
fn stale(metadata: &fs::Metadata, now: SystemTime) -> bool {
    metadata
        .modified()
        .ok()
        .and_then(|modified| now.duration_since(modified).ok())
        .is_some_and(|age| age > STALE)
}

/// Clear the folder at `root` as of `now`: stale staged saves anywhere in it,
/// and an older build's `.epicenter`.
pub fn sweep(root: &Path, now: SystemTime) {
    sweep_saves(root, now);
    clear_legacy(root, now);
}

/// `sweep` as of now.
pub fn sweep_now(root: &Path) {
    sweep(root, SystemTime::now());
}

/// Remove every stale staged save in `directory` and below it, following no
/// link and skipping `.git` in any case.
fn sweep_saves(directory: &Path, now: SystemTime) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if kind.is_dir() {
            if !name.eq_ignore_ascii_case(".git") {
                sweep_saves(&entry.path(), now);
            }
            continue;
        }
        if !kind.is_file() || !state::is_staged_save(&name) {
            continue;
        }
        if entry.metadata().is_ok_and(|metadata| stale(&metadata, now)) {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// Whether `path` is a directory itself, not a link to one.
fn is_directory(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_dir())
}

/// Clear what an older build kept in the `.epicenter` at `root`.
fn clear_legacy(root: &Path, now: SystemTime) {
    let legacy = state::directory(root);
    if !is_directory(&legacy) {
        return;
    }
    let saves = legacy.join(state::LEGACY_SAVES);
    if is_directory(&saves) {
        if let Ok(entries) = fs::read_dir(&saves) {
            for entry in entries.flatten() {
                let is_file = entry.file_type().is_ok_and(|kind| kind.is_file());
                if is_file && entry.metadata().is_ok_and(|metadata| stale(&metadata, now)) {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
        remove_empty(&saves);
    }
    let recordings = legacy.join(state::LEGACY_RECORDINGS);
    if is_directory(&recordings) {
        move_recordings(root, &recordings, "", now);
        remove_empty(&recordings);
    }
    // Only when nothing is left in it: never the page's to import.
    let _ = fs::remove_dir(&legacy);
}

/// Move each recording last changed over an hour ago in the older build's
/// `recordings` directory `directory`, at the folder-relative `relative`
/// below it, beside its final path under a recording's reserved name. One
/// that cannot be moved stays.
fn move_recordings(root: &Path, directory: &Path, relative: &str, now: SystemTime) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let child = if relative.is_empty() {
            name.clone()
        } else {
            format!("{relative}/{name}")
        };
        if kind.is_dir() {
            move_recordings(root, &entry.path(), &child, now);
            continue;
        }
        let Some(stem) = child.strip_suffix(".webm") else {
            continue;
        };
        if !kind.is_file() || stem.is_empty() || stem.ends_with('/') {
            continue;
        }
        if !entry.metadata().is_ok_and(|metadata| stale(&metadata, now)) {
            continue;
        }
        let pending = state::pending_recording(stem);
        if let Some((parent, _)) = pending.rsplit_once('/') {
            if page_files::mkdir(root, &root.join(parent)).is_err() {
                continue;
            }
        }
        let Ok(target) = page_files::data_path(root, &pending) else {
            continue;
        };
        // One that cannot be placed stays, for the recorder's recovery.
        let _ = place(&entry.path(), &target);
    }
}

/// Remove `directory` and every directory below it that is empty, deepest
/// first, following no link.
fn remove_empty(directory: &Path) {
    if let Ok(entries) = fs::read_dir(directory) {
        for entry in entries.flatten() {
            if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                remove_empty(&entry.path());
            }
        }
    }
    let _ = fs::remove_dir(directory);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempDir;

    const HOUR: Duration = Duration::from_secs(60 * 60);

    /// Write `bytes` at `path` under `root`, last changed `age` ago.
    fn aged(root: &Path, path: &str, bytes: &[u8], age: Duration) {
        let at = root.join(path);
        fs::create_dir_all(at.parent().unwrap()).unwrap();
        fs::write(&at, bytes).unwrap();
        let file = fs::File::options().write(true).open(&at).unwrap();
        file.set_modified(SystemTime::now() - age).unwrap();
    }

    fn exists(root: &Path, path: &str) -> bool {
        fs::symlink_metadata(root.join(path)).is_ok()
    }

    /// Stale staged saves go at any depth; a young one, a recording in
    /// progress, any other hidden file, and anything in `.git` stay.
    #[test]
    fn a_sweep_removes_only_stale_staged_saves_anywhere() {
        let temp = TempDir::new("sweep");
        let root = temp.folder("notes");
        let old = HOUR + Duration::from_secs(60);
        let young = HOUR - Duration::from_secs(60);
        aged(&root, ".ep-0123456789abcdef.save", b"x", old);
        aged(&root, "notes/deep/.ep-aaaa.save", b"x", old);
        aged(&root, "notes/.ep-bbbb.save", b"x", young);
        aged(&root, "notes/.ep-k3j9x2ab-take.recording", b"audio", 10 * HOUR);
        aged(&root, ".DS_Store", b"x", 10 * HOUR);
        aged(&root, "notes/.ep-x.saved", b"x", 10 * HOUR);
        aged(&root, ".git/.ep-cccc.save", b"git's", 10 * HOUR);
        fs::create_dir(root.join(".ep-dddd.save")).unwrap();
        sweep(&root, SystemTime::now());
        assert!(!exists(&root, ".ep-0123456789abcdef.save"));
        assert!(!exists(&root, "notes/deep/.ep-aaaa.save"));
        for kept in [
            "notes/.ep-bbbb.save",
            "notes/.ep-k3j9x2ab-take.recording",
            ".DS_Store",
            "notes/.ep-x.saved",
            ".git/.ep-cccc.save",
            ".ep-dddd.save",
        ] {
            assert!(exists(&root, kept), "{kept}");
        }
    }

    /// A link is never followed: what it reaches stays, however old.
    #[cfg(unix)]
    #[test]
    fn a_sweep_follows_no_link() {
        let temp = TempDir::new("sweep-link");
        let root = temp.folder("notes");
        let elsewhere = temp.folder("elsewhere");
        aged(&elsewhere, ".ep-aaaa.save", b"theirs", 10 * HOUR);
        aged(&elsewhere, "saves/old", b"theirs", 10 * HOUR);
        std::os::unix::fs::symlink(&elsewhere, root.join("linked")).unwrap();
        std::os::unix::fs::symlink(elsewhere.join(".ep-aaaa.save"), root.join(".ep-bbbb.save"))
            .unwrap();
        std::os::unix::fs::symlink(&elsewhere, root.join(".epicenter")).unwrap();
        sweep(&root, SystemTime::now() + 10 * HOUR);
        assert!(exists(&elsewhere, ".ep-aaaa.save"));
        assert!(exists(&elsewhere, "saves/old"));
        assert!(exists(&root, ".ep-bbbb.save"));
        assert!(exists(&root, ".epicenter"));
    }

    /// An older build's `.epicenter`: stale saves go, a stale recording moves
    /// beside its final path under a recording's name, a young one stays,
    /// the manifest and hash cache stay, and so does `.epicenter` until it is
    /// empty.
    #[test]
    fn an_older_builds_state_is_cleared_but_never_a_recording_or_the_manifest() {
        let temp = TempDir::new("sweep-legacy");
        let root = temp.folder("notes");
        aged(&root, ".epicenter/saves/staged-old", b"x", 2 * HOUR);
        aged(&root, ".epicenter/saves/staged-young", b"x", HOUR / 2);
        aged(&root, ".epicenter/recordings/recordings/2026/take.webm", b"audio", 2 * HOUR);
        aged(&root, ".epicenter/recordings/live.webm", b"live", HOUR / 2);
        aged(&root, ".epicenter/synced.json", b"{}", 10 * HOUR);
        aged(&root, ".epicenter/hashes.json", b"{}", 10 * HOUR);
        fs::create_dir_all(root.join(".epicenter/recordings/empty/deeper")).unwrap();
        sweep(&root, SystemTime::now());

        assert!(!exists(&root, ".epicenter/saves/staged-old"));
        assert!(exists(&root, ".epicenter/saves/staged-young"));
        assert!(!exists(&root, ".epicenter/recordings/recordings/2026/take.webm"));
        assert!(!exists(&root, ".epicenter/recordings/recordings"));
        assert!(!exists(&root, ".epicenter/recordings/empty"));
        let moved: Vec<String> = fs::read_dir(root.join("recordings/2026"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(moved.len(), 1);
        assert_eq!(
            state::recording_final(&format!("recordings/2026/{}", moved[0])).as_deref(),
            Some("recordings/2026/take.webm")
        );
        assert_eq!(
            fs::read(root.join("recordings/2026").join(&moved[0])).unwrap(),
            b"audio"
        );
        assert!(exists(&root, ".epicenter/recordings/live.webm"));
        assert!(exists(&root, ".epicenter/synced.json"));
        assert!(exists(&root, ".epicenter/hashes.json"));

        // Once the page imported the manifest and the young files are gone,
        // the next open removes what is left.
        for imported in [
            ".epicenter/synced.json",
            ".epicenter/hashes.json",
            ".epicenter/saves/staged-young",
            ".epicenter/recordings/live.webm",
        ] {
            fs::remove_file(root.join(imported)).unwrap();
        }
        sweep(&root, SystemTime::now());
        assert!(!exists(&root, ".epicenter"));
        assert!(exists(&root, "recordings/2026"));
    }

    /// A folder with nothing to clear is left as it is, and nothing is made.
    #[test]
    fn a_sweep_makes_nothing() {
        let temp = TempDir::new("sweep-empty");
        let root = temp.folder("notes");
        sweep(&root, SystemTime::now());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
    }
}
