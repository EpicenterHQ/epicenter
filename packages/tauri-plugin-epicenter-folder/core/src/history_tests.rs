//! Native Git history for one folder.
//!
//! Each test opens a disposable folder and compares what the owner reports
//! with what plain `git` sees afterward.
//!
//! Key behaviors:
//! - A save is committed by the owner even after the handle that saved is gone.
//! - A save asks for an automatic commit. While the Git lock or the file gate
//!   is held, the request waits with any later ones, and once the holder lets
//!   go one commit takes the latest files without another save.
//! - A failed automatic commit is not retried on its own; a save that landed
//!   while it ran gets one more commit.
//! - An explicit commit or fast-forward waits and then reads fresh inputs.
//! - A fetch or push in flight holds neither the file gate nor the Git lock:
//!   saves land and are committed while it runs.
//! - A commit holds exactly what it snapshotted, however saves land after.
//! - Shutdown waits for an admitted commit and starts none of its own.
//! - A branch moved by another Git process is reported, never retried or
//!   overwritten; held ref and index locks fail or warn without losing files.
//! - A staged commit is written on the parent it pinned or not at all: a
//!   branch moved after the pin is refused and the index keeps its bytes.
//!   Its tree is the one Git writes from the index, intent-to-add entries
//!   left out.
//! - Status writes nothing: no object, no index refresh, no lock file.
//! - Commits hold the exact bytes on disk; responses carry no file bytes.
//! - Push, fetch, and fast-forward follow the shared history's rules.

use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use crate::files::FileChange;
use crate::git::Remote;
use crate::history::{
    CommitOutcome, GitError, Observation, OwnerEvent, PendingIncoming, PullError, PullOutcome,
    PushOutcome, RecoverOutcome,
};
use crate::messages::{ChangeKind, PathChange};
use crate::owner::{FolderConfig, FolderOwner};
use crate::testing::{config, create, eventually, git, open, overwrite, replace, tree, TempDir};

/// Wait for the automatic worker a save started, and any scan. The save
/// counted the worker as active before it returned, so nothing can start
/// after this sees it idle.
fn settled(owner: &FolderOwner) {
    eventually("the admitted commit and any scan to finish", || {
        let activity = owner.snapshot().activity;
        !activity.commit.active && !activity.scan.active
    });
}

/// Explicitly push and verify the branch head reached the remote.
fn pushed(owner: &FolderOwner, root: &Path) {
    let head = git(root, &["rev-parse", "HEAD"]);
    assert_eq!(owner.push(None), PushOutcome::Pushed { oid: head.clone() });
    eventually("the head to be pushed", || {
        let snapshot = owner.snapshot();
        !snapshot.activity.push.active
            && matches!(
                snapshot.last_push.as_ref().map(|attempt| &attempt.result),
                Some(PushOutcome::Pushed { oid }) if *oid == head
            )
    });
}

/// A hook that reports reaching it and then waits to be released, once.
fn hold_once() -> (
    Arc<dyn Fn() + Send + Sync>,
    mpsc::Receiver<()>,
    mpsc::Sender<()>,
) {
    let (reached, at_hook) = mpsc::channel::<()>();
    let (release, gate) = mpsc::channel::<()>();
    let gate = Mutex::new(gate);
    let once = AtomicBool::new(true);
    let hook: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
        if once.swap(false, Ordering::SeqCst) {
            reached.send(()).unwrap();
            gate.lock().unwrap().recv().unwrap();
        }
    });
    (hook, at_hook, release)
}

fn save(owner: &FolderOwner, path: &str, content: &str) {
    owner.apply(&[overwrite(path, content)]).unwrap();
}

/// Write a file as another program would: no commit is asked for.
fn outside(root: &Path, path: &str, content: &str) {
    let file = root.join(path);
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(file, content).unwrap();
}

fn subjects(root: &Path) -> Vec<String> {
    git(root, &["log", "--format=%s"])
        .lines()
        .map(str::to_string)
        .collect()
}

fn change(path: &str, kind: ChangeKind) -> PathChange {
    PathChange {
        path: path.to_string(),
        kind,
    }
}

// ============================================================================
// Commit passes
// ============================================================================

#[test]
fn a_save_is_committed_after_the_handle_that_saved_is_gone() {
    let temp = TempDir::new("gone");
    let root = temp.folder("notes");
    let owner = open(&root);
    {
        let page = owner.clone();
        save(&page, "a.md", "saved just before the page closed");
        // The page's handle goes away the moment the save returns.
    }
    settled(&owner);
    assert_eq!(subjects(&root), vec!["Add a.md"]);
    assert_eq!(
        git(&root, &["show", "HEAD:a.md"]),
        "saved just before the page closed"
    );
    assert_eq!(
        git(&root, &["log", "-1", "--format=%an <%ae>"]),
        "Test Author <test@example.com>"
    );
    assert_eq!(
        git(&root, &["status", "--porcelain"]),
        "",
        "the index matches the head"
    );
    let Some(attempt) = &owner.snapshot().last_commit else {
        panic!("the pass is recorded in the snapshot");
    };
    assert!(matches!(
        &attempt.result,
        CommitOutcome::Committed { message, changed_paths: 1, index_warning: None, parent: None, .. }
            if message == "Add a.md"
    ));
}

#[test]
fn saves_made_while_the_git_lock_is_held_are_committed_once_it_is_released() {
    let temp = TempDir::new("git-busy");
    let root = temp.folder("notes");
    let owner = open(&root);
    let (hook, at_capture, release) = hold_once();
    owner.hooks().after_capture = Some(hook);

    save(&owner, "a.md", "A");
    at_capture.recv().unwrap();
    // A's commit released the file gate and holds the Git lock, before it
    // publishes. Later saves land, and their requests wait for A.
    save(&owner, "b.md", "B");
    save(&owner, "b.md", "B, again");
    save(&owner, "c.md", "C");
    assert_eq!(owner.read("b.md").unwrap().bytes, b"B, again");
    assert!(owner.snapshot().activity.commit.active, "A is still held");
    assert!(!root.join(".git/refs/heads/main").exists());

    // A publishes, and with no further save one more commit takes the
    // latest files on top of it.
    release.send(()).unwrap();
    settled(&owner);
    let head = git(&root, &["rev-parse", "HEAD"]);
    let first = git(&root, &["rev-parse", "HEAD~1"]);
    assert_eq!(subjects(&root), vec!["Update 2 files", "Add a.md"]);
    assert_eq!(git(&root, &["show", "HEAD:b.md"]), "B, again");
    assert_eq!(git(&root, &["status", "--porcelain"]), "");
    let snapshot = owner.snapshot();
    assert!(matches!(
        &snapshot.last_commit.as_ref().unwrap().result,
        CommitOutcome::Committed { oid, parent, changed_paths: 2, .. }
            if *oid == head && parent.as_deref() == Some(first.as_str())
    ));
    assert!(matches!(
        snapshot.files,
        Observation::Observed { stale: false, ref value, .. } if value.changes.is_empty()
    ));

    // Every request was answered: an explicit commit finds nothing new.
    assert!(matches!(owner.commit(), CommitOutcome::Unchanged { .. }));
    assert_eq!(subjects(&root).len(), 2);
}

#[test]
fn an_explicit_commit_waits_for_the_git_lock_and_commits_what_landed_meanwhile() {
    let temp = TempDir::new("explicit-wait");
    let root = temp.folder("notes");
    let owner = open(&root);
    outside(&root, "a.md", "A");
    let (hook, at_hash, release) = hold_once();
    owner.hooks().before_hash = Some(hook);

    let first = {
        let owner = owner.clone();
        std::thread::spawn(move || owner.commit())
    };
    at_hash.recv().unwrap();
    // The first commit holds the Git lock. A second is asked for: it takes
    // the file gate, finds the Git lock held, and gives the gate back.
    let second = {
        let owner = owner.clone();
        std::thread::spawn(move || owner.commit())
    };
    // So a save still lands while both commits are outstanding, wherever the
    // second one is in its wait.
    let (done, finished) = mpsc::channel();
    let saver = owner.clone();
    let saving = std::thread::spawn(move || {
        save(&saver, "b.md", "B");
        done.send(()).unwrap();
    });
    finished
        .recv_timeout(Duration::from_secs(20))
        .expect("a save is not stuck behind a commit that is itself waiting");
    saving.join().unwrap();

    release.send(()).unwrap();
    let first = first.join().unwrap();
    let second = second.join().unwrap();
    let CommitOutcome::Committed {
        oid: first_oid,
        message,
        changed_paths: 1,
        ..
    } = &first
    else {
        panic!("{first:?}");
    };
    assert_eq!(message, "Add a.md");
    // The second read the folder only once it held both locks: it holds the
    // save that landed while it waited, on top of the first commit, unless
    // that save's own automatic commit got the locks first.
    settled(&owner);
    let head = git(&root, &["rev-parse", "HEAD"]);
    assert!(
        match &second {
            CommitOutcome::Committed {
                parent,
                message,
                changed_paths: 1,
                oid,
                ..
            } =>
                parent.as_deref() == Some(first_oid.as_str())
                    && message == "Add b.md"
                    && *oid == head,
            CommitOutcome::Unchanged {
                head: Some(unchanged),
                ..
            } => *unchanged == head,
            _ => false,
        },
        "{second:?}"
    );
    assert_eq!(subjects(&root), vec!["Add b.md", "Add a.md"]);
    assert_eq!(git(&root, &["rev-parse", "HEAD^"]), *first_oid);
    assert!(matches!(
        owner.snapshot().files,
        Observation::Observed { stale: false, ref value, .. } if value.changes.is_empty()
    ));
}

#[test]
fn a_rename_cannot_land_inside_a_snapshot_so_the_pass_never_commits_an_empty_tree() {
    let temp = TempDir::new("coherent");
    let root = temp.folder("notes");
    let owner = open(&root);
    save(&owner, "todos/old.md", "row");
    save(&owner, "todos/old.png", "image");
    owner.commit();
    assert_eq!(
        git(&root, &["ls-tree", "-r", "--name-only", "HEAD"]),
        "todos/old.md\ntodos/old.png"
    );
    outside(&root, "todos/old.md", "row, edited");

    // While the pass holds the file gate to snapshot, a rename of the row and
    // its attachment is requested. It must not land until the snapshot exists.
    let renamer = owner.clone();
    let renamed: Arc<Mutex<Option<std::thread::JoinHandle<()>>>> = Arc::default();
    let handle = Arc::clone(&renamed);
    let landed_during = Arc::new(AtomicBool::new(false));
    let observed = Arc::clone(&landed_during);
    let once = AtomicBool::new(true);
    owner.hooks().during_snapshot = Some(Arc::new(move || {
        if !once.swap(false, Ordering::SeqCst) {
            return;
        }
        let (done, finished) = mpsc::channel();
        let renamer = renamer.clone();
        *handle.lock().unwrap() = Some(std::thread::spawn(move || {
            let moves: Vec<FileChange> = ["md", "png"]
                .iter()
                .map(|extension| FileChange::Move {
                    from: format!("todos/old.{extension}"),
                    to: format!("todos/new.{extension}"),
                    expected_sha256: None,
                })
                .collect();
            renamer.apply(&moves).unwrap();
            // Nobody is listening any more once the hook stopped waiting.
            let _ = done.send(());
        }));
        observed.store(
            finished.recv_timeout(Duration::from_millis(250)).is_ok(),
            Ordering::SeqCst,
        );
    }));

    let outcome = owner.commit();
    renamed.lock().unwrap().take().unwrap().join().unwrap();
    assert!(
        !landed_during.load(Ordering::SeqCst),
        "the rename waited for the snapshot"
    );
    assert!(
        matches!(outcome, CommitOutcome::Committed { ref message, .. } if message == "Update todos/old.md"),
        "{outcome:?}"
    );
    assert_eq!(
        git(&root, &["ls-tree", "-r", "--name-only", "HEAD"]),
        "todos/old.md\ntodos/old.png"
    );
    assert_eq!(git(&root, &["show", "HEAD:todos/old.md"]), "row, edited");
    assert_eq!(
        owner.children("todos").unwrap().files,
        vec!["new.md", "new.png"]
    );

    // The rename asked for its own commit.
    settled(&owner);
    assert_eq!(
        git(&root, &["ls-tree", "-r", "--name-only", "HEAD"]),
        "todos/new.md\ntodos/new.png"
    );
    assert_eq!(subjects(&root)[0], "Update 4 files");
    assert!(
        !root
            .join(".git/epicenter/scratch")
            .read_dir()
            .unwrap()
            .any(|_| true),
        "no snapshot is left behind"
    );
}

#[test]
fn a_commit_holds_exactly_what_it_snapshotted_while_later_saves_land() {
    let temp = TempDir::new("held-hash");
    let root = temp.folder("notes");
    let owner = open(&root);
    let (hook, at_hash, release) = hold_once();
    owner.hooks().before_hash = Some(hook);
    let outcomes: Arc<Mutex<Vec<CommitOutcome>>> = Arc::default();
    let heard = Arc::clone(&outcomes);
    let _subscription = owner.subscribe(move |event| {
        if let OwnerEvent::Snapshot { snapshot, .. } = event {
            if let Some(attempt) = &snapshot.last_commit {
                let mut heard = heard.lock().unwrap();
                if heard.last() != Some(&attempt.result) {
                    heard.push(attempt.result.clone());
                }
            }
        }
    });

    save(&owner, "a.md", "A");
    at_hash.recv().unwrap();
    // A's commit has its snapshot and is held before it hashes a byte.
    let (done, finished) = mpsc::channel();
    let saver = owner.clone();
    let saving = std::thread::spawn(move || {
        save(&saver, "b.md", "B");
        // Overwriting a file A snapshotted must not change what A commits.
        save(&saver, "a.md", "A, rewritten after the snapshot");
        done.send(()).unwrap();
    });
    finished
        .recv_timeout(Duration::from_secs(10))
        .expect("saves finish while the commit is held at hashing");
    saving.join().unwrap();
    assert!(owner.snapshot().activity.commit.active);

    release.send(()).unwrap();
    settled(&owner);
    // A's target, message, and count all come from its snapshot. Both later
    // saves asked while it held the Git lock; their request was carried by
    // one more commit, with no further save.
    let first = git(&root, &["rev-parse", "HEAD~1"]);
    let head = git(&root, &["rev-parse", "HEAD"]);
    let outcomes = outcomes.lock().unwrap().clone();
    assert!(
        matches!(
            outcomes.as_slice(),
            [
                CommitOutcome::Committed { oid: a, parent: None, message: a_message, changed_paths: 1, .. },
                CommitOutcome::Committed { oid: b, parent: Some(b_parent), message: b_message, changed_paths: 2, .. },
            ] if *a == first
                && a_message == "Add a.md"
                && *b == head
                && *b_parent == first
                && b_message == "Update 2 files"
        ),
        "{outcomes:?}"
    );
    assert_eq!(subjects(&root), vec!["Update 2 files", "Add a.md"]);
    assert_eq!(
        git(&root, &["ls-tree", "-r", "--name-only", "HEAD~1"]),
        "a.md"
    );
    assert_eq!(git(&root, &["show", "HEAD~1:a.md"]), "A");
    assert_eq!(
        git(&root, &["show", "HEAD:a.md"]),
        "A, rewritten after the snapshot"
    );
    assert_eq!(git(&root, &["show", "HEAD:b.md"]), "B");
    assert!(matches!(
        owner.snapshot().files,
        Observation::Observed { stale: false, .. }
    ));
}

#[test]
fn an_observation_captured_before_a_save_is_stale_until_a_later_commit() {
    let temp = TempDir::new("stale");
    let root = temp.folder("notes");
    let owner = open(&root);
    outside(&root, "a.md", "A");
    let saver = owner.clone();
    let once = AtomicBool::new(true);
    let (hold, at_hash, release) = hold_once();
    owner.hooks().after_capture = Some(Arc::new(move || {
        if once.swap(false, Ordering::SeqCst) {
            // The save's own commit waits before hashing until released.
            saver.hooks().before_hash = Some(Arc::clone(&hold));
            save(&saver, "b.md", "B");
        }
    }));

    assert!(matches!(
        owner.commit(),
        CommitOutcome::Committed { ref message, .. } if message == "Add a.md"
    ));
    // A's commit is not rejected because a save landed after its capture, but
    // its clean observation is older than that save.
    assert!(matches!(
        owner.snapshot().files,
        Observation::Observed { stale: true, .. }
    ));
    assert_eq!(git(&root, &["status", "--porcelain"]), "?? b.md");

    at_hash.recv().unwrap();
    release.send(()).unwrap();
    settled(&owner);
    assert!(matches!(
        &owner.snapshot().last_commit.as_ref().unwrap().result,
        CommitOutcome::Committed { message, .. } if message == "Add b.md"
    ));
    assert!(matches!(
        owner.snapshot().files,
        Observation::Observed { stale: false, .. }
    ));
}

#[test]
fn a_branch_moved_by_another_git_process_is_reported_and_never_overwritten() {
    let temp = TempDir::new("branch-moved");
    let root = temp.folder("notes");
    let owner = open(&root);
    save(&owner, "a.md", "A");
    let base = match owner.commit() {
        CommitOutcome::Committed { oid, .. } => oid,
        other => panic!("{other:?}"),
    };

    let outside_root = root.clone();
    let once = AtomicBool::new(true);
    owner.hooks().after_capture = Some(Arc::new(move || {
        if once.swap(false, Ordering::SeqCst) {
            git(
                &outside_root,
                &["commit", "--quiet", "--allow-empty", "-m", "outside commit"],
            );
        }
    }));
    save(&owner, "b.md", "B");
    let outside;
    match owner.commit() {
        CommitOutcome::BranchMoved {
            candidate,
            expected,
            actual,
        } => {
            outside = git(&root, &["rev-parse", "HEAD"]);
            assert_eq!(expected.as_deref(), Some(base.as_str()));
            assert_eq!(actual.as_deref(), Some(outside.as_str()));
            assert_ne!(candidate, outside);
            assert_eq!(git(&root, &["cat-file", "-t", &candidate]), "commit");
        }
        other => panic!("the lost compare-and-swap is reported: {other:?}"),
    }
    // The commit returned its report and nothing tried again: the branch is
    // where the other process left it, and the save is on disk, uncommitted.
    assert_eq!(subjects(&root), vec!["outside commit", "Add a.md"]);
    assert_eq!(git(&root, &["status", "--porcelain"]), "?? b.md");
    let snapshot = owner.snapshot();
    assert!(matches!(
        snapshot.last_commit.as_ref().unwrap().result,
        CommitOutcome::BranchMoved { .. }
    ));
    assert!(!snapshot.activity.commit.active);
    assert_eq!(
        owner.read("b.md").unwrap().bytes,
        b"B",
        "the save is still on disk"
    );

    match owner.commit() {
        CommitOutcome::Committed {
            parent, message, ..
        } => {
            assert_eq!(parent.as_deref(), Some(outside.as_str()));
            assert_eq!(message, "Add b.md");
        }
        other => panic!("a later commit lands on top: {other:?}"),
    }
}

#[test]
fn bytes_snapshotted_for_one_parent_are_never_committed_on_another() {
    let temp = TempDir::new("requeue");
    let root = temp.folder("notes");
    let owner = open(&root);
    save(&owner, "a.md", "A");
    owner.commit();

    // After the snapshot, another program moves the branch and the working
    // file together, as its own commit would.
    let outside_root = root.clone();
    let once = AtomicBool::new(true);
    owner.hooks().before_hash = Some(Arc::new(move || {
        if once.swap(false, Ordering::SeqCst) {
            std::fs::write(outside_root.join("a.md"), "A from the incoming commit").unwrap();
            git(&outside_root, &["commit", "--quiet", "-am", "incoming"]);
        }
    }));
    save(&owner, "b.md", "B");
    let incoming = match owner.commit() {
        // The snapshot belongs to the parent it was taken on. It is not
        // published on the new one, and the commit does not start over.
        CommitOutcome::BranchMoved { actual, .. } => actual.unwrap(),
        other => panic!("{other:?}"),
    };
    assert_eq!(subjects(&root), vec!["incoming", "Add a.md"]);
    assert_eq!(git(&root, &["rev-parse", "HEAD"]), incoming);
    assert_eq!(
        git(&root, &["show", "HEAD:a.md"]),
        "A from the incoming commit",
        "the older snapshot did not undo the incoming change"
    );

    // Asked again, the commit pins the new parent and snapshots afresh.
    assert!(matches!(
        owner.commit(),
        CommitOutcome::Committed { ref parent, ref message, .. }
            if parent.as_deref() == Some(incoming.as_str()) && message == "Add b.md"
    ));
    assert_eq!(
        git(&root, &["show", "HEAD:a.md"]),
        "A from the incoming commit"
    );
}

#[test]
fn a_held_ref_lock_fails_the_commit_and_leaves_the_saved_bytes() {
    let temp = TempDir::new("ref-lock");
    let root = temp.folder("notes");
    let owner = open(&root);
    save(&owner, "a.md", "A");
    owner.commit();
    let head = git(&root, &["rev-parse", "HEAD"]);
    let audio: Vec<u8> = (0..200_000u32).map(|index| (index % 251) as u8).collect();
    owner
        .apply(&[FileChange::Create {
            path: "rec/take.wav".into(),
            bytes: audio.clone(),
        }])
        .unwrap();
    let ref_lock = root.join(".git/refs/heads/main.lock");
    std::fs::write(&ref_lock, "").unwrap();

    let outcome = owner.commit();
    assert!(
        matches!(outcome, CommitOutcome::Failed { ref error } if error.contains("update-ref")),
        "{outcome:?}"
    );
    assert_eq!(git(&root, &["rev-parse", "HEAD"]), head);
    assert_eq!(owner.read("rec/take.wav").unwrap().bytes, audio);

    std::fs::remove_file(&ref_lock).unwrap();
    assert!(matches!(
        owner.commit(),
        CommitOutcome::Committed { ref message, .. } if message == "Add rec/take.wav"
    ));
}

#[test]
fn a_save_during_a_failing_automatic_commit_gets_one_more_and_the_failure_alone_gets_none() {
    let temp = TempDir::new("failed-automatic");
    let root = temp.folder("notes");
    let owner = open(&root);
    save(&owner, "a.md", "A");
    settled(&owner);
    let base = git(&root, &["rev-parse", "HEAD"]);
    let ref_lock = root.join(".git/refs/heads/main.lock");

    // Count every commit that reaches publishing. The first takes the
    // branch's ref lock, as another Git process would, and is held there;
    // the second finds the lock gone.
    let captures = Arc::new(AtomicUsize::new(0));
    let (reached, at_capture) = mpsc::channel::<()>();
    let (release, gate) = mpsc::channel::<()>();
    let gate = Mutex::new(gate);
    let counter = Arc::clone(&captures);
    let locked = ref_lock.clone();
    owner.hooks().after_capture = Some(Arc::new(move || {
        match counter.fetch_add(1, Ordering::SeqCst) {
            0 => {
                std::fs::write(&locked, "").unwrap();
                reached.send(()).unwrap();
                gate.lock().unwrap().recv().unwrap();
            }
            1 => std::fs::remove_file(&locked).unwrap(),
            _ => {}
        }
    }));
    let outcomes: Arc<Mutex<Vec<CommitOutcome>>> = Arc::default();
    let heard = Arc::clone(&outcomes);
    let _subscription = owner.subscribe(move |event| {
        if let OwnerEvent::Snapshot { snapshot, .. } = event {
            if let Some(attempt) = &snapshot.last_commit {
                let mut heard = heard.lock().unwrap();
                if heard.last() != Some(&attempt.result) {
                    heard.push(attempt.result.clone());
                }
            }
        }
    });

    // B's commit answered its request and holds the Git lock. A newer save
    // lands while that commit is still going to fail.
    save(&owner, "b.md", "B");
    at_capture.recv().unwrap();
    save(&owner, "b.md", "B, again");
    assert!(owner.snapshot().activity.commit.active);

    // The held commit fails, and with no further save one more commit takes
    // the newer bytes on the unchanged parent.
    release.send(()).unwrap();
    settled(&owner);
    assert_eq!(captures.load(Ordering::SeqCst), 2);
    let outcomes = outcomes.lock().unwrap().clone();
    assert!(
        matches!(
            outcomes.as_slice(),
            [
                CommitOutcome::Committed { message: a_message, .. },
                CommitOutcome::Failed { error },
                CommitOutcome::Committed { parent: Some(parent), message, changed_paths: 1, .. },
            ] if a_message == "Add a.md"
                && error.contains("update-ref")
                && *parent == base
                && message == "Add b.md"
        ),
        "{outcomes:?}"
    );
    assert_eq!(git(&root, &["show", "HEAD:b.md"]), "B, again");
    assert_eq!(git(&root, &["status", "--porcelain"]), "");

    // A failure with no save during it asks for nothing: once the lock is
    // gone, nothing runs on its own and the save stays uncommitted.
    let head = git(&root, &["rev-parse", "HEAD"]);
    std::fs::write(&ref_lock, "").unwrap();
    save(&owner, "c.md", "C");
    settled(&owner);
    assert_eq!(captures.load(Ordering::SeqCst), 3);
    assert!(matches!(
        &owner.snapshot().last_commit.as_ref().unwrap().result,
        CommitOutcome::Failed { error } if error.contains("update-ref")
    ));
    std::fs::remove_file(&ref_lock).unwrap();
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(captures.load(Ordering::SeqCst), 3);
    assert!(!owner.snapshot().activity.commit.active);
    assert_eq!(git(&root, &["rev-parse", "HEAD"]), head);
    assert_eq!(git(&root, &["status", "--porcelain"]), "?? c.md");
    assert_eq!(owner.read("c.md").unwrap().bytes, b"C");

    // The next save's commit carries both.
    save(&owner, "d.md", "D");
    settled(&owner);
    assert!(matches!(
        &owner.snapshot().last_commit.as_ref().unwrap().result,
        CommitOutcome::Committed { parent: Some(parent), message, changed_paths: 2, .. }
            if *parent == head && message == "Update 2 files"
    ));
    assert_eq!(git(&root, &["status", "--porcelain"]), "");
}

#[test]
fn a_held_index_lock_commits_with_a_warning_and_a_later_pass_reconciles() {
    let temp = TempDir::new("index-lock");
    let root = temp.folder("notes");
    let owner = open(&root);
    save(&owner, "a.md", "A");
    owner.commit();
    outside(&root, "a.md", "A2");
    // Staged content that differs from the working bytes, and a staged-only add.
    std::fs::write(root.join("staged-only.md"), "staged").unwrap();
    git(&root, &["add", "staged-only.md"]);
    std::fs::remove_file(root.join("staged-only.md")).unwrap();
    let index_before = std::fs::read(root.join(".git/index")).unwrap();
    let index_lock = root.join(".git/index.lock");
    std::fs::write(&index_lock, "").unwrap();

    match owner.commit() {
        CommitOutcome::Committed {
            message,
            index_warning,
            ..
        } => {
            assert_eq!(message, "Update a.md");
            let warning = index_warning.expect("the index could not be reconciled");
            assert!(warning.contains("index.lock"), "{warning}");
        }
        other => panic!("the branch still moved: {other:?}"),
    }
    assert_eq!(git(&root, &["show", "HEAD:a.md"]), "A2");
    assert_eq!(
        std::fs::read(root.join(".git/index")).unwrap(),
        index_before
    );

    std::fs::remove_file(&index_lock).unwrap();
    assert_eq!(
        owner.commit(),
        CommitOutcome::Unchanged {
            head: Some(git(&root, &["rev-parse", "HEAD"])),
            index_warning: None,
        }
    );
    assert_eq!(
        git(&root, &["status", "--porcelain"]),
        "",
        "staged-only entries are gone"
    );
}

#[test]
fn status_writes_nothing_into_the_folder_or_its_git_directory() {
    let temp = TempDir::new("read-only");
    let root = temp.folder("notes");
    let owner = open(&root);
    save(&owner, "a.md", "A");
    save(&owner, "keep/b.md", "B");
    owner.commit();
    settled(&owner);
    // Uncommitted work of every kind, plus an index whose stat data is stale.
    outside(&root, "a.md", "A changed");
    outside(&root, "new.md", "untracked");
    std::fs::remove_dir_all(root.join("keep")).unwrap();
    std::thread::sleep(Duration::from_millis(20));
    let before = tree(&root);

    let observed = owner.status().unwrap();
    assert_eq!(
        observed.changes,
        vec![
            change("a.md", ChangeKind::Modify),
            change("keep/b.md", ChangeKind::Delete),
            change("new.md", ChangeKind::Add),
        ]
    );
    assert_eq!(observed.head, Some(git(&root, &["rev-parse", "HEAD"])));
    owner.paths().unwrap();
    owner.diff(&[]).unwrap();
    owner.log(5).unwrap();
    owner.poll_external();

    let after = tree(&root);
    let names = |files: &[(String, Vec<u8>)]| {
        files
            .iter()
            .map(|(name, _)| name.clone())
            .collect::<Vec<_>>()
    };
    assert_eq!(
        names(&before),
        names(&after),
        "no object, lock, or scratch file appeared"
    );
    assert_eq!(before, after, "no file's bytes changed, the index included");
}

#[test]
fn ignore_rules_narrow_untracked_files_and_tracked_files_survive_them() {
    let temp = TempDir::new("ignore");
    let root = temp.folder("notes");
    let owner = open(&root);
    save(&owner, "keep.log", "tracked before the rule");
    owner.commit();
    outside(&root, ".gitignore", "*.log\nbuild/\n");
    outside(&root, "keep.log", "tracked and edited");
    outside(&root, "new.log", "ignored");
    outside(&root, "build/out.txt", "ignored directory");
    outside(
        &root,
        "sub/index.sqlite3",
        "a file that happens to share the name",
    );
    std::fs::write(root.join("index.sqlite3"), "generated").unwrap();
    std::fs::write(root.join(".DS_Store"), "scratch").unwrap();
    std::fs::write(root.join(".git/info/exclude"), "excluded.md\n").unwrap();
    outside(&root, "excluded.md", "ignored by info/exclude");

    let expected = vec![
        change(".gitignore", ChangeKind::Add),
        change("keep.log", ChangeKind::Modify),
        change("sub/index.sqlite3", ChangeKind::Add),
    ];
    assert_eq!(owner.status().unwrap().changes, expected);
    assert!(matches!(
        owner.commit(),
        CommitOutcome::Committed { changed_paths: 3, ref message, .. } if message == "Update 3 files"
    ));
    assert_eq!(
        git(&root, &["ls-tree", "-r", "--name-only", "HEAD"]),
        ".gitignore\nkeep.log\nsub/index.sqlite3"
    );
    assert_eq!(git(&root, &["show", "HEAD:keep.log"]), "tracked and edited");
    assert!(owner.status().unwrap().changes.is_empty());
}

#[cfg(unix)]
#[test]
fn what_a_plain_file_commit_cannot_represent_blocks_the_pass_but_not_status() {
    use std::os::unix::fs::PermissionsExt;
    let cases: [(&str, fn(&Path), &str); 6] = [
        (
            "symlink",
            |root| std::os::unix::fs::symlink("a.md", root.join("link.md")).unwrap(),
            "link.md is a symbolic link; automatic commits only write plain files",
        ),
        (
            "executable",
            |root| {
                std::fs::write(root.join("run.sh"), "#!/bin/sh\n").unwrap();
                std::fs::set_permissions(root.join("run.sh"), std::fs::Permissions::from_mode(0o755))
                    .unwrap();
            },
            "run.sh is an executable file; automatic commits only write plain files",
        ),
        (
            "nested",
            |root| {
                std::fs::create_dir_all(root.join("vendor/.git")).unwrap();
            },
            "vendor/.git is nested Git data; automatic commits only write plain files",
        ),
        (
            "attribute",
            |root| std::fs::write(root.join(".gitattributes"), "*.md text eol=crlf\n").unwrap(),
            "a.md has the Git attribute text; automatic commits do not apply attribute filters or conversion",
        ),
        (
            "autocrlf",
            |root| {
                git(root, &["config", "core.autocrlf", "input"]);
            },
            "core.autocrlf is input; automatic commits do not convert line endings",
        ),
        (
            "detached",
            |root| {
                git(root, &["checkout", "--quiet", "--detach"]);
            },
            "HEAD is detached",
        ),
    ];
    for (label, arrange, reason) in cases {
        let temp = TempDir::new(label);
        let root = temp.folder("notes");
        let owner = open(&root);
        save(&owner, "a.md", "A");
        owner.commit();
        let head = git(&root, &["rev-parse", "HEAD"]);
        arrange(&root);
        save(&owner, "b.md", "B");

        assert_eq!(
            owner.commit(),
            CommitOutcome::Blocked {
                reason: reason.to_string()
            },
            "{label}"
        );
        assert_eq!(git(&root, &["rev-parse", "HEAD"]), head, "{label}");
        assert_eq!(owner.read("b.md").unwrap().bytes, b"B", "{label}");
        let observed = owner.status().expect("status still observes the folder");
        assert!(
            observed.changes.contains(&change("b.md", ChangeKind::Add)),
            "{label}"
        );
    }
}

#[test]
fn sixty_four_mebibytes_of_audio_commit_exactly_and_no_response_carries_a_byte() {
    const FILES: usize = 8;
    const SIZE: usize = 8 * 1024 * 1024;
    let temp = TempDir::new("audio");
    let root = temp.folder("recordings");
    let owner = open(&root);
    let mut digests = Vec::new();
    for index in 0..FILES {
        // Incompressible enough that every blob is really written.
        let mut state = 0x9e3779b97f4a7c15u64.wrapping_mul(index as u64 + 1);
        let bytes: Vec<u8> = (0..SIZE)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                state as u8
            })
            .collect();
        digests.push(Sha256::digest(&bytes));
        // Written as a recorder process would, so only the commit below
        // hashes them.
        std::fs::create_dir_all(root.join("rec")).unwrap();
        std::fs::write(root.join(format!("rec/{index}.wav")), bytes).unwrap();
        outside(&root, &format!("rec/{index}.md"), "---\ntitle: take\n---\n");
    }

    // The commit hashes and stores 64 MiB. A short save must not wait for it.
    let committing = owner.clone();
    let commit = std::thread::spawn(move || committing.commit());
    eventually("the commit to start", || {
        owner.snapshot().activity.commit.active
    });
    let started = Instant::now();
    save(
        &owner,
        "note.md",
        "written while the audio was being hashed",
    );
    let save_took = started.elapsed();
    let still_hashing = owner.snapshot().activity.commit.active;
    let first = commit.join().unwrap();
    assert!(
        still_hashing,
        "the save returned after {save_took:?}, while the commit was still running"
    );

    let CommitOutcome::Committed { changed_paths, .. } = &first else {
        panic!("{first:?}");
    };
    assert!(
        *changed_paths == 16 || *changed_paths == 17,
        "{changed_paths}"
    );
    let status = owner.status().unwrap();
    let second = owner.commit();
    for (index, digest) in digests.iter().enumerate() {
        let blob = std::process::Command::new("git")
            .args(["cat-file", "blob", &format!("HEAD:rec/{index}.wav")])
            .current_dir(&root)
            .output()
            .unwrap();
        assert_eq!(blob.stdout.len(), SIZE);
        assert_eq!(Sha256::digest(&blob.stdout), *digest, "rec/{index}.wav");
    }
    assert_eq!(
        git(&root, &["show", "HEAD:note.md"]),
        "written while the audio was being hashed"
    );
    assert_eq!(
        git(&root, &["ls-tree", "-r", "HEAD"])
            .lines()
            .filter(|line| !line.starts_with("100644 blob"))
            .count(),
        0,
        "every entry is a plain file"
    );

    let wire = [
        serde_json::to_string(&first).unwrap(),
        serde_json::to_string(&second).unwrap(),
        serde_json::to_string(&status).unwrap(),
        serde_json::to_string(&*owner.snapshot()).unwrap(),
    ];
    for response in &wire {
        assert!(
            response.len() < 4096,
            "{} bytes: {response}",
            response.len()
        );
    }
}

// ============================================================================
// Explicit Git
// ============================================================================

#[test]
fn paths_diff_and_log_inspect_the_history_saves_made() {
    let temp = TempDir::new("inspect");
    let root = temp.folder("notes");
    let owner = open(&root);
    save(&owner, "a.md", "A\n");
    settled(&owner);
    save(&owner, "b.md", "B\n");
    settled(&owner);
    // Another program changes a file the folder committed.
    std::fs::write(root.join("a.md"), "changed\n").unwrap();

    let paths = owner.paths().unwrap();
    assert_eq!(
        paths
            .iter()
            .map(|p| format!("{}{} {}", p.index, p.worktree, p.path))
            .collect::<Vec<_>>(),
        vec![" M a.md"]
    );
    let diff = owner.diff(&["a.md".to_string()]).unwrap();
    assert!(diff.contains("-A") && diff.contains("+changed"), "{diff}");
    assert_eq!(owner.diff(&["b.md".to_string()]).unwrap(), "");
    let log = owner.log(10).unwrap();
    assert_eq!(
        log.iter()
            .map(|commit| commit.message.trim_end())
            .collect::<Vec<_>>(),
        vec!["Add b.md", "Add a.md"]
    );
    assert_eq!(log[0].parents, vec![log[1].oid.clone()]);
    assert_eq!(log[0].author.name, "Test Author");
    assert_eq!(owner.log(1).unwrap().len(), 1);
}

#[cfg(unix)]
#[test]
fn automatic_commits_run_no_commit_hooks_and_ignore_configured_signing() {
    use std::os::unix::fs::PermissionsExt;

    let temp = TempDir::new("no-hooks");
    let root = temp.folder("notes");
    let owner = open(&root);
    let hook = root.join(".git/hooks/pre-commit");
    std::fs::create_dir_all(hook.parent().unwrap()).unwrap();
    std::fs::write(&hook, "#!/bin/sh\nprintf ran > hook-ran\nexit 1\n").unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    git(&root, &["config", "commit.gpgSign", "true"]);
    git(
        &root,
        &["config", "gpg.program", "/nonexistent-folder-test-signer"],
    );

    save(&owner, "a.md", "A");
    settled(&owner);

    let head = git(&root, &["rev-parse", "HEAD"]);
    assert!(!root.join("hook-ran").exists());
    assert!(!git(&root, &["cat-file", "commit", &head]).contains("\ngpgsig "));
}

// ============================================================================
// Remote
// ============================================================================

fn with_remote(root: &Path, bare: &Path) -> FolderOwner {
    FolderOwner::open(FolderConfig {
        remote: Some(Remote {
            url: bare.display().to_string(),
            branch: "main".to_string(),
        }),
        ..config(root)
    })
    .unwrap()
}

#[test]
fn a_save_is_committed_locally_then_explicitly_pushed_and_another_folder_fast_forwards_to_it() {
    let temp = TempDir::new("remote");
    let bare = temp.folder("remote.git");
    git(
        &bare,
        &["init", "--quiet", "--bare", "--initial-branch=main"],
    );
    let first_root = temp.folder("first");
    let first = with_remote(&first_root, &bare);
    assert_eq!(
        first.fetch(None).unwrap().oid,
        None,
        "the remote has no branch yet"
    );

    save(&first, "a.md", "A");
    settled(&first);
    assert!(first.snapshot().last_push.is_none());
    assert!(!bare.join("refs/heads/main").exists());
    pushed(&first, &first_root);
    let head = git(&first_root, &["rev-parse", "HEAD"]);
    assert_eq!(
        first.snapshot().last_push.as_ref().unwrap().result,
        PushOutcome::Pushed { oid: head.clone() }
    );
    assert_eq!(git(&bare, &["rev-parse", "main"]), head);
    let Observation::Observed { value: sync, .. } = &first.snapshot().sync else {
        panic!("sync is observed after a push");
    };
    assert_eq!(
        (sync.ahead, sync.behind, sync.remote.as_deref()),
        (0, 0, Some(head.as_str()))
    );

    let second_root = temp.folder("second");
    let second = with_remote(&second_root, &bare);
    assert_eq!(second.pull_fast_forward(), Err(PullError::NoFetchedHead));
    std::fs::write(second_root.join(".git/info/exclude"), "ignored.md\n").unwrap();
    std::fs::write(second_root.join("ignored.md"), "kept").unwrap();
    assert_eq!(second.fetch(None).unwrap().oid, Some(head.clone()));
    assert_eq!(
        second.pull_fast_forward(),
        Ok(PullOutcome::FastForwarded {
            from: None,
            to: head.clone(),
            changed_paths: vec!["a.md".to_string()],
        })
    );
    assert_eq!(second.read("a.md").unwrap().bytes, b"A");
    assert_eq!(second.read("ignored.md").unwrap().bytes, b"kept");
    assert_eq!(git(&second_root, &["rev-parse", "HEAD"]), head);
    assert_eq!(git(&second_root, &["status", "--porcelain"]), "");
    assert_eq!(
        second.pull_fast_forward(),
        Ok(PullOutcome::UpToDate {
            head: Some(head.clone())
        })
    );

    // An edit and an addition travel as one fast-forward. They are one save:
    // a second save made while the first one's commit ran would be a second
    // commit.
    first
        .apply(&[overwrite("a.md", "A2"), overwrite("dir/b.md", "B")])
        .unwrap();
    settled(&first);
    pushed(&first, &first_root);
    let next = git(&first_root, &["rev-parse", "HEAD"]);
    assert_eq!(git(&bare, &["rev-parse", "main"]), next);
    second.fetch(None).unwrap();
    std::fs::write(second_root.join("a.md"), "local edit").unwrap();
    std::fs::write(second_root.join("untracked.md"), "new local work").unwrap();
    assert_eq!(
        second.pull_fast_forward(),
        Err(PullError::Dirty {
            paths: vec!["a.md".to_string(), "untracked.md".to_string()]
        })
    );
    std::fs::write(second_root.join("a.md"), "A").unwrap();
    std::fs::remove_file(second_root.join("untracked.md")).unwrap();
    std::fs::write(second_root.join(".git/info/exclude"), "ignored.md\ndir/\n").unwrap();
    save(&second, "dir/b.md", "an ignored file in the way");
    assert_eq!(
        second.pull_fast_forward(),
        Err(PullError::Collision {
            paths: vec!["dir/b.md".to_string()]
        })
    );
    assert_eq!(
        second.read("dir/b.md").unwrap().bytes,
        b"an ignored file in the way"
    );
    std::fs::remove_dir_all(second_root.join("dir")).unwrap();
    assert!(matches!(
        second.pull_fast_forward(),
        Ok(PullOutcome::FastForwarded { ref to, ref changed_paths, .. })
            if *to == next && *changed_paths == vec!["a.md".to_string(), "dir/b.md".to_string()]
    ));
    assert_eq!(second.read("a.md").unwrap().bytes, b"A2");
    assert_eq!(second.read("dir/b.md").unwrap().bytes, b"B");

    // Local history the remote lacks is ahead; unrelated history has diverged.
    save(&second, "c.md", "C");
    second.commit();
    assert!(matches!(
        second.pull_fast_forward(),
        Ok(PullOutcome::Ahead { .. })
    ));
    save(&first, "d.md", "D");
    settled(&first);
    pushed(&first, &first_root);
    assert_eq!(
        git(&bare, &["rev-parse", "main"]),
        git(&first_root, &["rev-parse", "HEAD"])
    );
    second.fetch(None).unwrap();
    assert!(matches!(
        second.pull_fast_forward(),
        Err(PullError::Diverged { .. })
    ));
    assert!(
        matches!(second.push(None), PushOutcome::Failed { .. }),
        "a non-fast-forward push is refused"
    );
}

#[test]
fn a_fast_forward_asked_for_during_a_commit_waits_for_it_and_is_not_undone_by_it() {
    let temp = TempDir::new("waiting-pull");
    let bare = temp.folder("remote.git");
    git(
        &bare,
        &["init", "--quiet", "--bare", "--initial-branch=main"],
    );
    let upstream_root = temp.folder("upstream");
    let upstream = with_remote(&upstream_root, &bare);
    save(&upstream, "shared.md", "one");
    upstream.commit();
    assert!(matches!(upstream.push(None), PushOutcome::Pushed { .. }));

    let root = temp.folder("local");
    let owner = with_remote(&root, &bare);
    owner.fetch(None).unwrap();
    owner.pull_fast_forward().unwrap();
    save(&upstream, "shared.md", "two, from upstream");
    upstream.commit();
    assert!(matches!(upstream.push(None), PushOutcome::Pushed { .. }));
    let incoming = owner.fetch(None).unwrap().oid.unwrap();

    let old = git(&root, &["rev-parse", "HEAD"]);

    // A commit snapshots the clean folder at the old head and is held under
    // the Git lock. The fast-forward is asked for now.
    let (hook, at_hash, release) = hold_once();
    owner.hooks().before_hash = Some(hook);
    let committing = {
        let owner = owner.clone();
        std::thread::spawn(move || owner.commit())
    };
    at_hash.recv().unwrap();
    let pulling = {
        let owner = owner.clone();
        std::thread::spawn(move || owner.pull_fast_forward())
    };
    // It cannot move the files or the branch under the held commit: the
    // commit pinned the old head, and it finds that head unchanged.
    release.send(()).unwrap();
    assert_eq!(
        committing.join().unwrap(),
        CommitOutcome::Unchanged {
            head: Some(old.clone()),
            index_warning: None
        }
    );
    // Then the fast-forward runs, on what it reads once it holds both locks.
    assert_eq!(
        pulling.join().unwrap(),
        Ok(PullOutcome::FastForwarded {
            from: Some(old),
            to: incoming.clone(),
            changed_paths: vec!["shared.md".to_string()],
        })
    );
    assert_eq!(git(&root, &["rev-parse", "HEAD"]), incoming);
    assert_eq!(
        owner.read("shared.md").unwrap().bytes,
        b"two, from upstream"
    );
    assert_eq!(git(&root, &["status", "--porcelain"]), "");
}

#[test]
fn a_fast_forward_never_overwrites_bytes_written_after_it_found_the_folder_clean() {
    let temp = TempDir::new("pull-baseline");
    let bare = temp.folder("remote.git");
    git(
        &bare,
        &["init", "--quiet", "--bare", "--initial-branch=main"],
    );
    let upstream_root = temp.folder("upstream");
    let upstream = with_remote(&upstream_root, &bare);
    save(&upstream, "edited.md", "committed");
    save(&upstream, "removed.md", "committed");
    upstream.commit();
    upstream.push(None);

    let root = temp.folder("local");
    let owner = with_remote(&root, &bare);
    owner.fetch(None).unwrap();
    owner.pull_fast_forward().unwrap();
    let head = git(&root, &["rev-parse", "HEAD"]);
    save(&upstream, "edited.md", "incoming");
    upstream
        .apply(&[FileChange::Remove {
            path: "removed.md".into(),
            expected_sha256: None,
        }])
        .unwrap();
    upstream.commit();
    upstream.push(None);
    owner.fetch(None).unwrap();

    // The folder was clean when the fast-forward looked. Before it builds its
    // changes, another program writes both files it is about to touch.
    let outside = root.clone();
    owner.hooks().during_pull = Some(Arc::new(move || {
        std::fs::write(outside.join("edited.md"), "written by another program").unwrap();
        std::fs::write(outside.join("removed.md"), "also written outside").unwrap();
    }));

    // The update's own look at every path, after its record is in place and
    // before it writes, finds both in neither state. It is withdrawn whole:
    // nothing written, no record left, the branch where it was.
    assert_eq!(
        owner.pull_fast_forward(),
        Err(PullError::Dirty {
            paths: vec!["edited.md".to_string(), "removed.md".to_string()]
        })
    );
    assert_eq!(owner.snapshot().pending_incoming, None);
    assert_eq!(git(&root, &["for-each-ref", "refs/epicenter"]), "");
    assert!(!root.join(".git/epicenter/incoming.json").exists());
    assert_eq!(
        std::fs::read_to_string(root.join("edited.md")).unwrap(),
        "written by another program"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("removed.md")).unwrap(),
        "also written outside"
    );
    assert_eq!(
        git(&root, &["rev-parse", "HEAD"]),
        head,
        "the branch did not move"
    );
}

#[test]
fn a_repository_that_configures_its_identity_and_remote_keeps_them() {
    let temp = TempDir::new("repo-config");
    let bare = temp.folder("remote.git");
    git(
        &bare,
        &["init", "--quiet", "--bare", "--initial-branch=main"],
    );

    // Someone set this directory up with Git before the app opened it.
    let configured_root = temp.folder("configured");
    git(
        &configured_root,
        &["init", "--quiet", "--initial-branch=main"],
    );
    git(&configured_root, &["config", "user.name", "Ada Lovelace"]);
    git(
        &configured_root,
        &["config", "user.email", "ada@example.com"],
    );
    git(
        &configured_root,
        &["remote", "add", "origin", &bare.display().to_string()],
    );
    let honoring = |root: &Path| {
        FolderOwner::open(FolderConfig {
            use_repository_author: true,
            use_repository_origin: true,
            ..config(root)
        })
        .unwrap()
    };
    let configured = honoring(&configured_root);
    assert_eq!(configured.author().name, "Ada Lovelace");
    assert_eq!(
        configured.snapshot().remote,
        Some(Remote {
            url: bare.display().to_string(),
            branch: "main".to_string(),
        })
    );
    save(&configured, "a.md", "A");
    settled(&configured);
    assert!(configured.snapshot().last_push.is_none());
    assert!(!bare.join("refs/heads/main").exists());
    pushed(&configured, &configured_root);
    assert_eq!(
        git(&configured_root, &["log", "-1", "--format=%an <%ae>"]),
        "Ada Lovelace <ada@example.com>"
    );
    assert_eq!(
        git(&bare, &["rev-parse", "main"]),
        git(&configured_root, &["rev-parse", "HEAD"])
    );

    // A directory with nothing configured uses what the shell supplied.
    let plain_root = temp.folder("plain");
    let plain = honoring(&plain_root);
    assert_eq!(plain.author(), &crate::testing::author());
    assert_eq!(plain.snapshot().remote, None);

    // Without the options, the repository's configuration is not consulted.
    configured.shutdown();
    let fixed = FolderOwner::open(config(&configured_root)).unwrap();
    assert_eq!(fixed.author(), &crate::testing::author());
    assert_eq!(fixed.snapshot().remote, None);
}

#[test]
fn reading_the_repository_author_does_not_turn_on_its_remote() {
    let temp = TempDir::new("author-only");
    let origin = temp.folder("origin.git");
    git(
        &origin,
        &["init", "--quiet", "--bare", "--initial-branch=main"],
    );
    let origin_before = tree(&origin);

    // The directory has an identity and an `origin`, as a person's might.
    let root = temp.folder("capture");
    git(&root, &["init", "--quiet", "--initial-branch=main"]);
    git(&root, &["config", "user.name", "Ada Lovelace"]);
    git(&root, &["config", "user.email", "ada@example.com"]);
    git(
        &root,
        &["remote", "add", "origin", &origin.display().to_string()],
    );

    let owner = FolderOwner::open(FolderConfig {
        use_repository_author: true,
        ..config(&root)
    })
    .unwrap();
    assert_eq!(
        owner.author(),
        &crate::git::Author {
            name: "Ada Lovelace".to_string(),
            email: "ada@example.com".to_string(),
        }
    );
    assert_eq!(
        owner.snapshot().remote,
        None,
        "the configured origin stays unused"
    );

    // A save is committed locally, by the configured author, and goes nowhere.
    save(&owner, "a.md", "A");
    // The commit decides about its push before it stops being active.
    settled(&owner);
    let snapshot = owner.snapshot();
    assert!(matches!(
        snapshot.last_commit.as_ref().unwrap().result,
        CommitOutcome::Committed { .. }
    ));
    assert_eq!(snapshot.last_push, None, "no push was attempted");
    assert!(!snapshot.activity.push.active);
    assert_eq!(
        git(&root, &["log", "-1", "--format=%an <%ae> %s"]),
        "Ada Lovelace <ada@example.com> Add a.md"
    );
    assert_eq!(
        tree(&origin),
        origin_before,
        "the origin was never contacted"
    );
    assert_eq!(
        git(&root, &["for-each-ref", "refs/remotes"]),
        "",
        "no remote-tracking ref was written"
    );
    // Asked directly, remote operations say there is no remote.
    assert_eq!(owner.push(None), PushOutcome::NoRemote);
    assert_eq!(owner.fetch(None), Err(GitError::NoRemote));
    owner.shutdown();

    // The origin alone: the remote is used, the supplied author commits.
    let origin_only = FolderOwner::open(FolderConfig {
        use_repository_origin: true,
        ..config(&root)
    })
    .unwrap();
    assert_eq!(origin_only.author(), &crate::testing::author());
    assert_eq!(
        origin_only.snapshot().remote,
        Some(Remote {
            url: origin.display().to_string(),
            branch: "main".to_string(),
        })
    );
    origin_only.shutdown();

    // An explicit remote is honored with discovery off, and is the fallback
    // when discovery is on and the repository has no `origin`.
    let explicit = Remote {
        url: temp.path().join("explicit.git").display().to_string(),
        branch: "main".to_string(),
    };
    let supplied = FolderOwner::open(FolderConfig {
        use_repository_author: true,
        remote: Some(explicit.clone()),
        ..config(&root)
    })
    .unwrap();
    assert_eq!(supplied.snapshot().remote, Some(explicit.clone()));
    supplied.shutdown();
    let bare_root = temp.folder("no-origin");
    let fallback = FolderOwner::open(FolderConfig {
        use_repository_origin: true,
        remote: Some(explicit.clone()),
        ..config(&bare_root)
    })
    .unwrap();
    assert_eq!(fallback.snapshot().remote, Some(explicit));
}

/// A valid Git LFS pointer: what a repository stores for a file whose bytes
/// live elsewhere. No LFS program is involved in writing it here.
const LFS_POINTER: &str = "version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12345\n";

/// A folder that has fast-forwarded to an upstream commit holding real audio,
/// and the plain Git clone that upstream commits are made in.
struct Incoming {
    _temp: TempDir,
    upstream: std::path::PathBuf,
    root: std::path::PathBuf,
    owner: FolderOwner,
}

fn incoming(label: &str) -> Incoming {
    let temp = TempDir::new(label);
    let bare = temp.folder("remote.git");
    git(
        &bare,
        &["init", "--quiet", "--bare", "--initial-branch=main"],
    );
    // Another program's clone: plain Git, so it can commit what the owner
    // itself would refuse to.
    let upstream = temp.folder("upstream");
    git(&upstream, &["init", "--quiet", "--initial-branch=main"]);
    git(
        &upstream,
        &["remote", "add", "origin", &bare.display().to_string()],
    );
    std::fs::create_dir_all(upstream.join("rec/nested")).unwrap();
    std::fs::write(upstream.join("rec/take.wav"), "RIFF real audio bytes").unwrap();
    std::fs::write(upstream.join("rec/nested/deep.wav"), "RIFF deeper audio").unwrap();
    std::fs::write(upstream.join("notes.md"), "line one\nline two\n").unwrap();
    git(&upstream, &["add", "--all"]);
    git(&upstream, &["commit", "--quiet", "-m", "audio"]);
    git(&upstream, &["push", "--quiet", "origin", "main"]);

    let root = temp.folder("local");
    let owner = with_remote(&root, &bare);
    owner.fetch(None).unwrap();
    assert!(matches!(
        owner.pull_fast_forward(),
        Ok(PullOutcome::FastForwarded { .. })
    ));
    Incoming {
        _temp: temp,
        upstream,
        root,
        owner,
    }
}

impl Incoming {
    /// Commit the upstream working tree and make it the fetched head.
    fn publish(&self, message: &str) -> String {
        git(&self.upstream, &["add", "--all"]);
        git(&self.upstream, &["commit", "--quiet", "-m", message]);
        git(&self.upstream, &["push", "--quiet", "origin", "main"]);
        self.owner.fetch(None).unwrap().oid.unwrap()
    }

    /// The fast-forward is refused for `path` and nothing at all changed:
    /// no working file, no index entry, no ref.
    fn refused_untouched(&self, path: &str, reason_holds: &str) {
        let head = git(&self.root, &["rev-parse", "HEAD"]);
        let before = tree(&self.root);
        let refused = self.owner.pull_fast_forward().unwrap_err();
        let PullError::Unrepresentable { paths, reason } = &refused else {
            panic!("the incoming commit is unrepresentable, not {refused:?}");
        };
        assert_eq!(paths, &vec![path.to_string()]);
        assert!(reason.contains(reason_holds), "{reason}");
        assert_eq!(git(&self.root, &["rev-parse", "HEAD"]), head);
        assert_eq!(
            git(
                &self.root,
                &["--no-optional-locks", "status", "--porcelain"]
            ),
            ""
        );
        let after = tree(&self.root);
        let changed: Vec<&String> = before
            .iter()
            .zip(&after)
            .filter(|(a, b)| a != b)
            .map(|(a, _)| &a.0)
            // The fetch itself records the remote head and its objects.
            .filter(|name| {
                !name.starts_with(".git/objects")
                    && !name.starts_with(".git/refs/remotes")
                    && !name.starts_with(".git/logs/refs/remotes")
                    && *name != ".git/FETCH_HEAD"
            })
            .collect();
        assert!(changed.is_empty(), "{changed:?}");
        assert_eq!(
            std::fs::read_to_string(self.root.join("rec/take.wav")).unwrap(),
            "RIFF real audio bytes",
            "the current audio is still the audio"
        );
    }
}

#[test]
fn an_incoming_commit_that_declares_an_lfs_filter_is_refused_before_any_write() {
    // At the root: the remote starts tracking audio with LFS and replaces the
    // bytes with a pointer.
    let rooted = incoming("lfs-root");
    std::fs::write(
        rooted.upstream.join(".gitattributes"),
        "*.wav filter=lfs diff=lfs merge=lfs -text\n",
    )
    .unwrap();
    std::fs::write(rooted.upstream.join("rec/take.wav"), LFS_POINTER).unwrap();
    rooted.publish("track audio with lfs");
    rooted.refused_untouched("rec/nested/deep.wav", "filter=lfs");
    assert!(!rooted.root.join(".gitattributes").exists());

    // In a nested `.gitattributes`, selecting only files below it.
    let nested = incoming("lfs-nested");
    std::fs::write(
        nested.upstream.join("rec/nested/.gitattributes"),
        "deep.wav filter=lfs\n",
    )
    .unwrap();
    std::fs::write(nested.upstream.join("rec/nested/deep.wav"), LFS_POINTER).unwrap();
    nested.publish("track one nested file with lfs");
    nested.refused_untouched("rec/nested/deep.wav", "filter=lfs");
    assert_eq!(
        std::fs::read_to_string(nested.root.join("rec/nested/deep.wav")).unwrap(),
        "RIFF deeper audio"
    );
}

#[test]
fn an_incoming_normalizing_attribute_is_refused_even_when_it_only_selects_unchanged_files() {
    // Line-ending conversion declared for a file the commit does not touch.
    let converting = incoming("incoming-eol");
    std::fs::write(
        converting.upstream.join(".gitattributes"),
        "*.md text eol=crlf\n",
    )
    .unwrap();
    converting.publish("normalize markdown line endings");
    converting.refused_untouched("notes.md", "text");

    // The working tree's own attributes do not mask the incoming commit's:
    // locally the file is declared plain, upstream declares a filter.
    let masked = incoming("incoming-masked");
    std::fs::write(masked.root.join(".git/info/exclude"), ".gitattributes\n").unwrap();
    std::fs::write(masked.upstream.join(".gitattributes"), "*.wav filter=lfs\n").unwrap();
    masked.publish("filter audio");
    std::fs::write(masked.root.join(".gitattributes"), "*.wav -filter\n").unwrap();
    let refused = masked.owner.pull_fast_forward().unwrap_err();
    assert!(
        matches!(refused, PullError::Unrepresentable { ref reason, .. } if reason.contains("filter=lfs")),
        "{refused:?}"
    );
    assert_eq!(
        std::fs::read_to_string(masked.root.join("rec/take.wav")).unwrap(),
        "RIFF real audio bytes"
    );
}

#[test]
fn pointer_shaped_text_with_no_declared_filter_fast_forwards_byte_for_byte() {
    let plain = incoming("pointer-text");
    // Someone keeps an LFS pointer as an ordinary file, and declares
    // attributes that change no bytes.
    std::fs::write(plain.upstream.join("rec/take.wav"), LFS_POINTER).unwrap();
    std::fs::write(plain.upstream.join("example-pointer.txt"), LFS_POINTER).unwrap();
    std::fs::write(
        plain.upstream.join(".gitattributes"),
        "*.wav -text diff=audio\n*.md linguist-documentation\n",
    )
    .unwrap();
    let head = plain.publish("keep a pointer as plain text");

    assert!(matches!(
        plain.owner.pull_fast_forward(),
        Ok(PullOutcome::FastForwarded { ref to, ref changed_paths, .. })
            if *to == head && changed_paths.len() == 3
    ));
    for path in ["rec/take.wav", "example-pointer.txt"] {
        assert_eq!(
            std::fs::read_to_string(plain.root.join(path)).unwrap(),
            LFS_POINTER,
            "{path}"
        );
    }
    assert_eq!(git(&plain.root, &["rev-parse", "HEAD"]), head);
    assert_eq!(git(&plain.root, &["status", "--porcelain"]), "");
}

/// A hook that counts every transport the owner admits and holds the first
/// one, after reporting it, until released.
fn count_and_hold_first() -> (
    Arc<dyn Fn() + Send + Sync>,
    Arc<std::sync::atomic::AtomicUsize>,
    mpsc::Receiver<()>,
    mpsc::Sender<()>,
) {
    let admitted = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = Arc::clone(&admitted);
    let (hold, at_hook, release) = hold_once();
    let hook: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
        counter.fetch_add(1, Ordering::SeqCst);
        hold();
    });
    (hook, admitted, at_hook, release)
}

#[test]
fn a_push_withdrawn_before_its_transport_starts_never_runs_and_others_are_kept() {
    let temp = TempDir::new("withdraw-push");
    let bare = temp.folder("remote.git");
    git(
        &bare,
        &["init", "--quiet", "--bare", "--initial-branch=main"],
    );
    let root = temp.folder("notes");
    let owner = with_remote(&root, &bare);
    save(&owner, "a.md", "A");
    owner.commit();
    let first = git(&root, &["rev-parse", "HEAD"]);
    let (hook, admitted, at_hook, release) = count_and_hold_first();
    owner.hooks().during_push = Some(hook);

    // A's transport is admitted: it pinned the first commit and is held
    // before `git push` starts. A itself then withdraws.
    let a = owner.request();
    let a_pushing = {
        let (owner, caller) = (owner.clone(), a.caller());
        std::thread::spawn(move || owner.push(Some(&caller)))
    };
    at_hook.recv().unwrap();
    drop(a);
    // A second commit, so a push that started for B or C would have work.
    save(&owner, "b.md", "B");
    owner.commit();
    let second = git(&root, &["rev-parse", "HEAD"]);

    // B and C ask while A is held. B withdraws; C does not.
    let (b, c) = (owner.request(), owner.request());
    let b_pushing = {
        let (owner, caller) = (owner.clone(), b.caller());
        std::thread::spawn(move || owner.push(Some(&caller)))
    };
    let c_pushing = {
        let (owner, caller) = (owner.clone(), c.caller());
        std::thread::spawn(move || owner.push(Some(&caller)))
    };
    drop(b);
    // B hears at once that nothing was pinned or sent for it, whether it was
    // already waiting behind A or had not yet asked.
    assert_eq!(
        b_pushing.join().unwrap(),
        PushOutcome::Cancelled { oid: None }
    );
    assert_eq!(admitted.load(Ordering::SeqCst), 1, "only A was admitted");
    assert!(
        !bare.join("refs/heads/main").exists(),
        "A is still held before its transport"
    );

    // The admitted transport outlives its caller's withdrawal and finishes.
    release.send(()).unwrap();
    assert_eq!(
        a_pushing.join().unwrap(),
        PushOutcome::Pushed { oid: first }
    );
    // C's push runs once, for C alone, and pins the head as it is then.
    assert_eq!(
        c_pushing.join().unwrap(),
        PushOutcome::Pushed {
            oid: second.clone()
        }
    );
    assert_eq!(git(&bare, &["rev-parse", "main"]), second);
    assert_eq!(
        admitted.load(Ordering::SeqCst),
        2,
        "A and C; B's push never started"
    );
    // Nothing of B's is left behind: the next push is the third admitted.
    assert_eq!(owner.push(None), PushOutcome::Pushed { oid: second });
    assert_eq!(admitted.load(Ordering::SeqCst), 3);

    // A request withdrawn before it asks is refused on arrival.
    let early = owner.request();
    let caller = early.caller();
    drop(early);
    assert_eq!(
        owner.push(Some(&caller)),
        PushOutcome::Cancelled { oid: None }
    );
    assert_eq!(owner.fetch(Some(&caller)), Err(GitError::Withdrawn));
    assert_eq!(admitted.load(Ordering::SeqCst), 3);
}

#[test]
fn a_fetch_withdrawn_before_its_transport_starts_never_runs() {
    let fetching = incoming("withdraw-fetch");
    let owner = &fetching.owner;
    let head = git(&fetching.root, &["rev-parse", "HEAD"]);
    let (hook, admitted, at_hook, release) = count_and_hold_first();
    owner.hooks().during_fetch = Some(hook);
    let before = owner.snapshot().last_fetch.clone();

    let a_fetching = {
        let owner = owner.clone();
        std::thread::spawn(move || owner.fetch(None))
    };
    at_hook.recv().unwrap();
    // B asks while A's fetch is held, and withdraws.
    let b = owner.request();
    let b_fetching = {
        let (owner, caller) = (owner.clone(), b.caller());
        std::thread::spawn(move || owner.fetch(Some(&caller)))
    };
    drop(b);
    assert_eq!(b_fetching.join().unwrap(), Err(GitError::Withdrawn));
    assert_eq!(admitted.load(Ordering::SeqCst), 1, "only A was admitted");
    assert_eq!(
        owner.snapshot().last_fetch,
        before,
        "a withdrawn fetch is not an attempt"
    );

    release.send(()).unwrap();
    assert_eq!(
        a_fetching.join().unwrap(),
        Ok(crate::history::FetchOutcome {
            oid: Some(head.clone())
        })
    );
    // B's fetch never started: the next one is the second ever admitted.
    assert_eq!(owner.fetch(None).unwrap().oid, Some(head));
    assert_eq!(admitted.load(Ordering::SeqCst), 2);
}

#[test]
fn a_fetch_and_a_push_in_flight_hold_no_save_and_no_commit_back() {
    let temp = TempDir::new("network-held");
    let bare = temp.folder("remote.git");
    git(
        &bare,
        &["init", "--quiet", "--bare", "--initial-branch=main"],
    );
    let upstream_root = temp.folder("upstream");
    let upstream = with_remote(&upstream_root, &bare);
    save(&upstream, "shared.md", "one");
    upstream.commit();
    assert!(matches!(upstream.push(None), PushOutcome::Pushed { .. }));

    // A folder that commits on edit, level with the remote. The remote then
    // moves on, so the fetch below has a commit to bring in.
    let root = temp.folder("local");
    let owner = with_remote(&root, &bare);
    owner.fetch(None).unwrap();
    owner.pull_fast_forward().unwrap();
    let base = git(&root, &["rev-parse", "HEAD"]);
    save(&upstream, "shared.md", "two");
    upstream.commit();
    assert!(matches!(upstream.push(None), PushOutcome::Pushed { .. }));
    let incoming = git(&upstream_root, &["rev-parse", "HEAD"]);

    let (fetch_hook, fetches, at_fetch, release_fetch) = count_and_hold_first();
    let (push_hook, pushes, at_push, release_push) = count_and_hold_first();
    owner.hooks().during_fetch = Some(fetch_hook);
    owner.hooks().during_push = Some(push_hook);

    // As a terminal's `git fetch` does: the owner admits the transport, and
    // it stays in flight for as long as the remote takes.
    let request = owner.request();
    let fetching = {
        let (owner, caller) = (owner.clone(), request.caller());
        std::thread::spawn(move || owner.fetch(Some(&caller)))
    };
    at_fetch.recv().unwrap();
    assert!(owner.snapshot().activity.fetch.active);

    // A save lands and its own attempt commits it, with the fetch in flight.
    save(&owner, "a.md", "A");
    settled(&owner);
    let first = git(&root, &["rev-parse", "HEAD"]);
    assert!(matches!(
        &owner.snapshot().last_commit.as_ref().unwrap().result,
        CommitOutcome::Committed { oid, parent, message, .. }
            if *oid == first && parent.as_deref() == Some(base.as_str()) && message == "Add a.md"
    ));
    // The save stays local. An explicit push is admitted and held as well.
    assert!(owner.snapshot().last_push.is_none());
    let pushing = {
        let owner = owner.clone();
        std::thread::spawn(move || owner.push(None))
    };
    at_push.recv().unwrap();
    let snapshot = owner.snapshot();
    assert!(snapshot.activity.fetch.active && snapshot.activity.push.active);

    // With both in flight: a second save is committed by its own attempt, a
    // replacement over a stale hash is still refused, and explicit work runs.
    let read = owner.read("a.md").unwrap().sha256;
    save(&owner, "b.md", "B");
    settled(&owner);
    assert_eq!(subjects(&root)[..2], ["Add b.md", "Add a.md"]);
    save(&owner, "a.md", "A, from another window");
    settled(&owner);
    assert!(matches!(
        owner.apply(&[replace("a.md", "built on the stale read", &read)]),
        Err(crate::files::ApplyError::Refused {
            error: crate::files::FileError::Conflict { .. }
        })
    ));
    assert!(owner.status().unwrap().changes.is_empty());
    assert!(matches!(owner.commit(), CommitOutcome::Unchanged { .. }));
    let snapshot = owner.snapshot();
    assert!(snapshot.activity.fetch.active && snapshot.activity.push.active);
    assert_eq!(fetches.load(Ordering::SeqCst), 1);
    assert_eq!(
        pushes.load(Ordering::SeqCst),
        1,
        "later attempts owed no push"
    );

    // Both transports then run for real. The fetch brings in the remote's
    // commit; the push carries the commit it pinned when it was admitted,
    // which the remote refuses because it has moved on.
    release_fetch.send(()).unwrap();
    assert_eq!(
        fetching.join().unwrap(),
        Ok(crate::history::FetchOutcome {
            oid: Some(incoming.clone())
        })
    );
    assert_eq!(
        git(&root, &["rev-parse", "refs/remotes/origin/main"]),
        incoming
    );
    release_push.send(()).unwrap();
    assert!(matches!(
        pushing.join().unwrap(),
        PushOutcome::Failed { .. }
    ));
    eventually("the push to settle", || {
        owner.snapshot().last_push.is_some()
    });
    assert!(matches!(
        &owner.snapshot().last_push.as_ref().unwrap().result,
        PushOutcome::Failed { oid, .. } if *oid == first
    ));
    assert_eq!(git(&bare, &["rev-parse", "main"]), incoming);
}

#[test]
fn remote_operations_without_a_remote_say_so() {
    let temp = TempDir::new("no-remote");
    let root = temp.folder("notes");
    let owner = open(&root);
    assert_eq!(owner.push(None), PushOutcome::NoRemote);
    assert_eq!(owner.fetch(None), Err(GitError::NoRemote));
    assert_eq!(
        owner.pull_fast_forward(),
        Err(PullError::Git {
            error: GitError::NoRemote
        })
    );
}

#[test]
fn an_unreachable_remote_fails_the_push_and_the_fetch_but_not_the_commit() {
    let temp = TempDir::new("bad-remote");
    let root = temp.folder("notes");
    let missing = temp.path().join("no-such-remote.git");
    let owner = with_remote(&root, &missing);
    save(&owner, "a.md", "A");
    settled(&owner);
    assert!(owner.snapshot().last_push.is_none());
    assert!(matches!(owner.push(None), PushOutcome::Failed { .. }));
    assert_eq!(subjects(&root), vec!["Add a.md"]);
    assert!(matches!(
        owner.snapshot().last_push.as_ref().unwrap().result,
        PushOutcome::Failed { .. }
    ));
    assert!(
        matches!(owner.fetch(None), Err(GitError::Failed { ref operation, .. }) if operation == "fetch")
    );
}

// ============================================================================
// Shutdown
// ============================================================================

#[test]
fn shutdown_waits_for_an_admitted_commit_and_commits_nothing_of_its_own() {
    let temp = TempDir::new("shutdown-commit");
    let root = temp.folder("notes");
    let owner = open(&root);
    let (hook, at_capture, release) = hold_once();
    owner.hooks().after_capture = Some(hook);

    // A's commit is admitted and held before it publishes. B's request waits
    // for the worker that is committing A. The handle that saved is gone.
    {
        let page = owner.clone();
        save(&page, "a.md", "A");
        at_capture.recv().unwrap();
        save(&page, "b.md", "B");
    }

    let closing = owner.clone();
    let (closed, finished) = mpsc::channel();
    let shutdown = std::thread::spawn(move || {
        closing.shutdown();
        closed.send(()).unwrap();
    });
    eventually("the fence", || owner.snapshot().closed);
    assert_eq!(owner.commit(), CommitOutcome::Closed);
    assert!(
        finished.recv_timeout(Duration::from_millis(150)).is_err(),
        "shutdown waits for the admitted commit"
    );
    assert!(owner.snapshot().activity.commit.active);

    release.send(()).unwrap();
    shutdown.join().unwrap();
    // Read with no waiting: shutdown returned only after A's commit landed.
    assert_eq!(subjects(&root), vec!["Add a.md"]);
    let snapshot = owner.snapshot();
    assert!(!snapshot.activity.commit.active);
    assert!(matches!(
        &snapshot.last_commit.as_ref().unwrap().result,
        CommitOutcome::Committed { message, .. } if message == "Add a.md"
    ));
    // B's request was not carried past the fence, and there was no last
    // commit for it: B is saved and uncommitted.
    assert_eq!(git(&root, &["status", "--porcelain"]), "?? b.md");
    assert_eq!(std::fs::read_to_string(root.join("b.md")).unwrap(), "B");
}

#[test]
fn a_save_that_lands_after_the_fence_stays_saved_and_starts_no_commit() {
    let temp = TempDir::new("shutdown");
    let root = temp.folder("notes");
    let owner = open(&root);
    let (admitted, at_admission) = mpsc::channel::<()>();
    let (release, gate) = mpsc::channel::<()>();
    let gate = Mutex::new(gate);
    owner.hooks().before_apply = Some(Arc::new(move || {
        admitted.send(()).unwrap();
        gate.lock().unwrap().recv().unwrap();
    }));
    let saver = owner.clone();
    let held =
        std::thread::spawn(move || saver.apply(&[create("held.md", "admitted before shutdown")]));
    at_admission.recv().unwrap();

    let closing = owner.clone();
    let (closed, finished) = mpsc::channel();
    let shutdown = std::thread::spawn(move || {
        closing.shutdown();
        closed.send(()).unwrap();
    });
    eventually("the fence", || owner.snapshot().closed);
    owner.hooks().before_apply = None;
    assert!(matches!(
        owner.apply(&[create("late.md", "refused")]),
        Err(crate::files::ApplyError::Refused {
            error: crate::files::FileError::Closed
        })
    ));
    assert_eq!(owner.paths(), Err(GitError::Closed));
    assert!(
        finished.recv_timeout(Duration::from_millis(150)).is_err(),
        "shutdown waits for the admitted save"
    );

    release.send(()).unwrap();
    held.join().unwrap().unwrap();
    shutdown.join().unwrap();
    // The save was admitted before the fence, so it landed. Its request
    // came after the fence, so no worker was admitted for it.
    assert_eq!(
        std::fs::read_to_string(root.join("held.md")).unwrap(),
        "admitted before shutdown"
    );
    let snapshot = owner.snapshot();
    assert_eq!(snapshot.last_commit, None);
    assert!(!snapshot.activity.commit.active);
    assert!(
        !root.join(".git/refs/heads/main").exists(),
        "nothing was committed"
    );
    assert!(!root.join("late.md").exists());
    assert_eq!(owner.commit(), CommitOutcome::Closed);
    assert_eq!(owner.status(), Err(GitError::Closed));
    owner.shutdown();
}

#[cfg(unix)]
#[test]
fn a_published_commit_survives_a_failed_observation_after_the_root_moves() {
    use std::os::unix::fs::PermissionsExt;

    let temp = TempDir::new("post-publication-observation");
    let root = temp.folder("notes");
    let moved_root = temp.path().join("notes-moved");
    let owner = open(&root);
    outside(&root, "saved.md", "published bytes");
    owner.status().unwrap();
    // Plain Git invokes this after committing the ref transaction. Moving
    // the root then makes the owner's later Git process fail to start in its
    // recorded directory, while the ref and saved file already exist.
    let hook = root.join(".git/hooks/reference-transaction");
    std::fs::write(
        &hook,
        "#!/bin/sh\nif [ \"$1\" = committed ]; then mv \"$PWD\" \"$PWD-moved\"; fi\n",
    )
    .unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    let outcome = owner.commit();
    let snapshot = owner.snapshot();
    assert!(
        moved_root.is_dir(),
        "the Git transaction hook moved the root after publication"
    );
    let published = git(&moved_root, &["rev-parse", "HEAD"]);
    assert_eq!(
        std::fs::read_to_string(moved_root.join("saved.md")).unwrap(),
        "published bytes"
    );
    std::fs::remove_file(moved_root.join(".git/hooks/reference-transaction")).unwrap();
    std::fs::rename(&moved_root, &root).unwrap();
    owner.shutdown();
    assert!(
        matches!(outcome, CommitOutcome::Committed { ref oid, .. } if oid == &published),
        "{outcome:?}"
    );
    assert!(
        matches!(&snapshot.files, Observation::Observed { stale: true, error: Some(error), .. } if error.contains("could not start"))
    );
    assert!(
        matches!(&snapshot.last_commit.as_ref().unwrap().result, CommitOutcome::Committed { oid, .. } if oid == &published)
    );
}

#[cfg(unix)]
#[test]
fn a_published_fast_forward_survives_a_failed_observation_after_the_root_moves() {
    use std::os::unix::fs::PermissionsExt;

    let incoming = incoming("post-pull-observation");
    let from = git(&incoming.root, &["rev-parse", "HEAD"]);
    std::fs::write(incoming.upstream.join("notes.md"), "incoming bytes").unwrap();
    let to = incoming.publish("update the notes");
    incoming.owner.status().unwrap();
    let moved_root = incoming.root.with_file_name("local-moved");
    // The root moves once the branch itself is published. The pins the
    // update takes first are ref transactions too; they move nothing.
    let hook = incoming.root.join(".git/hooks/reference-transaction");
    std::fs::write(
        &hook,
        "#!/bin/sh\nif [ \"$1\" = committed ] && grep -q ' refs/heads/main$'; then mv \"$PWD\" \"$PWD-moved\"; fi\n",
    )
    .unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    let outcome = incoming.owner.pull_fast_forward();
    let snapshot = incoming.owner.snapshot();
    assert!(
        moved_root.is_dir(),
        "the ref was published before the root moved"
    );
    assert_eq!(git(&moved_root, &["rev-parse", "HEAD"]), to);
    assert_eq!(
        std::fs::read_to_string(moved_root.join("notes.md")).unwrap(),
        "incoming bytes"
    );
    std::fs::remove_file(moved_root.join(".git/hooks/reference-transaction")).unwrap();
    std::fs::rename(&moved_root, &incoming.root).unwrap();
    incoming.owner.shutdown();
    assert_eq!(
        outcome,
        Ok(PullOutcome::FastForwarded {
            from: Some(from),
            to: to.clone(),
            changed_paths: vec!["notes.md".to_string()]
        })
    );
    assert!(
        matches!(&snapshot.files, Observation::Observed { stale: true, error: Some(error), .. } if error.contains("could not start"))
    );
    assert_eq!(snapshot.last_pull.as_ref().unwrap().result, outcome.into());

    // The move could not be read back, so the record was not cleared. An
    // explicit recovery finds the branch at the target and clears it,
    // writing no file.
    let reopened = open(&incoming.root);
    assert!(matches!(
        reopened.snapshot().pending_incoming,
        Some(PendingIncoming::Recorded { ref next_head, .. }) if *next_head == to
    ));
    assert!(matches!(
        reopened.recover_incoming(),
        Ok(RecoverOutcome::Cleared { .. })
    ));
    assert_eq!(reopened.snapshot().pending_incoming, None);
    assert_eq!(git(&incoming.root, &["for-each-ref", "refs/epicenter"]), "");
}
