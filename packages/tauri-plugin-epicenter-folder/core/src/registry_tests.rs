//! Scopes, grants, page work, and the cross-process lock.
//!
//! Key behaviors:
//! - A scope is granted only to the windows registered or later permitted
//!   for it; a refused grant creates nothing.
//! - The first grant locks the folder and initializes nothing; a reloaded
//!   page's grant, or another window's, returns the same root under the same
//!   lock. A second scope on that root is `Busy`.
//! - A linked `.git` or a linked folder directory is refused; a linked
//!   parent is not.
//! - An application folder's missing directory is created; a data folder's
//!   is refused `Missing`, and nothing is created.
//! - A data folder inside another repository's working tree may not get a
//!   repository of its own; an application folder there may.
//! - Shutdown waits for running page work in every window, refuses new work,
//!   and releases the lock.
//! - The lock excludes another process, in both directions with the Bun
//!   hosts' lock, and a killed process leaves nothing to recover.
//! - Saves racing on one root with the same expected hash, from two windows,
//!   publish one at a time: exactly one lands, and the others are
//!   `Conflict`, even when each pauses between its check and its rename.

use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use crate::lock::{LockError, RootLock};
use crate::page_files::{self, ChangeError, Expectation};
use crate::registry::{FolderConfig, FolderKind, GrantError, Registry, ScopeConfig};
use crate::testing::{author, TempDir};

fn scope(name: &str, root: &Path, window: &str) -> ScopeConfig {
    ScopeConfig {
        scope: name.to_string(),
        folder: FolderConfig::new(root, author()),
        windows: vec![window.to_string()],
    }
}

fn registry(root: &Path, window: &str) -> Registry {
    let registry = Registry::new();
    registry.register(scope("notes", root, window)).unwrap();
    registry
}

#[test]
fn a_scope_is_granted_locked_and_initialized_by_nothing() {
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
    assert_eq!(granted.branch, "main");
    assert_eq!(granted.author_name, "Test Author");
    assert!(
        !root.join(".git").exists(),
        "granting initializes nothing; the page engine does"
    );
    // The same window asks again, as a reloaded page does: same root, same lock.
    assert_eq!(registry.grant("notes", "main").unwrap(), granted);
    // No other holder can take the folder meanwhile.
    assert!(matches!(
        RootLock::acquire(&canonical),
        Err(LockError::Busy { .. })
    ));

    registry.shutdown();
    assert_eq!(
        registry.grant("notes", "main").err(),
        Some(GrantError::ShuttingDown)
    );
    drop(RootLock::acquire(&canonical).expect("shutdown releases the lock"));
}

#[test]
fn a_missing_data_folder_is_refused_and_not_created() {
    let temp = TempDir::new("grant-missing");
    let root = temp.path().join("absent").join("vault");
    let registry = Registry::new();
    registry
        .register(ScopeConfig {
            folder: FolderConfig::data(&root, author()),
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
    registry.shutdown();
}

/// A directory above the root holds `.git`: a data folder there is that
/// repository's working tree, so its first `git init` is refused, in the
/// words the Bun opener uses; an application folder there is not.
#[test]
fn a_data_folder_inside_another_repository_may_not_get_its_own() {
    let temp = TempDir::new("grant-nested");
    let outer = temp.folder("outer");
    std::fs::create_dir(outer.join(".git")).unwrap();
    let problem = |root: &Path| {
        format!(
            "{} is inside the repository at {}; commit it with that repository's Git",
            root.display(),
            outer.display()
        )
    };
    for (kind, name) in [(FolderKind::Data, "vault"), (FolderKind::Application, "todos")] {
        let root = temp.folder(&format!("outer/deeper/{name}"));
        let registry = Registry::new();
        let mut config = scope(name, &root, "main");
        config.folder.kind = kind;
        registry.register(config).unwrap();
        let granted = registry.grant(name, "main").unwrap();
        let (canonical, work) = registry.admit_page_work(name, "main").unwrap();
        let expected = (kind == FolderKind::Data).then(|| problem(&canonical));
        assert_eq!(granted.init_problem, expected, "{kind:?}");
        assert_eq!(work.init_problem(&canonical), expected, "{kind:?}");
        drop(work);
        registry.shutdown();
    }

    // Asked again at each `init`: once the repository above is gone, a data
    // folder may get its own.
    let root = temp.folder("outer/vault");
    let registry = Registry::new();
    registry
        .register(ScopeConfig {
            folder: FolderConfig::data(&root, author()),
            ..scope("vault", &root, "main")
        })
        .unwrap();
    registry.grant("vault", "main").unwrap();
    let (canonical, work) = registry.admit_page_work("vault", "main").unwrap();
    assert_eq!(work.init_problem(&canonical), Some(problem(&canonical)));
    std::fs::remove_dir(outer.join(".git")).unwrap();
    assert_eq!(work.init_problem(&canonical), None);
    drop(work);
    registry.shutdown();
}

#[test]
fn every_window_of_a_scope_is_granted_one_root_under_one_lock() {
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

    // A window the shell lets in later shares the root, and the lock stays
    // the one taken by the first grant.
    registry.permit("notes", "browser").unwrap();
    registry.permit("notes", "browser").unwrap();
    assert_eq!(registry.grant("notes", "browser").unwrap(), granted);
    assert!(matches!(
        RootLock::acquire(&canonical),
        Err(LockError::Busy { .. })
    ));
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
    drop(RootLock::acquire(&canonical).expect("shutdown releases the one lock"));
}

#[test]
fn a_second_scope_on_the_same_root_is_busy() {
    let temp = TempDir::new("grant-twice");
    let root = temp.folder("notes");
    let registry = registry(&root, "main");
    registry.register(scope("again", &root, "second")).unwrap();
    registry.grant("notes", "main").unwrap();
    assert_eq!(
        registry.grant("again", "second").err(),
        Some(GrantError::Busy {
            root: root.display().to_string()
        })
    );
    registry.shutdown();
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
    granted.shutdown();
}

#[test]
fn shutdown_waits_for_every_windows_running_page_work_and_refuses_new_work() {
    let temp = TempDir::new("grant-work");
    let registry = Arc::new(registry(&temp.path().join("notes"), "main"));
    registry.permit("notes", "side").unwrap();
    registry.grant("notes", "main").unwrap();
    let (_, work) = registry.admit_page_work("notes", "main").unwrap();
    let (_, side_work) = registry.admit_page_work("notes", "side").unwrap();
    let finished = Arc::new(AtomicBool::new(false));
    let shutting = {
        let registry = Arc::clone(&registry);
        let finished = Arc::clone(&finished);
        std::thread::spawn(move || {
            registry.shutdown();
            assert!(finished.load(Ordering::SeqCst), "shutdown waited for the work");
        })
    };
    std::thread::sleep(Duration::from_millis(100));
    assert!(matches!(
        registry.admit_page_work("notes", "main"),
        Err(GrantError::ShuttingDown)
    ));
    drop(work);
    std::thread::sleep(Duration::from_millis(100));
    assert!(!shutting.is_finished(), "shutdown waits for the other window's work");
    finished.store(true, Ordering::SeqCst);
    drop(side_work);
    shutting.join().unwrap();
}

fn hex_sha256(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Every admitted change on a root shares its publishing mutex, whichever
/// window it came from, so saves that read the same version check and rename
/// one at a time. Each save pauses between its check and its rename
/// (`PAUSE_AFTER_CHECK`), so without the mutex every save would pass the
/// check before any renamed, and more than one would land.
#[test]
fn saves_racing_on_one_root_with_the_same_expected_hash_land_once() {
    const SAVES: usize = 8;
    let temp = TempDir::new("grant-race");
    let root = temp.folder("notes");
    let registry = Arc::new(registry(&root, "main"));
    registry.permit("notes", "side").unwrap();
    registry.grant("notes", "main").unwrap();
    std::fs::create_dir_all(root.join(".git/epicenter/scratch")).unwrap();
    let target = root.join("a.md");
    std::fs::write(&target, b"old").unwrap();
    let expected = Expectation::Sha256(hex_sha256(b"old"));
    let start = Arc::new(std::sync::Barrier::new(SAVES));
    let saves: Vec<_> = (0..SAVES)
        .map(|save| {
            let registry = Arc::clone(&registry);
            let start = Arc::clone(&start);
            let (target, expected) = (target.clone(), expected.clone());
            let staged = root.join(format!(".git/epicenter/scratch/save-{save}"));
            let root = root.clone();
            std::thread::spawn(move || {
                page_files::PAUSE_AFTER_CHECK.with(|pause| pause.set(Duration::from_millis(50)));
                let bytes = format!("save {save}");
                page_files::write_file(&root, &staged, bytes.as_bytes(), true).unwrap();
                let window = if save % 2 == 0 { "main" } else { "side" };
                let (root, work) = registry.admit_page_work("notes", window).unwrap();
                start.wait();
                let _held = work.publishing();
                let landed = page_files::rename(&root, &staged, &target, &expected);
                if landed.is_err() {
                    page_files::remove(&root, &staged, false, &Expectation::Any).unwrap();
                }
                (bytes, landed)
            })
        })
        .collect();
    let outcomes: Vec<_> = saves.into_iter().map(|save| save.join().unwrap()).collect();
    let winners: Vec<_> = outcomes.iter().filter(|(_, landed)| landed.is_ok()).collect();
    assert_eq!(winners.len(), 1, "{outcomes:?}");
    let won = winners[0].0.as_bytes();
    assert_eq!(std::fs::read(&target).unwrap(), won);
    for (_, landed) in outcomes.iter().filter(|(_, landed)| landed.is_err()) {
        assert_eq!(
            landed,
            &Err(ChangeError::Conflict {
                actual_sha256: Some(hex_sha256(won))
            })
        );
    }
    assert!(std::fs::read_dir(root.join(".git/epicenter/scratch"))
        .unwrap()
        .next()
        .is_none());
    registry.shutdown();
}

/// Another process, in Bun, that takes the same SQLite lock on the same file,
/// reports the outcome on stdout, and holds it until it is killed.
fn bun_locker(root: &Path) -> (Child, String) {
    let script = r#"
        import { Database } from 'bun:sqlite';
        import { basename, dirname, join } from 'node:path';
        const root = process.argv.at(-1);
        const database = new Database(join(dirname(root), `.${basename(root)}.epicenter-lock`), { create: true });
        try {
            database.run('PRAGMA busy_timeout = 0');
            database.run('BEGIN EXCLUSIVE');
            console.log('locked');
        } catch (cause) {
            console.log(`refused ${cause.code}`);
        }
        setInterval(() => {}, 1000);
    "#;
    let mut child = Command::new("bun")
        .args(["-e", script, "--"])
        .arg(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        // This repository always has Bun. Without it the test would prove
        // nothing about another process, so it fails instead of passing.
        .expect("bun is required to hold the lock from another process");
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    (child, line.trim().to_string())
}

#[test]
fn another_process_is_excluded_and_a_killed_holder_leaves_the_folder_free() {
    let temp = TempDir::new("processes");
    let root = temp.folder("notes");

    // Another process holds the folder: this one is refused, at once.
    let (mut holder, outcome) = bun_locker(&root);
    assert_eq!(outcome, "locked");
    let registry = registry(&root, "main");
    assert_eq!(
        registry.grant("notes", "main").err(),
        Some(GrantError::Busy {
            root: root.display().to_string()
        })
    );

    // Killing the holder is all it takes; there is no stale lock to clear.
    holder.kill().unwrap();
    holder.wait().unwrap();
    registry
        .grant("notes", "main")
        .expect("the folder is free after the kill");

    // This process holds it: the other is refused the same way.
    let (mut contender, outcome) = bun_locker(&root);
    contender.kill().unwrap();
    contender.wait().unwrap();
    assert!(outcome.starts_with("refused SQLITE_BUSY"), "{outcome}");

    registry.shutdown();
    let (mut after, outcome) = bun_locker(&root);
    after.kill().unwrap();
    after.wait().unwrap();
    assert_eq!(
        outcome, "locked",
        "shutdown released the folder to other processes"
    );
    std::io::stdout().flush().unwrap();
    std::thread::sleep(Duration::from_millis(10));
}
