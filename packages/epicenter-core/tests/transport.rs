//! Rounds over HTTP through the core's registered smart HTTP transport and
//! its LFS client, against stock `git http-backend` and an LFS server that
//! both require the bearer token.

mod common;

use std::io::Write;
use std::path::Path;

use common::http::{serve, serve_with_store, HttpRemote};
use common::*;
use epicenter_core::lfs::Pointer;
use epicenter_core::{sync_round, Options, Remote, Round, Status};

const TOKEN: &str = "test-token-1234";
const WAV: &[u8] = b"RIFF\x01\x02\x03\x04 a recording";

fn has_git() -> bool {
    std::process::Command::new("git")
        .arg("--version")
        .output()
        .is_ok()
}

/// A world whose bare remote is served over HTTP.
fn served(world: &World) -> (HttpRemote, String) {
    let remote = serve(world.dir.path(), TOKEN);
    let url = format!("{}/remote.git", remote.origin);
    (remote, url)
}

fn sync(folder: &Path, url: &str, token: Option<&str>, machine: &str) -> Round {
    let remote = Remote {
        url: url.into(),
        token: token.map(str::to_string),
        // The default: `<url>/info/lfs`, over the same client as Git.
        lfs: None,
    };
    let round = sync_round(
        folder,
        &Options {
            remote: Some(remote),
            machine: machine.into(),
            merge: &StandIn,
            turn_wait: epicenter_core::lock::TURN_WAIT,
        },
    );
    eprintln!(
        "{machine}: {:?} {:?} {}",
        round.status,
        round.message,
        round.notes.join("; ")
    );
    round
}

#[test]
fn git_and_lfs_travel_over_one_client_with_the_token_on_every_request() {
    if !has_git() {
        return;
    }
    let world = World::new();
    let (remote, url) = served(&world);

    let a = world.folder("a");
    write(&a, ".gitattributes", ATTRIBUTES);
    write(&a, "notes/from-a.md", "from a\n");
    write(&a, "recordings/one.wav", WAV);
    assert_eq!(sync(&a, &url, Some(TOKEN), "A").status, Status::Synced);

    let b = world.folder("b");
    write(&b, ".gitattributes", ATTRIBUTES);
    write(&b, "notes/from-b.md", "from b\n");
    assert_eq!(sync(&b, &url, Some(TOKEN), "B").status, Status::Synced);
    assert_eq!(std::fs::read(b.join("recordings/one.wav")).unwrap(), WAV);
    assert_eq!(sync(&a, &url, Some(TOKEN), "A").status, Status::Synced);
    assert_eq!(read(&a, "notes/from-b.md"), "from b\n");

    let pointer = Pointer::parse(&remote_blob(&world, "recordings/one.wav").unwrap()).unwrap();
    assert_eq!(pointer, Pointer::of(WAV));
    assert!(world
        .dir
        .path()
        .join("lfs-objects")
        .join(&pointer.oid)
        .exists());

    let seen = remote.seen();
    assert!(seen.iter().all(|r| r.authorized), "{seen:?}");
    for line in [
        "GET /remote.git/info/refs?service=git-upload-pack",
        "POST /remote.git/git-upload-pack",
        "GET /remote.git/info/refs?service=git-receive-pack",
        "POST /remote.git/git-receive-pack",
        "POST /remote.git/info/lfs/objects/batch",
        &format!("PUT /remote.git/info/lfs/objects/{}", pointer.oid),
        &format!("GET /remote.git/info/lfs/objects/{}", pointer.oid),
    ] {
        assert!(seen.iter().any(|r| r.line == line), "no {line} in {seen:?}");
    }
    for folder in [&a, &b] {
        let config = std::fs::read_to_string(folder.join(".git/config")).unwrap();
        assert!(!config.contains(TOKEN), "{config}");
    }
}

#[test]
fn a_remote_that_refuses_the_token_stops_the_round_and_changes_nothing() {
    if !has_git() {
        return;
    }
    let world = World::new();
    let (remote, url) = served(&world);
    let a = world.folder("a");
    write(&a, "notes/from-a.md", "from a\n");
    assert_eq!(sync(&a, &url, Some(TOKEN), "A").status, Status::Synced);
    let head = git2::Repository::open(&a)
        .unwrap()
        .refname_to_id("refs/heads/main")
        .unwrap();

    write(&a, "notes/later.md", "later\n");
    let before = remote.seen().len();
    let round = sync(&a, &url, Some("a-revoked-token"), "A");
    assert_eq!(round.status, Status::Stopped, "{:?}", round.message);
    assert!(round
        .message
        .unwrap()
        .contains("refused this account (403)"));
    assert!(remote.seen()[before..].iter().all(|r| !r.authorized));
    let repo = git2::Repository::open(&a).unwrap();
    assert_eq!(repo.refname_to_id("refs/heads/main").unwrap(), head);
    assert!(remote_blob(&world, "notes/later.md").is_none());
}

#[test]
fn lfs_transfers_on_another_origin_never_see_the_token() {
    if !has_git() {
        return;
    }
    let world = World::new();
    let (remote, store) = serve_with_store(world.dir.path(), TOKEN);
    let url = format!("{}/remote.git", remote.origin);
    let a = world.folder("a");
    write(&a, ".gitattributes", ATTRIBUTES);
    write(&a, "recordings/one.wav", WAV);
    assert_eq!(sync(&a, &url, Some(TOKEN), "A").status, Status::Synced);
    let b = world.folder("b");
    assert_eq!(sync(&b, &url, Some(TOKEN), "B").status, Status::Synced);
    assert_eq!(std::fs::read(b.join("recordings/one.wav")).unwrap(), WAV);

    let stored = store.seen();
    assert!(
        stored.iter().any(|r| r.line.starts_with("PUT ")),
        "{stored:?}"
    );
    assert!(
        stored.iter().any(|r| r.line.starts_with("GET ")),
        "{stored:?}"
    );
    assert!(
        stored.iter().all(|r| r.authorization.is_none()),
        "{stored:?}"
    );
    assert!(remote.seen().iter().all(|r| r.authorized));
}

#[test]
fn https_goes_through_the_registered_transport() {
    // A server that answers a TLS handshake in plain HTTP: libgit2 built
    // without TLS would report an unsupported protocol; the registered
    // transport reaches the server and fails in rustls, a network error to
    // retry.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("https://{}/remote.git", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let _ = (&stream).write_all(b"HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\n\r\n");
        }
    });
    let world = World::new();
    let a = world.folder("a");
    write(&a, "notes/from-a.md", "from a\n");
    let round = sync(&a, &url, Some(TOKEN), "A");
    assert_eq!(round.status, Status::Retry, "{:?}", round.message);
    let message = round.message.unwrap();
    assert!(!message.contains("unsupported URL protocol"), "{message}");
    assert!(message.contains(&url), "{message}");
}
