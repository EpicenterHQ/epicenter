//! The IPC surface: opening a named root, and one command per method of the
//! page's folder storage (`storage`, ADR-0581).
//!
//! A page names a root (`Root::Data` or `Root::AppData`) and a relative path
//! in it, never an absolute path; the shared path rule keeps the path inside
//! the root. Only `root_path` answers an absolute path, for the page to show.
//! A storage command works in the folder its root reached when the page
//! opened it (`Roots::opened`), cloned when the command is admitted, so
//! nothing that happens meanwhile redirects it. A root it cannot use is a
//! `RootError` (`Disconnected` for a link whose target is gone), and a
//! storage refusal or failure a `StorageError` (`FolderError`). Every command that touches
//! the disk runs on the blocking pool, never on the thread that drives the
//! windows. The folder's Git is not here: the `epicenter` CLI runs it
//! (ADR-0559).

use std::path::PathBuf;

use epicenter_folder_core::storage::{self, ListedFile, PutOutcome, StorageError};
use serde::Serialize;
use specta::Type;
use tauri::ipc::Channel;
use tauri::{Manager, Runtime, Webview};

use crate::{Directory, FolderChanged, Root, RootError, Roots};

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

/// Why a storage command answered no: the root it named cannot be used
/// (`RootError`, such as `Disconnected` with the link's folder and target),
/// or the storage operation refused or failed (`StorageError`). The two never
/// share a `name`, so the page tells them apart by it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(untagged)]
pub enum FolderError {
    Root(RootError),
    Storage(StorageError),
}

impl From<RootError> for FolderError {
    fn from(error: RootError) -> Self {
        Self::Root(error)
    }
}

impl From<StorageError> for FolderError {
    fn from(error: StorageError) -> Self {
        Self::Storage(error)
    }
}

fn failed(path: &str, operation: &str, message: String) -> StorageError {
    StorageError::Io {
        path: path.to_string(),
        operation: operation.to_string(),
        message,
    }
}

/// Open `root` and watch it. Whatever is at the root's path opens, through a
/// link if one is there, and a missing folder is made (ADR-0726); a link
/// whose target is gone is `Disconnected`, and nothing is made. Each call
/// looks again, so Retry finds a folder that came back. The root's one watch
/// sends its changes to the latest channel this page opened it with. Opening
/// removes the staged files a stopped save left an hour or more ago
/// (`storage::sweep_stale_scratch`).
#[tauri::command]
#[specta::specta]
pub async fn open_root<R: Runtime>(
    webview: Webview<R>,
    root: Root,
    on_change: Channel<FolderChanged>,
) -> Result<(), RootError> {
    let label = webview.label().to_string();
    let page = webview.state::<Roots>().page(&label)?;
    let app = webview.app_handle().clone();
    blocking(
        move || {
            let roots = app.state::<Roots>();
            let directory = roots.open(root)?;
            storage::sweep_stale_scratch(directory.root());
            roots.watch(root, &directory, &label, page, move |change| {
                if let Err(error) = on_change.send(change) {
                    log::warn!("The folder observation could not be delivered: {error}");
                }
            })
        },
        |message| {
            Err(RootError::Unavailable {
                folder: root.to_string(),
                message,
            })
        },
    )
    .await
}

/// The path the shell named `root` at, written out
/// (`/Users/me/Epicenter/whispering`, not where a link there leads), for the
/// page to show. It opens, reads and makes nothing, and no command takes it.
#[tauri::command]
#[specta::specta]
pub fn root_path<R: Runtime>(webview: Webview<R>, root: Root) -> Result<String, RootError> {
    webview
        .state::<Roots>()
        .path(root)
        .map(|path| path.to_string_lossy().into_owned())
}

/// The folder `root` reached when the page opened it, for one command
/// (`Roots::opened`).
fn opened<R: Runtime>(webview: &Webview<R>, root: Root) -> Result<Directory, FolderError> {
    Ok(webview.state::<Roots>().opened(root)?)
}

/// Every file below `root`, `.git` aside, hidden ones included, none of
/// them followed (`storage::list`).
#[tauri::command]
#[specta::specta]
pub async fn list_folder<R: Runtime>(
    webview: Webview<R>,
    root: Root,
) -> Result<Vec<ListedFile>, FolderError> {
    let directory = opened(&webview, root)?;
    blocking(
        move || storage::list(directory.root()).map_err(FolderError::from),
        |message| Err(failed("", "list", message).into()),
    )
    .await
}

/// Read a file in `root` (`storage::read`). The ASCII stamp, a zero byte,
/// then the file bytes return in one raw `ArrayBuffer`, rather than as a JSON
/// array of numbers. tauri-specta cannot type a raw response, so the
/// generated bindings leave this command out and `device/tauri-store.ts`
/// invokes it by name; `init` dispatches it beside the typed commands.
#[tauri::command]
pub async fn read_folder_file<R: Runtime>(
    webview: Webview<R>,
    path: String,
    root: Root,
) -> Result<tauri::ipc::Response, FolderError> {
    let directory = opened(&webview, root)?;
    let at = path.clone();
    blocking(
        move || storage::read(directory.root(), &path).map_err(FolderError::from),
        |message| Err(failed(&at, "read", message).into()),
    )
    .await
    .map(|read| {
        let mut response = read.stamp.into_bytes();
        response.push(0);
        response.extend_from_slice(&read.bytes);
        tauri::ipc::Response::new(response)
    })
}

/// Publish a file's bytes in a root, or remove it, only while the path holds
/// what the page expects (`storage::put`): a `landed` result with its stamp,
/// or `stale` when it did not hold that and nothing changed.
///
/// The bytes are the request's raw body, so file content crosses IPC as it
/// is rather than as a JSON array of numbers. Percent-encoded headers carry
/// the rest: `path`, `root` (`Data` or `AppData`), `remove` (`true` to
/// remove the file, when the body is ignored), and `expected`, the version
/// the page read there (`absent` for a create, or `sha256:` and the SHA-256
/// of the file: `storage::Expectation`). A JSON array of bytes is accepted
/// as well: Tauri sends one when its custom-protocol IPC failed and it fell
/// back to `postMessage`. Any other body is refused.
///
/// The check runs right before the change; within this process, puts of one
/// path take turns from the check to the change (`storage::put`).
/// tauri-specta cannot type a raw request, so the generated bindings leave
/// this command out and `device/tauri-store.ts` invokes it by name; `init`
/// dispatches it beside the typed commands.
#[tauri::command]
pub async fn put_folder_file<R: Runtime>(
    webview: Webview<R>,
    request: tauri::ipc::Request<'_>,
) -> Result<PutOutcome, FolderError> {
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
        other => return Err(refused(format!("remove is {other:?}, not true or false")).into()),
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
    let root: Root = required("root")
        .and_then(|root| root.parse())
        .map_err(refused)?;
    let directory = opened(&webview, root)?;
    let at = path.clone();
    blocking(
        move || {
            storage::put(directory.root(), &path, bytes.as_deref(), &expected)
                .map_err(FolderError::from)
        },
        |message| Err(failed(&at, operation, message).into()),
    )
    .await
}

/// The folder `root` reached, and the path the shell named it at, for a
/// command that names the folder to another program.
pub(crate) fn named<R: Runtime>(
    webview: &Webview<R>,
    root: Root,
) -> Result<(Directory, PathBuf), RootError> {
    let roots = webview.state::<Roots>();
    Ok((roots.opened(root)?, roots.path(root)?))
}
