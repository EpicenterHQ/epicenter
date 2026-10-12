//! Scopes, window sessions, and the cross-process lock.
//!
//! Key behaviors:
//! - A window attaches only to a scope the shell registered for it.
//! - Detaching one window leaves the owner and every other window working,
//!   and a commit the owner admitted for it still finishes.
//! - Shutdown drains admitted saves, starts no commit, then releases the lock.
//! - The lock excludes another process, in both directions with the Bun
//!   hosts' lock, and a killed process leaves nothing to recover.

use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use crate::files::{ApplyError, FileError};
use crate::history::OwnerEvent;
use crate::lock::{LockError, RootLock};
use crate::registry::{AttachError, Registry, ScopeConfig};
use crate::testing::{config, create, eventually, git, TempDir};

fn registry(root: &Path, windows: &[&str]) -> Registry {
    let registry = Registry::new();
    registry
        .register(ScopeConfig {
            scope: "notes".to_string(),
            folder: config(root),
            windows: windows.iter().map(|window| window.to_string()).collect(),
        })
        .unwrap();
    registry
}

#[test]
fn a_window_attaches_only_to_a_scope_registered_for_it() {
    let temp = TempDir::new("scopes");
    let root = temp.folder("notes");
    let registry = registry(&root, &["main"]);
    assert_eq!(
        registry.attach("other", "main").err(),
        Some(AttachError::UnknownScope {
            scope: "other".into()
        })
    );
    assert_eq!(
        registry.attach("notes", "intruder").err(),
        Some(AttachError::WindowNotPermitted {
            scope: "notes".into(),
            window: "intruder".into()
        })
    );
    assert!(
        !root.join(".git").exists(),
        "a refused attach opens nothing"
    );

    let session = registry.attach("notes", "main").unwrap();
    assert!(root.join(".git/HEAD").is_file());
    assert!(session.authorize("main").is_ok());
    assert_eq!(
        session.authorize("intruder").err().as_deref(),
        Some("this folder session belongs to the window 'main', not 'intruder'")
    );
    let duplicate = registry.register(ScopeConfig {
        scope: "notes".to_string(),
        folder: config(temp.path()),
        windows: vec!["intruder".to_string()],
    });
    assert_eq!(
        duplicate.err().as_deref(),
        Some("the folder scope 'notes' is already registered")
    );
    assert!(
        registry.attach("notes", "intruder").is_err(),
        "a scope cannot be reconfigured"
    );
}

#[test]
fn detaching_one_window_leaves_the_other_and_the_admitted_commit() {
    let temp = TempDir::new("detach");
    let root = temp.folder("notes");
    let registry = registry(&root, &["a", "b"]);
    let a = registry.attach("notes", "a").unwrap();
    let b = registry.attach("notes", "b").unwrap();
    let heard: Arc<Mutex<Vec<String>>> = Arc::default();
    let listener = Arc::clone(&heard);
    let _b_events = b.authorize("b").unwrap().subscribe(move |event| {
        if let OwnerEvent::FilesChanged { paths, .. } = event {
            listener.lock().unwrap().extend(paths.clone());
        }
    });

    // Window A saves and asks for a commit. The commit is held before it
    // publishes, and then window A detaches.
    let owner = b.authorize("b").unwrap();
    let (reached, at_capture) = mpsc::channel::<()>();
    let (release, gate) = mpsc::channel::<()>();
    let gate = Mutex::new(gate);
    owner.hooks().after_capture = Some(Arc::new(move || {
        reached.send(()).unwrap();
        gate.lock().unwrap().recv().unwrap();
    }));
    let from_a = a.authorize("a").unwrap().clone();
    from_a.apply(&[create("from-a.md", "A")]).unwrap();
    let committing = std::thread::spawn(move || from_a.commit());
    at_capture.recv().unwrap();
    owner.hooks().after_capture = None;
    drop(a);

    assert_eq!(
        owner.read("from-a.md").unwrap().bytes,
        b"A",
        "both windows share one owner"
    );
    // The commit the owner admitted outlives the session that asked.
    release.send(()).unwrap();
    committing.join().unwrap();
    assert_eq!(
        git(&root, &["ls-tree", "-r", "--name-only", "HEAD"]),
        "from-a.md"
    );

    owner.apply(&[create("from-b.md", "B")]).unwrap();
    assert_eq!(*heard.lock().unwrap(), vec!["from-a.md", "from-b.md"]);
    owner.commit();
    assert_eq!(
        git(&root, &["ls-tree", "-r", "--name-only", "HEAD"]),
        "from-a.md\nfrom-b.md"
    );

    // A window that comes back shares the same owner and snapshot again.
    let again = registry.attach("notes", "a").unwrap();
    assert_eq!(
        again.authorize("a").unwrap().snapshot().last_commit,
        owner.snapshot().last_commit
    );
}

#[test]
fn shutdown_drains_a_held_save_commits_nothing_and_releases_the_lock() {
    let temp = TempDir::new("registry-shutdown");
    let root = temp.folder("notes");
    let registry = Arc::new(registry(&root, &["main"]));
    let session = registry.attach("notes", "main").unwrap();
    let owner = session.authorize("main").unwrap().clone();
    assert_eq!(
        RootLock::acquire(&root).err(),
        Some(LockError::Busy { root: root.clone() }),
        "the registry holds the lock while the owner is open"
    );

    let (admitted, at_admission) = mpsc::channel::<()>();
    let (release, gate) = mpsc::channel::<()>();
    let gate = Mutex::new(gate);
    owner.hooks().before_apply = Some(Arc::new(move || {
        admitted.send(()).unwrap();
        gate.lock().unwrap().recv().unwrap();
    }));
    let saver = owner.clone();
    let held = std::thread::spawn(move || saver.apply(&[create("held.md", "admitted")]));
    at_admission.recv().unwrap();
    // The page that asked is gone before its save lands.
    drop(session);

    let closing = Arc::clone(&registry);
    let shutdown = std::thread::spawn(move || closing.shutdown());
    eventually("the fence", || owner.snapshot().closed);
    assert_eq!(
        registry.attach("notes", "main").err(),
        Some(AttachError::ShuttingDown)
    );
    assert!(
        matches!(RootLock::acquire(&root), Err(LockError::Busy { .. })),
        "still draining"
    );
    assert!(matches!(
        owner.apply(&[create("late.md", "x")]),
        Err(ApplyError::Refused {
            error: FileError::Closed
        })
    ));

    release.send(()).unwrap();
    held.join().unwrap().unwrap();
    shutdown.join().unwrap();
    // The save landed, and shutdown committed nothing.
    assert_eq!(
        std::fs::read_to_string(root.join("held.md")).unwrap(),
        "admitted"
    );
    assert_eq!(owner.snapshot().last_commit, None);
    assert!(!root.join(".git/refs/heads/main").exists());
    RootLock::acquire(&root).expect("shutdown released the lock");
}

/// A Bun process that takes the lock exactly as `root-lock.ts` does, reports
/// the outcome on stdout, and holds it until it is killed.
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

    // A Bun host holds the folder: this process is refused, at once.
    let (mut holder, outcome) = bun_locker(&root);
    assert_eq!(outcome, "locked");
    let registry = registry(&root, &["main"]);
    assert_eq!(
        registry.attach("notes", "main").err(),
        Some(AttachError::Busy {
            root: root.display().to_string()
        })
    );
    assert!(
        !root.join(".git").exists(),
        "a busy folder is not initialized"
    );

    // Killing the holder is all it takes; there is no stale lock to clear.
    holder.kill().unwrap();
    holder.wait().unwrap();
    let session = registry
        .attach("notes", "main")
        .expect("the folder is free after the kill");

    // This process holds it: a Bun host is refused the same way.
    let (mut contender, outcome) = bun_locker(&root);
    contender.kill().unwrap();
    contender.wait().unwrap();
    assert!(outcome.starts_with("refused SQLITE_BUSY"), "{outcome}");

    drop(session);
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
