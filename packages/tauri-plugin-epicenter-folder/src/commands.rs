//! The IPC surface: the grant, the checked file changes, and `git`.
//!
//! A page names a scope and nothing else; the registry decides whether the
//! invoking window may use it, and every change and `git` run happens in the
//! root the scope was granted, which the page never supplies. Each command
//! that touches the disk or runs `git` holds a `PageWork` admission while it
//! runs, so a quit waits for it, and runs on the blocking pool, never on the
//! thread that drives the windows.

use std::sync::Arc;

use epicenter_folder_core::page_files;
use epicenter_folder_core::page_git::{self, GitOutput};
use epicenter_folder_core::registry::{Granted, GrantError, PageWork};
use tauri::{Manager, Runtime, Webview};

use crate::Folders;

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

/// Give this window the directory of a scope the shell registered for it.
/// The folder is locked on its first grant and stays locked until shutdown.
/// The window is given the file system plugin's reading commands for that
/// directory and everything beneath it, dot files included, through a
/// capability added at run time for this window (`directory_capability`).
/// Nothing else on disk becomes reachable.
#[tauri::command]
#[specta::specta]
pub async fn grant_directory<R: Runtime>(
    webview: Webview<R>,
    scope: String,
) -> Result<Granted, GrantError> {
    let label = webview.label().to_string();
    let app = webview.app_handle().clone();
    let granting = (scope.clone(), label.clone());
    let granted = blocking(
        move || {
            app.state::<Folders>()
                .registry
                .grant(&granting.0, &granting.1)
        },
        |message| Err(GrantError::Unavailable { message }),
    )
    .await?;
    let app = webview.app_handle();
    let folders = app.state::<Folders>();
    let key = (label.clone(), scope.clone());
    let mut capabilities = folders
        .granted_capabilities
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !capabilities.contains(&key) {
        let url = webview.url().map_err(|cause| GrantError::Unavailable {
            message: format!("the page's address could not be read: {cause}"),
        })?;
        app.add_capability(directory_capability(
            &label,
            &scope,
            std::path::Path::new(&granted.root),
            &url,
        ))
        .map_err(|cause| GrantError::Unavailable {
            message: format!(
                "the folder directory '{}' could not be granted: {cause}",
                granted.root
            ),
        })?;
        capabilities.insert(key);
    }
    Ok(granted)
}

/// The fs plugin commands a granted folder's storage reads with. A shell
/// lists the same permissions, unscoped, in the window's capability, so its
/// build checks every name; only a grant gives them a path. Changes go
/// through this crate's own commands (`write_folder_file` and the rest),
/// which check the whole path on disk (`page_files`).
pub const DIRECTORY_COMMANDS: [&str; 3] = [
    "fs:allow-read-dir",
    "fs:allow-lstat",
    "fs:allow-read-file",
];

/// The glob patterns a window may read, as Tauri's fs scope compiles them
/// (`glob::Pattern::new`). The root is escaped, so a `[`, `*`, or `?` in its
/// name stays literal. The scope resolves every existing path, links
/// included, before matching, so a link inside the folder that points
/// outside it is refused.
pub(crate) fn directory_patterns(root: &std::path::Path) -> Vec<String> {
    let base = glob::Pattern::escape(&root.to_string_lossy());
    vec![base.clone(), format!("{base}/**")]
}

/// One window's reading access to one folder: the fs plugin's reading
/// commands on the root and everything beneath it. A capability's scope
/// matches dot files when the fs plugin is configured with
/// `requireLiteralLeadingDot: false`, which a shell must set: `.git` and
/// files other programs leave behind live there.
///
/// The capability applies to this window's pages at the origin of the page
/// that asked, when it is an `http(s)` one such as a shell's loopback host,
/// and to its local pages, the app's own bundle. Tauri matches a page's URL
/// against the capability on every call, not once at the grant, so other
/// content reaches this window only by navigating it, which the shell's
/// navigation guards keep out.
fn directory_capability(
    label: &str,
    scope: &str,
    root: &std::path::Path,
    url: &tauri::Url,
) -> tauri::ipc::CapabilityBuilder {
    let readable: Vec<serde_json::Value> = directory_patterns(root)
        .into_iter()
        .map(|path| serde_json::json!({ "path": path }))
        .collect();
    let mut capability = tauri::ipc::CapabilityBuilder::new(format!(
        "epicenter-folder-directory:{label}:{scope}"
    ))
    .window(label)
    .local(true);
    if matches!(url.scheme(), "http" | "https") {
        capability = capability.remote(url.origin().ascii_serialization());
    }
    for command in DIRECTORY_COMMANDS {
        capability =
            capability.permission_scoped(command, readable.clone(), Vec::<serde_json::Value>::new());
    }
    capability
}

/// The root this window was granted for `scope`, and the admission the change
/// holds until it ends, so a quit waits for it.
fn changing_root<R: Runtime>(
    webview: &Webview<R>,
    scope: &str,
) -> Result<(std::path::PathBuf, PageWork), String> {
    webview
        .app_handle()
        .state::<Folders>()
        .registry
        .admit_page_work(scope, webview.label())
        .map_err(|refusal| format!("{refusal:?}"))
}

/// Write a new file the engine stages in a granted folder's `.git`: a
/// staged copy or a private index copy (`page_files::write_file`).
///
/// The bytes are the request's raw body, as the fs plugin's `write_file`
/// takes them, so file content crosses IPC as it is rather than as a JSON
/// array of numbers. The `scope`, `path`, and `create-new` headers carry the
/// rest, each percent-encoded. A JSON array of bytes is accepted as well, as
/// the fs plugin accepts it: Tauri sends one when its custom-protocol IPC
/// failed and it fell back to `postMessage`. Any other body is refused.
/// tauri-specta cannot type a raw request, so the generated bindings leave
/// this command out and `directory-tauri.ts` invokes it by name; `init`
/// dispatches it beside the typed commands.
#[tauri::command]
pub async fn write_folder_file<R: Runtime>(
    webview: Webview<R>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let header = |name: &str| -> Result<String, String> {
        let value = request
            .headers()
            .get(name)
            .ok_or_else(|| format!("write_folder_file needs the {name} header"))?;
        percent_encoding::percent_decode(value.as_bytes())
            .decode_utf8()
            .map(|decoded| decoded.into_owned())
            .map_err(|_| format!("the {name} header is not percent-encoded UTF-8"))
    };
    let scope = header("scope")?;
    let path = header("path")?;
    let create_new = match header("create-new")?.as_str() {
        "true" => true,
        "false" => false,
        other => return Err(format!("create-new is {other:?}, not true or false")),
    };
    // The blocking pool needs the bytes to outlive the request.
    let bytes: Vec<u8> = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        tauri::ipc::InvokeBody::Json(value) => serde_json::from_value(value.clone())
            .map_err(|_| "write_folder_file takes its bytes as a raw body".to_string())?,
    };
    let (root, work) = changing_root(&webview, &scope)?;
    blocking(
        move || {
            let _work = work;
            page_files::write_file(&root, std::path::Path::new(&path), &bytes, create_new)
        },
        Err,
    )
    .await
}

/// Rename within a granted folder (`page_files::rename`).
#[tauri::command]
#[specta::specta]
pub async fn rename_folder_path<R: Runtime>(
    webview: Webview<R>,
    scope: String,
    from: String,
    to: String,
) -> Result<(), String> {
    let (root, work) = changing_root(&webview, &scope)?;
    blocking(
        move || {
            let _work = work;
            page_files::rename(
                &root,
                std::path::Path::new(&from),
                std::path::Path::new(&to),
            )
        },
        Err,
    )
    .await
}

/// Remove within a granted folder (`page_files::remove`).
#[tauri::command]
#[specta::specta]
pub async fn remove_folder_path<R: Runtime>(
    webview: Webview<R>,
    scope: String,
    path: String,
    recursive: bool,
) -> Result<(), String> {
    let (root, work) = changing_root(&webview, &scope)?;
    blocking(
        move || {
            let _work = work;
            page_files::remove(&root, std::path::Path::new(&path), recursive)
        },
        Err,
    )
    .await
}

/// Make a directory in a granted folder (`page_files::mkdir`).
#[tauri::command]
#[specta::specta]
pub async fn make_folder_directory<R: Runtime>(
    webview: Webview<R>,
    scope: String,
    path: String,
) -> Result<(), String> {
    let (root, work) = changing_root(&webview, &scope)?;
    blocking(
        move || {
            let _work = work;
            page_files::mkdir(&root, std::path::Path::new(&path))
        },
        Err,
    )
    .await
}

/// Run one Git operation for a folder this window was granted.
/// `page_git` decides which operations and options are allowed, and fixes
/// the environment. `authorization`, for a push or fetch to an `https`
/// origin, is sent to that origin alone. `request` is an ID the page makes
/// up for the run, a random UUID, so `cancel_git` can stop it (`git_runs`).
#[tauri::command]
#[specta::specta]
pub async fn run_git<R: Runtime>(
    webview: Webview<R>,
    scope: String,
    args: Vec<String>,
    input: Option<Vec<u8>>,
    index_file: Option<String>,
    authorization: Option<String>,
    request: String,
) -> Result<GitOutput, GrantError> {
    let app = webview.app_handle().clone();
    let window = webview.window().label().to_string();
    let (root, work) = app
        .state::<Folders>()
        .registry
        .admit_page_work(&scope, webview.label())?;
    let cancel = app
        .state::<Folders>()
        .git_runs
        .start(&window, &request)
        .map_err(|message| GrantError::Unavailable { message })?;
    let running = Arc::clone(&cancel);
    let result = blocking(
        move || {
            let _work = work;
            page_git::run(
                &root,
                &args,
                input.as_deref(),
                index_file.as_deref(),
                authorization.as_deref(),
                &running,
            )
        },
        Err,
    )
    .await;
    app.state::<Folders>()
        .git_runs
        .finish(&window, &request, &cancel);
    result.map_err(|message| GrantError::Unavailable { message })
}

/// Stop a `run_git` this window's page started, named by its ID. A run that
/// has not started yet is stopped as it starts. Stopping one that has
/// finished, or another window's, does nothing.
#[tauri::command]
#[specta::specta]
pub async fn cancel_git<R: Runtime>(
    webview: Webview<R>,
    request: String,
) -> Result<(), GrantError> {
    webview
        .state::<Folders>()
        .git_runs
        .cancel(webview.window().label(), &request);
    Ok(())
}
