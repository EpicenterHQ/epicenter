//! A page's storage over a real directory.
//!
//! Key behaviors:
//! - A listing and a directory's children leave out `.git` at the root and
//!   follow no link; a link is a file to them.
//! - A path through a link, or naming one, is refused as `InvalidPath`; a
//!   name stored under another spelling is absent to a read and refused to
//!   a change, on a disk that ignores case or normalization.
//! - A put lands only on what the page expected and is otherwise `Stale`,
//!   changing nothing; `None` bytes remove the file; a refused save lock is
//!   `Io` and changes nothing; no staged file outlives a put.
//! - A directory is made with its ancestors and removed only when empty.
//! - Staged files an hour old are swept, and nothing younger or foreign.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::*;
use crate::lock::SaveLock;
use crate::testing::TempDir;

fn sha256(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn folder(label: &str, files: &[(&str, &[u8])]) -> (TempDir, PathBuf) {
    let temp = TempDir::new(label);
    let root = temp.folder("notes");
    for (path, bytes) in files {
        let target = root.join(path);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(target, bytes).unwrap();
    }
    (temp, root)
}

/// Bytes to put.
fn b(bytes: &[u8]) -> Option<&[u8]> {
    Some(bytes)
}

/// A turn that is always given.
fn free() -> Result<(), String> {
    Ok(())
}

fn put_now(
    root: &Path,
    path: &str,
    bytes: Option<&[u8]>,
    if_match: Option<&str>,
) -> Result<PutOutcome, StorageError> {
    put(root, path, bytes, if_match, free)
}

/// The staged files left under `root`.
fn staged(root: &Path) -> Vec<String> {
    fs::read_dir(root.join(SCRATCH_DIRECTORY))
        .map(|entries| {
            entries
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default()
}

/// Whether this disk finds `Probe` when asked for `probe`.
fn ignores_case(root: &Path) -> bool {
    fs::write(root.join("Probe"), b"").unwrap();
    let ignores = root.join("probe").exists();
    fs::remove_file(root.join("Probe")).unwrap();
    ignores
}

fn invalid(path: &str) -> impl Fn(&StorageError) -> bool + '_ {
    move |error| matches!(error, StorageError::InvalidPath { path: at, .. } if at == path)
}

#[test]
fn a_listing_leaves_out_git_at_the_root_and_follows_no_link() {
    let (_temp, root) = folder(
        "storage-list",
        &[
            ("todos/a.md", b"first\n"),
            (".git/HEAD", b"ref: refs/heads/main\n"),
            ("kv.json", b"{}"),
        ],
    );
    fs::create_dir_all(root.join("empty")).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(root.join("todos"), root.join("linked")).unwrap();
    let mut listing = list(&root).unwrap();
    listing.files.sort_by(|a, b| a.path.cmp(&b.path));
    listing.directories.sort();
    let mut files: Vec<(&str, u64)> = vec![("kv.json", 2), ("todos/a.md", 6)];
    #[cfg(unix)]
    {
        let size = fs::symlink_metadata(root.join("linked")).unwrap().len();
        files.insert(1, ("linked", size));
    }
    assert_eq!(
        listing
            .files
            .iter()
            .map(|file| (file.path.as_str(), file.size))
            .collect::<Vec<_>>(),
        files
    );
    assert_eq!(listing.directories, ["empty", "todos"]);
}

#[test]
fn children_are_named_by_kind_and_refused_where_no_directory_is() {
    let (_temp, root) = folder(
        "storage-children",
        &[
            ("todos/a.md", b"a"),
            ("todos/sub/b.md", b"b"),
            (".git/HEAD", b"x"),
        ],
    );
    let top = children(&root, "").unwrap();
    assert_eq!(top.directories, ["todos"]);
    assert!(top.files.is_empty());
    let mut todos = children(&root, "todos").unwrap();
    todos.files.sort();
    assert_eq!(todos.files, ["a.md"]);
    assert_eq!(todos.directories, ["sub"]);
    assert_eq!(
        children(&root, "todos/a.md"),
        Err(StorageError::NotADirectory {
            path: "todos/a.md".into()
        })
    );
    assert_eq!(
        children(&root, "notes"),
        Err(StorageError::NotFound {
            path: "notes".into()
        })
    );
    assert!(children(&root, ".git").is_err_and(|error| invalid(".git")(&error)));
}

#[test]
fn a_read_answers_the_bytes_of_a_regular_file_and_nothing_else() {
    let bytes: Vec<u8> = (0..=255).collect();
    let (_temp, root) = folder("storage-read", &[("all.bin", &bytes), ("todos/a.md", b"a")]);
    assert_eq!(read(&root, "all.bin").unwrap(), bytes);
    assert_eq!(
        read(&root, "todos"),
        Err(StorageError::NotAFile {
            path: "todos".into()
        })
    );
    assert_eq!(
        read(&root, "b.md"),
        Err(StorageError::NotFound {
            path: "b.md".into()
        })
    );
    // A file where a directory would be holds nothing below it.
    assert_eq!(
        read(&root, "todos/a.md/x"),
        Err(StorageError::NotFound {
            path: "todos/a.md/x".into()
        })
    );
    for refused in [
        "",
        ".git/HEAD",
        "../outside.md",
        "todos//a.md",
        "todos/HEAD",
    ] {
        assert!(
            read(&root, refused).is_err_and(|error| invalid(refused)(&error)),
            "{refused:?}"
        );
    }
}

#[cfg(unix)]
#[test]
fn a_link_is_never_followed_and_a_path_through_one_is_refused() {
    let (temp, root) = folder("storage-links", &[]);
    let elsewhere = temp.folder("elsewhere");
    fs::write(elsewhere.join("secret.md"), b"theirs").unwrap();
    std::os::unix::fs::symlink(&elsewhere, root.join("todos")).unwrap();
    std::os::unix::fs::symlink(elsewhere.join("secret.md"), root.join("a.md")).unwrap();
    for path in ["todos/secret.md", "a.md", "todos/new.md"] {
        assert!(
            read(&root, path).is_err_and(|error| invalid(path)(&error)),
            "{path}"
        );
        assert!(
            put_now(&root, path, b(b"mine"), None).is_err_and(|error| invalid(path)(&error)),
            "{path}"
        );
        assert!(
            put_now(&root, path, None, Some(&sha256(b"theirs")))
                .is_err_and(|error| invalid(path)(&error)),
            "{path}"
        );
    }
    assert!(children(&root, "todos").is_err_and(|error| invalid("todos")(&error)));
    assert!(mkdir(&root, "todos/sub").is_err_and(|error| invalid("todos/sub")(&error)));
    assert!(rmdir(&root, "todos").is_err_and(|error| invalid("todos")(&error)));
    assert_eq!(fs::read(elsewhere.join("secret.md")).unwrap(), b"theirs");
    assert_eq!(fs::read_dir(&elsewhere).unwrap().count(), 1);
}

/// On a disk that ignores case, `todos/a.md` reaches `Todos/A.md`. The
/// stored spelling is another entry: absent to a read, refused to a change.
#[test]
fn a_name_stored_under_another_spelling_is_another_entry() {
    let (_temp, root) = folder("storage-spelling", &[("Todos/A.md", b"theirs")]);
    if !ignores_case(&root) {
        return;
    }
    for path in ["todos/A.md", "Todos/a.md"] {
        assert_eq!(
            read(&root, path),
            Err(StorageError::NotFound { path: path.into() })
        );
        assert!(put_now(&root, path, b(b"mine"), None).is_err_and(|error| invalid(path)(&error)));
        assert!(
            put_now(&root, path, None, Some(&sha256(b"theirs")))
                .is_err_and(|error| invalid(path)(&error))
        );
    }
    assert_eq!(
        children(&root, "todos"),
        Err(StorageError::NotFound {
            path: "todos".into()
        })
    );
    assert!(mkdir(&root, "todos").is_err_and(|error| invalid("todos")(&error)));
    assert_eq!(
        rmdir(&root, "todos"),
        Err(StorageError::NotFound {
            path: "todos".into()
        })
    );
    assert_eq!(read(&root, "Todos/A.md").unwrap(), b"theirs");
    assert!(staged(&root).is_empty());
    // Both ways of finding the stored spelling agree.
    for names in [["todos", "A.md"], ["Todos", "a.md"]] {
        assert!(!spelled_by_listing(&root, &names).unwrap());
        #[cfg(any(target_os = "macos", target_os = "ios", windows))]
        assert!(!spelled_by_resolving(&root, &names).unwrap());
    }
    assert!(spelled_by_listing(&root, &["Todos", "A.md"]).unwrap());
    #[cfg(any(target_os = "macos", target_os = "ios", windows))]
    assert!(spelled_by_resolving(&root, &["Todos", "A.md"]).unwrap());
}

/// macOS stores a name in the normalization it was written in and finds it
/// by either. A name asked for in the other is another entry.
#[cfg(target_os = "macos")]
#[test]
fn a_name_stored_in_another_normalization_is_another_entry() {
    let decomposed = "cafe\u{301}.md";
    let composed = "caf\u{e9}.md";
    let (_temp, root) = folder("storage-normalization", &[(decomposed, b"theirs")]);
    if !root.join(composed).exists() {
        return;
    }
    assert_eq!(
        read(&root, composed),
        Err(StorageError::NotFound {
            path: composed.into()
        })
    );
    assert!(
        put_now(&root, composed, b(b"mine"), None).is_err_and(|error| invalid(composed)(&error))
    );
    assert_eq!(read(&root, decomposed).unwrap(), b"theirs");
}

#[test]
fn a_put_lands_only_on_what_the_page_expected() {
    let (_temp, root) = folder("storage-put", &[]);
    let a = root.join("todos/a.md");
    // A new file, and its missing parent, land where nothing was.
    assert_eq!(
        put_now(&root, "todos/a.md", b(b"first"), None),
        Ok(PutOutcome::Landed)
    );
    assert_eq!(fs::read(&a).unwrap(), b"first");
    // A create over the file is stale, and so is another hash.
    assert_eq!(
        put_now(&root, "todos/a.md", b(b"again"), None),
        Ok(PutOutcome::Stale)
    );
    assert_eq!(
        put_now(&root, "todos/a.md", b(b"mine"), Some(&sha256(b"other"))),
        Ok(PutOutcome::Stale)
    );
    assert_eq!(fs::read(&a).unwrap(), b"first");
    // The hash of what is there lands.
    assert_eq!(
        put_now(&root, "todos/a.md", b(b"second"), Some(&sha256(b"first"))),
        Ok(PutOutcome::Landed)
    );
    assert_eq!(fs::read(&a).unwrap(), b"second");
    // A guarded replacement of a missing file is stale.
    assert_eq!(
        put_now(&root, "todos/b.md", b(b"b"), Some(&sha256(b"second"))),
        Ok(PutOutcome::Stale)
    );
    assert!(!root.join("todos/b.md").exists());
    // Removal: only the expected bytes, and only a file.
    assert_eq!(
        put_now(&root, "todos/a.md", None, None),
        Ok(PutOutcome::Stale)
    );
    assert_eq!(
        put_now(&root, "todos/a.md", None, Some(&sha256(b"other"))),
        Ok(PutOutcome::Stale)
    );
    assert!(a.exists());
    assert_eq!(
        put_now(&root, "todos/a.md", None, Some(&sha256(b"second"))),
        Ok(PutOutcome::Landed)
    );
    assert!(!a.exists());
    // Nothing there is what a removal expecting nothing wants.
    assert_eq!(
        put_now(&root, "todos/a.md", None, None),
        Ok(PutOutcome::Landed)
    );
    assert_eq!(
        put_now(&root, "todos/a.md", None, Some(&sha256(b"second"))),
        Ok(PutOutcome::Stale)
    );
    assert!(staged(&root).is_empty());
}

#[test]
fn a_put_is_refused_where_no_file_can_be() {
    let (_temp, root) = folder("storage-put-refused", &[("todos/a.md", b"a")]);
    assert_eq!(
        put_now(&root, "todos", b(b"x"), None),
        Err(StorageError::NotAFile {
            path: "todos".into()
        })
    );
    assert_eq!(
        put_now(&root, "todos/a.md/b.md", b(b"x"), None),
        Err(StorageError::NotADirectory {
            path: "todos/a.md".into()
        })
    );
    // A removal below a file finds nothing there.
    assert_eq!(
        put_now(&root, "todos/a.md/b.md", None, None),
        Ok(PutOutcome::Landed)
    );
    for refused in [".git/config", "HEAD", "todos/a.md.", ""] {
        assert!(
            put_now(&root, refused, b(b"x"), None).is_err_and(|error| invalid(refused)(&error)),
            "{refused:?}"
        );
    }
    assert!(!root.join(".git/config").exists());
    assert!(staged(&root).is_empty());
}

/// A save lock another process holds too long refuses the turn: the put is
/// `Io`, a definite failure, and nothing changed.
#[test]
fn a_put_whose_turn_is_refused_changes_nothing() {
    let (_temp, root) = folder("storage-put-lock", &[("a.md", b"old")]);
    let held = SaveLock::acquire(&root, Duration::ZERO).unwrap();
    let wait = || SaveLock::acquire(&root, Duration::from_millis(20));
    for (bytes, operation) in [(Some(&b"new"[..]), "write"), (None, "remove")] {
        let refused = put(&root, "a.md", bytes, Some(&sha256(b"old")), wait).unwrap_err();
        let StorageError::Io {
            path,
            operation: did,
            message,
        } = refused
        else {
            panic!("{refused:?}");
        };
        assert_eq!((path.as_str(), did.as_str()), ("a.md", operation));
        assert!(message.contains("Nothing was saved"), "{message}");
    }
    assert!(put(&root, "b.md", b(b"b"), None, wait).is_err());
    assert_eq!(fs::read(root.join("a.md")).unwrap(), b"old");
    assert!(!root.join("b.md").exists());
    assert!(staged(&root).is_empty());
    drop(held);
    assert_eq!(
        put(&root, "a.md", b(b"new"), Some(&sha256(b"old")), wait),
        Ok(PutOutcome::Landed)
    );
}

/// Before the first commit makes a repository (ADR-0535), a save stages its
/// bytes in `.git/epicenter/scratch`, so `.git` is made on the way and
/// nothing else is put in it.
#[test]
fn a_folder_with_no_repository_yet_stages_its_first_save() {
    let (_temp, root) = folder("storage-no-repository", &[]);
    assert_eq!(
        put_now(&root, "todos.md", b(b"milk"), None),
        Ok(PutOutcome::Landed)
    );
    assert_eq!(fs::read(root.join("todos.md")).unwrap(), b"milk");
    let made: Vec<_> = fs::read_dir(root.join(".git"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(made, ["epicenter"]);
    assert!(staged(&root).is_empty());
}

#[cfg(unix)]
#[test]
fn a_hard_link_is_replaced_not_written_through() {
    let (temp, root) = folder("storage-hardlink", &[]);
    fs::create_dir_all(root.join("todos")).unwrap();
    let outside = temp.path().join("outside.md");
    fs::write(&outside, b"theirs").unwrap();
    fs::hard_link(&outside, root.join("todos/a.md")).unwrap();
    assert_eq!(
        put_now(&root, "todos/a.md", b(b"mine"), Some(&sha256(b"theirs"))),
        Ok(PutOutcome::Landed)
    );
    assert_eq!(fs::read(&outside).unwrap(), b"theirs");
    assert_eq!(fs::read(root.join("todos/a.md")).unwrap(), b"mine");
}

#[test]
fn the_hash_is_the_one_the_page_computes() {
    assert_eq!(
        sha256(b""),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    // A file is hashed as it streams, to the same digest as its bytes.
    let bytes: Vec<u8> = (0..200_000u32).map(|n| (n % 251) as u8).collect();
    let (_temp, root) = folder("storage-hash", &[("big.bin", &bytes)]);
    assert_eq!(file_sha256(&root.join("big.bin")).unwrap(), sha256(&bytes));
}

#[test]
fn a_directory_is_made_with_its_ancestors_and_removed_only_when_empty() {
    let (_temp, root) = folder("storage-directories", &[("a.md", b"a")]);
    mkdir(&root, "todos/sub").unwrap();
    assert!(root.join("todos/sub").is_dir());
    mkdir(&root, "todos").unwrap();
    assert_eq!(
        mkdir(&root, "a.md"),
        Err(StorageError::NotADirectory {
            path: "a.md".into()
        })
    );
    assert_eq!(
        mkdir(&root, "a.md/sub"),
        Err(StorageError::NotADirectory {
            path: "a.md".into()
        })
    );
    assert!(mkdir(&root, ".git/hooks").is_err_and(|error| invalid(".git/hooks")(&error)));
    assert_eq!(
        rmdir(&root, "todos"),
        Err(StorageError::DirectoryNotEmpty {
            path: "todos".into()
        })
    );
    assert_eq!(
        rmdir(&root, "a.md"),
        Err(StorageError::NotADirectory {
            path: "a.md".into()
        })
    );
    assert_eq!(
        rmdir(&root, "gone"),
        Err(StorageError::NotFound {
            path: "gone".into()
        })
    );
    rmdir(&root, "todos/sub").unwrap();
    rmdir(&root, "todos").unwrap();
    assert!(!root.join("todos").exists());
}

/// A save racing on one path: two puts that expect the same bytes, each
/// pausing between its check and its rename under a shared turn, land once.
#[test]
fn two_puts_expecting_the_same_bytes_land_once() {
    let (_temp, root) = folder("storage-race", &[("a.md", b"old")]);
    let turn = std::sync::Arc::new(std::sync::Mutex::new(()));
    let start = std::sync::Arc::new(std::sync::Barrier::new(2));
    let saves: Vec<_> = ["one", "two"]
        .into_iter()
        .map(|name| {
            let (root, turn, start) = (root.clone(), turn.clone(), start.clone());
            std::thread::spawn(move || {
                PAUSE_AFTER_CHECK.with(|pause| pause.set(Duration::from_millis(50)));
                start.wait();
                put(
                    &root,
                    "a.md",
                    Some(name.as_bytes()),
                    Some(&sha256(b"old")),
                    || Ok(turn.lock().unwrap()),
                )
            })
        })
        .collect();
    let mut outcomes: Vec<_> = saves.into_iter().map(|save| save.join().unwrap()).collect();
    outcomes.sort_by_key(|outcome| format!("{outcome:?}"));
    assert_eq!(outcomes, [Ok(PutOutcome::Landed), Ok(PutOutcome::Stale)]);
    assert!(staged(&root).is_empty());
}

#[test]
fn staged_names_age_as_the_page_reads_them() {
    let engine = "0123456789abcdef0123456789abcdef";
    let hour = 60 * 60 * 1000;
    let made = 1_700_000_000_000u64;
    let name = format!("{}-{engine}-0", base36(made));
    assert!(!is_stale_scratch(&name, made + hour));
    assert!(is_stale_scratch(&name, made + hour + 1));
    assert!(!is_stale_scratch(&name, made - 1));
    for foreign in [
        "staged-1",
        "notes.md",
        &format!("{}-{engine}", base36(made)),
        &format!("{}-{}-0", base36(made), &engine[1..]),
        &format!("{}-{}-0", base36(made), engine.to_uppercase()),
        &format!("{}-{engine}-0-1", base36(made)),
        // Past `Number.MAX_SAFE_INTEGER`, which the page would not parse.
        &format!("{}-{engine}-0", base36(1 << 53)),
    ] {
        assert!(!is_stale_scratch(foreign, u64::MAX), "{foreign}");
    }
    // The names a put stages carry their time.
    let staged = scratch_name(made);
    assert!(
        staged.starts_with(&format!("{}-", base36(made))),
        "{staged}"
    );
    assert!(is_stale_scratch(&staged, made + hour + 1), "{staged}");
    assert!(!is_stale_scratch(&staged, made + hour), "{staged}");
}

#[test]
fn a_sweep_removes_only_staged_files_an_hour_old() {
    let (_temp, root) = folder("storage-sweep", &[]);
    let scratch = root.join(SCRATCH_DIRECTORY);
    fs::create_dir_all(&scratch).unwrap();
    let now = now_ms();
    let hour = 60 * 60 * 1000;
    let old = scratch_name(now - hour - 1);
    let young = scratch_name(now - hour + 60_000);
    for name in [old.as_str(), young.as_str(), "foreign"] {
        fs::write(scratch.join(name), b"x").unwrap();
    }
    let old_directory = scratch_name(now - 2 * hour);
    fs::create_dir(scratch.join(&old_directory)).unwrap();
    sweep_scratch(&root, now);
    let mut left = staged(&root);
    left.sort();
    let mut expected = vec![young, "foreign".to_string(), old_directory];
    expected.sort();
    assert_eq!(left, expected);
    // A folder with no staging directory sweeps nothing.
    let (_other, empty) = folder("storage-sweep-empty", &[]);
    sweep_scratch(&empty, now);
    assert!(!empty.join(".git").exists());
}

#[cfg(unix)]
#[test]
fn a_linked_staging_directory_is_not_swept_or_staged_in() {
    let (temp, root) = folder("storage-sweep-link", &[]);
    let elsewhere = temp.folder("elsewhere");
    let old = scratch_name(1);
    fs::write(elsewhere.join(&old), b"theirs").unwrap();
    fs::create_dir_all(root.join(".git/epicenter")).unwrap();
    std::os::unix::fs::symlink(&elsewhere, root.join(SCRATCH_DIRECTORY)).unwrap();
    sweep_scratch(&root, now_ms());
    assert!(elsewhere.join(&old).exists());
    assert!(matches!(
        put_now(&root, "a.md", b(b"x"), None),
        Err(StorageError::Io { .. })
    ));
    assert!(!root.join("a.md").exists());
    assert_eq!(fs::read_dir(&elsewhere).unwrap().count(), 1);
}
