//! The IPC surface: the grant, and one command per method of the page's
//! folder storage (`storage`, ADR-0581).
//!
//! A page names a scope and folder-relative paths, nothing else; the
//! registry decides whether the invoking window may use the scope, and every
//! call happens in the root the scope was granted, which the page never
//! supplies. Each change holds a `PageWork` admission while it runs, which
//! shares its root's publishing mutex. Every command that touches the disk
//! runs on the blocking pool, never on the thread that drives the windows.
//! The folder's Git is not here: the `epicenter` CLI runs it (ADR-0559).
//!
//! These commands are a contract between this shell and the pages it ships
//! or installs, not across versions: a shell update may change them, and an
//! installed app built for the old ones is rebuilt.

use std::path::{Path, PathBuf};

use epicenter_folder_core::registry::{Granted, GrantError, PageWork};
use epicenter_folder_core::storage::{self, Children, FileListing, PutOutcome, StorageError};
use tauri::{Manager, Runtime, Webview};

use crate::{Folders, WindowFolder};

/// Run blocking work off the window thread.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
    lost: impl FnOnce(String) -> T,
) -> T {
    match tauri::async_runtime::spawn_blocking(work).await {
        Ok(value) => value,
        Err(cause) => lost(cause.to_string()),
    }
}

fn failed(path: &str, operation: &str, message: String) -> StorageError {
    StorageError::Io {
        path: path.to_string(),
        operation: operation.to_string(),
        message,
    }
}

/// Which app this window runs and the folder the shell handed it
/// (`Folders::hand`), or `None` for a window that runs no app. An app's
/// page opens this folder, never one its own URL names.
#[tauri::command]
#[specta::specta]
pub async fn window_folder<R: Runtime>(webview: Webview<R>) -> Option<WindowFolder> {
    webview
        .app_handle()
        .state::<Folders>()
        .handed(webview.label())
}

/// Give this window the directory of a scope the shell registered for it.
/// The window reads and changes it through this plugin's commands alone;
/// nothing else on disk becomes reachable. From the first grant the folder
/// is watched, and the scope's windows hear `epicenter-folder://changed`.
/// Every grant also removes the staged files a stopped save left an hour or
/// more ago (`storage::sweep_scratch`).
#[tauri::command]
#[specta::specta]
pub async fn grant_directory<R: Runtime>(
    webview: Webview<R>,
    scope: String,
) -> Result<Granted, GrantError> {
    let label = webview.label().to_string();
    let app = webview.app_handle().clone();
    blocking(
        move || {
            let folders = app.state::<Folders>();
            let granted = folders.registry.grant(&scope, &label)?;
            let root = Path::new(&granted.root);
            folders.watch(&app, &scope, root);
            storage::sweep_stale_scratch(root);
            Ok(granted)
        },
        |message| Err(GrantError::Unavailable { message }),
    )
    .await
}

/// The root this window was granted for `scope`, for a read. A read holds
/// no admission: it publishes nothing.
fn reading_root<R: Runtime>(
    webview: &Webview<R>,
    scope: &str,
    path: &str,
    operation: &str,
) -> Result<PathBuf, StorageError> {
    webview
        .app_handle()
        .state::<Folders>()
        .registry
        .granted_root(scope, webview.label())
        .map_err(|refusal| failed(path, operation, format!("{refusal:?}")))
}

/// The root this window was granted for `scope`, and the admission the change
/// holds until it ends.
fn changing_root<R: Runtime>(
    webview: &Webview<R>,
    scope: &str,
    path: &str,
    operation: &str,
) -> Result<(PathBuf, PageWork), StorageError> {
    webview
        .app_handle()
        .state::<Folders>()
        .registry
        .admit_page_work(scope, webview.label())
        .map_err(|refusal| failed(path, operation, format!("{refusal:?}")))
}

/// Every entry below a granted folder's root, `.git` aside, none of them
/// followed (`storage::list`).
#[tauri::command]
#[specta::specta]
pub async fn list_folder<R: Runtime>(
    webview: Webview<R>,
    scope: String,
) -> Result<FileListing, StorageError> {
    let root = reading_root(&webview, &scope, "", "list")?;
    blocking(
        move || storage::list(&root),
        |message| Err(failed("", "list", message)),
    )
    .await
}

/// The immediate children of a directory in a granted folder, the root for
/// `""` (`storage::children`).
#[tauri::command]
#[specta::specta]
pub async fn read_folder_children<R: Runtime>(
    webview: Webview<R>,
    scope: String,
    directory: String,
) -> Result<Children, StorageError> {
    let root = reading_root(&webview, &scope, &directory, "list")?;
    let at = directory.clone();
    blocking(
        move || storage::children(&root, &directory),
        |message| Err(failed(&at, "list", message)),
    )
    .await
}

/// Read a file in a granted folder (`storage::read`). The bytes return as a
/// raw response, an `ArrayBuffer` to the page, rather than as a JSON array of
/// numbers. tauri-specta cannot type a raw response, so the generated
/// bindings leave this command out and `tauri-files.ts` invokes it by name;
/// `init` dispatches it beside the typed commands.
#[tauri::command]
pub async fn read_folder_file<R: Runtime>(
    webview: Webview<R>,
    scope: String,
    path: String,
) -> Result<tauri::ipc::Response, StorageError> {
    let root = reading_root(&webview, &scope, &path, "read")?;
    let at = path.clone();
    blocking(
        move || storage::read(&root, &path),
        |message| Err(failed(&at, "read", message)),
    )
    .await
    .map(tauri::ipc::Response::new)
}

/// Publish a file's bytes in a granted folder, or remove it, only while the
/// path holds what the page expects (`storage::put`): `"landed"`, or
/// `"stale"` when it did not hold that and nothing changed.
///
/// The bytes are the request's raw body, so file content crosses IPC as it
/// is rather than as a JSON array of numbers. Percent-encoded headers carry
/// the rest: `scope`, `path`, `remove` (`true` to remove the file, when the
/// body is ignored), and `if-match`, the SHA-256 of the file the page
/// expects there, left out for no file. A JSON array of bytes is accepted as
/// well: Tauri sends one when its custom-protocol IPC failed and it fell
/// back to `postMessage`. Any other body is refused.
///
/// The check and the change hold the root's publishing mutex, which every
/// window's changes on that root share, and its save lock, which a Bun
/// process's saves take too (`PageWork::publishing`), so a save is never
/// overtaken between them by another save through the shell or the Bun
/// host. A save lock another process holds too long is `Io`, and nothing
/// changed. tauri-specta cannot type a raw request, so the generated
/// bindings leave this command out and `tauri-files.ts` invokes it by name;
/// `init` dispatches it beside the typed commands.
#[tauri::command]
pub async fn put_folder_file<R: Runtime>(
    webview: Webview<R>,
    request: tauri::ipc::Request<'_>,
) -> Result<PutOutcome, StorageError> {
    let header = |name: &str| -> Result<Option<String>, String> {
        let Some(value) = request.headers().get(name) else {
            return Ok(None);
        };
        percent_encoding::percent_decode(value.as_bytes())
            .decode_utf8()
            .map(|decoded| Some(decoded.into_owned()))
            .map_err(|_| format!("the {name} header is not percent-encoded UTF-8"))
    };
    let required = |name: &str| {
        header(name)?.ok_or_else(|| format!("put_folder_file needs the {name} header"))
    };
    let path = header("path").ok().flatten().unwrap_or_default();
    let refused = |message: String| failed(&path, "write", message);
    let scope = required("scope").map_err(refused)?;
    required("path").map_err(refused)?;
    let remove = match required("remove").map_err(refused)?.as_str() {
        "true" => true,
        "false" => false,
        other => return Err(refused(format!("remove is {other:?}, not true or false"))),
    };
    let if_match = header("if-match").map_err(refused)?;
    // The blocking pool needs the bytes to outlive the request.
    let bytes: Option<Vec<u8>> = match (remove, request.body()) {
        (true, _) => None,
        (false, tauri::ipc::InvokeBody::Raw(bytes)) => Some(bytes.clone()),
        (false, tauri::ipc::InvokeBody::Json(value)) => Some(
            serde_json::from_value(value.clone()).map_err(|_| {
                refused("put_folder_file takes its bytes as a raw body".to_string())
            })?,
        ),
    };
    let operation = if remove { "remove" } else { "write" };
    let (root, work) = changing_root(&webview, &scope, &path, operation)?;
    let at = path.clone();
    blocking(
        move || {
            storage::put(&root, &path, bytes.as_deref(), if_match.as_deref(), || {
                work.publishing()
            })
        },
        |message| Err(failed(&at, operation, message)),
    )
    .await
}

/// Make a directory and its missing ancestors in a granted folder
/// (`storage::mkdir`).
#[tauri::command]
#[specta::specta]
pub async fn make_folder_directory<R: Runtime>(
    webview: Webview<R>,
    scope: String,
    path: String,
) -> Result<(), StorageError> {
    let (root, work) = changing_root(&webview, &scope, &path, "create directory")?;
    let at = path.clone();
    blocking(
        move || {
            let _work = work;
            storage::mkdir(&root, &path)
        },
        |message| Err(failed(&at, "create directory", message)),
    )
    .await
}

/// Remove an empty directory in a granted folder (`storage::rmdir`), under
/// the same publishing and save locks as a put.
#[tauri::command]
#[specta::specta]
pub async fn remove_folder_directory<R: Runtime>(
    webview: Webview<R>,
    scope: String,
    path: String,
) -> Result<(), StorageError> {
    let (root, work) = changing_root(&webview, &scope, &path, "remove directory")?;
    let at = path.clone();
    blocking(
        move || storage::rmdir(&root, &path, || work.publishing()),
        |message| Err(failed(&at, "remove directory", message)),
    )
    .await
}
