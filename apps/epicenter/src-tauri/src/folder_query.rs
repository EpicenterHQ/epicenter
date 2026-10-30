//! Read-only SQL over the invoking editor window's bound directory.
//! The page supplies a statement, never a filesystem path. The existing CLI
//! child lifetime and Bun SQLite executor own execution and cleanup.
use std::collections::BTreeMap;

use serde::Deserialize;
use tauri::{Manager, Webview};
use tauri_plugin_epicenter_folder::FolderExt;

use crate::cli::{failed, window_invocation, CliError};

#[derive(Deserialize, serde::Serialize, specta::Type)]
#[serde(untagged)]
pub enum QueryCell {
    Null(()),
    Number(f64),
    Text(String),
    Bytes(Vec<u8>),
}

#[derive(Deserialize, serde::Serialize, specta::Type)]
pub struct QueryAnswer {
    columns: Vec<String>,
    rows: Vec<BTreeMap<String, QueryCell>>,
    excluded: Vec<String>,
    warnings: Vec<String>,
    truncated: bool,
}

#[tauri::command]
#[specta::specta]
pub async fn folder_query(webview: Webview, sql: String) -> Result<QueryAnswer, CliError> {
    let directory = webview
        .app_handle()
        .folders()
        .bound(webview.label())
        .map_err(|error| failed(error.to_string()))?;
    let input = serde_json::to_vec(&serde_json::json!({ "sql": sql }))
        .map_err(|error| failed(error.to_string()))?;
    let root = directory
        .root()
        .to_str()
        .ok_or_else(|| failed("The folder's path is not UTF-8"))?;
    let invocation = window_invocation(&webview)?;
    tokio::time::timeout(
        std::time::Duration::from_secs(15),
        invocation.answer(&["documents-query", root, "--json"], Some(input)),
    )
    .await
    .map_err(|_| CliError::Refused {
        message: "The query ran for 15 seconds; narrow it and try again".into(),
    })?
}
