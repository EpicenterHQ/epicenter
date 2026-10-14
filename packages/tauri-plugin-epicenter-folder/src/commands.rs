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
use tauri::{Manager, Resource, Runtime, Webview};

use crate::lifecycle::Instance;
use crate::Folders;

/// The identity of one actual webview, kept in that webview's own resource
/// table. Clones of a `Webview` share its table; a new webview created under
/// the same label has its own. See `lifecycle`.
struct InstanceResource(Arc<Instance>);

const INSTANCE_RESOURCE: &str = "epicenter-folder-webview";

impl Resource for InstanceResource {
    fn name(&self) -> std::borrow::Cow<'_, str> {
        INSTANCE_RESOURCE.into()
    }
}

/// Give a webview Tauri just announced its instance. A webview that already
/// has one keeps it.
pub(crate) fn adopt<R: Runtime>(webview: &Webview<R>) {
    if instance(webview).is_some() {
        return;
    }
    let created = webview
        .state::<Folders>()
        .lifecycles
        .created(webview.window().label());
    webview.resources_table().add(InstanceResource(created));
}

/// The instance of exactly this webview, read from its own table.
fn instance<R: Runtime>(webview: &Webview<R>) -> Option<Arc<Instance>> {
    let table = webview.resources_table();
    let rid = table
        .names()
        .find(|(_, name)| name == INSTANCE_RESOURCE)
        .map(|(rid, _)| rid)?;
    table
        .get::<InstanceResource>(rid)
        .ok()
        .map(|resource| Arc::clone(&resource.0))
}

/// A page started loading in this webview: the page before it is over, so
/// its `git` runs are no longer reachable by its request numbers.
pub(crate) fn page_started<R: Runtime>(webview: &Webview<R>) {
    // This webview's own instance: a handle to a destroyed webview that
    // shares a label with a live one advances nothing of the live one's.
    if let Some(instance) = instance(webview) {
        instance.page_started();
    }
}

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
/// capability added at run time for this window alone. Nothing else on disk
/// becomes reachable.
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

/// Whether `url` is the app's own bundled page, which Tauri matches against
/// local capabilities: `tauri://localhost`, or `http(s)://tauri.localhost` on
/// Windows. Any other `http(s)` page is a remote origin, such as a shell's
/// loopback host.
fn is_bundled_page(url: &tauri::Url) -> bool {
    match url.scheme() {
        "http" | "https" => url.host_str() == Some("tauri.localhost"),
        _ => true,
    }
}

/// One window's reading access to one folder: the fs plugin's reading
/// commands on the root and everything beneath it. A capability's scope
/// matches dot files when the fs plugin is configured with
/// `requireLiteralLeadingDot: false`, which a shell must set: `.git` and
/// files other programs leave behind live there.
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
    .window(label);
    capability = if is_bundled_page(url) {
        capability.local(true)
    } else {
        capability.remote(url.origin().ascii_serialization())
    };
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

/// Write a file in a granted folder (`page_files::write_file`).
#[tauri::command]
#[specta::specta]
pub async fn write_folder_file<R: Runtime>(
    webview: Webview<R>,
    scope: String,
    path: String,
    bytes: Vec<u8>,
    create_new: bool,
) -> Result<(), String> {
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
/// origin, is sent to that origin alone. `request` names the run, so
/// `cancel_git` can stop it.
#[tauri::command]
#[specta::specta]
pub async fn run_git<R: Runtime>(
    webview: Webview<R>,
    scope: String,
    args: Vec<String>,
    input: Option<Vec<u8>>,
    index_file: Option<String>,
    authorization: Option<String>,
    request: u32,
) -> Result<GitOutput, GrantError> {
    let label = webview.label().to_string();
    let app = webview.app_handle().clone();
    let (root, work) = app
        .state::<Folders>()
        .registry
        .admit_page_work(&scope, &label)?;
    let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let cancel_entry = cancel.clone();
    let page = instance(&webview)
        .and_then(|instance| instance.page())
        .ok_or_else(|| GrantError::Unavailable {
            message: "the page that asked for Git is gone".to_string(),
        })?;
    let key = (label, page.number(), request);
    {
        let folders = app.state::<Folders>();
        let mut requests = folders
            .git_requests
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // One running command per number: a second would take over the
        // first's cancel, and its end would remove the first's.
        if requests.contains_key(&key) {
            return Err(GrantError::Unavailable {
                message: format!("a Git command numbered {request} is already running"),
            });
        }
        requests.insert(key.clone(), cancel.clone());
    }
    let running = app.clone();
    let result = blocking(
        move || {
            let _work = work;
            page_git::run(
                &root,
                &args,
                input.as_deref(),
                index_file.as_deref(),
                authorization.as_deref(),
                &cancel,
            )
        },
        |message| Err(message),
    )
    .await;
    {
        let folders = running.state::<Folders>();
        let mut requests = folders
            .git_requests
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if requests
            .get(&key)
            .is_some_and(|current| Arc::ptr_eq(current, &cancel_entry))
        {
            requests.remove(&key);
        }
    }
    result.map_err(|message| GrantError::Unavailable { message })
}

/// Stop a `run_git` this window started. Stopping one that has finished, or
/// another window's, does nothing.
#[tauri::command]
#[specta::specta]
pub async fn cancel_git<R: Runtime>(webview: Webview<R>, request: u32) -> Result<(), GrantError> {
    let Some(page) = instance(&webview).and_then(|instance| instance.page()) else {
        return Ok(());
    };
    let key = (webview.label().to_string(), page.number(), request);
    let app = webview.app_handle().clone();
    let folders = app.state::<Folders>();
    let requests = folders
        .git_requests
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(cancel) = requests.get(&key) {
        cancel.store(true, std::sync::atomic::Ordering::SeqCst);
    }
    Ok(())
}
