//! Scopes, grants, page work, and the cross-process lock.
//!
//! Key behaviors:
//! - A scope is granted only to the one window registered for it; a refused
//!   grant creates nothing.
//! - The first grant locks the folder and initializes nothing; a reloaded
//!   page's grant returns the same root.
//! - A linked `.git` or a linked folder directory is refused; a linked
//!   parent is not.
//! - Shutdown waits for running page work, refuses new work, and releases
//!   the lock.
//! - The lock excludes another process, in both directions with the Bun
//!   hosts' lock, and a killed process leaves nothing to recover.

use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use crate::lock::{LockError, RootLock};
use crate::registry::{FolderConfig, GrantError, Registry, ScopeConfig};
use crate::testing::{author, TempDir};

fn scope(name: &str, root: &Path, window: &str) -> ScopeConfig {
    ScopeConfig {
        scope: name.to_string(),
        folder: FolderConfig::new(root, author()),
        window: window.to_string(),
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
fn shutdown_waits_for_running_page_work_and_refuses_new_work() {
    let temp = TempDir::new("grant-work");
    let registry = Arc::new(registry(&temp.path().join("notes"), "main"));
    registry.grant("notes", "main").unwrap();
    let (_, work) = registry.admit_page_work("notes", "main").unwrap();
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
    finished.store(true, Ordering::SeqCst);
    drop(work);
    shutting.join().unwrap();
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
