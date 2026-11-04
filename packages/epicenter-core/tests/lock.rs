//! The round lock against the TypeScript CLI's own lock
//! (`holdingFileLock` in `packages/cli/src/file-lock.ts`, an exclusive
//! SQLite transaction), run by Bun in another process: each side must find
//! the other's lock on `.git/epicenter-sync.lock`.

mod common;

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::time::Duration;

use common::*;
use epicenter_core::lock::RoundLock;
use epicenter_core::{sync_round, Options, Status};

const CLI_LOCK: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../cli/src/file-lock.ts");

/// Holds the CLI's lock on argv[2] until a line arrives on stdin (`hold`),
/// or tries once and reports whether it got it (`try`).
const SCRIPT: &str = r#"
const [lockModule, path, mode] = process.argv.slice(2);
const { holdingFileLock } = await import(lockModule);
const options = { waitMs: 0, held: 'held elsewhere' };
if (mode === 'hold') {
	await holdingFileLock(path, options, async () => {
		console.log('locked');
		for await (const _ of console) break;
	});
} else {
	try {
		await holdingFileLock(path, options, async () => console.log('took it'));
	} catch (cause) {
		console.log(`refused: ${cause.message}`);
	}
}
"#;

fn bun() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(|h| Path::new(&h).join(".bun/bin/bun"));
    let found = std::env::var_os("PATH")
        .into_iter()
        .flat_map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .map(|d| d.join("bun"))
        .chain(home)
        .find(|p| p.is_file());
    if found.is_none() {
        eprintln!("bun is not installed; skipping the CLI lock test");
    }
    found
}

fn cli_lock(bun: &Path, dir: &Path, path: &Path, mode: &str) -> (Child, BufReader<ChildStdout>) {
    let script = dir.join("lock.ts");
    std::fs::write(&script, SCRIPT).unwrap();
    let mut child = Command::new(bun)
        .arg(&script)
        .args([CLI_LOCK, path.to_str().unwrap(), mode])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let out = BufReader::new(child.stdout.take().unwrap());
    (child, out)
}

fn line(out: &mut BufReader<ChildStdout>) -> String {
    let mut line = String::new();
    out.read_line(&mut line).unwrap();
    line.trim().to_string()
}

fn options(wait: Duration) -> Options<'static> {
    Options {
        remote: None,
        machine: "A".into(),
        merge: &StandIn,
        turn_wait: wait,
    }
}

#[test]
fn a_round_waits_for_the_clis_lock_then_retries() {
    let Some(bun) = bun() else { return };
    let world = World::new();
    let a = world.folder("a");
    write(&a, "notes/one.md", "one\n");
    epicenter_core::open_or_init(&a).unwrap();
    let lock = a.join(".git/epicenter-sync.lock");

    let (mut child, mut out) = cli_lock(&bun, world.dir.path(), &lock, "hold");
    assert_eq!(line(&mut out), "locked");
    let round = sync_round(&a, &options(Duration::from_millis(200)));
    assert_eq!(round.status, Status::Retry, "{:?}", round.message);
    assert!(round.message.unwrap().contains("nothing was changed"));
    assert!(
        git2::Repository::open(&a).unwrap().head().is_err(),
        "no commit was made"
    );

    // Released: the next round runs.
    writeln!(child.stdin.take().unwrap()).unwrap();
    assert!(child.wait().unwrap().success());
    let round = sync_round(&a, &options(Duration::ZERO));
    assert_eq!(round.status, Status::Synced, "{:?}", round.message);
}

#[test]
fn the_cli_finds_the_cores_lock_held() {
    let Some(bun) = bun() else { return };
    let world = World::new();
    let a = world.folder("a");
    let repo = epicenter_core::open_or_init(&a).unwrap();
    let lock = a.join(".git/epicenter-sync.lock");

    let held = RoundLock::acquire(repo.commondir(), Duration::ZERO).unwrap();
    let (mut child, mut out) = cli_lock(&bun, world.dir.path(), &lock, "try");
    assert_eq!(line(&mut out), "refused: held elsewhere");
    assert!(child.wait().unwrap().success());

    drop(held);
    let (mut child, mut out) = cli_lock(&bun, world.dir.path(), &lock, "try");
    assert_eq!(line(&mut out), "took it");
    assert!(child.wait().unwrap().success());
}
