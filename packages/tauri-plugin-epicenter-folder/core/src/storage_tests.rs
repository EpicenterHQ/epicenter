//! A page's storage over a real directory.
//!
//! Key behaviors:
//! - A listing and a directory's children leave out `.git` and `.epicenter`
//!   at the root and follow no link; a link is a file to them.
//! - A path through a link, or naming one, is refused as `InvalidPath`; a
//!   name stored under another spelling is absent to a read and refused to
//!   a change, on a disk that ignores case or normalization.
//! - A put lands only on what the page expected and is otherwise `Stale`,
//!   changing nothing; `None` bytes remove the file; no staged file outlives
//!   a put.
//! - A put stages inside the root, in `.epicenter/scratch`, makes nothing
//!   next to the root, and makes and changes nothing in `.git`: a folder with
//!   no `.git`, or with a `.git` file or link, saves alike.
//! - A scratch directory, or the `.epicenter` holding it, that is a link or
//!   not a directory refuses a put as `Io`, and the file at the path stays
//!   as it was.
//! - On Unix staged bytes are this account's alone: the scratch directory is
//!   `0700`, an open one is tightened first, and each
//!   staged file is `0600`. A replaced file keeps its mode; a new one is
//!   `0600`. On macOS neither keeps an access control entry the parent
//!   passes on, and one that cannot be removed refuses the put before anything is staged.
//! - A directory is made with its ancestors and removed only when empty.
//! - Staged files an hour old are swept, and nothing younger or foreign: no
//!   other file, no directory, no link.

use std::fs;
use std::path::{Path, PathBuf};

use super::*;
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

#[test]
fn list_read_and_put_report_the_observed_file_stamp() {
    let (_temp, root) = folder("storage-stamp", &[("note.txt", b"old")]);
    let initial = list(&root).unwrap().files[0].stamp.clone();
    assert_eq!(read(&root, "note.txt").unwrap().stamp, initial);

    let landed = super::put(&root, "note.txt", Some(b"new"), &Expectation::Any).unwrap();
    let PutOutcome::Landed {
        stamp: Some(published),
    } = landed
    else {
        panic!("the put did not report its published file");
    };
    assert_ne!(published, initial);
    assert_eq!(list(&root).unwrap().files[0].stamp, published);
    assert_eq!(read(&root, "note.txt").unwrap().stamp, published);

    let removed = super::put(&root, "note.txt", None, &Expectation::Any).unwrap();
    assert_eq!(removed, PutOutcome::Landed { stamp: None });
}

/// What most cases here expect: the file whose SHA-256 is `if_match`, or
/// nothing for `None`. The expectation vectors cover `Any` and `Present`.
fn witness(if_match: Option<&str>) -> Expectation {
    if_match.map_or(Expectation::Absent, |hash| {
        Expectation::Sha256(hash.to_string())
    })
}

/// `storage::put` expecting `witness(if_match)`.
fn put(
    root: &Path,
    path: &str,
    bytes: Option<&[u8]>,
    if_match: Option<&str>,
) -> Result<PutOutcome, StorageError> {
    super::put(root, path, bytes, &witness(if_match)).map(|outcome| match outcome {
        PutOutcome::Landed { .. } => PutOutcome::Landed { stamp: None },
        stale => stale,
    })
}

/// The scratch directory inside `root`.
fn scratch(root: &Path) -> PathBuf {
    scratch_directory(root)
}

/// The staged files left in `root`'s scratch directory.
fn staged(root: &Path) -> Vec<String> {
    fs::read_dir(scratch(root))
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
fn a_listing_leaves_out_git_and_epicenter_at_the_root_and_follows_no_link() {
    let (_temp, root) = folder(
        "storage-list",
        &[
            ("todos/a.md", b"first\n"),
            (".git/HEAD", b"ref: refs/heads/main\n"),
            (".epicenter/scratch/staged", b"x"),
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
    let mut children = children(&root, "").unwrap();
    children.directories.sort();
    assert_eq!(children.directories, ["empty", "todos"]);
    assert!(!children
        .files
        .iter()
        .any(|name| name.starts_with(".epicenter")));
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
    assert_eq!(read(&root, "all.bin").unwrap().bytes, bytes);
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
    for refused in ["", ".git/HEAD", "../outside.md", "todos//a.md"] {
        assert!(
            read(&root, refused).is_err_and(|error| invalid(refused)(&error)),
            "{refused:?}"
        );
    }
}

#[cfg(unix)]
#[test]
fn existing_nonportable_names_can_be_repaired_with_a_witness() {
    let (_temp, root) = folder(
        "storage-read-nonportable",
        &[("notes/.md", b"empty"), ("notes/a: b.md", b"colon")],
    );
    assert_eq!(read(&root, "notes/.md").unwrap().bytes, b"empty");
    assert_eq!(read(&root, "notes/a: b.md").unwrap().bytes, b"colon");
    assert!(put(&root, "notes/a: b.md", b(b"changed"), None)
        .is_err_and(|error| invalid("notes/a: b.md")(&error)));
    let witness = sha256(b"colon");
    assert_eq!(
        put(&root, "notes/a: b.md", b(b"repaired"), Some(&witness)).unwrap(),
        PutOutcome::Landed { stamp: None }
    );
    assert_eq!(read(&root, "notes/a: b.md").unwrap().bytes, b"repaired");
    assert_eq!(
        put(&root, "notes/a: b.md", None, Some(&sha256(b"repaired"))).unwrap(),
        PutOutcome::Landed { stamp: None }
    );
    assert_eq!(
        read(&root, "notes/a: b.md"),
        Err(StorageError::NotFound {
            path: "notes/a: b.md".into()
        })
    );
}

#[test]
fn an_existing_head_is_readable_but_never_changed() {
    let (_temp, root) = folder("storage-head-private", &[("HEAD", b"notes\n")]);
    assert_eq!(read(&root, "HEAD").unwrap().bytes, b"notes\n");
    let witness = sha256(b"notes\n");
    assert!(
        put(&root, "HEAD", b(b"ref: refs/heads/main\n"), Some(&witness))
            .is_err_and(|error| invalid("HEAD")(&error))
    );
    assert!(put(&root, "HEAD", None, Some(&witness)).is_err_and(|error| invalid("HEAD")(&error)));
    assert_eq!(read(&root, "HEAD").unwrap().bytes, b"notes\n");
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
            put(&root, path, b(b"mine"), None).is_err_and(|error| invalid(path)(&error)),
            "{path}"
        );
        assert!(
            put(&root, path, None, Some(&sha256(b"theirs")))
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
        assert!(put(&root, path, b(b"mine"), None).is_err_and(|error| invalid(path)(&error)));
        assert!(put(&root, path, None, Some(&sha256(b"theirs")))
            .is_err_and(|error| invalid(path)(&error)));
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
    assert_eq!(read(&root, "Todos/A.md").unwrap().bytes, b"theirs");
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
    assert!(put(&root, composed, b(b"mine"), None).is_err_and(|error| invalid(composed)(&error)));
    assert_eq!(read(&root, decomposed).unwrap().bytes, b"theirs");
}

#[test]
fn a_put_lands_only_on_what_the_page_expected() {
    let (_temp, root) = folder("storage-put", &[]);
    let a = root.join("todos/a.md");
    // A new file, and its missing parent, land where nothing was.
    assert_eq!(
        put(&root, "todos/a.md", b(b"first"), None),
        Ok(PutOutcome::Landed { stamp: None })
    );
    assert_eq!(fs::read(&a).unwrap(), b"first");
    // A create over the file is stale, and so is another hash.
    assert_eq!(
        put(&root, "todos/a.md", b(b"again"), None),
        Ok(PutOutcome::Stale)
    );
    assert_eq!(
        put(&root, "todos/a.md", b(b"mine"), Some(&sha256(b"other"))),
        Ok(PutOutcome::Stale)
    );
    assert_eq!(fs::read(&a).unwrap(), b"first");
    // The hash of what is there lands.
    assert_eq!(
        put(&root, "todos/a.md", b(b"second"), Some(&sha256(b"first"))),
        Ok(PutOutcome::Landed { stamp: None })
    );
    assert_eq!(fs::read(&a).unwrap(), b"second");
    // A guarded replacement of a missing file is stale.
    assert_eq!(
        put(&root, "todos/b.md", b(b"b"), Some(&sha256(b"second"))),
        Ok(PutOutcome::Stale)
    );
    assert!(!root.join("todos/b.md").exists());
    // Removal: only the expected bytes, and only a file.
    assert_eq!(put(&root, "todos/a.md", None, None), Ok(PutOutcome::Stale));
    assert_eq!(
        put(&root, "todos/a.md", None, Some(&sha256(b"other"))),
        Ok(PutOutcome::Stale)
    );
    assert!(a.exists());
    assert_eq!(
        put(&root, "todos/a.md", None, Some(&sha256(b"second"))),
        Ok(PutOutcome::Landed { stamp: None })
    );
    assert!(!a.exists());
    // Nothing there is what a removal expecting nothing wants.
    assert_eq!(
        put(&root, "todos/a.md", None, None),
        Ok(PutOutcome::Landed { stamp: None })
    );
    assert_eq!(
        put(&root, "todos/a.md", None, Some(&sha256(b"second"))),
        Ok(PutOutcome::Stale)
    );
    assert!(staged(&root).is_empty());
}

#[test]
fn a_put_is_refused_where_no_file_can_be() {
    let (_temp, root) = folder("storage-put-refused", &[("todos/a.md", b"a")]);
    assert_eq!(
        put(&root, "todos", b(b"x"), None),
        Err(StorageError::NotAFile {
            path: "todos".into()
        })
    );
    assert_eq!(
        put(&root, "todos/a.md/b.md", b(b"x"), None),
        Err(StorageError::NotADirectory {
            path: "todos/a.md".into()
        })
    );
    // A removal below a file finds nothing there.
    assert_eq!(
        put(&root, "todos/a.md/b.md", None, None),
        Ok(PutOutcome::Landed { stamp: None })
    );
    for refused in [".git/config", "HEAD", "todos/a.md.", ""] {
        assert!(
            put(&root, refused, b(b"x"), None).is_err_and(|error| invalid(refused)(&error)),
            "{refused:?}"
        );
    }
    assert!(!root.join(".git/config").exists());
    assert!(staged(&root).is_empty());
}

/// The names directly in `directory`, sorted.
fn names(directory: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

/// A folder needs no Git to save: a put stages inside the root, in
/// `.epicenter/scratch`, the directory the Bun host stages in. Nothing is
/// made beside the root, and the root holds only what was saved and
/// `.epicenter`, which no listing shows.
#[test]
fn a_folder_with_no_git_saves_and_stages_inside_the_root() {
    let (temp, root) = folder("storage-no-git", &[("readme.txt", b"plain\n")]);
    assert_eq!(scratch(&root), root.join(".epicenter/scratch"));
    assert_eq!(
        put(&root, "todos/a.md", b(b"milk"), None),
        Ok(PutOutcome::Landed { stamp: None })
    );
    assert_eq!(
        put(&root, "todos/a.md", b(b"eggs"), Some(&sha256(b"milk"))),
        Ok(PutOutcome::Landed { stamp: None })
    );
    assert_eq!(
        put(&root, "readme.txt", None, Some(&sha256(b"plain\n"))),
        Ok(PutOutcome::Landed { stamp: None })
    );
    assert_eq!(fs::read(root.join("todos/a.md")).unwrap(), b"eggs");
    assert_eq!(names(&root), [".epicenter", "todos"]);
    assert_eq!(names(temp.path()), ["notes"]);
    assert!(scratch(&root).is_dir());
    assert!(staged(&root).is_empty());
    assert_eq!(list(&root).unwrap().directories, ["todos"]);
}

/// A `.git` file (a linked worktree or submodule) and a `.git` link are left
/// as they are: a put lands, writes nothing through them, and makes nothing
/// in `.git`.
#[test]
fn a_git_file_or_link_is_left_as_it_is_and_saves_land() {
    let gitdir = b"gitdir: /elsewhere/.git/worktrees/notes\n";
    let (_temp, root) = folder("storage-git-file", &[(".git", gitdir)]);
    assert_eq!(
        put(&root, "todos/a.md", b(b"milk"), None),
        Ok(PutOutcome::Landed { stamp: None })
    );
    assert_eq!(fs::read(root.join(".git")).unwrap(), gitdir);
    assert_eq!(names(&root), [".epicenter", ".git", "todos"]);
    assert!(staged(&root).is_empty());
    #[cfg(unix)]
    {
        let (temp, root) = folder("storage-git-link", &[]);
        let repository = temp.folder("repository");
        std::os::unix::fs::symlink(&repository, root.join(".git")).unwrap();
        assert_eq!(
            put(&root, "todos/a.md", b(b"milk"), None),
            Ok(PutOutcome::Landed { stamp: None })
        );
        assert!(fs::symlink_metadata(root.join(".git"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(
            names(&repository).is_empty(),
            "nothing was written through the link"
        );
        assert!(staged(&root).is_empty());
    }
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
        put(&root, "todos/a.md", b(b"mine"), Some(&sha256(b"theirs"))),
        Ok(PutOutcome::Landed { stamp: None })
    );
    assert_eq!(fs::read(&outside).unwrap(), b"theirs");
    assert_eq!(fs::read(root.join("todos/a.md")).unwrap(), b"mine");
}

#[cfg(unix)]
#[test]
fn replacing_a_file_keeps_its_permission_bits() {
    use std::os::unix::fs::PermissionsExt;
    let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
    let (_temp, root) = folder(
        "storage-mode",
        &[
            ("private.md", b"one"),
            ("tool.sh", b"#!/bin/sh"),
            ("plain.md", b"p"),
        ],
    );
    for (path, bits) in [
        ("private.md", 0o600),
        ("tool.sh", 0o750),
        ("plain.md", 0o644),
    ] {
        fs::set_permissions(root.join(path), fs::Permissions::from_mode(bits)).unwrap();
    }
    // A stale put changes nothing, mode included.
    assert_eq!(
        put(&root, "private.md", b(b"x"), Some(&sha256(b"other"))),
        Ok(PutOutcome::Stale)
    );
    assert_eq!(mode(&root.join("private.md")), 0o600);
    // A guarded replacement keeps what the file had, not the umask's.
    for (path, old, new, bits) in [
        ("private.md", &b"one"[..], &b"two"[..], 0o600),
        ("tool.sh", &b"#!/bin/sh"[..], &b"#!/bin/bash"[..], 0o750),
        ("plain.md", &b"p"[..], &b"q"[..], 0o644),
    ] {
        assert_eq!(
            put(&root, path, b(new), Some(&sha256(old))),
            Ok(PutOutcome::Landed { stamp: None })
        );
        assert_eq!(fs::read(root.join(path)).unwrap(), new);
        assert_eq!(mode(&root.join(path)), bits, "{path}");
    }
    // A new file keeps the staged file's mode: its owner's alone.
    assert_eq!(
        put(&root, "fresh.md", b(b"new"), None),
        Ok(PutOutcome::Landed { stamp: None })
    );
    assert_eq!(mode(&root.join("fresh.md")), 0o600);
    assert!(staged(&root).is_empty());
}

/// A scratch directory made `0755` is `0700` before anything is staged in
/// it, and the save that lands keeps the replaced file's `0644`.
#[cfg(unix)]
#[test]
fn an_open_scratch_directory_is_made_private_before_staging() {
    use std::os::unix::fs::PermissionsExt;
    let mode = |path: &Path| fs::symlink_metadata(path).unwrap().permissions().mode() & 0o777;
    let (_temp, root) = folder("storage-private", &[("shared.md", b"old")]);
    fs::set_permissions(root.join("shared.md"), fs::Permissions::from_mode(0o644)).unwrap();
    fs::create_dir_all(scratch(&root)).unwrap();
    fs::set_permissions(scratch(&root), fs::Permissions::from_mode(0o755)).unwrap();

    assert_eq!(
        put(&root, "shared.md", b(b"new"), Some(&sha256(b"old"))),
        Ok(PutOutcome::Landed { stamp: None })
    );
    assert_eq!(fs::read(root.join("shared.md")).unwrap(), b"new");
    assert_eq!(mode(&root.join("shared.md")), 0o644);
    assert_eq!(mode(&scratch(&root)), 0o700);
    assert!(staged(&root).is_empty());
}

/// A missing scratch directory is made `0700`.
#[cfg(unix)]
#[test]
fn a_new_scratch_directory_is_private() {
    use std::os::unix::fs::PermissionsExt;
    let (_temp, root) = folder("storage-private-new", &[]);
    assert_eq!(
        put(&root, "a.md", b(b"a"), None),
        Ok(PutOutcome::Landed { stamp: None })
    );
    let made = fs::symlink_metadata(scratch(&root)).unwrap();
    assert_eq!(made.permissions().mode() & 0o777, 0o700);
}

/// The access control entries `ls` lists on `path`, which it does not
/// follow: one line each after the entry's own.
#[cfg(target_os = "macos")]
fn acl(path: &Path) -> Vec<String> {
    let listed = std::process::Command::new("/bin/ls")
        .arg("-ldeq")
        .arg(path)
        .env("LC_ALL", "C")
        .output()
        .unwrap();
    assert!(listed.status.success(), "{listed:?}");
    String::from_utf8(listed.stdout)
        .unwrap()
        .lines()
        .skip(1)
        .filter(|line| {
            line.trim_start()
                .split_once(": ")
                .is_some_and(|(index, _)| index.bytes().all(|byte| byte.is_ascii_digit()))
        })
        .map(str::to_string)
        .collect()
}

/// Give `directory` an entry that lets every account list and read what is
/// made in it from now on, as a shared parent can.
#[cfg(target_os = "macos")]
fn share_with_everyone(directory: &Path) {
    let status = std::process::Command::new("/bin/chmod")
        .args([
            "+a",
            "everyone allow list,search,read,file_inherit,directory_inherit",
        ])
        .arg(directory)
        .status()
        .unwrap();
    assert!(status.success());
}

/// A parent that passes `everyone allow read` on makes a `0700` scratch
/// directory and a `0600` staged file readable by every account. Neither
/// keeps the entry: a new file, which is its staged file renamed, lands
/// `0600` with no entry, and the scratch directory has none.
#[cfg(target_os = "macos")]
#[test]
fn staged_bytes_keep_no_acl_the_parent_passes_on() {
    use std::os::unix::fs::PermissionsExt;
    let mode = |path: &Path| fs::symlink_metadata(path).unwrap().permissions().mode() & 0o777;
    let (_temp, root) = folder("storage-private-acl", &[]);
    share_with_everyone(&root);
    // The root passes it on, as it would to `.epicenter` and its scratch
    // directory.
    let probe = root.join("probe");
    fs::create_dir(&probe).unwrap();
    assert!(acl(&probe)
        .iter()
        .any(|entry| entry.contains("everyone inherited allow")));

    assert_eq!(
        put(&root, "fresh.md", b(b"secret"), None),
        Ok(PutOutcome::Landed { stamp: None })
    );
    assert_eq!(fs::read(root.join("fresh.md")).unwrap(), b"secret");
    assert_eq!(
        (mode(&root.join("fresh.md")), acl(&root.join("fresh.md"))),
        (0o600, vec![])
    );
    assert_eq!(
        (mode(&scratch(&root)), acl(&scratch(&root))),
        (0o700, vec![])
    );
    assert!(staged(&root).is_empty());
}

/// A scratch directory whose entry cannot be removed (here it is locked
/// with the user immutable flag) refuses a put as `Io` before anything is
/// staged, and the file at the path stays as it was.
#[cfg(target_os = "macos")]
#[test]
fn a_scratch_directory_whose_acl_stays_refuses_a_put() {
    use std::os::unix::fs::PermissionsExt;
    let chflags = |flag: &str, path: &Path| {
        let status = std::process::Command::new("/usr/bin/chflags")
            .arg(flag)
            .arg(path)
            .status()
            .unwrap();
        assert!(status.success());
    };
    let (_temp, root) = folder("storage-acl-stays", &[("a.md", b"accepted")]);
    share_with_everyone(&root);
    let scratch = scratch(&root);
    fs::create_dir_all(&scratch).unwrap();
    fs::set_permissions(&scratch, fs::Permissions::from_mode(0o700)).unwrap();
    chflags("uchg", &scratch);
    let refused = put(&root, "a.md", b(b"mine"), Some(&sha256(b"accepted")));
    chflags("nouchg", &scratch);
    let Err(StorageError::Io { message, .. }) = &refused else {
        panic!("{refused:?}");
    };
    assert!(message.contains("could not be made private"), "{message}");
    assert_eq!(fs::read(root.join("a.md")).unwrap(), b"accepted");
    assert!(staged(&root).is_empty());
    assert!(!acl(&scratch).is_empty());
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
    let (temp, root) = folder("storage-sweep", &[]);
    let scratch = scratch(&root);
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
    let mut expected = vec![young, "foreign".to_string(), old_directory];
    // A link named as an old staged file is not one, and what it reaches
    // stays.
    #[cfg(unix)]
    {
        let target = temp.path().join("target.md");
        fs::write(&target, b"theirs").unwrap();
        let old_link = scratch_name(now - 2 * hour);
        std::os::unix::fs::symlink(&target, scratch.join(&old_link)).unwrap();
        expected.push(old_link);
    }
    sweep_scratch(&root, now);
    let mut left = staged(&root);
    left.sort();
    expected.sort();
    assert_eq!(left, expected);
    #[cfg(unix)]
    assert_eq!(fs::read(temp.path().join("target.md")).unwrap(), b"theirs");
    // A folder with nothing staged sweeps nothing, and makes nothing.
    let (other, empty) = folder("storage-sweep-empty", &[]);
    sweep_scratch(&empty, now);
    assert_eq!(names(other.path()), ["notes"]);
    assert!(names(&empty).is_empty());
}

/// A scratch directory that is a link is never followed: nothing is staged
/// through it or swept through it, the directory it names keeps its mode, a
/// put is `Io`, and the file at the path stays as it was.
#[cfg(unix)]
#[test]
fn a_linked_scratch_directory_is_not_swept_or_staged_in() {
    use std::os::unix::fs::PermissionsExt;
    let (temp, root) = folder("storage-sweep-link", &[("a.md", b"accepted")]);
    let elsewhere = temp.folder("elsewhere");
    fs::set_permissions(&elsewhere, fs::Permissions::from_mode(0o755)).unwrap();
    let old = scratch_name(1);
    fs::write(elsewhere.join(&old), b"theirs").unwrap();
    fs::create_dir(root.join(".epicenter")).unwrap();
    std::os::unix::fs::symlink(&elsewhere, scratch(&root)).unwrap();
    sweep_scratch(&root, now_ms());
    assert!(elsewhere.join(&old).exists());
    for (path, if_match) in [("a.md", Some(sha256(b"accepted"))), ("b.md", None)] {
        let refused = put(&root, path, b(b"mine"), if_match.as_deref()).unwrap_err();
        let StorageError::Io { message, .. } = &refused else {
            panic!("{refused:?}");
        };
        assert!(message.contains("symbolic link"), "{message}");
    }
    assert_eq!(fs::read(root.join("a.md")).unwrap(), b"accepted");
    assert!(!root.join("b.md").exists());
    assert_eq!(names(&elsewhere), [old]);
    assert_eq!(
        fs::metadata(&elsewhere).unwrap().permissions().mode() & 0o777,
        0o755
    );
    // A removal stages nothing, so it still lands.
    assert_eq!(
        put(&root, "a.md", None, Some(&sha256(b"accepted"))),
        Ok(PutOutcome::Landed { stamp: None })
    );
}

/// A file where the scratch directory would be refuses a put as `Io`, and
/// it and the file at the path stay as they were.
#[test]
fn a_scratch_path_that_is_not_a_directory_refuses_a_put() {
    let (_temp, root) = folder("storage-scratch-file", &[("a.md", b"accepted")]);
    fs::create_dir(root.join(".epicenter")).unwrap();
    fs::write(scratch(&root), b"someone's file").unwrap();
    let refused = put(&root, "a.md", b(b"mine"), Some(&sha256(b"accepted"))).unwrap_err();
    let StorageError::Io {
        path,
        operation,
        message,
    } = &refused
    else {
        panic!("{refused:?}");
    };
    assert_eq!((path.as_str(), operation.as_str()), ("a.md", "write"));
    assert!(message.contains("not a directory"), "{message}");
    sweep_scratch(&root, now_ms());
    assert_eq!(fs::read(scratch(&root)).unwrap(), b"someone's file");
    assert_eq!(fs::read(root.join("a.md")).unwrap(), b"accepted");
}

/// A link at `.epicenter` is never followed: nothing is staged or swept
/// through it, a put is `Io`, and the file at the path stays as it was.
#[cfg(unix)]
#[test]
fn a_linked_state_directory_is_not_swept_or_staged_in() {
    let (temp, root) = folder("storage-state-link", &[("a.md", b"accepted")]);
    let elsewhere = temp.folder("elsewhere");
    fs::create_dir(elsewhere.join("scratch")).unwrap();
    let old = scratch_name(1);
    fs::write(elsewhere.join("scratch").join(&old), b"theirs").unwrap();
    std::os::unix::fs::symlink(&elsewhere, root.join(".epicenter")).unwrap();
    sweep_scratch(&root, now_ms());
    assert!(elsewhere.join("scratch").join(&old).exists());
    let refused = put(&root, "b.md", b(b"mine"), None).unwrap_err();
    let StorageError::Io { message, .. } = &refused else {
        panic!("{refused:?}");
    };
    assert!(message.contains("symbolic link"), "{message}");
    assert!(!root.join("b.md").exists());
    assert_eq!(names(&elsewhere.join("scratch")), [old]);
}

/// A put that does not land leaves no directory it made.
#[test]
fn a_put_that_does_not_land_leaves_no_new_directory() {
    let (_temp, root) = folder("storage-no-new-directory", &[("old.md", b"old")]);
    assert_eq!(
        put(&root, "new/deep/a.md", b(b"x"), Some(&sha256(b"old"))),
        Ok(PutOutcome::Stale)
    );
    assert!(!root.join("new").exists());
    // A directory another writer filled meanwhile stays.
    let made = make_parents(&root, &["kept", "deep"]).unwrap();
    fs::write(root.join("kept/other.md"), b"theirs").unwrap();
    remove_made(&made);
    assert!(!root.join("kept/deep").exists());
    assert!(root.join("kept/other.md").exists());
    assert!(staged(&root).is_empty());
}

/// The vectors `storage-outcomes.test.ts` in `@epicenter/folder` runs over
/// the Bun directory storage, run here over the shell's.
#[test]
fn storage_follows_the_shared_outcomes() {
    use serde_json::{json, Value};
    let vectors: Value =
        serde_json::from_str(include_str!("../../fixtures/storage-outcomes.json")).unwrap();
    let cases = vectors["cases"].as_array().unwrap();
    assert!(cases.len() >= 30, "the fixture holds the cases");
    let text = |value: &Value| value.as_str().map(str::to_string);
    let mut ran = 0;
    for (index, case) in cases.iter().enumerate() {
        let name = case["name"].as_str().unwrap();
        let temp = TempDir::new(&format!("storage-outcome-{index}"));
        let root = temp.folder("root");
        let outside = temp.folder("outside");
        fs::write(outside.join("secret.md"), b"secret").unwrap();
        match case["requires"].as_str() {
            Some("caseInsensitive") if !ignores_case(&root) => continue,
            #[cfg(not(unix))]
            Some("links" | "nonportableNames") => continue,
            _ => {}
        }
        let tree = &case["tree"];
        for directory in tree["directories"].as_array().into_iter().flatten() {
            fs::create_dir_all(root.join(directory.as_str().unwrap())).unwrap();
        }
        for (path, content) in tree["files"].as_object().into_iter().flatten() {
            let target = root.join(path);
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            fs::write(target, content.as_str().unwrap()).unwrap();
        }
        #[cfg(unix)]
        for (path, target) in tree["links"].as_object().into_iter().flatten() {
            std::os::unix::fs::symlink(target.as_str().unwrap(), root.join(path)).unwrap();
        }
        let call = &case["call"];
        let path = call["path"].as_str().unwrap_or_default();
        let expected = match &call["expected"] {
            Value::String(kind) => Expectation::parse(kind).unwrap(),
            Value::Object(file) => {
                Expectation::Sha256(sha256(file["sha256Of"].as_str().unwrap().as_bytes()))
            }
            _ => Expectation::Absent,
        };
        let answer: Result<Value, StorageError> = match call["method"].as_str().unwrap() {
            "read" => read(&root, path)
                .map(|read| json!({ "text": String::from_utf8(read.bytes).unwrap() })),
            "put" => {
                let bytes = text(&call["bytes"]);
                super::put(&root, path, bytes.as_deref().map(str::as_bytes), &expected).map(
                    |outcome| {
                        json!(match outcome {
                            PutOutcome::Landed { .. } => "landed",
                            PutOutcome::Stale => "stale",
                        })
                    },
                )
            }
            "mkdir" => mkdir(&root, path).map(|()| Value::Null),
            "rmdir" => rmdir(&root, path).map(|()| Value::Null),
            "children" => children(&root, path).map(|mut found| {
                found.files.sort();
                found.directories.sort();
                json!(found)
            }),
            "list" => list(&root).map(|mut listing| {
                listing.files.sort_by(|a, b| a.path.cmp(&b.path));
                listing.directories.sort();
                json!({
                    "files": listing.files.iter().map(|file| json!({
                        "path": file.path,
                        "size": file.size,
                    })).collect::<Vec<_>>(),
                    "directories": listing.directories,
                })
            }),
            other => panic!("{name}: no method {other}"),
        };
        let expected = &case["expect"];
        match answer {
            Ok(value) => assert_eq!(&value, &expected["value"], "{name}"),
            Err(error) => {
                let error = json!(error);
                let wanted = &expected["error"];
                assert!(wanted.is_object(), "{name}: {error}");
                for (field, want) in wanted.as_object().unwrap() {
                    assert_eq!(&error[field], want, "{name}: {error}");
                }
            }
        }
        let after = &case["after"];
        for (path, content) in after["files"].as_object().into_iter().flatten() {
            assert_eq!(
                fs::read_to_string(root.join(path)).ok().as_deref(),
                content.as_str(),
                "{name}: {path}"
            );
        }
        for path in after["absent"].as_array().into_iter().flatten() {
            let path = path.as_str().unwrap();
            assert!(
                fs::symlink_metadata(root.join(path)).is_err(),
                "{name}: {path}"
            );
        }
        assert!(staged(&root).is_empty(), "{name}: a staged file was left");
        ran += 1;
    }
    assert!(ran >= 25, "only {ran} cases ran");
}

#[test]
fn listing_tolerates_subdirectories_removed_during_its_walk_but_not_a_missing_root() {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    let (_temp, root) = folder("listing-churn", &[("keep.md", b"kept")]);
    for n in 0..200 {
        fs::create_dir(root.join(format!("d{n}"))).unwrap();
    }
    let stopped = Arc::new(AtomicBool::new(false));
    let removing = stopped.clone();
    let changing = root.clone();
    let worker = std::thread::spawn(move || {
        while !removing.load(Ordering::Relaxed) {
            for n in 0..200 {
                let at = changing.join(format!("d{n}"));
                fs::remove_dir(&at).unwrap();
                fs::create_dir(&at).unwrap();
            }
        }
    });
    let results: Vec<_> = (0..100).map(|_| list(&root)).collect();
    stopped.store(true, Ordering::Relaxed);
    worker.join().unwrap();
    for result in results {
        assert!(result
            .unwrap()
            .files
            .iter()
            .any(|file| file.path == "keep.md"));
    }
    fs::remove_dir_all(&root).unwrap();
    assert!(list(&root).is_err());
}
