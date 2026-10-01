use rusqlite::{
    ffi,
    hooks::{AuthAction, AuthContext, Authorization},
    limits::Limit,
    params_from_iter,
    types::{Value, ValueRef},
    Connection, OpenFlags,
};
use serde_json::{json, Value as Json};
use std::{
    ffi::{CStr, CString},
    ptr,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

// The reader owns one bounded snapshot and installs policy before user SQL.
const ROW_LIMIT: usize = 1000;
const BYTE_LIMIT: usize = 1024 * 1024;
const OP_LIMIT: usize = 1_000_000;

// SQLite parses every remaining tail under the same installed authorizer.
// The pointer belongs to this rusqlite connection and its bundled SQLite.
fn one_statement(conn: &Connection, sql: &str) -> Result<(), String> {
    let text = CString::new(sql).map_err(|_| "embedded NUL".to_string())?;
    let mut cursor = text.as_ptr();
    let end = unsafe { cursor.add(text.as_bytes().len()) };
    let mut count = 0;
    while cursor < end {
        let mut stmt = ptr::null_mut();
        let mut tail = ptr::null();
        let rc = unsafe {
            ffi::sqlite3_prepare_v3(
                conn.handle(),
                cursor,
                (end.offset_from(cursor) + 1) as i32,
                0,
                &mut stmt,
                &mut tail,
            )
        };
        if !stmt.is_null() {
            count += 1;
            unsafe {
                ffi::sqlite3_finalize(stmt);
            }
        }
        if rc != ffi::SQLITE_OK {
            return Err(format!(
                "prepare {rc}: {}",
                unsafe { CStr::from_ptr(ffi::sqlite3_errmsg(conn.handle())) }.to_string_lossy()
            ));
        }
        if count > 1 {
            return Err("multiple statements".into());
        }
        if tail <= cursor || tail > end {
            return Err("invalid parser tail".into());
        }
        cursor = tail;
    }
    if count != 1 {
        return Err("expected one statement".into());
    }
    Ok(())
}

pub fn run(
    path: &std::path::Path,
    sql: &str,
    parameters: &[Value],
    tables: Vec<String>,
    canceled: Arc<AtomicBool>,
    stopped: Arc<AtomicBool>,
) -> Result<Json, String> {
    if canceled.load(Ordering::Acquire) || stopped.load(Ordering::Acquire) {
        return Err("SQLite query canceled.".into());
    }
    if sql.len() > 64 * 1024 {
        return Err("SQLite query exceeds SQL limit.".into());
    }
    if tables.iter().any(|table| {
        table.to_ascii_lowercase().starts_with("sqlite_")
            || table.to_ascii_lowercase().starts_with("pragma_")
            || matches!(table.as_str(), "dbstat" | "sqlite_dbpage")
    }) {
        return Err("Internal SQLite tables cannot be queried.".into());
    }
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| e.to_string())?;
    conn.busy_timeout(Duration::from_millis(50))
        .map_err(|e| e.to_string())?;
    conn.set_limit(Limit::SQLITE_LIMIT_LENGTH, BYTE_LIMIT as i32)
        .map_err(|e| e.to_string())?;
    conn.set_limit(Limit::SQLITE_LIMIT_SQL_LENGTH, 64 * 1024)
        .map_err(|e| e.to_string())?;
    conn.set_limit(Limit::SQLITE_LIMIT_COLUMN, 128)
        .map_err(|e| e.to_string())?;
    conn.set_limit(Limit::SQLITE_LIMIT_EXPR_DEPTH, 100)
        .map_err(|e| e.to_string())?;
    // Hold the same read snapshot for schema classification and query execution.
    conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
    let mut physical_relations: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_schema")
        .map_err(|e| e.to_string())?
        .query_map([], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<_>>()
        .map_err(|e| e.to_string())?;
    physical_relations.extend(
        [
            "sqlite_master",
            "sqlite_schema",
            "sqlite_temp_master",
            "sqlite_temp_schema",
        ]
        .map(str::to_owned),
    );
    let schema_relations = physical_relations.clone();
    // A physical table may shadow an eponymous JSON module. Warm only modules
    // that actually exist in this snapshot, and never exempt the shadow table.
    for module in ["json_each", "json_tree"] {
        if !schema_relations
            .iter()
            .any(|name| name.eq_ignore_ascii_case(module))
        {
            conn.prepare(&format!("SELECT value FROM {module}('[]')"))
                .map_err(|error| error.to_string())?;
        }
    }
    physical_relations.extend(
        conn.prepare("PRAGMA module_list")
            .map_err(|e| e.to_string())?
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?,
    );
    let denied = Arc::new(Mutex::new(Vec::new()));
    let observed = denied.clone();
    conn.authorizer(Some(move |context: AuthContext<'_>| {
        let allowed = match context.action {
            AuthAction::Select | AuthAction::Recursive => true,
            AuthAction::Read {
                table_name,
                column_name,
            } => {
                let is_json_module = matches!(table_name, "json_each" | "json_tree")
                    && !schema_relations
                        .iter()
                        .any(|name| name.eq_ignore_ascii_case(table_name));
                if context.database_name.is_none() && column_name.is_empty() {
                    // Unqualified physical count(*) and CTEs share this callback shape.
                    // Resolve against schema captured during trusted construction.
                    if (tables.iter().any(|allowed| allowed == table_name) || is_json_module)
                        || (!table_name.to_ascii_lowercase().starts_with("pragma_")
                            && !physical_relations
                                .iter()
                                .any(|name| name.eq_ignore_ascii_case(table_name)))
                    {
                        return Authorization::Allow;
                    }
                }
                context.database_name == Some("main")
                    && (tables.iter().any(|allowed| allowed == table_name) || is_json_module)
            }
            AuthAction::Function { function_name } => matches!(
                function_name,
                "count"
                    | "sum"
                    | "avg"
                    | "min"
                    | "max"
                    | "total"
                    | "abs"
                    | "round"
                    | "length"
                    | "lower"
                    | "upper"
                    | "trim"
                    | "ltrim"
                    | "rtrim"
                    | "substr"
                    | "substring"
                    | "replace"
                    | "instr"
                    | "coalesce"
                    | "ifnull"
                    | "nullif"
                    | "iif"
                    | "typeof"
                    | "hex"
                    | "unhex"
                    | "unicode"
                    | "char"
                    | "printf"
                    | "format"
                    | "date"
                    | "time"
                    | "datetime"
                    | "julianday"
                    | "unixepoch"
                    | "strftime"
                    | "timediff"
                    | "json"
                    | "json_array"
                    | "json_object"
                    | "json_extract"
                    | "json_array_length"
                    | "json_type"
                    | "json_valid"
                    | "json_quote"
                    | "json_each"
                    | "json_tree"
                    | "json_group_array"
                    | "json_group_object"
                    | "like"
                    | "glob"
                    | "randomblob"
                    | "zeroblob"
            ),
            _ => false,
        };
        if allowed {
            Authorization::Allow
        } else {
            observed
                .lock()
                .unwrap()
                .push(format!("{:?} {:?}", context.database_name, context.action));
            Authorization::Deny
        }
    }))
    .map_err(|e| e.to_string())?;
    let started = Instant::now();
    let calls = Arc::new(AtomicUsize::new(0));
    let progress = calls.clone();
    let canceled_progress = canceled.clone();
    let stopped_progress = stopped.clone();
    conn.progress_handler(
        1000,
        Some(move || {
            let operations = (progress.fetch_add(1, Ordering::Relaxed) + 1) * 1000;
            operations >= OP_LIMIT
                || started.elapsed() > Duration::from_secs(1)
                || canceled_progress.load(Ordering::Acquire)
                || stopped_progress.load(Ordering::Acquire)
        }),
    )
    .map_err(|e| e.to_string())?;
    let check_completion = || {
        if canceled.load(Ordering::Acquire)
            || stopped.load(Ordering::Acquire)
            || started.elapsed() > Duration::from_secs(1)
        {
            return Err("SQLite query interrupted.".to_string());
        }
        Ok(())
    };
    let result: Result<Json, String> = (|| {
        check_completion()?;
        one_statement(&conn, sql)?;
        let mut statement = conn.prepare(sql).map_err(|e| e.to_string())?;
        let columns: Vec<String> = statement
            .column_names()
            .into_iter()
            .map(str::to_owned)
            .collect();
        if columns.iter().any(|column| column.len() > 64 * 1024) {
            return Err("SQLite column name exceeds limit.".into());
        }
        let mut bytes = serde_json::to_vec(&json!({"columns":columns,"rows":[],"truncated":false}))
            .unwrap()
            .len();
        if bytes > BYTE_LIMIT {
            return Err("SQLite query metadata exceeds result limit.".into());
        }
        let mut rows = Vec::new();
        let mut truncated = None;
        let mut source = statement
            .query(params_from_iter(parameters.iter()))
            .map_err(|e| e.to_string())?;
        while let Some(row) = source.next().map_err(|e| e.to_string())? {
            check_completion()?;
            if rows.len() == ROW_LIMIT {
                truncated = Some("rows");
                break;
            }
            let mut values = Vec::new();
            for i in 0..columns.len() {
                values.push(match row.get_ref(i).map_err(|e| e.to_string())? {
                    ValueRef::Null => Json::Null,
                    ValueRef::Integer(n) => json!({"integer": n.to_string()}),
                    ValueRef::Real(n) if n.is_finite() => json!(n),
                    ValueRef::Real(_) => return Err("SQLite returned a non-finite number.".into()),
                    ValueRef::Text(text) => {
                        Json::String(String::from_utf8_lossy(text).into_owned())
                    }
                    ValueRef::Blob(blob) => {
                        json!({"blob": blob.iter().map(|b| format!("{b:02x}")).collect::<String>()})
                    }
                });
            }
            let encoded_bytes = serde_json::to_vec(&values).unwrap().len();
            // JavaScript expands some reals (1e20) when validating the decoded
            // result. Reserve the longer decimal spelling too; extreme powers
            // may truncate earlier, but never exceed the receiving byte bound.
            let decimal_expansion: usize = values
                .iter()
                .filter_map(Json::as_f64)
                .map(|number| {
                    number
                        .to_string()
                        .len()
                        .saturating_sub(serde_json::to_string(&number).unwrap().len())
                })
                .sum();
            bytes += encoded_bytes + decimal_expansion + usize::from(!rows.is_empty());
            if bytes > BYTE_LIMIT {
                truncated = Some("bytes");
                break;
            }
            rows.push(values);
        }
        check_completion()?;
        Ok(json!({"columns": columns, "rows": rows, "truncated": truncated.is_some()}))
    })();
    result.map_err(|e| {
        format!(
            "{e}; denied={:?}; progressCalls={}; elapsedMs={}",
            denied.lock().unwrap(),
            calls.load(Ordering::Relaxed),
            started.elapsed().as_millis()
        )
    })
}
