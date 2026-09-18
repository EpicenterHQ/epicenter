//! One generation's physical SQLite resources. The TypeScript owner admits and
//! orders work; this worker owns connections and never runs on the pipe reader.
use crate::device_owner::{self, AccountIdentity};
use rusqlite::{params_from_iter, types::ValueRef, Connection, InterruptHandle};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
};

#[path = "sqlite-restricted.rs"]
mod restricted;

pub const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;
#[derive(Debug, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum SqlValue {
    Null,
    Number(f64),
    Text(String),
    Blob(Blob),
}
#[derive(Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Blob {
    blob: Vec<u8>,
}
#[derive(Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Statement {
    sql: String,
    parameters: Vec<SqlValue>,
}
#[derive(Debug, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Request {
    Open {
        account: Option<AccountIdentity>,
        #[serde(rename = "appId")]
        app_id: String,
        name: String,
    },
    Delete {
        account: Option<AccountIdentity>,
        #[serde(rename = "appId")]
        app_id: String,
        name: String,
    },
    Close {
        connection: String,
    },
    Run {
        connection: String,
        statement: Statement,
    },
    All {
        connection: String,
        statement: Statement,
    },
    Batch {
        connection: String,
        statements: Vec<Statement>,
    },
    Query {
        connection: String,
        statement: Statement,
        tables: Vec<String>,
    },
}
#[derive(Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
enum Outcome {
    Ok { data: Value },
    Error { message: String },
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    r#type: &'static str,
    request_id: String,
    #[serde(flatten)]
    outcome: Outcome,
}
struct Work {
    request_id: String,
    request: Request,
    canceled: Arc<AtomicBool>,
}
pub struct Worker {
    sender: Option<mpsc::SyncSender<Work>>,
    cancellations: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    stopped: Arc<AtomicBool>,
    pub failed: Arc<AtomicBool>,
    interrupts: Arc<Mutex<HashMap<String, InterruptHandle>>>,
    thread: Option<thread::JoinHandle<()>>,
}
impl Worker {
    pub fn new(
        root: PathBuf,
        generation: u64,
        responses: mpsc::SyncSender<String>,
        failed: Arc<AtomicBool>,
    ) -> Self {
        let (sender, receiver) = mpsc::sync_channel::<Work>(64);
        let stopped = Arc::new(AtomicBool::new(false));
        let cancellations = Arc::new(Mutex::new(HashMap::<String, Arc<AtomicBool>>::new()));
        let worker_cancellations = cancellations.clone();
        let interrupts = Arc::new(Mutex::new(HashMap::new()));
        let worker_stopped = stopped.clone();
        let worker_interrupts = interrupts.clone();
        let worker_failed = failed.clone();
        let thread = thread::spawn(move || {
            let mut databases = Databases {
                root,
                generation,
                next: 0,
                connections: HashMap::new(),
                stopped: worker_stopped.clone(),
                interrupts: worker_interrupts,
            };
            for work in receiver {
                let result = if worker_stopped.load(Ordering::Acquire) {
                    Err("SQLite generation is closed.".into())
                } else {
                    databases.execute(work.request, work.canceled)
                };
                worker_cancellations
                    .lock()
                    .unwrap()
                    .remove(&work.request_id);
                let outcome = match result {
                    Ok(data) => Outcome::Ok { data },
                    Err(message) => Outcome::Error { message },
                };
                let mut response = Response {
                    r#type: "sqlite-result",
                    request_id: work.request_id,
                    outcome,
                };
                let mut line = serde_json::to_string(&response).expect("finite SQLite response");
                if line.len() > MAX_FRAME_BYTES {
                    response.outcome = Outcome::Error {
                        message: "SQLite result exceeds native frame limit.".into(),
                    };
                    line = serde_json::to_string(&response).unwrap();
                }
                if responses.try_send(line).is_err() {
                    worker_failed.store(true, Ordering::Release);
                    break;
                }
            }
            // Connections drop before join returns, including after a transport failure.
            databases.interrupts.lock().unwrap().clear();
        });
        Self {
            sender: Some(sender),
            cancellations,
            stopped,
            failed,
            interrupts,
            thread: Some(thread),
        }
    }
    pub fn submit(&self, request_id: String, request: Request) -> Result<(), String> {
        if request_id.is_empty() || request_id.len() > 128 {
            return Err("Invalid SQLite request id.".into());
        }
        if self.stopped.load(Ordering::Acquire) {
            return Err("SQLite generation is closed.".into());
        }
        let canceled = Arc::new(AtomicBool::new(false));
        let mut cancellations = self.cancellations.lock().unwrap();
        if cancellations.contains_key(&request_id) {
            return Err("Duplicate SQLite request id.".into());
        }
        cancellations.insert(request_id.clone(), canceled.clone());
        if self
            .sender
            .as_ref()
            .ok_or("SQLite generation is closed.")?
            .try_send(Work {
                request_id: request_id.clone(),
                request,
                canceled,
            })
            .is_err()
        {
            cancellations.remove(&request_id);
            return Err("SQLite worker queue is full or closed.".into());
        }
        Ok(())
    }
    pub fn cancel(&self, id: &str) {
        if let Some(canceled) = self.cancellations.lock().unwrap().get(id) {
            canceled.store(true, Ordering::Release);
        }
    }
    pub fn stop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        for interrupt in self.interrupts.lock().unwrap().values() {
            interrupt.interrupt();
        }
        self.sender.take();
        if let Some(thread) = self.thread.take() {
            if thread.join().is_err() {
                self.failed.store(true, Ordering::Release);
            }
        }
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.stop();
    }
}
struct Databases {
    root: PathBuf,
    generation: u64,
    next: u64,
    connections: HashMap<String, (PathBuf, Connection)>,
    stopped: Arc<AtomicBool>,
    interrupts: Arc<Mutex<HashMap<String, InterruptHandle>>>,
}
fn database_path(
    root: &std::path::Path,
    app_id: &str,
    name: &str,
    account: Option<&AccountIdentity>,
) -> Result<PathBuf, String> {
    let labels = app_id.split('.').collect::<Vec<_>>();
    if labels.len() < 2
        || !labels.iter().all(|label| {
            !label.is_empty()
                && label
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                && label.as_bytes()[0].is_ascii_alphanumeric()
                && label.as_bytes()[label.len() - 1].is_ascii_alphanumeric()
        })
    {
        return Err("Invalid SQLite app id.".into());
    }
    if name.is_empty()
        || !name.as_bytes()[0].is_ascii_lowercase()
        || !name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
    {
        return Err("Invalid SQLite name.".into());
    }
    Ok(root
        .join("apps")
        .join(app_id)
        .join("device")
        .join(device_owner::path(account)?)
        .join("sqlite")
        .join(format!("{name}.sqlite")))
}
fn bindings(statement: &Statement) -> Result<Vec<rusqlite::types::Value>, String> {
    statement
        .parameters
        .iter()
        .map(|value| match value {
            SqlValue::Null => Ok(rusqlite::types::Value::Null),
            SqlValue::Text(s) => Ok(rusqlite::types::Value::Text(s.clone())),
            SqlValue::Blob(b) => Ok(rusqlite::types::Value::Blob(b.blob.clone())),
            SqlValue::Number(n) if n.is_finite() => {
                Ok(if n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0 {
                    rusqlite::types::Value::Integer(*n as i64)
                } else {
                    rusqlite::types::Value::Real(*n)
                })
            }
            _ => Err("SQLite number must be finite.".into()),
        })
        .collect()
}
fn run(connection: &Connection, statement: &Statement) -> Result<usize, String> {
    let before = connection.total_changes();
    let mut prepared = connection
        .prepare(&statement.sql)
        .map_err(|error| error.to_string())?;
    let mut rows = prepared
        .query(params_from_iter(bindings(statement)?))
        .map_err(|error| error.to_string())?;
    while rows.next().map_err(|error| error.to_string())?.is_some() {}
    // SELECT and row-producing pragmas report zero even after an earlier write.
    Ok(if connection.total_changes() == before {
        0
    } else {
        connection.changes() as usize
    })
}

impl Databases {
    fn execute(&mut self, request: Request, canceled: Arc<AtomicBool>) -> Result<Value, String> {
        match request {
            Request::Query {
                connection,
                statement,
                tables,
            } => {
                let (path, _) = self
                    .connections
                    .get(&connection)
                    .ok_or("Unknown SQLite connection.")?;
                restricted::run(
                    path,
                    &statement.sql,
                    &bindings(&statement)?,
                    tables,
                    canceled,
                    self.stopped.clone(),
                )
            }
            Request::Open {
                app_id,
                name,
                account,
            } => {
                let path = database_path(&self.root, &app_id, &name, account.as_ref())?;
                if self.connections.values().any(|(opened, _)| opened == &path) {
                    return Err("SQLite file is already open.".into());
                }
                std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
                let connection = Connection::open(&path).map_err(|e| e.to_string())?;
                connection
                    .busy_timeout(std::time::Duration::from_secs(5))
                    .map_err(|e| e.to_string())?;
                let stopped = self.stopped.clone();
                connection
                    .progress_handler(1000, Some(move || stopped.load(Ordering::Acquire)))
                    .map_err(|e| e.to_string())?;
                self.next += 1;
                let id = format!("{}:{}", self.generation, self.next);
                self.interrupts
                    .lock()
                    .unwrap()
                    .insert(id.clone(), connection.get_interrupt_handle());
                self.connections.insert(id.clone(), (path, connection));
                Ok(json!({"connection":id}))
            }
            Request::Delete {
                app_id,
                name,
                account,
            } => {
                let path = database_path(&self.root, &app_id, &name, account.as_ref())?;
                if self.connections.values().any(|(opened, _)| opened == &path) {
                    return Err("SQLite file is still open.".into());
                }
                for suffix in ["", "-wal", "-shm", "-journal"] {
                    let mut file = path.as_os_str().to_os_string();
                    file.push(suffix);
                    match std::fs::remove_file(file) {
                        Ok(()) => (),
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                        Err(e) => return Err(e.to_string()),
                    }
                }
                Ok(Value::Null)
            }
            Request::Close { connection } => {
                let (path, db) = self
                    .connections
                    .remove(&connection)
                    .ok_or("Unknown SQLite connection.")?;
                match db.close() {
                    Ok(()) => {
                        self.interrupts.lock().unwrap().remove(&connection);
                        Ok(Value::Null)
                    }
                    Err((db, error)) => {
                        self.connections.insert(connection, (path, db));
                        Err(error.to_string())
                    }
                }
            }
            Request::Run {
                connection,
                statement,
            } => {
                let (_, db) = self
                    .connections
                    .get(&connection)
                    .ok_or("Unknown SQLite connection.")?;
                Ok(json!({"changes":run(db,&statement)?}))
            }
            Request::Batch {
                connection,
                statements,
            } => {
                let (_, db) = self
                    .connections
                    .get_mut(&connection)
                    .ok_or("Unknown SQLite connection.")?;
                let tx = db.transaction().map_err(|e| e.to_string())?;
                let changes = statements
                    .iter()
                    .map(|s| run(&tx, s))
                    .collect::<Result<Vec<_>, _>>()?;
                tx.commit().map_err(|e| e.to_string())?;
                Ok(json!({"changes":changes}))
            }
            Request::All {
                connection,
                statement,
            } => {
                let (_, db) = self
                    .connections
                    .get(&connection)
                    .ok_or("Unknown SQLite connection.")?;
                let mut prepared = db.prepare(&statement.sql).map_err(|e| e.to_string())?;
                let columns = prepared
                    .column_names()
                    .iter()
                    .map(|name| name.to_string())
                    .collect::<Vec<_>>();
                let mut source = prepared
                    .query(params_from_iter(bindings(&statement)?))
                    .map_err(|e| e.to_string())?;
                let mut rows = Vec::new();
                let mut bytes = 0;
                while let Some(row) = source.next().map_err(|e| e.to_string())? {
                    let mut values = serde_json::Map::new();
                    for (index, name) in columns.iter().enumerate() {
                        let value = match row.get_ref(index).map_err(|e| e.to_string())? {
                            ValueRef::Null => Value::Null,
                            ValueRef::Integer(n) => json!(n),
                            ValueRef::Real(n) if n.is_finite() => json!(n),
                            ValueRef::Real(_) => {
                                return Err("SQLite returned a non-finite number.".into())
                            }
                            ValueRef::Text(s) => {
                                json!(std::str::from_utf8(s).map_err(|e| e.to_string())?)
                            }
                            ValueRef::Blob(b) => json!({"blob":b}),
                        };
                        values.insert(name.clone(), value);
                    }
                    bytes += serde_json::to_vec(&values).unwrap().len() + 1;
                    if bytes > MAX_FRAME_BYTES {
                        return Err("SQLite rows exceed native frame limit.".into());
                    }
                    rows.push(values);
                }
                Ok(json!(rows))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(
        worker: &Worker,
        responses: &mpsc::Receiver<String>,
        id: &str,
        value: Value,
    ) -> Value {
        worker
            .submit(id.into(), serde_json::from_value(value).unwrap())
            .unwrap();
        serde_json::from_str(
            &responses
                .recv_timeout(std::time::Duration::from_secs(3))
                .unwrap(),
        )
        .unwrap()
    }
    fn open(worker: &Worker, responses: &mpsc::Receiver<String>) -> String {
        request(
            worker,
            responses,
            "open",
            json!({"kind":"open","appId":"so.epicenter.mail","name":"cache"}),
        )["data"]["connection"]
            .as_str()
            .unwrap()
            .into()
    }
    fn statement(kind: &str, connection: &str, sql: &str) -> Value {
        json!({"kind":kind,"connection":connection,"statement":{"sql":sql,"parameters":[]}})
    }
    #[test]
    fn native_requests_keep_each_account_database_separate() {
        let root = tempfile::tempdir().unwrap();
        let (tx, rx) = mpsc::sync_channel(64);
        let mut worker = Worker::new(root.path().into(), 1, tx, Arc::new(AtomicBool::new(false)));
        let mut seen = std::collections::HashSet::new();
        for (authority, person) in [
            ("one", "alice"),
            ("one", "bob"),
            ("two", "alice"),
            ("one", "alice"),
        ] {
            let opened = request(
                &worker,
                &rx,
                "open",
                json!({"kind":"open","appId":"so.epicenter.mail","name":"cache","account":{"authorityId":authority,"principalId":person}}),
            );
            let connection = opened["data"]["connection"].as_str().unwrap();
            assert_eq!(
                request(
                    &worker,
                    &rx,
                    "ddl",
                    statement(
                        "run",
                        connection,
                        "CREATE TABLE IF NOT EXISTS messages (id INTEGER)"
                    )
                )["status"],
                "ok"
            );
            let count = request(
                &worker,
                &rx,
                "count",
                statement("all", connection, "SELECT count(*) AS n FROM messages"),
            );
            assert_eq!(
                count["data"][0]["n"],
                if seen.contains(&(authority, person)) {
                    1
                } else {
                    0
                }
            );
            if seen.insert((authority, person)) {
                assert_eq!(
                    request(
                        &worker,
                        &rx,
                        "insert",
                        statement("run", connection, "INSERT INTO messages VALUES (1)")
                    )["status"],
                    "ok"
                );
            }
            assert_eq!(
                request(
                    &worker,
                    &rx,
                    "close",
                    json!({"kind":"close","connection":connection})
                )["status"],
                "ok"
            );
        }
        worker.stop();
    }
    #[test]
    fn values_transactions_and_scope_are_native_owned() {
        let root = tempfile::tempdir().unwrap();
        let (tx, rx) = mpsc::sync_channel(64);
        let mut worker = Worker::new(root.path().into(), 1, tx, Arc::new(AtomicBool::new(false)));
        let connection = open(&worker, &rx);
        assert_eq!(request(&worker,&rx,"ddl",statement("run",&connection,"CREATE TABLE messages(id INTEGER PRIMARY KEY, value BLOB, text TEXT, number REAL, empty TEXT)"))["status"],"ok");
        let insert = json!({"kind":"run","connection":connection,"statement":{"sql":"INSERT INTO messages VALUES(?,?,?,?,?)","parameters":[1,{"blob":[0,255]},"'; DELETE FROM messages;--",1.5,null]}});
        assert_eq!(
            request(&worker, &rx, "insert", insert)["data"]["changes"],
            1
        );
        assert_eq!(
            request(
                &worker,
                &rx,
                "readonly-run",
                statement("run", &connection, "SELECT * FROM messages")
            )["data"]["changes"],
            0
        );
        assert_eq!(
            request(
                &worker,
                &rx,
                "pragma-run",
                statement("run", &connection, "PRAGMA user_version")
            )["data"]["changes"],
            0
        );
        let rows = request(
            &worker,
            &rx,
            "all",
            statement("all", &connection, "SELECT * FROM messages"),
        );
        assert_eq!(rows["data"][0]["value"], json!({"blob":[0,255]}));
        assert_eq!(rows["data"][0]["empty"], Value::Null);
        let batch = json!({"kind":"batch","connection":connection,"statements":[{"sql":"INSERT INTO messages(id) VALUES(2)","parameters":[]},{"sql":"INSERT INTO messages(id) VALUES(1)","parameters":[]}]});
        assert_eq!(request(&worker, &rx, "batch", batch)["status"], "error");
        assert_eq!(
            request(
                &worker,
                &rx,
                "count",
                statement("all", &connection, "SELECT count(*) AS n FROM messages")
            )["data"][0]["n"],
            1
        );
        assert_eq!(
            request(
                &worker,
                &rx,
                "close",
                json!({"kind":"close","connection":connection})
            )["status"],
            "ok"
        );
        let reopened = open(&worker, &rx);
        assert_ne!(connection, reopened);
        assert_eq!(
            request(
                &worker,
                &rx,
                "stale",
                statement("all", &connection, "SELECT 1")
            )["status"],
            "error"
        );
        assert_eq!(
            request(
                &worker,
                &rx,
                "restored",
                statement("all", &reopened, "SELECT count(*) AS n FROM messages")
            )["data"][0]["n"],
            1
        );
        request(
            &worker,
            &rx,
            "close-again",
            json!({"kind":"close","connection":reopened}),
        );
        request(
            &worker,
            &rx,
            "delete",
            json!({"kind":"delete","appId":"so.epicenter.mail","name":"cache"}),
        );
        assert!(!root
            .path()
            .join("apps/so.epicenter.mail/device/no-account/sqlite/cache.sqlite")
            .exists());
        worker.stop();
    }
    #[test]
    fn restricted_queries_preserve_columns_tags_and_refuse_escapes() {
        let root = tempfile::tempdir().unwrap();
        let (tx, rx) = mpsc::sync_channel(64);
        let mut worker = Worker::new(root.path().into(), 2, tx, Arc::new(AtomicBool::new(false)));
        let connection = open(&worker, &rx);
        request(
            &worker,
            &rx,
            "ddl",
            statement("run", &connection, "CREATE TABLE messages(id TEXT)"),
        );
        request(
            &worker,
            &rx,
            "private",
            statement("run", &connection, "CREATE TABLE sync_state(cursor TEXT)"),
        );
        for sql in [
            "DELETE FROM messages RETURNING id",
            "SELECT count(*) FROM sync_state",
            "SELECT name FROM sqlite_schema",
            "SELECT * FROM pragma_database_list",
            "ATTACH DATABASE ':memory:' AS other",
            "SELECT 1;SELECT 2",
            "SELECT 1e999",
            "/* empty */",
        ] {
            let response = request(
                &worker,
                &rx,
                "denied",
                json!({"kind":"query","connection":connection,"statement":{"sql":sql,"parameters":[]},"tables":["messages"]}),
            );
            assert_eq!(response["status"], "error", "{sql}: {response}");
        }
        let tagged = request(
            &worker,
            &rx,
            "tagged",
            json!({"kind":"query","connection":connection,"statement":{"sql":"SELECT 9223372036854775807 AS same, X'00ff' AS same, NULL","parameters":[]},"tables":["messages"]}),
        );
        assert_eq!(tagged["data"]["columns"], json!(["same", "same", "NULL"]));
        assert_eq!(
            tagged["data"]["rows"],
            json!([[{"integer":"9223372036854775807"},{"blob":"00ff"},null]])
        );
        request(
            &worker,
            &rx,
            "shadow",
            statement("run", &connection, "CREATE TABLE json_each(secret TEXT)"),
        );
        let shadow = request(
            &worker,
            &rx,
            "shadow-denied",
            json!({"kind":"query","connection":connection,"statement":{"sql":"SELECT count(*) FROM json_each","parameters":[]},"tables":["messages"]}),
        );
        assert_eq!(shadow["status"], "error");
        let sql=format!("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000) SELECT printf('%01000d',x) AS \"{}\" FROM n", "x".repeat(60_000));
        let bounded = request(
            &worker,
            &rx,
            "bounded",
            json!({"kind":"query","connection":connection,"statement":{"sql":sql,"parameters":[]},"tables":["messages"]}),
        );
        assert_eq!(bounded["status"], "ok", "{bounded}");
        assert_eq!(bounded["data"]["truncated"], true);
        assert!(bounded["data"]["rows"].as_array().unwrap().len() < 1000);
        assert!(serde_json::to_vec(&bounded["data"]).unwrap().len() <= 1024 * 1024);
        worker.stop();
    }
    #[test]
    fn cancellation_and_generation_retirement_do_not_wait_for_unbounded_sql() {
        let root = tempfile::tempdir().unwrap();
        let (tx, rx) = mpsc::sync_channel(64);
        let mut worker = Worker::new(root.path().into(), 3, tx, Arc::new(AtomicBool::new(false)));
        let connection = open(&worker, &rx);
        let endless =
            "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n) SELECT sum(x) FROM n";
        worker.submit("query".into(),serde_json::from_value(json!({"kind":"query","connection":connection,"statement":{"sql":endless,"parameters":[]},"tables":[]})).unwrap()).unwrap();
        worker.cancel("query");
        let canceled: Value =
            serde_json::from_str(&rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap())
                .unwrap();
        assert_eq!(canceled["status"], "error");
        worker
            .submit(
                "trusted".into(),
                serde_json::from_value(statement("all", &connection, endless)).unwrap(),
            )
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(10));
        let started = std::time::Instant::now();
        worker.stop();
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
        let (tx, rx) = mpsc::sync_channel(64);
        let mut next = Worker::new(root.path().into(), 4, tx, Arc::new(AtomicBool::new(false)));
        let reopened = open(&next, &rx);
        assert_ne!(connection, reopened);
        assert_eq!(
            request(
                &next,
                &rx,
                "stale",
                statement("all", &connection, "SELECT 1")
            )["status"],
            "error"
        );
        next.stop();
    }
    #[test]
    fn protocol_rejects_paths_extra_fields_and_invalid_blobs() {
        for value in [
            json!({"kind":"open","appId":"so.epicenter.mail","replica":{"library":"local"},"name":"cache"}),
            json!({"kind":"open","path":"/tmp/foreign","appId":"so.epicenter.mail","name":"cache"}),
            json!({"kind":"run","connection":"1:1","statement":{"sql":"SELECT ?","parameters":[{"blob":[256]}]}}),
        ] {
            assert!(serde_json::from_value::<Request>(value).is_err());
        }
        assert!(database_path(std::path::Path::new("/tmp"), "../escape", "cache", None).is_err());
        assert!(database_path(
            std::path::Path::new("/tmp"),
            "so.epicenter.mail",
            "../cache",
            None
        )
        .is_err());
    }
    #[test]
    fn sqlite_paths_depend_only_on_application_and_database() {
        let root = std::path::Path::new("/tmp/device-sqlite-test");
        assert_eq!(
            database_path(root, "so.epicenter.notes", "search", None).unwrap(),
            root.join("apps/so.epicenter.notes/device/no-account/sqlite/search.sqlite")
        );
        assert_ne!(
            database_path(root, "so.epicenter.notes", "search", None).unwrap(),
            database_path(root, "so.epicenter.mail", "search", None).unwrap()
        );
        assert_ne!(
            database_path(root, "so.epicenter.notes", "search", None).unwrap(),
            database_path(root, "so.epicenter.notes", "other", None).unwrap()
        );
    }
}
