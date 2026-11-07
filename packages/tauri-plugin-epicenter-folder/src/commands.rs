//! The IPC surface: opening a named root, and one command per method of the
//! page's folder storage (`storage`, ADR-0581).
//!
//! A page names a root (`Root::Data`, `Root::AppData`, and in the Epicenter
//! app `Root::Folder` and `Root::Epicenter`) and a relative path in it, never
//! an absolute path; the shared path rule keeps the path inside the root. `open_root` answers its display path for the page to show.
//! A storage command works in the folder its root reached when the app
//! opened it (`Roots::opened`), cloned when the command is admitted, so
//! nothing that happens meanwhile redirects it. A root it cannot use is a
//! `RootError` (`Disconnected` for a link whose target is gone), and a
//! storage refusal or failure a `StorageError` (`FolderError`). The shell's
//! own files at the top of the AppData root (`SHELL_FILES`: its credentials,
//! ADR-0740, and its record of its data folder) are never listed, read, or
//! written by a page: `InvalidPath`. Every command that touches
//! the disk runs on the blocking pool, never on the thread that drives the
//! windows. No Git runs here: a folder's history is its log on the
//! server (ADR-0824).

use std::ffi::OsString;
use std::path::Path;
use std::process::Command;

use epicenter_folder_core::identity::{identity_at, FolderIdentity};
use epicenter_folder_core::state;
use epicenter_folder_core::storage::{self, Landing, ListedFile, StorageError};
use epicenter_folder_core::sweep;
use serde::Serialize;
use specta::Type;
use tauri::{Emitter, Manager, Runtime, Webview};

use crate::records::{self, FolderRecord};
use crate::roots::{EpicenterEntry, EpicenterListing};
use crate::{Directory, FolderEvent, Root, RootError, Roots};

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

/// Where a standalone shell remembers its Data root's identity, at the top
/// of the AppData root (`epicenter-standalone`, ADR-0822).
pub const DATA_FOLDER_FILE: &str = "data-folder.json";

/// The shell's own files at the top of the AppData root, which no page
/// reaches, each with why: the refresh token and the provider keys
/// `epicenter-account` keeps (ADR-0740), and the identity of the folder the
/// shell opens as Data, which a page that wrote it could point at another.
const SHELL_FILES: [(&str, &str); 2] = [
    ("credentials.json", "it is the shell's own credentials"),
    (DATA_FOLDER_FILE, "it is the shell's own record of its data folder"),
];

/// Why `path` in `root` is the shell's own, or `None` when it is not.
fn shell_file(root: &Root, path: &str) -> Option<&'static str> {
    if *root != Root::AppData {
        return None;
    }
    SHELL_FILES
        .iter()
        .find(|(name, _)| *name == path)
        .map(|(_, reason)| *reason)
}

/// Refuse the shell's own files to a page.
fn refuse_shell_file(root: &Root, path: &str) -> Result<(), StorageError> {
    match shell_file(root, path) {
        None => Ok(()),
        Some(reason) => Err(StorageError::InvalidPath {
            path: path.to_string(),
            reason: reason.to_string(),
        }),
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
/// sends its changes as an app event. The page listens before opening. Opening
/// removes the saves a stopped writer left more than an hour ago, anywhere in
/// the folder, and clears what an older build kept in its `.epicenter`
/// (`sweep::sweep_now`).
#[tauri::command]
#[specta::specta]
pub async fn open_root<R: Runtime>(webview: Webview<R>, root: Root) -> Result<String, RootError> {
    let app = webview.app_handle().clone();
    let folder = webview.state::<Roots>().path(&root)?.display().to_string();
    let lost_folder = folder.clone();
    blocking(
        move || {
            let roots = app.state::<Roots>();
            let directory = roots.open(&root)?;
            sweep::sweep_now(directory.root());
            let events = app.clone();
            let event_root = root.clone();
            roots.watch(&root, &directory, move |change| {
                if let Err(error) = events.emit(
                    "folder-changed",
                    FolderEvent {
                        root: event_root.clone(),
                        paths: change.paths,
                    },
                ) {
                    log::warn!("The folder observation could not be delivered: {error}");
                }
            })?;
            Ok(folder)
        },
        |message| {
            Err(RootError::Unavailable {
                folder: lost_folder,
                message,
            })
        },
    )
    .await
}

/// Reveal the shell's named path for `root`. This also works before the root
/// opens: a dangling link is selected as a link, not followed to its target.
#[tauri::command]
#[specta::specta]
pub async fn reveal_root<R: Runtime>(webview: Webview<R>, root: Root) -> Result<(), RootError> {
    let path = webview.state::<Roots>().path(&root)?;
    let folder = path.display().to_string();
    let lost_folder = folder.clone();
    blocking(
        move || {
            let location = reveal_location(&path);
            let (program, arguments) = reveal_command(location);
            let opened = if cfg!(target_os = "windows") {
                Command::new(program).args(&arguments).spawn().map(|_| ())
            } else {
                Command::new(program)
                    .args(&arguments)
                    .status()
                    .and_then(|status| {
                        if status.success() {
                            Ok(())
                        } else {
                            Err(std::io::Error::other(format!(
                                "{program} exited with {status}"
                            )))
                        }
                    })
            };
            opened.map_err(|cause| RootError::Unavailable {
                folder,
                message: cause.to_string(),
            })
        },
        |message| {
            Err(RootError::Unavailable {
                folder: lost_folder,
                message,
            })
        },
    )
    .await
}

#[cfg(test)]
mod reveal_tests {
    use super::*;

    #[test]
    fn reveal_arguments_keep_the_location_as_one_argument() {
        let path = Path::new("/tmp/notes with spaces");
        let (program, arguments) = reveal_command(path);
        #[cfg(target_os = "macos")]
        assert_eq!(
            (program, arguments),
            ("open", vec![OsString::from("-R"), path.as_os_str().into()])
        );
        #[cfg(target_os = "windows")]
        assert_eq!(
            (program, arguments),
            (
                "explorer",
                vec![OsString::from("/select,"), path.as_os_str().into()]
            )
        );
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        assert_eq!(
            (program, arguments),
            ("xdg-open", vec![path.parent().unwrap().as_os_str().into()])
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_dangling_link_is_the_revealed_entry_even_above_the_root() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let link = temp.path().join("Epicenter");
        symlink(temp.path().join("missing"), &link).unwrap();
        assert_eq!(reveal_location(&link), link);
        assert_eq!(reveal_location(&link.join("capture")), link);
    }
}

/// The file manager request, with the location as one unparsed argument.
fn reveal_command(path: &Path) -> (&'static str, Vec<OsString>) {
    #[cfg(target_os = "macos")]
    return ("open", vec!["-R".into(), path.as_os_str().into()]);
    #[cfg(target_os = "windows")]
    return ("explorer", vec!["/select,".into(), path.as_os_str().into()]);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    return (
        "xdg-open",
        vec![path.parent().unwrap_or(path).as_os_str().into()],
    );
}

/// The named entry, or the closest entry that exists without following links.
fn reveal_location(path: &Path) -> &Path {
    path.ancestors()
        .find(|ancestor| std::fs::symlink_metadata(ancestor).is_ok())
        .unwrap_or(path)
}

/// The folder `root` reached when the app opened it, for one command
/// (`Roots::opened`).
fn opened<R: Runtime>(webview: &Webview<R>, root: &Root) -> Result<Directory, FolderError> {
    Ok(webview.state::<Roots>().opened(root)?)
}

/// Every regular file in `root` at or below each of `under` (a directory or
/// a file path; empty is the whole root), `.git` aside, hidden ones
/// included but never a save or recording in progress, none of them
/// followed, each with its version and size (`storage::list`). The shell's
/// own files are left out.
#[tauri::command]
#[specta::specta]
pub async fn list_folder<R: Runtime>(
    webview: Webview<R>,
    root: Root,
    under: Vec<String>,
) -> Result<Vec<ListedFile>, FolderError> {
    let directory = opened(&webview, &root)?;
    blocking(
        move || {
            let mut listing = storage::list(directory.root(), &under)?;
            listing.retain(|file| shell_file(&root, &file.path).is_none());
            Ok(listing)
        },
        |message| Err(failed("", "list", message).into()),
    )
    .await
}

/// Read a file in `root` (`storage::read`). The ASCII stamp, a zero byte,
/// then the file bytes return in one raw `ArrayBuffer`, rather than as a JSON
/// array of numbers. tauri-specta cannot type a raw response, so the
/// generated bindings leave this command out and `device/tauri-store.ts`
/// invokes it by name; `init` dispatches it beside the typed commands. The
/// shell's own files are refused.
#[tauri::command]
pub async fn read_folder_file<R: Runtime>(
    webview: Webview<R>,
    path: String,
    root: Root,
) -> Result<tauri::ipc::Response, FolderError> {
    refuse_shell_file(&root, &path)?;
    let directory = opened(&webview, &root)?;
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
/// what the page expects (`storage::put_landing`): `{ landed }` with the stamp of the file that landed,
/// or `stale` when it did not hold that and nothing changed.
///
/// The bytes are the request's raw body, so file content crosses IPC as it
/// is rather than as a JSON array of numbers. Percent-encoded headers carry
/// the rest: `path`, `root` (`Data`, `AppData`, `Epicenter`, or
/// `Folder/<name>`: `Root::header`), `remove` (`true` to
/// remove the file, when the body is ignored), and `expected`, the version
/// the page read there (`absent` for a create, or `sha256:` and the file's version,
/// which the shell hashes again: `storage::Expectation`). A JSON array of bytes is accepted
/// as well: Tauri sends one when its custom-protocol IPC failed and it fell
/// back to `postMessage`. Any other body is refused.
///
/// The check runs right before the change; within this process, puts of one
/// path take turns from the check to the change (`storage::put`).
/// tauri-specta cannot type a raw request, so the generated bindings leave
/// this command out and `device/tauri-store.ts` invokes it by name; `init`
/// dispatches it beside the typed commands. The shell's own files are
/// refused.
#[tauri::command]
pub async fn put_folder_file<R: Runtime>(
    webview: Webview<R>,
    request: tauri::ipc::Request<'_>,
) -> Result<Landing, FolderError> {
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
    let named = required("root").map_err(|_| RootError::Invalid {
        root: String::new(),
    })?;
    let root: Root = named
        .parse()
        .map_err(|_| RootError::Invalid { root: named })?;
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
    refuse_shell_file(&root, &path)?;
    let operation = if remove { "remove" } else { "write" };
    let directory = opened(&webview, &root)?;
    let at = path.clone();
    blocking(
        move || {
            storage::put_landing(directory.root(), &path, bytes.as_deref(), &expected)
                .map_err(FolderError::from)
        },
        |message| Err(failed(&at, operation, message).into()),
    )
    .await
}

/// The identity of the folder an open `root` reached, its link followed
/// (`identity::identity_of`): its inode and birth time. Null where the
/// system has none. A page names a cache of the folder's hashes by it.
#[tauri::command]
#[specta::specta]
pub async fn root_identity<R: Runtime>(
    webview: Webview<R>,
    root: Root,
) -> Result<Option<FolderIdentity>, FolderError> {
    let directory = opened(&webview, &root)?;
    blocking(
        move || {
            identity_at(directory.root())
                .map_err(|cause| failed("", "identity", cause.to_string()).into())
        },
        |message| Err(failed("", "identity", message).into()),
    )
    .await
}

/// The record Epicenter keeps for the open Data root, read from the
/// Epicenter folder's `.epicenter/synced/` (`records::proving`): the one
/// whose inode and birth time prove the folder's, when both have a real
/// birth time. Null when there is none, as for a folder Epicenter does not
/// sync. Nothing is written.
#[tauri::command]
#[specta::specta]
pub async fn data_record<R: Runtime>(
    webview: Webview<R>,
) -> Result<Option<FolderRecord>, FolderError> {
    let directory = opened(&webview, &Root::Data)?;
    let library = webview.state::<Roots>().library()?;
    blocking(
        move || {
            let identity = identity_at(directory.root())
                .map_err(|cause| failed("", "record", cause.to_string()))?;
            Ok(identity.and_then(|identity| records::proving(&state::records(&library), &identity)))
        },
        |message| Err(failed("", "record", message).into()),
    )
    .await
}

/// The Epicenter folder's listing (ADR-0813, ADR-0825): where it is and
/// whether it is itself a Git repository, every real directory directly
/// inside it, hidden names skipped, each with its name (its root is
/// `Root::Folder(name)`), its identity, and whether Git keeps it, the links
/// in it, shown as outside it, and what is there but cannot be a folder,
/// with why. The folder is made when it is missing.

#[tauri::command]
#[specta::specta]
pub async fn list_epicenter<R: Runtime>(
    webview: Webview<R>,
) -> Result<EpicenterListing, RootError> {
    let app = webview.app_handle().clone();
    blocking(
        move || app.state::<Roots>().list_epicenter(),
        |message| {
            Err(RootError::Unavailable {
                folder: String::new(),
                message,
            })
        },
    )
    .await
}

/// Make the directory `name` in the Epicenter folder, for a folder cloned or
/// accepted into it: refused when anything has that name, or the name is not
/// one every disk keeps. It opens as `Root::Folder(name)`.
#[tauri::command]
#[specta::specta]
pub async fn make_epicenter_folder<R: Runtime>(
    webview: Webview<R>,
    name: String,
) -> Result<EpicenterEntry, RootError> {
    let app = webview.app_handle().clone();
    blocking(
        move || app.state::<Roots>().make_epicenter_folder(&name),
        |message| {
            Err(RootError::Unavailable {
                folder: String::new(),
                message,
            })
        },
    )
    .await
}
