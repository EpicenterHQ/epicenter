//! Canonical directories and publication across independent native and Bun writers.
//! Validation preserves existing files and accepts linked parents. Shared save
//! locks prevent stale writers from replacing a newer save.

use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

use crate::directory::{Directory, DirectoryError};
use crate::storage::{self, PutOutcome};
use crate::testing::TempDir;

#[test]
fn a_fixed_default_is_created_and_a_chosen_directory_must_exist() {
    let temp = TempDir::new("bind-missing");
    let default = temp.path().join("absent").join("Todos");
    let made = Directory::create(&default).unwrap();
    assert!(default.is_dir());
    assert_eq!(made.root(), default.canonicalize().unwrap());
    assert!(
        std::fs::read_dir(&default).unwrap().next().is_none(),
        "creating initializes nothing; the page engine does"
    );

    let chosen = temp.path().join("gone").join("vault");
    assert_eq!(
        Directory::existing(&chosen).err(),
        Some(DirectoryError::Missing {
            path: chosen.clone()
        })
    );
    assert!(!temp.path().join("gone").exists(), "nothing was created");

    let file = temp.path().join("notes.md");
    std::fs::write(&file, "").unwrap();
    assert!(matches!(
        Directory::existing(&file),
        Err(DirectoryError::Unavailable { .. })
    ));
}

#[cfg(unix)]
#[test]
fn a_directory_that_is_a_link_is_refused_and_a_linked_parent_is_not() {
    let temp = TempDir::new("bind-linked-root");
    let elsewhere = temp.folder("elsewhere");
    let leaf = temp.path().join("leaf");
    std::os::unix::fs::symlink(&elsewhere, &leaf).unwrap();
    for open in [Directory::existing, Directory::create] {
        assert!(matches!(
            open(&leaf),
            Err(DirectoryError::Unavailable { .. })
        ));
    }
    assert!(std::fs::read_dir(&elsewhere).unwrap().next().is_none());

    // The root's parent may be a link a person chose.
    let real = temp.folder("real");
    let alias = temp.path().join("alias");
    std::os::unix::fs::symlink(&real, &alias).unwrap();
    let directory = Directory::create(&alias.join("notes")).unwrap();
    assert!(real.join("notes").is_dir());
    assert_eq!(directory.root(), real.join("notes").canonicalize().unwrap());
}

/// Save through an independently resolved directory, as an admitted writer does.
fn save(root: &Path) -> Result<PutOutcome, storage::StorageError> {
    let directory = Directory::existing(root).unwrap();
    storage::put(directory.root(), "todos/a.md", Some(b"milk"), None, || {
        directory.publishing()
    })
}

/// The names directly in `directory`, sorted.
fn names(directory: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

/// A plain directory with no `.git` is opened and saved to, and the save
/// makes nothing in it but the file: no `.git`, no scratch.
#[test]
fn a_directory_with_no_git_is_opened_and_saved_to() {
    let temp = TempDir::new("bind-no-git");
    let root = temp.folder("notes");
    assert_eq!(save(&root), Ok(PutOutcome::Landed));
    assert_eq!(std::fs::read(root.join("todos/a.md")).unwrap(), b"milk");
    assert_eq!(names(&root), ["todos"]);
    assert!(names(&storage::scratch_directory(&root).unwrap()).is_empty());
}

/// A linked worktree's or submodule's `.git` file, and a `.git` link, open
/// and save; each stays as it was, and nothing is written through it.
#[test]
fn a_git_file_or_link_is_opened_and_saved_to() {
    let temp = TempDir::new("bind-git-file");
    let worktree = temp.folder("worktree");
    let gitdir = "gitdir: /elsewhere/.git/worktrees/worktree\n";
    std::fs::write(worktree.join(".git"), gitdir).unwrap();
    assert_eq!(save(&worktree), Ok(PutOutcome::Landed));
    assert_eq!(
        std::fs::read_to_string(worktree.join(".git")).unwrap(),
        gitdir
    );
    assert_eq!(names(&worktree), [".git", "todos"]);
    #[cfg(unix)]
    {
        let linked = temp.folder("linked");
        let repository = temp.folder("repository");
        std::os::unix::fs::symlink(&repository, linked.join(".git")).unwrap();
        assert_eq!(save(&linked), Ok(PutOutcome::Landed));
        assert!(std::fs::symlink_metadata(linked.join(".git"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(names(&repository).is_empty());
    }
}

/// Git state that would send `hash-object -w` or `update-ref` elsewhere is
/// the `epicenter` CLI's to refuse before each history operation; the shell
/// runs no Git, so it binds the folder and saves without touching `.git`.
#[cfg(unix)]
#[test]
fn git_state_linked_elsewhere_does_not_block_opening_or_saving() {
    let temp = TempDir::new("bind-linked-state");
    let elsewhere = temp.folder("elsewhere");
    for planted in ["objects", "refs", "logs", "commondir", "epicenter"] {
        let root = temp.folder(&format!("notes-{planted}"));
        std::fs::create_dir_all(root.join(".git")).unwrap();
        let path = root.join(".git").join(planted);
        if planted == "commondir" {
            std::fs::write(&path, "../elsewhere\n").unwrap();
        } else {
            std::os::unix::fs::symlink(&elsewhere, &path).unwrap();
        }
        assert_eq!(save(&root), Ok(PutOutcome::Landed), "{planted}");
        assert_eq!(names(&root.join(".git")), [planted], "{planted}");
    }
    assert!(names(&elsewhere).is_empty());
}

fn hex_sha256(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Independent directory values and their clones all take the root's save
/// lock. Pausing after the expectation check exposes unsynchronized publication:
/// exactly one of the competing saves may land.
#[test]
fn saves_racing_on_one_root_with_the_same_expected_hash_land_once() {
    const SAVES: usize = 9;
    let temp = TempDir::new("bind-race");
    let root = temp.folder("notes");
    let directories: Vec<_> = (0..3)
        .map(|_| Directory::existing(&root).unwrap())
        .collect();
    std::fs::write(root.join("a.md"), b"old").unwrap();
    let expected = hex_sha256(b"old");
    let start = Arc::new(std::sync::Barrier::new(SAVES));
    let saves: Vec<_> = (0..SAVES)
        .map(|save| {
            let directory = directories[save % directories.len()].clone();
            let start = Arc::clone(&start);
            let expected = expected.clone();
            std::thread::spawn(move || {
                storage::PAUSE_AFTER_CHECK.with(|pause| pause.set(Duration::from_millis(50)));
                let bytes = format!("save {save}");
                start.wait();
                let landed = storage::put(
                    directory.root(),
                    "a.md",
                    Some(bytes.as_bytes()),
                    Some(&expected),
                    || directory.publishing(),
                );
                (bytes, landed)
            })
        })
        .collect();
    let outcomes: Vec<_> = saves.into_iter().map(|save| save.join().unwrap()).collect();
    let winners: Vec<_> = outcomes
        .iter()
        .filter(|(_, landed)| *landed == Ok(PutOutcome::Landed))
        .collect();
    assert_eq!(winners.len(), 1, "{outcomes:?}");
    assert_eq!(
        std::fs::read(root.join("a.md")).unwrap(),
        winners[0].0.as_bytes()
    );
    assert!(
        outcomes
            .iter()
            .filter(|(_, landed)| *landed != Ok(PutOutcome::Landed))
            .all(|(_, landed)| *landed == Ok(PutOutcome::Stale)),
        "{outcomes:?}"
    );
    assert!(names(&storage::scratch_directory(&root).unwrap()).is_empty());
    assert!(!root.join(".git").exists());
}

/// Another process, in Bun, that takes the folder's save lock as the Bun host
/// does (`@epicenter/folder/bun`), says `locked`, and on a line from stdin
/// lands its own save of `theirs` at `target`, then lets go and says
/// `released`.
fn bun_saver(root: &Path, target: &Path, theirs: &str) -> Child {
    let script = r#"
        import { Database } from 'bun:sqlite';
        import { writeFileSync } from 'node:fs';
        import { basename, dirname, join } from 'node:path';
        const [root, target, theirs] = process.argv.slice(-3);
        const database = new Database(join(dirname(root), `.${basename(root)}.epicenter-save-lock`), { create: true });
        database.run('PRAGMA busy_timeout = 0');
        database.run('BEGIN EXCLUSIVE');
        console.log('locked');
        for await (const _ of console) {
            writeFileSync(target, theirs);
            database.run('ROLLBACK');
            database.close();
            console.log('released');
            process.exit(0);
        }
    "#;
    Command::new("bun")
        .args(["-e", script, "--"])
        .arg(root)
        .arg(target)
        .arg(theirs)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("bun is required to save from another process")
}

/// A save from another process holds the folder's save lock across its own
/// check and rename. A shell save that read the same version waits for it,
/// then checks against what that save left, so it is `Stale` and the other
/// process's save is kept, not overwritten.
#[test]
fn a_shell_save_waits_for_another_process_save_and_then_is_stale() {
    let temp = TempDir::new("save-lock-process");
    let root = temp.folder("notes");
    let directory = Directory::existing(&root).unwrap();
    let target = root.join("a.md");
    std::fs::write(&target, b"old").unwrap();

    let mut other = bun_saver(&root, &target, "theirs");
    let mut said = BufReader::new(other.stdout.take().unwrap());
    let mut line = String::new();
    said.read_line(&mut line).unwrap();
    assert_eq!(line.trim(), "locked");

    let ours = {
        let directory = directory.clone();
        std::thread::spawn(move || {
            storage::put(
                directory.root(),
                "a.md",
                Some(b"ours"),
                Some(&hex_sha256(b"old")),
                || directory.publishing(),
            )
        })
    };
    std::thread::sleep(Duration::from_millis(200));
    assert!(
        !ours.is_finished(),
        "the shell's save waits for the other process"
    );
    assert_eq!(std::fs::read(&target).unwrap(), b"old");

    writeln!(other.stdin.as_mut().unwrap(), "go").unwrap();
    line.clear();
    said.read_line(&mut line).unwrap();
    assert_eq!(line.trim(), "released");
    other.wait().unwrap();

    assert_eq!(ours.join().unwrap(), Ok(PutOutcome::Stale));
    assert_eq!(std::fs::read(&target).unwrap(), b"theirs");
    assert!(names(&storage::scratch_directory(&root).unwrap()).is_empty());
}
