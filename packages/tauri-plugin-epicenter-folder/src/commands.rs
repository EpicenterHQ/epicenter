//! The IPC surface: opening the calling window's folder, and one command per
//! method of the page's folder storage (`storage`, ADR-0581).
//!
//! A page names folder-relative paths and, optionally, which of its window's
//! roots they are in: `root`, the exact path of the window's own directory
//! or of a root it opened (`open_folder`, which Tauri's runtime file-system
//! scope must allow: `scope`); no `root` is the window's own directory. Every
//! command derives its roots from the calling WebView's label, which Tauri
//! injects, so a page reaches no other path. Each command clones the
//! window's `Directory` when it is admitted and works in that root until it
//! ends, so a window closed and replaced under the same label meanwhile
//! cannot redirect it. Every command that touches the disk runs on the
//! blocking pool, never on the thread that drives the windows. The folder's
//! Git is not here: the `epicenter` CLI runs it (ADR-0559).

use epicenter_folder_core::library::resolved;
use epicenter_folder_core::root::{prepare_directory, PrepareError};
use epicenter_folder_core::storage::{self, ListedFile, PutOutcome, StorageError};
use tauri::ipc::Channel;
use tauri::{Manager, Runtime, Webview, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::scope::admit;
use crate::{folders::CloseAnswer, Directory, FolderChanged, Folders, WindowError};

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

/// Open a root for the calling window and watch it, answering its canonical
/// path, by which the page names it from then on. With no `root`, or the
/// window's own directory's path, it is that directory, which the shell
/// bound before the window existed: refused when gone, never made again.
/// Any other absolute `root` must be a folder an app may keep its files in
/// (`Refused` otherwise) that Tauri's file-system scope allows (`NotGranted`
/// otherwise); it is made, with missing parents, only for `create`, and is
/// `Missing` when it is not there. Each open root has one watch, whose
/// changes go to the latest channel the page opened it with, and removes
/// the staged files a stopped save left an hour or more ago
/// (`storage::sweep_scratch`).
#[tauri::command]
#[specta::specta]
pub async fn open_folder<R: Runtime>(
    webview: Webview<R>,
    root: Option<String>,
    create: bool,
    on_change: Channel<FolderChanged>,
) -> Result<String, WindowError> {
    let label = webview.label().to_string();
    let (primary, observation) = webview
        .app_handle()
        .state::<Folders>()
        .reserve_observation(&label)?;
    let app = webview.app_handle().clone();
    blocking(
        move || {
            let directory = match root.as_deref() {
                // The window's own directory, by any path that resolves to it.
                Some(root) if resolved(std::path::Path::new(root)) != primary.root() => {
                    admit(&webview, root, create)?
                }
                _ => primary,
            };
            let root = directory.root();
            prepare_directory(root, false).map_err(|error| match error {
                PrepareError::Missing => WindowError::Missing,
                PrepareError::Failed(message) => WindowError::Unavailable { message },
            })?;
            storage::sweep_stale_scratch(root);
            app.state::<Folders>()
                .watch(&label, &directory, observation, move |change| {
                    if let Err(error) = on_change.send(change) {
                        log::warn!("The folder observation could not be delivered: {error}");
                    }
                })?;
            Ok(root.to_string_lossy().into_owned())
        },
        |message| Err(WindowError::Unavailable { message }),
    )
    .await
}

/// The canonical path of `root`, a folder this window may open: what a page
/// remembers for a folder the person picked, since the picker answers the
/// path they reached, which may pass through a link (`/tmp` is
/// `/private/tmp` on macOS). `Refused`, `NotGranted` and `Missing` as
/// `open_folder` answers them; nothing is opened, watched or made.
#[tauri::command]
#[specta::specta]
pub async fn resolve_folder<R: Runtime>(
    webview: Webview<R>,
    root: String,
) -> Result<String, WindowError> {
    blocking(
        move || {
            admit(&webview, &root, false)
                .map(|directory| directory.root().to_string_lossy().into_owned())
        },
        |message| Err(WindowError::Unavailable { message }),
    )
    .await
}

/// Let this bound window answer its own native close requests.
#[tauri::command]
#[specta::specta]
pub fn subscribe_close<R: Runtime>(
    window: WebviewWindow<R>,
    on_close: Channel<()>,
) -> Result<u32, WindowError> {
    window
        .state::<Folders>()
        .subscribe_close(window.label(), on_close)
}

#[tauri::command]
#[specta::specta]
pub fn unsubscribe_close<R: Runtime>(window: WebviewWindow<R>, token: u32) {
    window
        .state::<Folders>()
        .unsubscribe_close(window.label(), token);
}

/// The caller can destroy only its own bound window after its writes drain.
#[tauri::command]
#[specta::specta]
pub async fn destroy_bound_window<R: Runtime>(
    window: WebviewWindow<R>,
    token: u32,
) -> Result<bool, String> {
    match window
        .state::<Folders>()
        .begin_close_answer(window.label(), token)
    {
        CloseAnswer::Ignore => return Ok(false),
        CloseAnswer::WaitForPrompt => return Ok(true),
        CloseAnswer::Destroy => {}
    }
    tauri::async_runtime::spawn_blocking(move || {
        let result = destroy_if_current(window.clone(), token);
        window
            .state::<Folders>()
            .finish_close_request(window.label(), token);
        result
    })
    .await
    .map_err(|error| error.to_string())?
}

/// An unanswered page cannot trap its window. A second close asks natively.
pub(crate) fn confirm_unanswered_close<R: Runtime>(window: WebviewWindow<R>, token: u32) {
    tauri::async_runtime::spawn_blocking(move || {
        let confirmed = window
            .dialog()
            .message("Some changes are still saving. Close the window anyway?")
            .title("Close window?")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Close anyway".into(),
                "Keep waiting".into(),
            ))
            .blocking_show();
        let result =
            if window
                .state::<Folders>()
                .finish_native_prompt(window.label(), token, confirmed)
            {
                destroy_if_current(window.clone(), token)
            } else {
                Ok(false)
            };
        if result != Ok(false) {
            window
                .state::<Folders>()
                .finish_close_request(window.label(), token);
        }
        if let Err(error) = result {
            log::warn!("The unanswered window could not close: {error}");
        }
    });
}

fn destroy_if_current<R: Runtime>(window: WebviewWindow<R>, token: u32) -> Result<bool, String> {
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    let dispatch = window.clone();
    window
        .run_on_main_thread(move || {
            // Navigation and close subscription changes also arrive on this
            // thread. A retired page cannot dispatch destruction afterward.
            let result = if !dispatch
                .state::<Folders>()
                .owns_close(dispatch.label(), token)
            {
                Ok(false)
            } else {
                dispatch
                    .destroy()
                    .map(|_| true)
                    .map_err(|error| error.to_string())
            };
            let _ = send.send(result);
        })
        .map_err(|error| error.to_string())?;
    receive.recv().map_err(|error| error.to_string())?
}

/// The root the page named among the calling window's, cloned for this
/// command (`Folders::bound_root`).
fn bound<R: Runtime>(
    webview: &Webview<R>,
    root: Option<&str>,
    path: &str,
    operation: &str,
) -> Result<Directory, StorageError> {
    webview
        .app_handle()
        .state::<Folders>()
        .bound_root(webview.label(), root)
        .map_err(|refusal| failed(path, operation, format!("{refusal:?}")))
}

/// Every file below the window's root, `.git` and `.epicenter` aside, none
/// of them followed (`storage::list`).
#[tauri::command]
#[specta::specta]
pub async fn list_folder<R: Runtime>(
    webview: Webview<R>,
    root: Option<String>,
) -> Result<Vec<ListedFile>, StorageError> {
    let directory = bound(&webview, root.as_deref(), "", "list")?;
    blocking(
        move || storage::list(directory.root()),
        |message| Err(failed("", "list", message)),
    )
    .await
}

/// Read a file in the window's folder (`storage::read`). The ASCII stamp,
/// a zero byte, then the file bytes return in one raw `ArrayBuffer`, rather than as a JSON array
/// of numbers. tauri-specta cannot type a raw response, so the generated
/// bindings leave this command out and `device/tauri-store.ts` invokes it by name;
/// `init` dispatches it beside the typed commands.
#[tauri::command]
pub async fn read_folder_file<R: Runtime>(
    webview: Webview<R>,
    path: String,
    root: Option<String>,
) -> Result<tauri::ipc::Response, StorageError> {
    let directory = bound(&webview, root.as_deref(), &path, "read")?;
    let at = path.clone();
    blocking(
        move || storage::read(directory.root(), &path),
        |message| Err(failed(&at, "read", message)),
    )
    .await
    .map(|read| {
        let mut response = read.stamp.into_bytes();
        response.push(0);
        response.extend_from_slice(&read.bytes);
        tauri::ipc::Response::new(response)
    })
}

/// Publish a file's bytes in the window's folder, or remove it, only while
/// the path holds what the page expects (`storage::put`): a `landed` result
/// with its stamp, or `stale` when it did not hold that and nothing changed.
///
/// The bytes are the request's raw body, so file content crosses IPC as it
/// is rather than as a JSON array of numbers. Percent-encoded headers carry
/// the rest: `path`, `root` (optional, as for every command), `remove`
/// (`true` to remove the file, when the body is ignored), and `expected`, what the page expects there (`any`, `absent`,
/// `present`, or `sha256:` and the SHA-256 of the file: `storage::Expectation`). A JSON
/// array of bytes is accepted as well: Tauri
/// sends one when its custom-protocol IPC failed and it fell back to
/// `postMessage`. Any other body is refused.
///
/// The check runs right before the change, with no lock between them
/// (`storage::put`). tauri-specta cannot type a raw request, so the generated
/// bindings leave this command out and `device/tauri-store.ts` invokes it by name;
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
    required("path").map_err(refused)?;
    let remove = match required("remove").map_err(refused)?.as_str() {
        "true" => true,
        "false" => false,
        other => return Err(refused(format!("remove is {other:?}, not true or false"))),
    };
    let expected =
        storage::Expectation::parse(&required("expected").map_err(refused)?).map_err(refused)?;
    // The blocking pool needs the bytes to outlive the request.
    let bytes: Option<Vec<u8>> = match (remove, request.body()) {
        (true, _) => None,
        (false, tauri::ipc::InvokeBody::Raw(bytes)) => Some(bytes.clone()),
        (false, tauri::ipc::InvokeBody::Json(value)) => {
            Some(serde_json::from_value(value.clone()).map_err(|_| {
                refused("put_folder_file takes its bytes as a raw body".to_string())
            })?)
        }
    };
    let operation = if remove { "remove" } else { "write" };
    let root = header("root").map_err(refused)?;
    let directory = bound(&webview, root.as_deref(), &path, operation)?;
    let at = path.clone();
    blocking(
        move || storage::put(directory.root(), &path, bytes.as_deref(), &expected),
        |message| Err(failed(&at, operation, message)),
    )
    .await
}
