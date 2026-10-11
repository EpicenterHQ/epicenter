//! What listings name and what reads open.
//!
//! Key behaviors:
//! - A listing names every entry: a symbolic link, named pipe, or other
//!   special entry is listed among the files, never followed, and a read
//!   refuses it
//! - A name that is not UTF-8 is listed by its lossy spelling, and a read of
//!   that spelling is refused rather than reported absent
//! - A file swapped for a pipe or a link after it was inspected is refused
//!   without blocking and without being followed

use std::fs;
use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;

use crate::files::{FileError, Files, BEFORE_READ};
use crate::testing::TempDir;

fn mkfifo(path: &Path) {
    use std::os::unix::ffi::OsStrExt;
    let name = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0, "mkfifo");
}

#[test]
fn a_listing_names_links_and_pipes_among_the_files_and_never_follows_them() {
    let temp = TempDir::new("list-links");
    let root = temp.folder("notes");
    let outside = temp.folder("outside");
    fs::write(outside.join("secret.md"), "secret").unwrap();
    fs::create_dir(root.join("todos")).unwrap();
    fs::write(root.join("todos/ok.md"), "ok").unwrap();
    std::os::unix::fs::symlink(outside.join("secret.md"), root.join("todos/linked.md")).unwrap();
    std::os::unix::fs::symlink(&outside, root.join("elsewhere")).unwrap();
    mkfifo(&root.join("todos/pipe.md"));
    let files = Files::new(&root);

    let listing = files.list().unwrap();
    let paths: Vec<&str> = listing
        .files
        .iter()
        .map(|file| file.path.as_str())
        .collect();
    assert_eq!(
        paths,
        vec![
            "elsewhere",
            "todos/linked.md",
            "todos/ok.md",
            "todos/pipe.md"
        ]
    );
    assert_eq!(listing.directories, vec!["todos"]);
    for path in ["elsewhere", "todos/linked.md", "todos/pipe.md"] {
        assert!(
            matches!(files.read(path), Err(FileError::InvalidPath { .. })),
            "{path}"
        );
    }
    assert_eq!(
        files.children("todos").unwrap().files,
        vec!["linked.md", "ok.md", "pipe.md"]
    );
}

#[test]
fn a_name_that_is_not_utf8_is_listed_and_a_read_of_it_is_refused() {
    use std::os::unix::ffi::OsStrExt;
    let temp = TempDir::new("list-bytes");
    let root = temp.folder("notes");
    fs::create_dir(root.join("todos")).unwrap();
    fs::write(root.join("todos/ok.md"), "ok").unwrap();
    let name = std::ffi::OsStr::from_bytes(b"caf\xe9.md");
    // APFS and some other filesystems refuse a name that is not UTF-8, so
    // nothing can be listed there; Linux filesystems hold one.
    if fs::write(root.join("todos").join(name), "bytes").is_err() {
        eprintln!("skipped: this filesystem refuses a name that is not UTF-8");
        return;
    }
    let files = Files::new(&root);

    assert_eq!(
        files.children("todos").unwrap().files,
        vec!["caf\u{fffd}.md", "ok.md"]
    );
    let listing = files.list().unwrap();
    let paths: Vec<&str> = listing
        .files
        .iter()
        .map(|file| file.path.as_str())
        .collect();
    assert_eq!(paths, vec!["todos/caf\u{fffd}.md", "todos/ok.md"]);
    assert_eq!(
        files.read("todos/caf\u{fffd}.md"),
        Err(FileError::InvalidPath {
            path: "todos/caf\u{fffd}.md".to_string(),
            reason: "the name on disk is not UTF-8, so no folder path names it".to_string(),
        })
    );
}

/// Read `path` on another thread, with `swap` run just before the read opens
/// it, and give up waiting after a few seconds.
fn read_after(
    root: &Path,
    path: &'static str,
    swap: impl Fn(&Path) + Send + 'static,
) -> Option<Result<Vec<u8>, FileError>> {
    let files = Files::new(root);
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        BEFORE_READ.with(|hook| *hook.borrow_mut() = Some(Box::new(swap)));
        let _ = sender.send(files.read(path).map(|read| read.bytes));
    });
    receiver.recv_timeout(Duration::from_secs(5)).ok()
}

#[test]
fn a_file_swapped_for_a_pipe_after_inspection_is_refused_without_blocking() {
    let temp = TempDir::new("read-pipe");
    let root = temp.folder("notes");
    fs::write(root.join("a.md"), "a").unwrap();
    let outcome = read_after(&root, "a.md", |target| {
        fs::remove_file(target).unwrap();
        mkfifo(target);
    });
    let Some(outcome) = outcome else {
        // Release the blocked reader so the test process can end.
        let _ = fs::OpenOptions::new().write(true).open(root.join("a.md"));
        panic!("the read blocked on a pipe");
    };
    assert_eq!(
        outcome,
        Err(FileError::InvalidPath {
            path: "a.md".to_string(),
            reason: "the path is not a regular file".to_string(),
        })
    );
}

#[test]
fn a_file_swapped_for_a_link_after_inspection_is_refused_and_not_followed() {
    let temp = TempDir::new("read-link");
    let root = temp.folder("notes");
    let outside = temp.folder("outside");
    fs::write(outside.join("secret.md"), "secret").unwrap();
    fs::write(root.join("a.md"), "a").unwrap();
    let secret = outside.join("secret.md");
    let outcome = read_after(&root, "a.md", move |target| {
        fs::remove_file(target).unwrap();
        std::os::unix::fs::symlink(&secret, target).unwrap();
    })
    .expect("the read finished");
    assert_eq!(
        outcome,
        Err(FileError::InvalidPath {
            path: "a.md".to_string(),
            reason: "the path passes through a symbolic link".to_string(),
        })
    );
}
