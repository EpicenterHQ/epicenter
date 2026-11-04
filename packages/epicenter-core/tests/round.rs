//! Whole sync rounds against a bare `file://` remote, with a directory
//! standing in for the LFS store.

mod common;

use std::path::Path;
use std::process::Command;

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
    assert_eq!(std::fs::read(b.join("photos/cat.png")).unwrap(), PNG_A);
    // Only here: an addition.
    assert_eq!(read(&b, "notes/only-b.md"), "---\ntitle: B\n---\nfrom b\n");
    // On both sides: a note merged with no base, a binary kept whole beside it.
    let shared = read(&b, "notes/shared.md");
    assert!(
        shared.starts_with("---\ntitle: Shared on B\ntags: one\nmood: calm\n---\n"),
        "{shared}"
    );
    assert!(
        shared.contains("<<<<<<< ") && shared.contains("written on b"),
        "{shared}"
    );
    let sibling = format!("photos/cat (conflict {}).png", &Pointer::of(PNG_B).oid[..7]);
    assert_eq!(std::fs::read(b.join(&sibling)).unwrap(), PNG_B);
    // Pushed, and the next round on A fast-forwards to it.
    assert_eq!(
        remote_blob(&world, "notes/only-b.md").unwrap(),
        b"---\ntitle: B\n---\nfrom b\n"
    );
    world.synced(&a, "A");
    assert_eq!(std::fs::read(a.join(&sibling)).unwrap(), PNG_B);
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
fn a_binary_both_sides_replaced_keeps_the_remote_at_its_path_and_the_local_beside_it() {
    let world = World::new();
    let a = seed_a(&world);
    world.synced(&a, "A");
    let b = world.folder("b");
    world.synced(&b, "B");

    write(&a, "photos/cat.png", b"cat v2 from A");
    world.synced(&a, "A");
    write(&b, "photos/cat.png", b"cat v2 from B");
    world.synced(&b, "B");
    let sibling = format!(
        "photos/cat (conflict {}).png",
        &Pointer::of(b"cat v2 from B").oid[..7]
    );
    assert_eq!(
        std::fs::read(b.join("photos/cat.png")).unwrap(),
        b"cat v2 from A"
    );
    assert_eq!(std::fs::read(b.join(&sibling)).unwrap(), b"cat v2 from B");
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

#[test]
fn stock_git_sees_a_clean_folder_after_a_round() {
    if Command::new("git").arg("--version").output().is_err() {
        return;
    }
    let world = World::new();
    let a = seed_a(&world);
    world.synced(&a, "A");
    let b = world.folder("b");
    write(&b, "notes/only-b.md", "from b\n");
    world.synced(&b, "B");
    for folder in [&a, &b] {
        // ADR-0733 keeps the LFS filter settings, which name `git-lfs` and no
        // path. Without them, stock Git re-reads a racily clean LFS file (one
        // written in the index's own second) raw and reports it modified.
        let git = |args: &[&str]| {
            let out = Command::new("git")
                .args([
                    "-c",
                    "filter.lfs.clean=git-lfs clean -- %f",
                    "-c",
                    "filter.lfs.smudge=git-lfs smudge -- %f",
                ])
                .args([
                    "-c",
                    "filter.lfs.process=git-lfs filter-process",
                    "-c",
                    "filter.lfs.required=true",
                ])
                .args(args)
                .current_dir(folder)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            String::from_utf8(out.stdout).unwrap()
        };
        assert_eq!(git(&["status", "--porcelain"]), "", "{}", folder.display());
        git(&["fsck", "--no-progress"]);
        assert_eq!(
            git(&["rev-parse", "HEAD"]).trim(),
            git(&["rev-parse", "origin/main"]).trim()
        );
    }
}
