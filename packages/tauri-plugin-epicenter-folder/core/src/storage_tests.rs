//! A page's storage over a real directory.
//!
//! Key behaviors:
//! - A listing leaves out `.git` and an older build's `.epicenter` at the
//!   root and every reserved name at any depth, lists other hidden files,
//!   and follows no link; a link is a file to it.
//! - A path through a link, or naming one, is refused as `InvalidPath`; a
//!   name stored under another spelling is absent to a read and refused to
//!   a change, on a disk that ignores case or normalization.
//! - A put lands only on what the page expected and is otherwise `Stale`,
//!   changing nothing; `None` bytes remove the file; no staged file outlives
//!   a put.
//! - Of puts racing in one process, over one version or creating one path,
//!   exactly one lands; a path holds no turn once its puts finish.
//! - A staged file is placed only where nothing is (`place`): whatever
//!   appeared after a check stays, by the exclusive rename and by the hard
//!   link it falls back to; and a link move cut off after its link is
//!   placed.
//! - A put stages beside its target under a reserved name, makes nothing
//!   next to the root and nothing in it but what was saved, and makes and
//!   changes nothing in `.git`: a folder with no `.git`, or with a `.git`
//!   file or link, saves alike. A put of a reserved name is refused.
//! - On Unix each staged file is `0600`. A replaced file keeps its mode; a
//!   new one is `0600`.
//! - A directory is made with its ancestors and removed only when empty.

use std::fs;
use std::path::{Path, PathBuf};

use super::*;
use crate::testing::TempDir;

fn blob(bytes: &[u8]) -> String {
    crate::blob::blob_id(bytes)
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
fn an_expectation_is_parsed_by_its_own_spelling() {
    let hash = blob(b"x");
    assert_eq!(Expectation::parse("absent"), Ok(Expectation::Absent));
    assert_eq!(
        Expectation::parse(&format!("blob:{hash}")),
        Ok(Expectation::Blob(hash.clone()))
    );
    for refused in [
        hash.clone(),
        "blob:absent".to_string(),
        format!("blob:{}", hash.to_uppercase()),
        format!("sha256:{hash}"),
        "anything".to_string(),
        "present".to_string(),
        String::new(),
    ] {
        assert!(Expectation::parse(&refused).is_err(), "{refused:?}");
    }
}

#[test]
fn list_and_read_report_the_same_stamp_and_a_write_changes_it() {
    let (_temp, root) = folder("storage-stamp", &[("note.txt", b"old")]);
    let initial = list(&root, &[String::new()]).unwrap()[0].version.clone();
    assert_eq!(read(&root, "note.txt").unwrap().stamp, initial);

    let landed = put(&root, "note.txt", b(b"new"), Some(&blob(b"old"))).unwrap();
    assert_eq!(landed, PutOutcome::Landed);
    let published = list(&root, &[String::new()]).unwrap()[0].version.clone();
    assert_ne!(published, initial);
    assert_eq!(read(&root, "note.txt").unwrap().stamp, published);
}

#[test]
fn an_attachment_is_named_by_the_stamp_that_landed_and_written_over_it() {
    let (_temp, root) = folder("storage-landing", &[("todos/a.md", b"note")]);
    let Landing::Landed(stamp) = put_landing(&root, "audio.webm", b(b"one"), &Expectation::Absent).unwrap() else {
        panic!("a create lands");
    };
    let listing = list(&root, &["audio.webm".to_string(), "todos".to_string()]).unwrap();
    let version = |path: &str| {
        listing
            .iter()
            .find(|file| file.path == path)
            .map(|file| file.version.clone())
            .unwrap()
    };
    assert_eq!(version("audio.webm"), stamp);
    assert_eq!(version("todos/a.md"), blob(b"note"));
    assert_eq!(read(&root, "audio.webm").unwrap().stamp, stamp);
    let over = Expectation::parse(&format!("stamp:{stamp}")).unwrap();
    assert!(matches!(
        put_landing(&root, "audio.webm", b(b"two"), &over).unwrap(),
        Landing::Landed(next) if next != stamp
    ));
    assert_eq!(
        put_landing(&root, "audio.webm", b(b"three"), &over).unwrap(),
        Landing::Stale
    );
    assert_eq!(fs::read(root.join("audio.webm")).unwrap(), b"two");
}

#[test]
fn a_write_expecting_any_replaces_whatever_is_there() {
    let (_temp, root) = folder("storage-any", &[("models.md", b"old")]);
    let any = Expectation::parse("any").unwrap();
    assert_eq!(super::put(&root, "models.md", b(b"new"), &any).unwrap(), PutOutcome::Landed);
    assert_eq!(fs::read(root.join("models.md")).unwrap(), b"new");
    assert_eq!(super::put(&root, "fresh.md", b(b"made"), &any).unwrap(), PutOutcome::Landed);
    assert_eq!(fs::read(root.join("fresh.md")).unwrap(), b"made");
    assert_eq!(super::put(&root, "fresh.md", None, &any).unwrap(), PutOutcome::Landed);
    assert!(!root.join("fresh.md").exists());
    assert_eq!(super::put(&root, "fresh.md", None, &any).unwrap(), PutOutcome::Landed);
}

/// What most cases here expect: the file whose Git blob id is `if_match`, or
/// nothing for `None`.
fn witness(if_match: Option<&str>) -> Expectation {
    if_match.map_or(Expectation::Absent, |hash| {
        Expectation::Blob(hash.to_string())
    })
}

/// `storage::put` expecting `witness(if_match)`.
fn put(
    root: &Path,
    path: &str,
    bytes: Option<&[u8]>,
    if_match: Option<&str>,
) -> Result<PutOutcome, StorageError> {
    super::put(root, path, bytes, &witness(if_match))
}

/// The staged saves left anywhere in `root`, by folder-relative path.
fn staged(root: &Path) -> Vec<String> {
    fn visit(directory: &Path, prefix: &str, found: &mut Vec<String>) {
        let Ok(entries) = fs::read_dir(directory) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if entry.file_type().unwrap().is_dir() {
                visit(&entry.path(), &format!("{prefix}{name}/"), found);
            } else if state::is_staged_save(&name) {
                found.push(format!("{prefix}{name}"));
            }
        }
    }
    let mut found = Vec::new();
    visit(root, "", &mut found);
    found
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

/// Hidden files are listed: whoever reads a listing skips them. Git's own
/// directory, what an older build left in `.epicenter`, and a write in
/// progress are left out, the last at any depth and even when asked for.
#[test]
fn a_listing_leaves_out_git_epicenter_and_reserved_names_and_links_and_lists_hidden_files() {
    let (_temp, root) = folder(
        "storage-list",
        &[
            ("todos/a.md", b"first\n"),
            (".git/HEAD", b"ref: refs/heads/main\n"),
            (".epicenter/synced.json", b"{}"),
            (".ep-0123456789abcdef.save", b"x"),
            ("todos/.ep-k3j9x2ab-take.recording", b"audio"),
            ("todos/.ep-x.saved", b"x"),
            ("todos/.DS_Store", b"x"),
            ("kv.json", b"{}"),
        ],
    );
    fs::create_dir_all(root.join("empty")).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(root.join("todos"), root.join("linked")).unwrap();
    let mut listing = list(&root, &[String::new()]).unwrap();
    listing.sort_by(|a, b| a.path.cmp(&b.path));
    let files = vec![
        "kv.json",
        "todos/.DS_Store",
        "todos/.ep-x.saved",
        "todos/a.md",
    ];
    assert_eq!(
        listing
            .iter()
            .map(|file| file.path.as_str())
            .collect::<Vec<_>>(),
        files
    );
    let asked = list(
        &root,
        &[
            "todos/.ep-k3j9x2ab-take.recording".to_string(),
            ".ep-0123456789abcdef.save".to_string(),
        ],
    )
    .unwrap();
    assert!(asked.is_empty(), "{asked:?}");
}

/// A reserved name is a save or a recording in progress, never the page's:
/// a put of one is refused and changes nothing.
#[test]
fn a_put_of_a_reserved_name_is_refused() {
    let pending = "todos/.ep-k3j9x2ab-take.recording";
    let (_temp, root) = folder("storage-reserved", &[(pending, b"audio")]);
    for path in [pending, ".ep-0123456789abcdef.save"] {
        assert!(
            put(&root, path, b(b"mine"), None).is_err_and(|error| invalid(path)(&error)),
            "{path}"
        );
        assert!(
            super::put(&root, path, None, &Expectation::Any)
                .is_err_and(|error| invalid(path)(&error)),
            "{path}"
        );
    }
    assert_eq!(fs::read(root.join(pending)).unwrap(), b"audio");
    assert!(!root.join(".ep-0123456789abcdef.save").exists());
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
    let witness = blob(b"colon");
    assert_eq!(
        put(&root, "notes/a: b.md", b(b"repaired"), Some(&witness)).unwrap(),
        PutOutcome::Landed
    );
    assert_eq!(read(&root, "notes/a: b.md").unwrap().bytes, b"repaired");
    assert_eq!(
        put(&root, "notes/a: b.md", None, Some(&blob(b"repaired"))).unwrap(),
        PutOutcome::Landed
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
    let witness = blob(b"notes\n");
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
            put(&root, path, None, Some(&blob(b"theirs")))
                .is_err_and(|error| invalid(path)(&error)),
            "{path}"
        );
    }
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
        assert!(put(&root, path, None, Some(&blob(b"theirs")))
            .is_err_and(|error| invalid(path)(&error)));
    }
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
        Ok(PutOutcome::Landed)
    );
    assert_eq!(fs::read(&a).unwrap(), b"first");
    // A create over the file is stale, and so is another hash.
    assert_eq!(
        put(&root, "todos/a.md", b(b"again"), None),
        Ok(PutOutcome::Stale)
    );
    assert_eq!(
        put(&root, "todos/a.md", b(b"mine"), Some(&blob(b"other"))),
        Ok(PutOutcome::Stale)
    );
    assert_eq!(fs::read(&a).unwrap(), b"first");
    // The hash of what is there lands.
    assert_eq!(
        put(&root, "todos/a.md", b(b"second"), Some(&blob(b"first"))),
        Ok(PutOutcome::Landed)
    );
    assert_eq!(fs::read(&a).unwrap(), b"second");
    // A guarded replacement of a missing file is stale.
    assert_eq!(
        put(&root, "todos/b.md", b(b"b"), Some(&blob(b"second"))),
        Ok(PutOutcome::Stale)
    );
    assert!(!root.join("todos/b.md").exists());
    // Removal: only the expected bytes, and only a file.
    assert_eq!(put(&root, "todos/a.md", None, None), Ok(PutOutcome::Stale));
    assert_eq!(
        put(&root, "todos/a.md", None, Some(&blob(b"other"))),
        Ok(PutOutcome::Stale)
    );
    assert!(a.exists());
    assert_eq!(
        put(&root, "todos/a.md", None, Some(&blob(b"second"))),
        Ok(PutOutcome::Landed)
    );
    assert!(!a.exists());
    // Nothing there is what a removal expecting nothing wants.
    assert_eq!(put(&root, "todos/a.md", None, None), Ok(PutOutcome::Landed));
    assert_eq!(
        put(&root, "todos/a.md", None, Some(&blob(b"second"))),
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
        Ok(PutOutcome::Landed)
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

/// A folder needs no Git to save: a put stages beside its target. Nothing
/// is made beside the root, and the root holds only what was saved.
#[test]
fn a_folder_with_no_git_saves_and_holds_only_what_was_saved() {
    let (temp, root) = folder("storage-no-git", &[("readme.txt", b"plain\n")]);
    assert_eq!(
        put(&root, "todos/a.md", b(b"milk"), None),
        Ok(PutOutcome::Landed)
    );
    assert_eq!(
        put(&root, "todos/a.md", b(b"eggs"), Some(&blob(b"milk"))),
        Ok(PutOutcome::Landed)
    );
    assert_eq!(
        put(&root, "readme.txt", None, Some(&blob(b"plain\n"))),
        Ok(PutOutcome::Landed)
    );
    assert_eq!(fs::read(root.join("todos/a.md")).unwrap(), b"eggs");
    assert_eq!(names(&root), ["todos"]);
    assert_eq!(names(&root.join("todos")), ["a.md"]);
    assert_eq!(names(temp.path()), ["notes"]);
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
        Ok(PutOutcome::Landed)
    );
    assert_eq!(fs::read(root.join(".git")).unwrap(), gitdir);
    assert_eq!(names(&root), [".git", "todos"]);
    assert!(staged(&root).is_empty());
    #[cfg(unix)]
    {
        let (temp, root) = folder("storage-git-link", &[]);
        let repository = temp.folder("repository");
        std::os::unix::fs::symlink(&repository, root.join(".git")).unwrap();
        assert_eq!(
            put(&root, "todos/a.md", b(b"milk"), None),
            Ok(PutOutcome::Landed)
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
        put(&root, "todos/a.md", b(b"mine"), Some(&blob(b"theirs"))),
        Ok(PutOutcome::Landed)
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
        put(&root, "private.md", b(b"x"), Some(&blob(b"other"))),
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
            put(&root, path, b(new), Some(&blob(old))),
            Ok(PutOutcome::Landed)
        );
        assert_eq!(fs::read(root.join(path)).unwrap(), new);
        assert_eq!(mode(&root.join(path)), bits, "{path}");
    }
    // A new file keeps the staged file's mode: its owner's alone.
    assert_eq!(
        put(&root, "fresh.md", b(b"new"), None),
        Ok(PutOutcome::Landed)
    );
    assert_eq!(mode(&root.join("fresh.md")), 0o600);
    assert!(staged(&root).is_empty());
}

#[test]
fn the_hash_is_the_one_the_page_computes() {
    assert_eq!(blob(b""), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    // A file is named as its bytes are.
    let bytes: Vec<u8> = (0..200_000u32).map(|n| (n % 251) as u8).collect();
    let (_temp, root) = folder("storage-hash", &[("big.bin", &bytes)]);
    assert_eq!(
        crate::blob::file_blob_id(&root.join("big.bin")).unwrap(),
        blob(&bytes)
    );
}

/// A staged file `put` or the recorder made beside its target, and the
/// target it is placed at in the root.
fn staged_and_target(label: &str) -> (TempDir, PathBuf, PathBuf) {
    let (temp, root) = folder(label, &[]);
    let (staged, mut file) = create_staged(&root).unwrap();
    file.write_all(b"mine").unwrap();
    (temp, staged, root.join("a.md"))
}

/// `place`, and the hard link it falls back to where the disk has no
/// exclusive rename, each named for a failure message.
const PLACES: [(&str, fn(&Path, &Path) -> io::Result<()>); 2] =
    [("place", place), ("place_by_link", place_by_link)];

#[test]
fn a_placed_file_appears_whole_and_its_staged_name_is_gone() {
    for (name, place) in PLACES {
        let (_temp, staged, target) = staged_and_target("place-whole");
        place(&staged, &target).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"mine", "{name}");
        assert!(!staged.exists(), "{name}");
    }
}

/// What a caller found absent can be taken before it places: a file, a
/// directory, or a link that appeared after its check is never replaced,
/// and the staged file stays for the caller to remove or place elsewhere.
#[test]
fn what_appeared_after_the_check_is_never_replaced() {
    for (name, place) in PLACES {
        let (temp, staged, target) = staged_and_target("place-taken");
        assert!(holds(&target, &Expectation::Absent).unwrap());
        fs::write(&target, b"theirs").unwrap();
        assert_eq!(
            place(&staged, &target).unwrap_err().kind(),
            ErrorKind::AlreadyExists,
            "{name}"
        );
        assert_eq!(fs::read(&target).unwrap(), b"theirs", "{name}");
        assert_eq!(fs::read(&staged).unwrap(), b"mine", "{name}");

        fs::remove_file(&target).unwrap();
        fs::create_dir(&target).unwrap();
        assert!(place(&staged, &target).is_err(), "{name}");
        assert!(target.is_dir(), "{name}");
        fs::remove_dir(&target).unwrap();

        #[cfg(unix)]
        {
            let elsewhere = temp.folder("elsewhere").join("b.md");
            std::os::unix::fs::symlink(&elsewhere, &target).unwrap();
            assert_eq!(
                place(&staged, &target).unwrap_err().kind(),
                ErrorKind::AlreadyExists,
                "{name}"
            );
            assert!(!elsewhere.exists(), "{name}: a link is not written through");
        }
        #[cfg(not(unix))]
        let _ = temp;
        assert_eq!(fs::read(&staged).unwrap(), b"mine", "{name}");
    }
}

/// A hard-link move cut off after its link and before it removed the staged
/// name left one file at both names: placing it again finishes the move.
#[cfg(unix)]
#[test]
fn a_link_move_cut_off_after_its_link_counts_as_placed() {
    let (_temp, staged, target) = staged_and_target("place-cut-off");
    fs::hard_link(&staged, &target).unwrap();
    place_by_link(&staged, &target).unwrap();
    assert_eq!(fs::read(&target).unwrap(), b"mine");
    assert!(!staged.exists());
}

#[test]
fn a_staged_file_that_is_gone_is_not_placed() {
    for (name, place) in PLACES {
        let (_temp, staged, target) = staged_and_target("place-gone");
        fs::remove_file(&staged).unwrap();
        assert_eq!(
            place(&staged, &target).unwrap_err().kind(),
            ErrorKind::NotFound,
            "{name}"
        );
        assert!(!target.exists(), "{name}");
    }
}

/// Run `writers` puts of `path` at once, each its own bytes over
/// `expected`, and answer each one's outcome.
fn racing_puts(root: &Path, path: &str, writers: usize, expected: &Expectation) -> Vec<PutOutcome> {
    let start = std::sync::Barrier::new(writers);
    std::thread::scope(|scope| {
        let puts: Vec<_> = (0..writers)
            .map(|writer| {
                let start = &start;
                scope.spawn(move || {
                    let bytes = format!("writer {writer}");
                    start.wait();
                    super::put(root, path, Some(bytes.as_bytes()), expected).unwrap()
                })
            })
            .collect();
        puts.into_iter().map(|put| put.join().unwrap()).collect()
    })
}

fn landed_once(outcomes: &[PutOutcome]) -> bool {
    outcomes
        .iter()
        .filter(|outcome| **outcome == PutOutcome::Landed)
        .count()
        == 1
        && outcomes
            .iter()
            .all(|outcome| matches!(outcome, PutOutcome::Landed | PutOutcome::Stale))
}

/// Of writers creating one path at once, exactly one lands, and the file
/// holds its bytes whole.
#[test]
fn of_writers_creating_one_path_at_once_exactly_one_lands() {
    let (_temp, root) = folder("storage-create-race", &[]);
    for round in 0..40 {
        let path = format!("words/{round}.md");
        let outcomes = racing_puts(&root, &path, 8, &Expectation::Absent);
        assert!(landed_once(&outcomes), "round {round}: {outcomes:?}");
        assert!(fs::read_to_string(root.join(&path))
            .unwrap()
            .starts_with("writer "));
    }
    assert_eq!(staged(&root), Vec::<String>::new());
}

/// Within one process, writers replacing one version at once take turns
/// from the check to the rename: exactly one lands, and the rest are stale.
#[test]
fn of_writers_replacing_one_version_at_once_exactly_one_lands() {
    let (_temp, root) = folder("storage-replace-race", &[]);
    for round in 0..40 {
        let read = format!("read {round}");
        fs::write(root.join("note.md"), &read).unwrap();
        let expected = Expectation::Blob(blob(read.as_bytes()));
        let outcomes = racing_puts(&root, "note.md", 8, &expected);
        assert!(landed_once(&outcomes), "round {round}: {outcomes:?}");
    }
    assert_eq!(staged(&root), Vec::<String>::new());
}

/// A path's turn ends with its put: a path no put is changing holds none,
/// so the turns kept never outgrow the puts running.
#[test]
fn a_path_holds_no_turn_once_its_puts_finish() {
    let (_temp, root) = folder("storage-turns", &[]);
    racing_puts(&root, "a.md", 4, &Expectation::Absent);
    let landed = fs::read(root.join("a.md")).unwrap();
    put(&root, "a.md", None, Some(&blob(&landed))).unwrap();
    let busy = BUSY.lock().unwrap();
    assert!(!busy.iter().any(|path| path.starts_with(&root)), "{busy:?}");
}

/// A put that does not land leaves no directory it made.
#[test]
fn a_put_that_does_not_land_leaves_no_new_directory() {
    let (_temp, root) = folder("storage-no-new-directory", &[("old.md", b"old")]);
    assert_eq!(
        put(&root, "new/deep/a.md", b(b"x"), Some(&blob(b"old"))),
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

/// Storage calls and what each answers (`storage_outcomes.json`), over the
/// shell's storage.
#[test]
fn storage_follows_the_outcome_vectors() {
    use serde_json::{json, Value};
    let vectors: Value = serde_json::from_str(include_str!("storage_outcomes.json")).unwrap();
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
                Expectation::Blob(blob(file["blobOf"].as_str().unwrap().as_bytes()))
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
                            PutOutcome::Landed => "landed",
                            PutOutcome::Stale => "stale",
                        })
                    },
                )
            }
            "list" => list(&root, &[String::new()]).map(|mut listing| {
                listing.sort_by(|a, b| a.path.cmp(&b.path));
                json!(listing
                    .iter()
                    .map(|file| json!({ "path": file.path }))
                    .collect::<Vec<_>>())
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
    let results: Vec<_> = (0..100).map(|_| list(&root, &[String::new()])).collect();
    stopped.store(true, Ordering::Relaxed);
    worker.join().unwrap();
    for result in results {
        assert!(result.unwrap().iter().any(|file| file.path == "keep.md"));
    }
    fs::remove_dir_all(&root).unwrap();
    assert!(list(&root, &[String::new()]).is_err());
}

thread_local! {
    /// A directory the walk finds removed after opening it, as macOS's
    /// `readdir` reports one removed mid-read: `ENOENT` from the entries.
    /// That race is the kernel's, too narrow to make on purpose.
    static REMOVED_MID_READ: std::cell::RefCell<Option<PathBuf>> =
        const { std::cell::RefCell::new(None) };
}

/// When `directory` is the one to remove mid-read, removes it and answers
/// what reading its entries then answers.
pub(super) fn removed_mid_read(directory: &Path) -> Option<io::Error> {
    REMOVED_MID_READ.with_borrow_mut(|removing| {
        if removing.as_deref() != Some(directory) {
            return None;
        }
        removing.take();
        fs::remove_dir_all(directory).unwrap();
        Some(io::Error::from(ErrorKind::NotFound))
    })
}

#[test]
fn a_subdirectory_removed_mid_read_is_unlisted_and_a_root_removed_mid_read_is_an_error() {
    let (_temp, root) = folder(
        "listing-removed-mid-read",
        &[("keep.md", b"kept"), ("gone/note.md", b"gone")],
    );
    REMOVED_MID_READ.set(Some(root.join("gone")));
    let listing = list(&root, &[String::new()]).unwrap();
    assert_eq!(
        listing
            .iter()
            .map(|file| file.path.as_str())
            .collect::<Vec<_>>(),
        ["keep.md"]
    );
    assert!(!root.join("gone").exists());

    REMOVED_MID_READ.set(Some(root.clone()));
    assert!(matches!(
        list(&root, &[String::new()]),
        Err(StorageError::Io { path, operation, .. }) if path.is_empty() && operation == "list"
    ));
}
