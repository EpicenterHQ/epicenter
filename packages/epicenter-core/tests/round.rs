//! Whole sync rounds against a bare `file://` remote, with a directory
//! standing in for the LFS store.

mod common;

use std::path::Path;

use common::*;
use epicenter_core::lfs::Pointer;
use epicenter_core::Status;
use git2::Repository;

const PNG_A: &[u8] = b"\x89PNG\r\n\x1a\n photo taken on A";
const PNG_B: &[u8] = b"\x89PNG\r\n\x1a\n photo taken on B";

fn seed_a(world: &World) -> std::path::PathBuf {
    let a = world.folder("a");
    write(&a, ".gitattributes", ATTRIBUTES);
    write(
        &a,
        ".gitignore",
        "# BEGIN epicenter\n.epicenter/\n.DS_Store\n# END epicenter\n",
    );
    write(
        &a,
        "notes/shared.md",
        "---\ntitle: Shared\ntags: one\n---\nline one\nline two\n",
    );
    write(&a, "notes/only-a.md", "---\ntitle: A\n---\nfrom a\n");
    write(&a, "photos/cat.png", PNG_A);
    write(&a, ".epicenter/parts/unfinished.md", "never committed");
    write(&a, ".DS_Store", "ignored");
    a
}

/// The LFS pointer `path` holds in `commit`.
fn pointer_in(repo: &Repository, commit: &str, path: &str) -> Option<Pointer> {
    let commit = repo
        .find_commit(git2::Oid::from_str(commit).unwrap())
        .unwrap();
    let entry = commit.tree().unwrap().get_path(Path::new(path)).ok()?;
    Pointer::parse(repo.find_blob(entry.id()).unwrap().content())
}

/// The names in `folder`'s `dir`, sorted.
fn names(folder: &Path, dir: &str) -> Vec<String> {
    let mut names: Vec<_> = std::fs::read_dir(folder.join(dir))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

fn roots(repo: &Repository, head: &str) -> usize {
    let mut walk = repo.revwalk().unwrap();
    walk.push(git2::Oid::from_str(head).unwrap()).unwrap();
    walk.filter(|id| {
        repo.find_commit(*id.as_ref().unwrap())
            .unwrap()
            .parent_count()
            == 0
    })
    .count()
}

/// The same matrix the CLI's e2e checks with `git check-attr`, read by libgit2.
#[test]
fn libgit2_reads_the_repository_attributes_as_git_does() {
    let world = World::new();
    let a = world.folder("a");
    write(&a, ".gitattributes", ATTRIBUTES);
    let repo = epicenter_core::open_or_init(&a).unwrap();
    for (path, lfs) in [
        ("media/clip.webm", true),
        ("photo.PNG", true),
        (".gitattributes", false),
        (".obsidian/workspace.json", false),
        ("sub/.trash/a.webm", false),
        ("notes/meeting notes.md", false),
        ("NOTES/LOUD.MD", false),
        ("data.csv", true),
    ] {
        assert_eq!(
            epicenter_core::worktree::stored_with_lfs(&repo, path).unwrap(),
            lfs,
            "{path}"
        );
    }
    let merge = repo
        .get_attr(
            Path::new("notes/a.md"),
            "merge",
            git2::AttrCheckFlags::FILE_THEN_INDEX,
        )
        .unwrap();
    assert_eq!(merge, Some("epicenter"));
}

#[test]
fn first_round_commits_lfs_pointers_and_pushes_to_an_empty_remote() {
    let world = World::new();
    let a = seed_a(&world);
    let round = world.synced(&a, "A");

    let remote = world.remote_repo();
    let head = remote
        .find_reference("refs/heads/main")
        .unwrap()
        .peel_to_commit()
        .unwrap();
    assert_eq!(head.message(), Some("Added from A"));
    assert_eq!(round.head.as_deref(), Some(head.id().to_string().as_str()));
    // The photo is a pointer in Git, its bytes in the LFS store.
    let pointer =
        Pointer::parse(&remote_blob(&world, "photos/cat.png").unwrap()).expect("an LFS pointer");
    assert_eq!(pointer, Pointer::of(PNG_A));
    assert!(world.lfs_store().join(&pointer.oid).exists());
    // Notes and hidden paths are plain Git; state and ignored files are not committed.
    assert!(remote_blob(&world, "notes/shared.md")
        .unwrap()
        .starts_with(b"---\ntitle: Shared"));
    assert!(Pointer::parse(&remote_blob(&world, ".gitattributes").unwrap()).is_none());
    assert!(remote_blob(&world, ".epicenter/parts/unfinished.md").is_none());
    assert!(remote_blob(&world, ".DS_Store").is_none());

    // A second round with nothing changed commits nothing and pushes nothing.
    let again = world.synced(&a, "A");
    assert!(again.notes.is_empty(), "{:?}", again.notes);
}

#[test]
fn first_contact_puts_this_folders_files_on_the_remote_main_in_one_commit() {
    let world = World::new();
    let a = seed_a(&world);
    write(&a, "photos/bird.png", b"bird, only on A");
    let pushed = world.synced(&a, "A").head.unwrap();

    // B made its folder before it ever synced: no .git at all.
    let b = world.folder("b");
    write(&b, ".gitattributes", ATTRIBUTES);
    write(
        &b,
        "notes/shared.md",
        "---\ntitle: Shared on B\nmood: calm\n---\nwritten on b\n",
    );
    write(&b, "notes/only-b.md", "---\ntitle: B\n---\nfrom b\n");
    write(&b, "photos/cat.png", PNG_B);
    write(&b, "photos/dog.png", b"dog, same on no one");
    let round = world.synced(&b, "B");

    let repo = Repository::open(&b).unwrap();
    let head = repo
        .find_commit(git2::Oid::from_str(round.head.as_deref().unwrap()).unwrap())
        .unwrap();
    assert_eq!(head.message(), Some("Added from B"));
    assert_eq!(
        head.parent_ids().collect::<Vec<_>>(),
        vec![git2::Oid::from_str(&pushed).unwrap()]
    );
    assert_eq!(
        roots(&repo, &head.id().to_string()),
        1,
        "no second root: no unrelated-history merge"
    );
    // Only the remote had it: checked out, LFS bytes smudged.
    assert_eq!(read(&b, "notes/only-a.md"), "---\ntitle: A\n---\nfrom a\n");
    assert_eq!(
        std::fs::read(b.join("photos/bird.png")).unwrap(),
        b"bird, only on A"
    );
    // Only here: an addition.
    assert_eq!(read(&b, "notes/only-b.md"), "---\ntitle: B\n---\nfrom b\n");
    // On both sides: a note merged with no base, a binary kept whole, this
    // computer's version winning as the later write; the remote's stays in
    // the history before it.
    let shared = read(&b, "notes/shared.md");
    assert!(
        shared.starts_with("---\ntitle: Shared on B\ntags: one\nmood: calm\n---\n"),
        "{shared}"
    );
    assert!(
        shared.contains("<<<<<<< ") && shared.contains("written on b"),
        "{shared}"
    );
    assert_eq!(std::fs::read(b.join("photos/cat.png")).unwrap(), PNG_B);
    assert_eq!(names(&b, "photos"), ["bird.png", "cat.png", "dog.png"]);
    assert_eq!(
        pointer_in(&repo, &pushed, "photos/cat.png"),
        Some(Pointer::of(PNG_A))
    );
    // Pushed, and the next round on A fast-forwards to it.
    assert_eq!(
        remote_blob(&world, "notes/only-b.md").unwrap(),
        b"---\ntitle: B\n---\nfrom b\n"
    );
    world.synced(&a, "A");
    assert_eq!(std::fs::read(a.join("photos/cat.png")).unwrap(), PNG_B);
    assert_eq!(read(&a, "notes/shared.md"), shared);
}

#[test]
fn three_way_merge_settles_front_matter_by_key_and_the_body_by_its_rule() {
    let world = World::new();
    let a = seed_a(&world);
    world.synced(&a, "A");
    let b = world.folder("b");
    world.synced(&b, "B");
    assert_eq!(read(&b, "notes/shared.md"), read(&a, "notes/shared.md"));

    // A changes the title and the body; B changes the title, adds a key, and changes the body.
    write(
        &a,
        "notes/shared.md",
        "---\ntitle: Title from A\ntags: one\n---\nline one\nA's line two\n",
    );
    world.synced(&a, "A");
    write(
        &b,
        "notes/shared.md",
        "---\ntitle: Title from B\ntags: one\nstatus: done\n---\nline one\nB's line two\n",
    );
    let round = world.synced(&b, "B");
    assert!(
        round
            .notes
            .iter()
            .any(|n| n.starts_with("notes/shared.md: settled")),
        "{:?}",
        round.notes
    );

    let merged = read(&b, "notes/shared.md");
    // B arrives later, so B's title wins with no block; A's key changes are kept.
    assert!(
        merged.starts_with("---\ntitle: Title from B\ntags: one\nstatus: done\n---\n"),
        "{merged}"
    );
    assert!(
        merged.contains("A's line two")
            && merged.contains("B's line two")
            && merged.contains("<<<<<<< "),
        "{merged}"
    );
    let repo = Repository::open(&b).unwrap();
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head.parent_count(), 2);
    assert_eq!(head.message(), Some("Merge origin/main"));

    world.synced(&a, "A");
    assert_eq!(read(&a, "notes/shared.md"), merged);
}

#[test]
fn a_note_libgit2_would_merge_by_line_still_goes_through_settle() {
    let world = World::new();
    let a = seed_a(&world);
    write(
        &a,
        "notes/long.md",
        "---\ntitle: Long\n---\n1\n2\n3\n4\n5\n6\n7\n8\n",
    );
    world.synced(&a, "A");
    let b = world.folder("b");
    world.synced(&b, "B");
    write(
        &a,
        "notes/long.md",
        "---\ntitle: Long, renamed on A\n---\n1\n2\n3\n4\n5\n6\n7\n8\n",
    );
    world.synced(&a, "A");
    write(
        &b,
        "notes/long.md",
        "---\ntitle: Long\n---\n1\n2\n3\n4\n5\n6\n7\neight\n",
    );
    let round = world.synced(&b, "B");
    assert!(
        round.notes.iter().any(|n| n == "notes/long.md: settled"),
        "{:?}",
        round.notes
    );
    assert_eq!(
        read(&b, "notes/long.md"),
        "---\ntitle: Long, renamed on A\n---\n1\n2\n3\n4\n5\n6\n7\neight\n"
    );
}

/// A merge that, the first time it runs, lets another machine push: the
/// remote moves between this round's fetch and its push.
struct Racing<'a> {
    world: &'a World,
    other: std::path::PathBuf,
    fired: std::cell::Cell<bool>,
}

impl epicenter_core::NoteMerge for Racing<'_> {
    fn settle(&self, n: &epicenter_core::NoteInput) -> Result<String, String> {
        if !self.fired.replace(true) {
            write(&self.other, "notes/from-c.md", "c got there first\n");
            self.world.synced(&self.other, "C");
        }
        StandIn.settle(n)
    }
}

#[test]
fn a_push_the_remote_moved_under_fetches_merges_and_pushes_again() {
    let world = World::new();
    let a = seed_a(&world);
    world.synced(&a, "A");
    let (b, c) = (world.folder("b"), world.folder("c"));
    world.synced(&b, "B");
    world.synced(&c, "C");
    write(&a, "notes/shared.md", "---\ntitle: A\n---\nfrom a\n");
    world.synced(&a, "A");
    write(&b, "notes/shared.md", "---\ntitle: B\n---\nfrom b\n");
    let racing = Racing {
        world: &world,
        other: c,
        fired: Default::default(),
    };
    let round = epicenter_core::sync_round(
        &b,
        &epicenter_core::Options {
            remote: Some(world.remote()),
            machine: "B".into(),
            merge: &racing,
            turn_wait: epicenter_core::lock::TURN_WAIT,
        },
    );
    eprintln!(
        "B: {:?} {:?} {}",
        round.status,
        round.message,
        round.notes.join("; ")
    );
    assert_eq!(round.status, Status::Synced, "{:?}", round.message);
    assert!(
        round.notes.iter().any(|n| n.starts_with("push rejected")),
        "{:?}",
        round.notes
    );
    assert_eq!(read(&b, "notes/from-c.md"), "c got there first\n");
    assert_eq!(
        remote_blob(&world, "notes/from-c.md").unwrap(),
        b"c got there first\n"
    );
}

#[test]
fn an_edit_beats_a_delete_both_ways() {
    let world = World::new();
    let a = seed_a(&world);
    world.synced(&a, "A");
    let b = world.folder("b");
    world.synced(&b, "B");

    // A deletes the note B edits, and B deletes the photo A replaces.
    std::fs::remove_file(a.join("notes/shared.md")).unwrap();
    write(&a, "photos/cat.png", b"a newer cat from A");
    world.synced(&a, "A");
    write(
        &b,
        "notes/shared.md",
        "---\ntitle: Kept\n---\nedited on b\n",
    );
    std::fs::remove_file(b.join("photos/cat.png")).unwrap();
    let round = world.synced(&b, "B");
    assert!(
        round
            .notes
            .iter()
            .any(|n| n == "edit beats delete: kept notes/shared.md (local edit)"),
        "{:?}",
        round.notes
    );
    assert!(
        round
            .notes
            .iter()
            .any(|n| n == "edit beats delete: kept photos/cat.png (remote edit)"),
        "{:?}",
        round.notes
    );
    assert_eq!(
        read(&b, "notes/shared.md"),
        "---\ntitle: Kept\n---\nedited on b\n"
    );
    assert_eq!(
        std::fs::read(b.join("photos/cat.png")).unwrap(),
        b"a newer cat from A"
    );

    world.synced(&a, "A");
    assert_eq!(
        read(&a, "notes/shared.md"),
        "---\ntitle: Kept\n---\nedited on b\n"
    );
}

#[test]
fn a_binary_both_sides_replaced_keeps_the_later_write_and_the_other_in_history() {
    let world = World::new();
    let a = seed_a(&world);
    world.synced(&a, "A");
    let b = world.folder("b");
    world.synced(&b, "B");

    write(&a, "photos/cat.png", b"cat v2 from A");
    let earlier = world.synced(&a, "A").head.unwrap();
    write(&b, "photos/cat.png", b"cat v2 from B");
    world.synced(&b, "B");
    assert_eq!(
        std::fs::read(b.join("photos/cat.png")).unwrap(),
        b"cat v2 from B"
    );
    assert_eq!(names(&b, "photos"), ["cat.png"]);
    world.synced(&a, "A");
    assert_eq!(
        std::fs::read(a.join("photos/cat.png")).unwrap(),
        b"cat v2 from B"
    );
    assert_eq!(
        pointer_in(&world.remote_repo(), &earlier, "photos/cat.png"),
        Some(Pointer::of(b"cat v2 from A"))
    );
}

#[test]
fn a_folder_that_tracks_another_remote_is_refused() {
    let world = World::new();
    let a = seed_a(&world);
    let repo = Repository::init(&a).unwrap();
    repo.remote("origin", "https://example.invalid/someone-else.git")
        .unwrap();
    let round = world.sync(&a, "A");
    assert_eq!(round.status, Status::Stopped);
    assert!(round.message.unwrap().contains("someone-else"));
}

fn sync_without_remote(folder: &Path, machine: &str) -> epicenter_core::Round {
    epicenter_core::sync_round(
        folder,
        &epicenter_core::Options {
            remote: None,
            machine: machine.into(),
            merge: &StandIn,
            turn_wait: epicenter_core::lock::TURN_WAIT,
        },
    )
}

#[test]
fn history_rounds_made_before_an_origin_meets_the_remote_by_first_contact() {
    let world = World::new();
    let a = seed_a(&world);
    let pushed = world.synced(&a, "A").head.unwrap();

    let b = world.folder("b");
    write(&b, ".gitattributes", ATTRIBUTES);
    write(&b, "notes/only-b.md", "---\ntitle: B\n---\nfrom b\n");
    let local = sync_without_remote(&b, "B");
    assert_eq!(local.status, Status::Synced);
    assert_eq!(
        local.notes.last().map(String::as_str),
        Some("no remote: committed locally")
    );
    write(&b, "notes/later.md", "---\ntitle: Later\n---\nstill offline\n");
    assert_eq!(sync_without_remote(&b, "B").status, Status::Synced);

    let round = world.synced(&b, "B");
    let repo = Repository::open(&b).unwrap();
    let head = round.head.unwrap();
    let commit = repo.find_commit(git2::Oid::from_str(&head).unwrap()).unwrap();
    assert_eq!(commit.message(), Some("Added from B"));
    assert_eq!(commit.parent_id(0).unwrap().to_string(), pushed);
    assert_eq!(roots(&repo, &head), 1, "the offline commits do not travel");
    assert_eq!(read(&b, "notes/only-a.md"), "---\ntitle: A\n---\nfrom a\n");
    assert_eq!(
        remote_blob(&world, "notes/later.md").unwrap(),
        b"---\ntitle: Later\n---\nstill offline\n"
    );
}

#[test]
fn a_history_epicenter_did_not_make_is_refused_with_the_command_that_resolves_it() {
    let world = World::new();
    let a = seed_a(&world);
    world.synced(&a, "A");

    let b = world.folder("b");
    write(&b, "mine.md", "---\ntitle: Mine\n---\n");
    let repo = Repository::init(&b).unwrap();
    let mut index = repo.index().unwrap();
    index.add_path(Path::new("mine.md")).unwrap();
    let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
    let me = git2::Signature::now("Me", "me@example.invalid").unwrap();
    let mine = repo
        .commit(Some("refs/heads/main"), &me, &me, "my own start", &tree, &[])
        .unwrap();
    repo.set_head("refs/heads/main").unwrap();

    let round = world.sync(&b, "B");
    assert_eq!(round.status, Status::Stopped);
    let message = round.message.unwrap();
    assert!(message.contains("\"my own start\""), "{message}");
    assert!(message.contains("rebase --root --onto origin/main"), "{message}");
    assert_eq!(repo.refname_to_id("refs/heads/main").unwrap(), mine);
}

#[test]
fn a_file_checked_out_as_its_lfs_pointer_gets_its_bytes_and_stays_a_pointer_in_git() {
    let world = World::new();
    let a = seed_a(&world);
    let pushed = world.synced(&a, "A").head.unwrap();

    // libgit2 runs no LFS filter, so its clone leaves the pointer, as a
    // stock clone without `git-lfs` does.
    let c = world.dir.path().join("c");
    Repository::clone(&world.remote().url, &c).unwrap();
    let pointer = std::fs::read(c.join("photos/cat.png")).unwrap();
    assert_eq!(Pointer::parse(&pointer), Some(Pointer::of(PNG_A)));

    let round = world.synced(&c, "C");
    assert!(
        round
            .notes
            .contains(&"restored 1 files checked out as LFS pointers".to_string()),
        "{:?}",
        round.notes
    );
    assert_eq!(std::fs::read(c.join("photos/cat.png")).unwrap(), PNG_A);
    assert_eq!(round.head.as_deref(), Some(pushed.as_str()), "nothing to commit");
    // The next round reads the bytes through the stat cache: nothing changed.
    assert!(world.synced(&c, "C").notes.is_empty());

    // A pointer the stat cache does not cover is committed as itself.
    write(&c, "photos/cat.png", &pointer);
    let again = world.synced(&c, "C");
    assert_eq!(again.head.as_deref(), Some(pushed.as_str()));
    assert_eq!(std::fs::read(c.join("photos/cat.png")).unwrap(), PNG_A);
}

#[test]
fn an_empty_folder_meeting_an_empty_remote_commits_nothing() {
    let world = World::new();
    let a = world.folder("a");
    let round = world.synced(&a, "A");
    assert_eq!(round.head, None);
    assert!(world.remote_repo().refname_to_id("refs/heads/main").is_err());
    assert!(Repository::open(&a)
        .unwrap()
        .refname_to_id("refs/heads/main")
        .is_err());
}

#[test]
fn rounds_racing_to_a_local_remote_lose_no_commit() {
    let world = World::new();
    let a = seed_a(&world);
    world.synced(&a, "A");
    let b = world.folder("b");
    world.synced(&b, "B");
    std::thread::scope(|scope| {
        for (folder, name) in [(&a, "A"), (&b, "B")] {
            let world = &world;
            scope.spawn(move || {
                for round in 0..8 {
                    write(
                        folder,
                        &format!("notes/{name}-{round}.md"),
                        format!("---\ntitle: {name} {round}\n---\n"),
                    );
                    let done = world.sync(folder, name);
                    assert_ne!(done.status, Status::Stopped, "{:?}", done.message);
                }
            });
        }
    });
    world.synced(&a, "A");
    world.synced(&b, "B");
    for name in ["A", "B"] {
        for round in 0..8 {
            let path = format!("notes/{name}-{round}.md");
            assert!(remote_blob(&world, &path).is_some(), "{path} was lost");
        }
    }
}
