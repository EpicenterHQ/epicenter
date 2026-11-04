//! Rounds keep a folder's object store bounded: packs and loose objects
//! are rolled up, and every object stays readable by libgit2 and stock Git.

mod common;

use std::path::Path;
use std::process::Command;

use common::*;
use epicenter_core::repack::{LOOSE_LIMIT, PACK_LIMIT};
use git2::Repository;

fn packs(folder: &Path) -> Vec<String> {
    std::fs::read_dir(folder.join(".git/objects/pack"))
        .unwrap()
        .filter_map(|e| {
            let name = e.unwrap().file_name().to_string_lossy().into_owned();
            name.ends_with(".pack").then_some(name)
        })
        .collect()
}

fn loose(folder: &Path) -> usize {
    std::fs::read_dir(folder.join(".git/objects"))
        .unwrap()
        .map(|e| e.unwrap())
        .filter(|e| e.file_name().len() == 2)
        .map(|e| std::fs::read_dir(e.path()).unwrap().count())
        .sum()
}

fn fsck(folder: &Path) {
    if Command::new("git").arg("--version").output().is_err() {
        return;
    }
    let out = Command::new("git")
        .args(["fsck", "--no-progress", "--no-dangling"])
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
}

#[test]
fn packs_stop_accumulating_over_many_rounds() {
    let world = World::new();
    let a = world.folder("a");
    let b = world.folder("b");
    write(&a, "notes/a.md", "a 0\n");
    world.synced(&a, "A");
    world.synced(&b, "B");
    let mut most = 0;
    let mut repacked = 0;
    for i in 1..=40 {
        write(&a, "notes/a.md", format!("a {i}\n"));
        let round = world.synced(&a, "A");
        repacked += round
            .notes
            .iter()
            .filter(|n| n.starts_with("repacked"))
            .count();
        write(&b, &format!("notes/b-{i}.md"), format!("b {i}\n"));
        world.synced(&b, "B");
        most = most.max(packs(&a).len());
    }
    // Each of A's rounds fetches one pack and persists one or two more;
    // without repacking A would hold over a hundred.
    assert!(repacked > 0);
    assert!(most <= PACK_LIMIT + 1, "{most} packs at most");
    assert!(packs(&a).len() <= PACK_LIMIT + 1, "{:?}", packs(&a));

    // Every commit and file is still there.
    let repo = Repository::open(&a).unwrap();
    let mut walk = repo.revwalk().unwrap();
    walk.push_head().unwrap();
    for id in walk {
        let commit = repo.find_commit(id.unwrap()).unwrap();
        commit
            .tree()
            .unwrap()
            .walk(git2::TreeWalkMode::PreOrder, |_, entry| {
                entry.to_object(&repo).unwrap();
                git2::TreeWalkResult::Ok
            })
            .unwrap();
    }
    eprintln!(
        "at most {most} packs; {repacked} repacks; {:?} now",
        packs(&a).len()
    );
    world.synced(&a, "A");
    assert_eq!(read(&a, "notes/b-40.md"), "b 40\n");
    fsck(&a);
}

#[test]
fn loose_objects_past_the_limit_move_into_a_pack() {
    let world = World::new();
    let a = world.folder("a");
    write(&a, "notes/a.md", "a\n");
    world.synced(&a, "A");
    // A person's own Git writes loose objects; libgit2 without the round's
    // in-memory store does too. These are unreachable and must survive.
    let repo = Repository::open(&a).unwrap();
    let ids: Vec<_> = (0..LOOSE_LIMIT + 10)
        .map(|i| repo.blob(format!("loose {i}\n").as_bytes()).unwrap())
        .collect();
    assert!(loose(&a) > LOOSE_LIMIT);

    let round = world.synced(&a, "A");
    assert!(
        round.notes.iter().any(|n| n.starts_with("repacked")),
        "{:?}",
        round.notes
    );
    assert_eq!(loose(&a), 0);
    let repo = Repository::open(&a).unwrap();
    for (i, id) in ids.iter().enumerate() {
        assert_eq!(
            repo.find_blob(*id).unwrap().content(),
            format!("loose {i}\n").as_bytes()
        );
    }
    fsck(&a);
}

#[test]
fn a_kept_pack_is_left_alone() {
    let world = World::new();
    let a = world.folder("a");
    write(&a, "notes/a.md", "a\n");
    world.synced(&a, "A");
    let first = packs(&a);
    for name in &first {
        let keep = a
            .join(".git/objects/pack")
            .join(name.replace(".pack", ".keep"));
        std::fs::write(keep, "").unwrap();
    }
    for i in 0..30 {
        write(&a, "notes/a.md", format!("a {i}\n"));
        world.synced(&a, "A");
    }
    let now = packs(&a);
    assert!(first.iter().all(|p| now.contains(p)), "{first:?} {now:?}");
    fsck(&a);
}
