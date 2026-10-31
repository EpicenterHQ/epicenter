//! Machine-local pins and successful recent openings in navigation.sqlite.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use crate::lock::SAVE_LOCK_WAIT;

pub const RECENT_LIMIT: usize = 20;

pub const FILE: &str = "navigation.sqlite";

pub fn file(data_dir: &Path) -> PathBuf {
    data_dir.join(FILE)
}

/// The two runtimes deliberately issue the same small schema. No migration is
/// needed: a foreign or future database is refused without changing its bytes.
const PINS_TABLE: &str = "CREATE TABLE pins(path TEXT NOT NULL PRIMARY KEY) STRICT, WITHOUT ROWID";
const RECENT_TABLE: &str =
    "CREATE TABLE recent(path TEXT NOT NULL PRIMARY KEY, sequence INTEGER NOT NULL) STRICT";
const APPLICATION_ID: i64 = 0x45504E56; // EPNV
const USER_VERSION: i64 = 1;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Navigation {
    pub pins: Vec<String>,
    pub recent: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum List {
    Pins,
    Recent,
}

fn existing(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!(
            "{} could not be inspected: {error}",
            path.display()
        )),
        Ok(stats) if stats.file_type().is_file() => Ok(true),
        Ok(_) => Err(unsupported(path, "it is not a regular file")),
    }
}

fn connection(path: &Path, create: bool) -> Result<rusqlite::Connection, String> {
    use rusqlite::OpenFlags;
    let mut flags = OpenFlags::SQLITE_OPEN_READ_WRITE;
    if create {
        flags |= OpenFlags::SQLITE_OPEN_CREATE;
    }
    let db = rusqlite::Connection::open_with_flags(path, flags)
        .map_err(|error| database_error(path, &error))?;
    db.busy_timeout(SAVE_LOCK_WAIT)
        .map_err(|error| database_error(path, &error))?;
    Ok(db)
}

#[derive(PartialEq, Eq)]
enum Schema {
    Empty,
    Ready,
}

/// Validate the complete identity, version, schema and rollback journal mode
/// inside the same transaction as the following read or mutation.
fn schema(tx: &rusqlite::Transaction<'_>, path: &Path) -> Result<Schema, String> {
    let mode: String = tx
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .map_err(|error| database_error(path, &error))?;
    if !mode.eq_ignore_ascii_case("delete") {
        return Err(unsupported(
            path,
            &format!("journal mode {mode} is unsupported; navigation requires DELETE mode"),
        ));
    }
    let application_id: i64 = tx
        .query_row("PRAGMA application_id", [], |row| row.get(0))
        .map_err(|error| database_error(path, &error))?;
    let version: i64 = tx
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| database_error(path, &error))?;
    let mut query = tx
        .prepare("SELECT name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
        .map_err(|error| database_error(path, &error))?;
    let objects = query
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
        .map_err(|error| database_error(path, &error))?;
    if application_id == 0 && version == 0 && objects.is_empty() {
        return Ok(Schema::Empty);
    }
    if application_id == APPLICATION_ID
        && version == USER_VERSION
        && objects
            == [
                ("pins".to_string(), Some(PINS_TABLE.to_string())),
                ("recent".to_string(), Some(RECENT_TABLE.to_string())),
            ]
    {
        return Ok(Schema::Ready);
    }
    Err(unsupported(
        path,
        &format!(
            "unknown navigation schema (application_id={application_id}, user_version={version})"
        ),
    ))
}

fn initialize(tx: &rusqlite::Transaction<'_>, path: &Path) -> Result<(), String> {
    tx.execute_batch(&format!("{PINS_TABLE}; {RECENT_TABLE}; PRAGMA application_id = {APPLICATION_ID}; PRAGMA user_version = {USER_VERSION};"))
        .map_err(|error| database_error(path, &error))
}

fn paths(tx: &rusqlite::Transaction<'_>, path: &Path, list: List) -> Result<Vec<String>, String> {
    let sql = match list {
        List::Pins => "SELECT path FROM pins ORDER BY path",
        List::Recent => "SELECT path FROM recent ORDER BY sequence DESC",
    };
    let mut query = tx
        .prepare(sql)
        .map_err(|error| database_error(path, &error))?;
    query
        .query_map([], |row| row.get(0))
        .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
        .map_err(|error| database_error(path, &error))
}

/// Read one consistent snapshot without creating a missing database.
pub fn read(data_dir: &Path) -> Result<Navigation, String> {
    let path = file(data_dir);
    if !existing(&path)? {
        return Ok(Navigation::default());
    }
    let mut db = connection(&path, false)?;
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Deferred)
        .map_err(|error| database_error(&path, &error))?;
    let result = if schema(&tx, &path)? == Schema::Empty {
        Navigation::default()
    } else {
        Navigation {
            pins: paths(&tx, &path, List::Pins)?,
            recent: paths(&tx, &path, List::Recent)?,
        }
    };
    tx.commit().map_err(|error| database_error(&path, &error))?;
    Ok(result)
}

fn mutate<T>(
    data_dir: &Path,
    create: bool,
    change: impl FnOnce(&rusqlite::Transaction<'_>, &Path) -> Result<T, String>,
) -> Result<Option<T>, String> {
    let path = file(data_dir);
    let present = existing(&path)?;
    if !create && !present {
        return Ok(None);
    }
    if create {
        fs::create_dir_all(data_dir).map_err(|error| unsupported(&path, &error.to_string()))?;
    }
    let mut db = connection(&path, create)?;
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|error| database_error(&path, &error))?;
    let state = schema(&tx, &path)?;
    if state == Schema::Empty && !create {
        return Ok(None);
    }
    if state == Schema::Empty {
        initialize(&tx, &path)?;
    }
    let result = change(&tx, &path)?;
    tx.commit().map_err(|error| database_error(&path, &error))?;
    Ok(Some(result))
}

/// Insert one pin if neither it nor an alias is already pinned.
pub fn pin(data_dir: &Path, directory: &str, same: impl Fn(&str) -> bool) -> Result<bool, String> {
    mutate(data_dir, true, |tx, path| {
        if paths(tx, path, List::Pins)?
            .iter()
            .any(|entry| entry == directory || same(entry))
        {
            return Ok(false);
        }
        tx.execute("INSERT INTO pins(path) VALUES (?1)", [directory])
            .map_err(|error| database_error(path, &error))?;
        Ok(true)
    })
    .map(|result| result.expect("pin creates a database"))
}

/// Record a completed opening as the newest of at most twenty recent paths.
pub fn record_opening(
    data_dir: &Path,
    directory: &str,
    same: impl Fn(&str) -> bool,
) -> Result<(), String> {
    mutate(data_dir, true, |tx, path| {
        let sequence: i64 = tx.query_row("SELECT COALESCE(MAX(sequence), 0) + 1 FROM recent", [], |row| row.get(0))
            .map_err(|error| database_error(path, &error))?;
        for entry in paths(tx, path, List::Recent)? {
            if entry != directory && same(&entry) {
                tx.execute("DELETE FROM recent WHERE path = ?1", [&entry])
                    .map_err(|error| database_error(path, &error))?;
            }
        }
        tx.execute("INSERT INTO recent(path, sequence) VALUES (?1, ?2) ON CONFLICT(path) DO UPDATE SET sequence = excluded.sequence", rusqlite::params![directory, sequence])
            .map_err(|error| database_error(path, &error))?;
        tx.execute("DELETE FROM recent WHERE path NOT IN (SELECT path FROM recent ORDER BY sequence DESC LIMIT 20)", [])
            .map_err(|error| database_error(path, &error))?;
        Ok(())
    }).map(|_| ())
}

/// Delete matching pins or recent entries, including all saved aliases.
pub fn remove(data_dir: &Path, list: List, same: impl Fn(&str) -> bool) -> Result<bool, String> {
    mutate(data_dir, false, |tx, path| {
        let mut changed = false;
        let sql = match list {
            List::Pins => "DELETE FROM pins WHERE path = ?1",
            List::Recent => "DELETE FROM recent WHERE path = ?1",
        };
        for entry in paths(tx, path, list)? {
            if same(&entry) {
                tx.execute(sql, [&entry])
                    .map_err(|error| database_error(path, &error))?;
                changed = true;
            }
        }
        Ok(changed)
    })
    .map(|result| result.unwrap_or(false))
}

fn unsupported(path: &Path, reason: &str) -> String {
    format!("{} was left unchanged because {reason}. Repair it to change pinned and recent folders again.", path.display())
}

fn database_error(path: &Path, error: &rusqlite::Error) -> String {
    if matches!(error, rusqlite::Error::SqliteFailure(failure, _) if matches!(failure.code, rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked))
    {
        return format!(
            "{} is busy because another navigation writer has it open. Try again.",
            path.display()
        );
    }
    unsupported(path, &error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    fn bun() -> &'static str {
        "bun"
    }
    fn module() -> String {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../cli/src/navigation.ts")
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned()
    }
    fn wait_for(path: &Path) {
        let until = Instant::now() + Duration::from_secs(5);
        while !path.exists() && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(path.exists(), "{} did not appear", path.display());
    }
    fn bun_script(script: &str, args: &[&str]) -> std::process::Child {
        Command::new(bun())
            .arg("-e")
            .arg(script)
            .args(args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap()
    }

    #[test]
    fn a_busy_read_expires_with_a_retryable_error_without_changing_facts() {
        let temp = tempfile::tempdir().unwrap();
        pin(temp.path(), "/kept", |_| false).unwrap();
        let held = Connection::open(file(temp.path())).unwrap();
        held.execute_batch("BEGIN EXCLUSIVE").unwrap();
        let started = std::time::Instant::now();
        let error = read(temp.path()).unwrap_err();
        assert!(started.elapsed() >= std::time::Duration::from_secs(9));
        assert!(error.contains("is busy"), "{error}");
        assert!(!error.contains("Repair"), "{error}");
        held.execute_batch("ROLLBACK").unwrap();
        assert_eq!(read(temp.path()).unwrap().pins, ["/kept"]);
    }

    #[test]
    fn missing_read_creates_nothing_and_zero_byte_file_is_empty() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("new");
        assert_eq!(read(&data).unwrap(), Navigation::default());
        assert!(!data.exists());
        fs::create_dir(&data).unwrap();
        fs::write(file(&data), []).unwrap();
        assert_eq!(read(&data).unwrap(), Navigation::default());
        pin(&data, "/one", |_| false).unwrap();
        assert_eq!(read(&data).unwrap().pins, ["/one"]);
    }

    #[test]
    fn schema_and_pragmas_match_bun_in_both_directions() {
        let temp = tempfile::tempdir().unwrap();
        let rust = temp.path().join("rust");
        let bun_data = temp.path().join("bun");
        pin(&rust, "/rust", |_| false).unwrap();
        let script = format!("import {{pinNavigation,readNavigation}} from {}; await pinNavigation(process.argv[1], '/bun'); const n=await readNavigation(process.argv[2]); if(n.pins[0] !== '/rust') process.exit(2);", serde_json::to_string(&module()).unwrap());
        let result = bun_script(
            &script,
            &[bun_data.to_str().unwrap(), rust.to_str().unwrap()],
        )
        .wait_with_output()
        .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        assert_eq!(read(&bun_data).unwrap().pins, ["/bun"]);
        for data in [&rust, &bun_data] {
            let db = Connection::open(file(data)).unwrap();
            let app: i64 = db
                .query_row("PRAGMA application_id", [], |r| r.get(0))
                .unwrap();
            let version: i64 = db
                .query_row("PRAGMA user_version", [], |r| r.get(0))
                .unwrap();
            let mode: String = db
                .query_row("PRAGMA journal_mode", [], |r| r.get(0))
                .unwrap();
            assert_eq!(
                (app, version, mode.as_str()),
                (APPLICATION_ID, USER_VERSION, "delete")
            );
            let objects: Vec<(String, String)> = db.prepare("SELECT name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").unwrap()
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().map(Result::unwrap).collect();
            assert_eq!(
                objects,
                [
                    ("pins".into(), PINS_TABLE.into()),
                    ("recent".into(), RECENT_TABLE.into())
                ]
            );
        }
    }

    #[test]
    fn corrupt_foreign_future_and_wal_databases_are_refused_unchanged() {
        let temp = tempfile::tempdir().unwrap();
        let path = file(temp.path());
        fs::write(&path, b"not sqlite").unwrap();
        let before = fs::read(&path).unwrap();
        assert!(read(temp.path()).is_err());
        assert!(pin(temp.path(), "/x", |_| false).is_err());
        assert_eq!(fs::read(&path).unwrap(), before);
        fs::remove_file(&path).unwrap();
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE foreign_table(x TEXT)")
            .unwrap();
        drop(db);
        assert!(pin(temp.path(), "/x", |_| false).is_err());
        let db = Connection::open(&path).unwrap();
        assert!(db.prepare("SELECT * FROM foreign_table").is_ok());
        drop(db);
        fs::remove_file(&path).unwrap();
        pin(temp.path(), "/x", |_| false).unwrap();
        let db = Connection::open(&path).unwrap();
        db.execute_batch("PRAGMA user_version = 2").unwrap();
        drop(db);
        assert!(read(temp.path()).is_err());
        let db = Connection::open(&path).unwrap();
        assert_eq!(
            db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            2
        );
        db.execute_batch("PRAGMA user_version = 1; PRAGMA journal_mode = WAL")
            .unwrap();
        drop(db);
        assert!(read(temp.path()).unwrap_err().contains("DELETE mode"));
    }

    #[test]
    fn pins_are_independent_and_recent_is_mru_twenty_with_alias_collapse() {
        let temp = tempfile::tempdir().unwrap();
        pin(temp.path(), "/pinned", |_| false).unwrap();
        assert!(!pin(temp.path(), "/alias", |entry| entry == "/pinned").unwrap());
        for index in 0..25 {
            record_opening(temp.path(), &format!("/opened-{index}"), |_| false).unwrap();
        }
        record_opening(temp.path(), "/opened-10", |_| false).unwrap();
        let saved = read(temp.path()).unwrap();
        assert_eq!(saved.pins, ["/pinned"]);
        assert_eq!(saved.recent.len(), RECENT_LIMIT);
        assert_eq!(saved.recent[0], "/opened-10");
        assert_eq!(saved.recent[1], "/opened-24");
        record_opening(temp.path(), "/alias-10", |entry| entry == "/opened-10").unwrap();
        assert!(!read(temp.path())
            .unwrap()
            .recent
            .contains(&"/opened-10".into()));
        assert!(remove(temp.path(), List::Pins, |entry| entry == "/pinned").unwrap());
        assert!(!remove(temp.path(), List::Pins, |entry| entry == "/pinned").unwrap());
        assert_eq!(read(temp.path()).unwrap().recent[0], "/alias-10");
    }

    #[test]
    fn native_immediate_transaction_makes_bun_wait_then_merge() {
        let temp = tempfile::tempdir().unwrap();
        pin(temp.path(), "/native", |_| false).unwrap();
        let mut db = Connection::open(file(temp.path())).unwrap();
        let tx = db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .unwrap();
        let marker = temp.path().join("bun-ready");
        let script = format!("import {{writeFileSync}} from 'node:fs'; import {{pinNavigation}} from {}; writeFileSync(process.argv[2], 'ready'); await pinNavigation(process.argv[1], '/bun');", serde_json::to_string(&module()).unwrap());
        let mut child = bun_script(
            &script,
            &[temp.path().to_str().unwrap(), marker.to_str().unwrap()],
        );
        wait_for(&marker);
        std::thread::sleep(Duration::from_millis(100));
        assert!(
            child.try_wait().unwrap().is_none(),
            "Bun bypassed native transaction"
        );
        tx.execute("INSERT INTO pins(path) VALUES ('/held')", [])
            .unwrap();
        tx.commit().unwrap();
        let result = child.wait_with_output().unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        assert_eq!(
            read(temp.path()).unwrap().pins,
            ["/bun", "/held", "/native"]
        );
    }

    #[test]
    fn killed_uncommitted_bun_writer_recovers_prior_facts() {
        let temp = tempfile::tempdir().unwrap();
        pin(temp.path(), "/durable", |_| false).unwrap();
        let marker = temp.path().join("bun-ready");
        let script = "import {Database} from 'bun:sqlite'; import {writeFileSync} from 'node:fs'; const db=new Database(process.argv[1],{readwrite:true}); db.exec('BEGIN IMMEDIATE'); db.exec(\"INSERT INTO pins(path) VALUES ('/uncommitted')\"); writeFileSync(process.argv[2], 'ready'); while(true) Bun.sleepSync(100);";
        let mut child = bun_script(
            script,
            &[
                file(temp.path()).to_str().unwrap(),
                marker.to_str().unwrap(),
            ],
        );
        wait_for(&marker);
        child.kill().unwrap();
        child.wait().unwrap();
        assert_eq!(read(temp.path()).unwrap().pins, ["/durable"]);
        pin(temp.path(), "/after", |_| false).unwrap();
        assert_eq!(read(temp.path()).unwrap().pins, ["/after", "/durable"]);
    }

    #[test]
    fn bun_immediate_transaction_makes_native_wait_then_merge() {
        let temp = tempfile::tempdir().unwrap();
        pin(temp.path(), "/native", |_| false).unwrap();
        let marker = temp.path().join("bun-ready");
        let release = temp.path().join("release");
        let script = "import {Database} from 'bun:sqlite'; import {writeFileSync,existsSync} from 'node:fs'; const db=new Database(process.argv[1],{readwrite:true}); db.exec('BEGIN IMMEDIATE'); db.exec(\"INSERT INTO pins(path) VALUES ('/bun')\"); writeFileSync(process.argv[2], 'ready'); while(!existsSync(process.argv[3])) Bun.sleepSync(5); db.exec('COMMIT'); db.close();";
        let child = bun_script(
            script,
            &[
                file(temp.path()).to_str().unwrap(),
                marker.to_str().unwrap(),
                release.to_str().unwrap(),
            ],
        );
        wait_for(&marker);
        let root = temp.path().to_path_buf();
        let native = std::thread::spawn(move || record_opening(&root, "/opened", |_| false));
        std::thread::sleep(Duration::from_millis(100));
        assert!(!native.is_finished(), "native bypassed Bun transaction");
        fs::write(&release, "go").unwrap();
        let result = child.wait_with_output().unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        native.join().unwrap().unwrap();
        let saved = read(temp.path()).unwrap();
        assert_eq!(saved.pins, ["/bun", "/native"]);
        assert_eq!(saved.recent, ["/opened"]);
    }
}
