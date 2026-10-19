//! Scopes, grants, and page work.
//!
//! Key behaviors:
//! - A scope is granted only to the windows registered or later permitted
//!   for it; a refused grant creates nothing.
//! - The first grant initializes nothing; a reloaded page's grant, or
//!   another window's, returns the same root.
//! - A second scope on that root, as the Folders window's `data:<name>` and
//!   an app's own scope are, and a second shell on it, are granted it too.
//! - A linked `.git` or a linked folder directory is refused; a linked
//!   parent is not.
//! - An application folder's missing directory is created; a data folder's
//!   is refused `Missing`, and nothing is created.
//! - Shutdown refuses new work and waits for none already running.
//! - Saves racing on one root with the same expected hash, from two windows,
//!   two scopes, or two shells, publish one at a time: exactly one lands,
//!   and the others are `Stale`, even when each pauses between its check
//!   and its rename.
//! - A shell save waits while a Bun process holds the folder's save lock,
//!   then checks against what that process saved: `Stale`, and the other
//!   save is kept.

use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

use crate::registry::{FolderConfig, GrantError, Registry, ScopeConfig};
use crate::storage::{self, PutOutcome};
use crate::testing::TempDir;

fn scope(name: &str, root: &Path, window: &str) -> ScopeConfig {
    ScopeConfig {
        scope: name.to_string(),
        folder: FolderConfig::new(root),
        windows: vec![window.to_string()],
    }
}

fn registry(root: &Path, window: &str) -> Registry {
    let registry = Registry::new();
    registry.register(scope("notes", root, window)).unwrap();
    registry
}

#[test]
fn a_scope_is_granted_and_initialized_by_nothing() {
    let temp = TempDir::new("grant");
    let root = temp.path().join("missing").join("notes");
    let registry = registry(&root, "main");
    assert_eq!(
        registry.grant("notes", "intruder").err(),
        Some(GrantError::WindowNotPermitted {
            scope: "notes".into(),
            window: "intruder".into()
        })
    );
    assert_eq!(
        registry.grant("other", "main").err(),
        Some(GrantError::UnknownScope {
            scope: "other".into()
        })
    );
    assert!(!root.exists(), "a refused grant creates nothing");
    assert!(matches!(
        registry.admit_page_work("notes", "main"),
        Err(GrantError::Unavailable { .. })
    ));

    let granted = registry.grant("notes", "main").unwrap();
    let canonical = root.canonicalize().unwrap();
    assert_eq!(granted.root, canonical.to_string_lossy());
    assert!(
        !root.join(".git").exists(),
        "granting initializes nothing; the page engine does"
    );
    // The same window asks again, as a reloaded page does: same root.
    assert_eq!(registry.grant("notes", "main").unwrap(), granted);

    registry.shutdown();
    assert_eq!(
        registry.grant("notes", "main").err(),
        Some(GrantError::ShuttingDown)
    );
}

#[test]
fn a_missing_data_folder_is_refused_and_not_created() {
    let temp = TempDir::new("grant-missing");
    let root = temp.path().join("absent").join("vault");
    let registry = Registry::new();
    registry
        .register(ScopeConfig {
            folder: FolderConfig::data(&root),
            ..scope("vault", &root, "main")
        })
        .unwrap();
    assert_eq!(
        registry.grant("vault", "main").err(),
        Some(GrantError::Missing {
            root: root.display().to_string()
        })
    );
    assert!(!temp.path().join("absent").exists(), "nothing was created");
    // Once a person makes it, the same scope is granted.
    std::fs::create_dir_all(&root).unwrap();
    registry.grant("vault", "main").unwrap();
    std::fs::remove_dir(&root).unwrap();
    assert_eq!(
        registry.grant("vault", "main").err(),
        Some(GrantError::Missing {
            root: root.display().to_string()
        })
    );
    assert!(!root.exists(), "reopening did not replace the chosen directory");
    registry.shutdown();
}

#[test]
fn every_window_of_a_scope_is_granted_one_root() {
    let temp = TempDir::new("grant-windows");
    let root = temp.folder("notes");
    let registry = Registry::new();
    assert!(registry
        .register(ScopeConfig {
            windows: Vec::new(),
            ..scope("notes", &root, "main")
        })
        .is_err());
    registry
        .register(ScopeConfig {
            windows: vec!["main".into(), "side".into()],
            ..scope("notes", &root, "main")
        })
        .unwrap();
    let granted = registry.grant("notes", "main").unwrap();
    assert_eq!(registry.grant("notes", "side").unwrap(), granted);
    let canonical = root.canonicalize().unwrap();
    assert_eq!(registry.admit_page_work("notes", "side").unwrap().0, canonical);
    assert_eq!(
        registry.grant("notes", "browser").err(),
        Some(GrantError::WindowNotPermitted {
            scope: "notes".into(),
            window: "browser".into()
        })
    );

    // A window the shell lets in later shares the root.
    registry.permit("notes", "browser").unwrap();
    registry.permit("notes", "browser").unwrap();
    assert_eq!(registry.grant("notes", "browser").unwrap(), granted);
    assert_eq!(
        registry.permit("other", "browser").err(),
        Some(GrantError::UnknownScope {
            scope: "other".into()
        })
    );

    registry.shutdown();
    assert_eq!(
        registry.permit("notes", "late").err(),
        Some(GrantError::ShuttingDown)
    );
}

/// The Folders window lists a folder before its app is installed, under
/// `data:<name>`; the app then opens it under its own scope. Both are
/// granted the one root, and a second shell on it is granted it too.
#[test]
fn a_second_scope_and_a_second_shell_are_granted_the_same_root() {
    let temp = TempDir::new("grant-twice");
    let root = temp.folder("notes");
    let shell = Registry::new();
    shell
        .register(ScopeConfig {
            folder: FolderConfig::data(&root),
            ..scope("data:notes", &root, "folders")
        })
        .unwrap();
    shell.register(scope("notes", &root, "app")).unwrap();
    let listed = shell.grant("data:notes", "folders").unwrap();
    assert_eq!(shell.grant("notes", "app").unwrap(), listed);

    let other_shell = registry(&root, "main");
    assert_eq!(other_shell.grant("notes", "main").unwrap(), listed);
    shell.shutdown();
    other_shell.shutdown();
}

#[cfg(unix)]
#[test]
fn a_linked_git_directory_is_refused() {
    let temp = TempDir::new("grant-linked-git");
    let root = temp.folder("linked");
    let elsewhere = temp.folder("elsewhere");
    std::os::unix::fs::symlink(&elsewhere, root.join(".git")).unwrap();
    assert!(matches!(
        registry(&root, "main").grant("notes", "main"),
        Err(GrantError::Unavailable { .. })
    ));
}

/// Git state that would send `hash-object -w` or `update-ref` elsewhere is
/// refused at the grant, as before every `git` run.
#[cfg(unix)]
#[test]
fn git_state_linked_elsewhere_is_refused() {
    let temp = TempDir::new("grant-linked-state");
    let elsewhere = temp.folder("elsewhere");
    for planted in ["objects", "refs", "logs", "commondir"] {
        let root = temp.folder(&format!("notes-{planted}"));
        std::fs::create_dir_all(root.join(".git")).unwrap();
        let path = root.join(".git").join(planted);
        if planted == "commondir" {
            std::fs::write(&path, "../elsewhere\n").unwrap();
        } else {
            std::os::unix::fs::symlink(&elsewhere, &path).unwrap();
        }
        assert!(
            matches!(
                registry(&root, "main").grant("notes", "main"),
                Err(GrantError::Unavailable { message }) if message.contains(&format!(".git/{planted}"))
            ),
            "{planted}"
        );
    }
}

#[cfg(unix)]
#[test]
fn a_folder_directory_that_is_a_link_is_refused_and_a_linked_parent_is_not() {
    let temp = TempDir::new("grant-linked-root");
    let elsewhere = temp.folder("elsewhere");
    let leaf = temp.path().join("leaf");
    std::os::unix::fs::symlink(&elsewhere, &leaf).unwrap();
    assert!(matches!(
        registry(&leaf, "main").grant("notes", "main"),
        Err(GrantError::Unavailable { .. })
    ));
    assert!(std::fs::read_dir(&elsewhere).unwrap().next().is_none());

    // The root's parent may be a link a person chose.
    let real = temp.folder("real");
    let alias = temp.path().join("alias");
    std::os::unix::fs::symlink(&real, &alias).unwrap();
    let granted = registry(&alias.join("notes"), "main");
    granted.grant("notes", "main").unwrap();
    assert!(real.join("notes").is_dir());
    let redirected = temp.folder("redirected");
    std::fs::remove_file(&alias).unwrap();
    std::os::unix::fs::symlink(&redirected, &alias).unwrap();
    assert!(matches!(
        granted.grant("notes", "main"),
        Err(GrantError::Missing { .. })
    ));
    assert!(!redirected.join("notes").exists());
    granted.shutdown();
}

#[test]
fn shutdown_refuses_new_work_without_waiting_for_running_work() {
    let temp = TempDir::new("grant-work");
    let root = temp.path().join("notes");
    let registry = registry(&root, "main");
    registry.permit("notes", "side").unwrap();
    registry.grant("notes", "main").unwrap();
    let (canonical, _work) = registry.admit_page_work("notes", "main").unwrap();
    let (_, _side_work) = registry.admit_page_work("notes", "side").unwrap();
    // Returns while both windows' work is still admitted.
    registry.shutdown();
    assert!(matches!(
        registry.admit_page_work("notes", "main"),
        Err(GrantError::ShuttingDown)
    ));
    assert_eq!(canonical, root.canonicalize().unwrap());
}

fn hex_sha256(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Every admitted change on a root shares its publishing mutex, whichever
/// window or scope it came from, and its save lock, whichever shell, so
/// saves that read the same version check and rename one at a time. Each
/// save pauses between its check and its rename (`PAUSE_AFTER_CHECK`), so
/// without the mutex and the lock every save would pass the check before
/// any renamed, and more than one would land. The writers alternate between
/// two windows of one scope, a second scope on the root, and a second
/// shell's registry.
#[test]
fn saves_racing_on_one_root_with_the_same_expected_hash_land_once() {
    const SAVES: usize = 9;
    let temp = TempDir::new("grant-race");
    let root = temp.folder("notes");
    let shell = Arc::new(registry(&root, "main"));
    shell.permit("notes", "side").unwrap();
    shell.register(scope("data:notes", &root, "folders")).unwrap();
    shell.grant("notes", "main").unwrap();
    shell.grant("data:notes", "folders").unwrap();
    let other_shell = Arc::new(registry(&root, "main"));
    other_shell.grant("notes", "main").unwrap();
    std::fs::write(root.join("a.md"), b"old").unwrap();
    let expected = hex_sha256(b"old");
    let start = Arc::new(std::sync::Barrier::new(SAVES));
    let saves: Vec<_> = (0..SAVES)
        .map(|save| {
            let (registry, scope, window) = match save % 4 {
                0 => (Arc::clone(&shell), "notes", "main"),
                1 => (Arc::clone(&shell), "notes", "side"),
                2 => (Arc::clone(&shell), "data:notes", "folders"),
                _ => (Arc::clone(&other_shell), "notes", "main"),
            };
            let start = Arc::clone(&start);
            let expected = expected.clone();
            std::thread::spawn(move || {
                storage::PAUSE_AFTER_CHECK.with(|pause| pause.set(Duration::from_millis(50)));
                let bytes = format!("save {save}");
                let (root, work) = registry.admit_page_work(scope, window).unwrap();
                start.wait();
                let landed = storage::put(&root, "a.md", Some(bytes.as_bytes()), Some(&expected), || {
                    work.publishing()
                });
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
    assert_eq!(std::fs::read(root.join("a.md")).unwrap(), winners[0].0.as_bytes());
    assert!(
        outcomes
            .iter()
            .filter(|(_, landed)| *landed != Ok(PutOutcome::Landed))
            .all(|(_, landed)| *landed == Ok(PutOutcome::Stale)),
        "{outcomes:?}"
    );
    assert!(std::fs::read_dir(root.join(".git/epicenter/scratch"))
        .unwrap()
        .next()
        .is_none());
    shell.shutdown();
    other_shell.shutdown();
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
    let registry = Arc::new(registry(&root, "main"));
    registry.grant("notes", "main").unwrap();
    let target = root.join("a.md");
    std::fs::write(&target, b"old").unwrap();

    let mut other = bun_saver(&root, &target, "theirs");
    let mut said = BufReader::new(other.stdout.take().unwrap());
    let mut line = String::new();
    said.read_line(&mut line).unwrap();
    assert_eq!(line.trim(), "locked");

    let ours = {
        let registry = Arc::clone(&registry);
        std::thread::spawn(move || {
            let (root, work) = registry.admit_page_work("notes", "main").unwrap();
            storage::put(&root, "a.md", Some(b"ours"), Some(&hex_sha256(b"old")), || {
                work.publishing()
            })
        })
    };
    std::thread::sleep(Duration::from_millis(200));
    assert!(!ours.is_finished(), "the shell's save waits for the other process");
    assert_eq!(std::fs::read(&target).unwrap(), b"old");

    writeln!(other.stdin.as_mut().unwrap(), "go").unwrap();
    line.clear();
    said.read_line(&mut line).unwrap();
    assert_eq!(line.trim(), "released");
    other.wait().unwrap();

    assert_eq!(ours.join().unwrap(), Ok(PutOutcome::Stale));
    assert_eq!(std::fs::read(&target).unwrap(), b"theirs");
    assert!(std::fs::read_dir(root.join(".git/epicenter/scratch"))
        .unwrap()
        .next()
        .is_none());
    registry.shutdown();
}
