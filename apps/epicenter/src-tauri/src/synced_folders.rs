//! The folders Epicenter syncs, as the `epicenter` CLI keeps them (decisions
//! 36, 39 and 70): the Folders window is a front end over the CLI, so every
//! action here is one CLI call a person or an agent could type.
//!
//! - The list is `epicenter status --json`, which reads every folder
//!   registered in the global Git configuration.
//! - The background service is `epicenter sync --watch --json`, run for as
//!   long as the app runs. Each round it prints `{"sync": {...}}` per folder;
//!   the last round of each folder is kept here and the Folders window hears
//!   `SYNCED_FOLDERS_CHANGED`.
//! - Adding a folder is the native picker, then `epicenter init <dir>`;
//!   cloning is `epicenter clone`; forgetting is `epicenter forget`; sharing
//!   is `epicenter share` and `unshare`. Each change to the set of folders
//!   restarts the service, so `--watch` watches the new set.
//! - `epicenter://init?path=<dir>[&contract=<url>]` queues the folder for the
//!   person to set up; a web page can fire the link, so it never runs `init`
//!   unasked.
//!
//! A page names a folder by the path the last listing gave it, and a command
//! refuses any path that listing did not hold: a page can act only on
//! folders the CLI registered.

use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime, Webview};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_epicenter_folder::defaults::DesktopPaths;
use tauri_plugin_epicenter_folder::Directory;

use crate::cli::{self, CliChildren, CliError, StartedChild};
use crate::{BuiltInApp, DesktopAppHandle};

/// The event the Folders window hears when a folder's round, the service,
/// or the requests changed. It carries nothing: the window lists again.
/// `SYNCED_FOLDERS_CHANGED` in `src/folders/synced-folders.ts` names it too.
pub const SYNCED_FOLDERS_CHANGED: &str = "epicenter://synced-folders-changed";

/// The service's key among the CLI's children. No window has this label, so
/// no page's reload or close ends it.
const SERVICE: &str = "epicenter:sync-service";
/// How long the service waits before it starts again after it exited.
const RESPAWN_AFTER: Duration = Duration::from_secs(5);
/// A run shorter than this that exits counts as a failure to start.
const QUICK_EXIT: Duration = Duration::from_secs(20);
/// How many quick exits in a row stop the service until a person restarts it.
const QUICK_EXITS: u32 = 3;

/// How one round of `epicenter sync` ended for a folder: 0, 1 and 2 as exit
/// codes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum SyncStatus {
    Synced,
    Retry,
    Stopped,
}

/// One folder's line of `epicenter sync --json` (`SyncResult` in the CLI).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncRound {
    pub folder: String,
    pub status: SyncStatus,
    /// The commit the folder's repository is at when the round ended.
    #[serde(default)]
    pub head: Option<String>,
    /// What the round did, one line each.
    #[serde(default)]
    pub notes: Vec<String>,
    /// Why the round ended `retry` or `stopped`.
    #[serde(default)]
    pub message: Option<String>,
    /// When this shell heard the round end, in milliseconds since the epoch.
    #[serde(default)]
    pub ended_at: f64,
}

/// A registered folder, with its last round.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncedFolder {
    pub path: String,
    pub name: String,
    /// The `origin` URL, or none for a folder that syncs only locally.
    pub remote: Option<String>,
    /// Files under the folder changed since its last commit.
    pub changes: u32,
    /// Commits ahead and behind the last fetched `origin/main`.
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    /// Why the folder cannot be read: "not on disk", "not in a Git repository",
    /// or a repository `init` has not adopted.
    pub problem: Option<String>,
    pub last: Option<SyncRound>,
}

/// Whether `epicenter sync --watch` is running for this app.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum SyncService {
    Starting,
    Running,
    Stopped { reason: String },
}

/// A folder an `epicenter://init` link asked to sync.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FolderSetup {
    pub path: String,
    /// The contract the link named, shown to the person. `epicenter init`
    /// takes no contract yet (decision 64).
    pub contract: Option<String>,
}

/// What the Folders window shows.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncedFolderListing {
    pub folders: Vec<SyncedFolder>,
    pub service: SyncService,
    pub setups: Vec<FolderSetup>,
}

/// What `epicenter init` or `clone` did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FolderSetUp {
    pub folder: String,
    #[serde(default)]
    pub changed: Vec<String>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum GrantLevel {
    Read,
    Write,
}

/// One person a repository is shared with (`RepositoryGrant`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct RepositoryGrant {
    pub person: String,
    pub level: GrantLevel,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct RepositoryGrants {
    pub grants: Vec<RepositoryGrant>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct RepositoryGrantRevoked {
    pub person: String,
    pub revoked: bool,
}

/// The shell's record of the synced folders: each folder's last round, the
/// paths the last listing held, the requests to set one up, and the service.
#[derive(Default)]
pub struct SyncedFolders {
    state: Mutex<State>,
    /// The service's child while it runs, for the app's exit.
    child: StartedChild,
}

#[derive(Default)]
struct State {
    rounds: HashMap<String, SyncRound>,
    listed: Vec<String>,
    setups: Vec<FolderSetup>,
    generation: u64,
    service: Service,
}

struct Service {
    state: SyncService,
    quick_exits: u32,
}

impl Default for Service {
    fn default() -> Self {
        Self {
            state: SyncService::Starting,
            quick_exits: 0,
        }
    }
}

impl SyncedFolders {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn record(&self, round: SyncRound) {
        self.lock().rounds.insert(round.folder.clone(), round);
    }

    /// The listing of these `status` lines, which become the folders a page
    /// may name.
    fn listing(&self, lines: &[StatusLine]) -> SyncedFolderListing {
        let mut state = self.lock();
        state.listed = lines.iter().map(|line| line.folder().to_string()).collect();
        let listed = state.listed.clone();
        state.rounds.retain(|folder, _| listed.contains(folder));
        SyncedFolderListing {
            folders: lines
                .iter()
                .map(|line| line.synced(state.rounds.get(line.folder()).cloned()))
                .collect(),
            service: state.service.state.clone(),
            setups: state.setups.clone(),
        }
    }

    /// `path` when the last listing held it.
    fn member(&self, path: &str) -> Result<String, CliError> {
        if self.lock().listed.iter().any(|listed| listed == path) {
            Ok(path.to_string())
        } else {
            Err(CliError::Refused {
                message: format!("{path} is not a folder Epicenter syncs."),
            })
        }
    }

    /// Queue a request to set up `setup.path`, once; a later request for the
    /// same path replaces its contract.
    fn request(&self, setup: FolderSetup) {
        let mut state = self.lock();
        match state
            .setups
            .iter_mut()
            .find(|queued| queued.path == setup.path)
        {
            Some(queued) => queued.contract = setup.contract,
            None => state.setups.push(setup),
        }
    }

    fn take_setup(&self, path: &str) -> Option<FolderSetup> {
        let mut state = self.lock();
        let index = state.setups.iter().position(|setup| setup.path == path)?;
        Some(state.setups.remove(index))
    }

    /// A new service run: the generation that run owns.
    fn begin_service(&self) -> u64 {
        let mut state = self.lock();
        state.generation += 1;
        state.service = Service::default();
        state.generation
    }

    /// Set the service's state, if `generation` is still the current run.
    fn service_is(&self, generation: u64, service: SyncService) -> bool {
        let mut state = self.lock();
        if state.generation != generation {
            return false;
        }
        state.service.state = service;
        true
    }

    /// The service run `generation` exited after `ran`, saying `reason`:
    /// whether to start it again. Quick exits in a row stop it.
    fn service_exited(&self, generation: u64, ran: Duration, reason: String) -> bool {
        let mut state = self.lock();
        if state.generation != generation {
            return false;
        }
        // A run that lasted was no failure to start: the count begins again.
        state.service.quick_exits = if ran < QUICK_EXIT {
            state.service.quick_exits + 1
        } else {
            0
        };
        if state.service.quick_exits >= QUICK_EXITS {
            state.service.state = SyncService::Stopped { reason };
            false
        } else {
            state.service.state = SyncService::Starting;
            true
        }
    }

    fn is_current(&self, generation: u64) -> bool {
        self.lock().generation == generation
    }
}

/// One line of `epicenter status --json`: a registered folder's status, or
/// why it has none.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum StatusLine {
    Problem { folder: String, problem: String },
    Status(FolderStatus),
}

#[derive(Debug, Clone, Deserialize)]
struct FolderStatus {
    folder: String,
    adopted: bool,
    changes: Vec<serde_json::Value>,
    remote: Option<String>,
    ahead: Option<u32>,
    behind: Option<u32>,
}

impl StatusLine {
    fn folder(&self) -> &str {
        match self {
            Self::Problem { folder, .. } => folder,
            Self::Status(status) => &status.folder,
        }
    }

    fn synced(&self, last: Option<SyncRound>) -> SyncedFolder {
        let path = self.folder().to_string();
        let name = folder_name(&path);
        match self {
            Self::Problem { problem, .. } => SyncedFolder {
                path,
                name,
                remote: None,
                changes: 0,
                ahead: None,
                behind: None,
                problem: Some(problem.clone()),
                last,
            },
            Self::Status(status) => SyncedFolder {
                path,
                name,
                remote: status.remote.clone(),
                changes: u32::try_from(status.changes.len()).unwrap_or(u32::MAX),
                ahead: status.ahead,
                behind: status.behind,
                problem: (!status.adopted)
                    .then(|| "its repository is not set up for sync".to_string()),
                last,
            },
        }
    }
}

/// The `{"status": ...}` lines of `epicenter status --json`, in order.
fn parse_status_lines(lines: &[String]) -> Result<Vec<StatusLine>, CliError> {
    #[derive(Deserialize)]
    struct Line {
        status: StatusLine,
    }
    lines
        .iter()
        .map(|line| {
            serde_json::from_str::<Line>(line)
                .map(|line| line.status)
                .map_err(|error| {
                    cli::failed(format!(
                        "epicenter status answered something that does not read: {error}"
                    ))
                })
        })
        .collect()
}

/// The round in a `{"sync": ...}` line, heard at `now`, or none for any
/// other line.
pub(crate) fn parse_sync_line(line: &str, now: f64) -> Option<SyncRound> {
    #[derive(Deserialize)]
    struct Line {
        sync: SyncRound,
    }
    let mut round = serde_json::from_str::<Line>(line).ok()?.sync;
    round.ended_at = now;
    Some(round)
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |since| since.as_millis() as f64)
}

fn folder_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

/// What the `epicenter://init?path=<dir>[&contract=<url>]` link asks, or none
/// for any other link.
///
/// The grammar is strict so that one link has one reading. The host is
/// exactly `init`, with no path, user, port, or fragment. The query is
/// `path=` then, optionally, `&contract=`, each value with no `&`, `;`, `=`
/// or `+` (a space is `%20`) and every `%` starting a valid escape. The path
/// decodes to a plainly spelled absolute path; the contract to an `https:`
/// or `http:` URL or a plainly spelled absolute path.
pub(crate) fn parse_init_link(url: &tauri::Url) -> Option<FolderSetup> {
    if url.scheme() != "epicenter"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
        || url.host_str() != Some("init")
        || !url.path().is_empty()
    {
        return None;
    }
    let query = url.query()?;
    let (path, contract) = match query.split_once('&') {
        Some((path, contract)) => (path, Some(contract.strip_prefix("contract=")?)),
        None => (query, None),
    };
    let path = decode_value(path.strip_prefix("path=")?)?;
    if !is_plain_absolute_path(&path) {
        return None;
    }
    let contract = match contract {
        None => None,
        Some(encoded) => {
            let contract = decode_value(encoded)?;
            let readable = is_plain_absolute_path(&contract)
                || tauri::Url::parse(&contract)
                    .is_ok_and(|url| matches!(url.scheme(), "https" | "http"));
            if !readable {
                return None;
            }
            Some(contract)
        }
    };
    Some(FolderSetup { path, contract })
}

fn decode_value(encoded: &str) -> Option<String> {
    if encoded.is_empty() || encoded.contains(['&', ';', '=', '+']) || !escapes_are_valid(encoded) {
        return None;
    }
    let decoded = percent_decode_str(encoded).decode_utf8().ok()?;
    (!decoded.chars().any(char::is_control)).then(|| decoded.into_owned())
}

/// Whether every `%` in `encoded` begins two hexadecimal digits.
fn escapes_are_valid(encoded: &str) -> bool {
    let bytes = encoded.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let escape = bytes.get(index + 1..index + 3);
            if !escape.is_some_and(|digits| digits.iter().all(u8::is_ascii_hexdigit)) {
                return false;
            }
            index += 3;
        } else {
            index += 1;
        }
    }
    true
}

/// Whether `path` is absolute and spelled as its own components: no `.` or
/// `..`, no doubled or trailing separator, and no control character.
fn is_plain_absolute_path(path: &str) -> bool {
    if path.chars().any(char::is_control) {
        return false;
    }
    let candidate = Path::new(path);
    if !candidate.is_absolute() {
        return false;
    }
    let mut rebuilt = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::CurDir | Component::ParentDir => return false,
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
                rebuilt.push(component)
            }
        }
    }
    rebuilt.as_os_str() == candidate.as_os_str()
}

/// A word a page passes as one CLI argument: nonempty, no control
/// character, and never an option.
fn argument(value: &str, what: &str) -> Result<String, CliError> {
    let value = value.trim();
    if value.is_empty() || value.starts_with('-') || value.chars().any(char::is_control) {
        return Err(CliError::Refused {
            message: format!("That is not a {what}."),
        });
    }
    Ok(value.to_string())
}

fn changed<R: Runtime>(app: &AppHandle<R>) {
    let _ = app.emit_to(BuiltInApp::Folders.id(), SYNCED_FOLDERS_CHANGED, ());
}

/// Receive an `epicenter://init` link: queue it and show the Folders window.
pub(crate) fn receive(app: &DesktopAppHandle, setup: FolderSetup) {
    app.state::<SyncedFolders>().request(setup);
    changed(app);
}

/// Start `epicenter sync --watch --json` for this app, ending a run already
/// going. It starts again after it exits, until it exits quickly
/// [`QUICK_EXITS`] times in a row.
pub(crate) fn start_service<R: Runtime>(app: &AppHandle<R>) {
    let folders = app.state::<SyncedFolders>();
    let generation = folders.begin_service();
    app.state::<CliChildren>().page_ended(SERVICE);
    changed(app);
    let app = app.clone();
    tauri::async_runtime::spawn(async move { run_service(app, generation).await });
}

/// Ask the service's child to stop at once, for the app's exit.
pub(crate) fn stop_service<R: Runtime>(app: &AppHandle<R>) {
    if let Some(folders) = app.try_state::<SyncedFolders>() {
        folders.begin_service();
        cli::stop_started(&folders.child);
    }
}

async fn run_service<R: Runtime>(app: AppHandle<R>, generation: u64) {
    loop {
        let folders = app.state::<SyncedFolders>();
        let invocation = match cli::invocation(&app) {
            Ok(invocation) => invocation
                .desktop()
                .owned_by(&app.state::<CliChildren>(), SERVICE)
                .recording_child(&folders.child),
            Err(error) => {
                folders.service_is(
                    generation,
                    SyncService::Stopped {
                        reason: error_message(&error),
                    },
                );
                changed(&app);
                return;
            }
        };
        if !folders.service_is(generation, SyncService::Running) {
            return;
        }
        changed(&app);
        let began = Instant::now();
        let heard = app.clone();
        let args: Vec<OsString> = ["sync", "--watch", "--json"].map(OsString::from).to_vec();
        let exit = invocation
            .run(&args, None, move |line| {
                if let Some(round) = parse_sync_line(&line, now_ms()) {
                    let folders = heard.state::<SyncedFolders>();
                    if folders.is_current(generation) {
                        folders.record(round);
                        changed(&heard);
                    }
                }
                Ok(())
            })
            .await;
        let reason = match exit {
            Ok(exit) => {
                let said = exit
                    .stderr
                    .trim()
                    .lines()
                    .last()
                    .unwrap_or_default()
                    .to_string();
                if said.is_empty() {
                    format!("epicenter sync --watch exited with code {}", exit.code)
                } else {
                    said
                }
            }
            Err(error) => error_message(&error),
        };
        let again = folders.service_exited(generation, began.elapsed(), reason);
        changed(&app);
        if !again {
            return;
        }
        log::warn!("epicenter sync --watch exited; starting it again");
        tokio::time::sleep(RESPAWN_AFTER).await;
        if !app.state::<SyncedFolders>().is_current(generation) {
            return;
        }
    }
}

fn error_message(error: &CliError) -> String {
    match error {
        CliError::Refused { message } | CliError::Failed { message } => message.clone(),
    }
}

/// The folders the CLI registered, each with its last round.
#[tauri::command]
#[specta::specta]
pub async fn synced_folders(webview: Webview) -> Result<SyncedFolderListing, CliError> {
    let mut lines = Vec::new();
    let exit = cli::window_invocation(&webview)?
        .desktop()
        .run(&["status".into(), "--json".into()], None, |line| {
            lines.push(line);
            Ok(())
        })
        .await?;
    if exit.code != 0 {
        return Err(cli::failed(format!(
            "epicenter status exited {}: {}",
            exit.code,
            exit.stderr.trim()
        )));
    }
    let statuses = parse_status_lines(&lines)?;
    Ok(webview.state::<SyncedFolders>().listing(&statuses))
}

/// Run `epicenter init <path>`, then restart the service.
///
/// A folder that is there must be one the shell would open in any window: a
/// real directory holding none of Epicenter's own files, so neither the
/// records nor the library root around every folder becomes a repository.
async fn init<R: Runtime>(webview: &Webview<R>, path: &str) -> Result<FolderSetUp, CliError> {
    #[derive(Deserialize)]
    struct Reply {
        init: FolderSetUp,
    }
    if Path::new(path).exists() {
        admit(&webview.state::<DesktopPaths>(), path)
            .map_err(|message| CliError::Refused { message })?;
    }
    let reply: Reply = cli::window_invocation(webview)?
        .desktop()
        .answer(&["init", path, "--json"], None)
        .await?;
    start_service(webview.app_handle());
    Ok(reply.init)
}

/// Choose a folder with the native picker and set it up for sync: `None`
/// when the person cancelled.
#[tauri::command]
#[specta::specta]
pub async fn add_synced_folder(webview: Webview) -> Result<Option<FolderSetUp>, CliError> {
    let app = webview.app_handle().clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let folder_dir = app.state::<DesktopPaths>().folder_dir.clone();
        app.dialog()
            .file()
            .set_title("Choose a folder to sync")
            .set_directory(&folder_dir)
            .blocking_pick_folder()
            .map(|picked| picked.into_path())
            .transpose()
    })
    .await
    .map_err(|error| cli::failed(format!("the folder picker did not finish: {error}")))?
    .map_err(|error| cli::failed(format!("the chosen folder could not be read: {error}")))?;
    let Some(path) = picked else {
        return Ok(None);
    };
    let path = path.to_string_lossy().into_owned();
    if !is_plain_absolute_path(&path) {
        return Err(CliError::Refused {
            message: format!("{path} is not a plainly spelled folder path."),
        });
    }
    init(&webview, &path).await.map(Some)
}

/// Set up the folder an `epicenter://init` link asked for. A refusal keeps
/// the request, so the person can read why and dismiss it.
#[tauri::command]
#[specta::specta]
pub async fn accept_folder_setup(webview: Webview, path: String) -> Result<FolderSetUp, CliError> {
    let folders = webview.state::<SyncedFolders>();
    let Some(setup) = folders.take_setup(&path) else {
        return Err(CliError::Refused {
            message: format!("Nothing asked to sync {path}."),
        });
    };
    let result = init(&webview, &setup.path).await;
    if result.is_err() {
        folders.request(setup);
    }
    changed(webview.app_handle());
    result
}

/// Let go of a request to sync `path` without reading it.
#[tauri::command]
#[specta::specta]
pub fn dismiss_folder_setup(app: DesktopAppHandle, path: String) {
    if app.state::<SyncedFolders>().take_setup(&path).is_some() {
        changed(&app);
    }
}

/// `epicenter clone <source>`: a repository as `<owner>/<name>` or a URL,
/// into the library folder, set up and registered.
#[tauri::command]
#[specta::specta]
pub async fn clone_synced_folder(
    webview: Webview,
    source: String,
) -> Result<FolderSetUp, CliError> {
    #[derive(Deserialize)]
    struct Reply {
        cloned: FolderSetUp,
    }
    let source = argument(&source, "repository name or URL")?;
    let reply: Reply = cli::window_invocation(&webview)?
        .desktop()
        .answer(&["clone", &source, "--json"], None)
        .await?;
    start_service(webview.app_handle());
    Ok(reply.cloned)
}

/// One round of `epicenter sync <path>` now, kept as the folder's last.
#[tauri::command]
#[specta::specta]
pub async fn sync_folder_now(webview: Webview, path: String) -> Result<SyncRound, CliError> {
    let path = webview.state::<SyncedFolders>().member(&path)?;
    let mut round = None;
    let exit = cli::window_invocation(&webview)?
        .desktop()
        .run(
            &["sync".into(), path.clone().into(), "--json".into()],
            None,
            |line| {
                round = parse_sync_line(&line, now_ms()).or(round.take());
                Ok(())
            },
        )
        .await?;
    let Some(round) = round else {
        return Err(cli::failed(format!(
            "epicenter sync {path} exited {} without a round: {}",
            exit.code,
            exit.stderr.trim()
        )));
    };
    webview.state::<SyncedFolders>().record(round.clone());
    changed(webview.app_handle());
    Ok(round)
}

/// `epicenter forget <path>`: stop syncing it, leaving its files and history.
#[tauri::command]
#[specta::specta]
pub async fn forget_synced_folder(webview: Webview, path: String) -> Result<(), CliError> {
    let path = webview.state::<SyncedFolders>().member(&path)?;
    let _: serde_json::Value = cli::window_invocation(&webview)?
        .desktop()
        .answer(&["forget", &path, "--json"], None)
        .await?;
    start_service(webview.app_handle());
    Ok(())
}

/// Open a synced folder's files in an editor window of their own.
#[tauri::command]
#[specta::specta]
pub async fn open_synced_folder(app: DesktopAppHandle, path: String) -> Result<(), String> {
    let path = app
        .state::<SyncedFolders>()
        .member(&path)
        .map_err(|error| error_message(&error))?;
    tauri::async_runtime::spawn_blocking(move || {
        let directory = admit(&app.state::<DesktopPaths>(), &path)?;
        crate::folder_windows::open_editor(&app, directory)
            .map(|_| ())
            .map_err(|error| format!("{error:#}"))
    })
    .await
    .map_err(|error| format!("the folder could not be opened: {error}"))?
}

/// The directory at `path` when it is a real folder that holds none of
/// Epicenter's own files.
fn admit(paths: &DesktopPaths, path: &str) -> Result<Directory, String> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return Err("This folder is not there.".to_string())
        }
        Err(error) => return Err(format!("This folder could not be checked: {error}")),
        Ok(stats) if !stats.is_dir() => return Err("This path is not a folder.".to_string()),
        Ok(_) => {}
    }
    let directory = Directory::existing(Path::new(path)).map_err(|error| error.to_string())?;
    if crate::folder_windows::overlaps_epicenter_files(paths, &directory) {
        return Err("This folder holds Epicenter's own files.".to_string());
    }
    Ok(directory)
}

/// Who the repository a synced folder pushes to is shared with.
#[tauri::command]
#[specta::specta]
pub async fn folder_sharing(webview: Webview, path: String) -> Result<RepositoryGrants, CliError> {
    let path = webview.state::<SyncedFolders>().member(&path)?;
    cli::window_invocation(&webview)?
        .desktop()
        .answer(&["share", &path, "--json"], None)
        .await
}

/// Let `person` read, or also write, the repository a synced folder pushes to.
#[tauri::command]
#[specta::specta]
pub async fn share_folder(
    webview: Webview,
    path: String,
    person: String,
    level: GrantLevel,
) -> Result<RepositoryGrant, CliError> {
    let path = webview.state::<SyncedFolders>().member(&path)?;
    let person = argument(&person, "handle")?;
    let level = match level {
        GrantLevel::Read => "--read",
        GrantLevel::Write => "--write",
    };
    cli::window_invocation(&webview)?
        .desktop()
        .answer(&["share", &path, &person, level, "--json"], None)
        .await
}

/// Revoke `person`'s access to the repository a synced folder pushes to.
#[tauri::command]
#[specta::specta]
pub async fn unshare_folder(
    webview: Webview,
    path: String,
    person: String,
) -> Result<RepositoryGrantRevoked, CliError> {
    let path = webview.state::<SyncedFolders>().member(&path)?;
    let person = argument(&person, "handle")?;
    cli::window_invocation(&webview)?
        .desktop()
        .answer(&["unshare", &path, &person, "--json"], None)
        .await
}

/// Start the service again after it stopped.
#[tauri::command]
#[specta::specta]
pub fn restart_sync_service(app: DesktopAppHandle) {
    start_service(&app);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link(text: &str) -> Option<FolderSetup> {
        parse_init_link(&text.parse().unwrap())
    }

    #[test]
    fn an_init_link_names_one_plain_path_and_maybe_a_contract() {
        assert_eq!(
            link("epicenter://init?path=%2FUsers%2Fme%2FNotes"),
            Some(FolderSetup {
                path: "/Users/me/Notes".into(),
                contract: None
            })
        );
        assert_eq!(
            link("epicenter://init?path=%2FUsers%2Fme%2Fa%20b&contract=https%3A%2F%2Fexample.com%2Fcontract.json"),
            Some(FolderSetup {
                path: "/Users/me/a b".into(),
                contract: Some("https://example.com/contract.json".into())
            })
        );
        assert_eq!(
            link("epicenter://init?path=%2Fdata&contract=%2Fapps%2Fnotes.json")
                .and_then(|setup| setup.contract),
            Some("/apps/notes.json".into())
        );
    }

    #[test]
    fn an_init_link_with_anything_else_is_not_read() {
        for text in [
            "epicenter://init",
            "epicenter://init?",
            "epicenter://init?path=",
            "epicenter://init?path=relative",
            "epicenter://init?path=%2Fa%2F..%2Fb",
            "epicenter://init?path=%2Fa%2F%2Fb",
            "epicenter://init?path=%2Fa%2F",
            "epicenter://init?path=%2Fa%0Ab",
            "epicenter://init?path=%2Fa+b",
            "epicenter://init?path=%2Fa%zz",
            "epicenter://init?contract=https%3A%2F%2Fx&path=%2Fa",
            "epicenter://init?path=%2Fa&contract=",
            "epicenter://init?path=%2Fa&contract=javascript%3Aalert(1)",
            "epicenter://init?path=%2Fa&contract=relative.json",
            "epicenter://init?path=%2Fa&other=1",
            "epicenter://init?path=%2Fa&contract=https%3A%2F%2Fx&more=1",
            "epicenter://init/more?path=%2Fa",
            "epicenter://init?path=%2Fa#fragment",
            "epicenter://user@init?path=%2Fa",
            "epicenter://init:1?path=%2Fa",
            "epicenter://open?path=%2Fa",
            "other://init?path=%2Fa",
        ] {
            assert_eq!(link(text), None, "{text}");
        }
    }

    #[test]
    fn a_sync_line_is_one_round_and_any_other_line_is_none() {
        let round = parse_sync_line(
            r#"{"sync":{"folder":"/f","status":"retry","head":"abc","notes":["committed 1 file"],"message":"index.lock is held"}}"#,
            7.0,
        )
        .unwrap();
        assert_eq!(
            round,
            SyncRound {
                folder: "/f".into(),
                status: SyncStatus::Retry,
                head: Some("abc".into()),
                notes: vec!["committed 1 file".into()],
                message: Some("index.lock is held".into()),
                ended_at: 7.0,
            }
        );
        assert_eq!(
            parse_sync_line(
                r#"{"sync":{"folder":"/f","status":"synced","notes":[]}}"#,
                1.0
            )
            .map(|round| round.status),
            Some(SyncStatus::Synced)
        );
        for other in [
            "",
            "not json",
            r#"{"error":"refused"}"#,
            r#"{"sync":{"folder":"/f","status":"done","notes":[]}}"#,
        ] {
            assert_eq!(parse_sync_line(other, 0.0), None, "{other}");
        }
    }

    fn status_lines() -> Vec<String> {
        vec![
            r#"{"status":{"folder":"/a","repository":"/a","branch":"main","head":"h","registered":true,"adopted":true,"changes":[{"status":"??","path":"x.md"}],"remote":"https://git.example/me/a.git","ahead":1,"behind":0}}"#.into(),
            r#"{"status":{"folder":"/gone","problem":"not on disk"}}"#.into(),
            r#"{"status":{"folder":"/b","repository":"/b","branch":null,"head":null,"registered":true,"adopted":false,"changes":[],"remote":null,"ahead":null,"behind":null}}"#.into(),
        ]
    }

    #[test]
    fn the_listing_joins_each_folders_status_with_its_last_round() {
        let folders = SyncedFolders::default();
        folders.record(
            parse_sync_line(
                r#"{"sync":{"folder":"/a","status":"synced","head":"h","notes":[]}}"#,
                5.0,
            )
            .unwrap(),
        );
        folders.record(
            parse_sync_line(
                r#"{"sync":{"folder":"/forgotten","status":"synced","notes":[]}}"#,
                5.0,
            )
            .unwrap(),
        );
        let listing = folders.listing(&parse_status_lines(&status_lines()).unwrap());
        assert_eq!(listing.service, SyncService::Starting);
        let [a, gone, b] = listing.folders.as_slice() else {
            panic!("three folders: {listing:?}");
        };
        assert_eq!(
            (
                a.name.as_str(),
                a.changes,
                a.ahead,
                a.remote.as_deref(),
                a.problem.as_deref()
            ),
            ("a", 1, Some(1), Some("https://git.example/me/a.git"), None)
        );
        assert_eq!(
            a.last.as_ref().map(|round| round.status),
            Some(SyncStatus::Synced)
        );
        assert_eq!(gone.problem.as_deref(), Some("not on disk"));
        assert_eq!(
            b.problem.as_deref(),
            Some("its repository is not set up for sync")
        );
        assert!(b.last.is_none());
        // A folder the listing no longer holds keeps no round.
        assert!(!folders.lock().rounds.contains_key("/forgotten"));
    }

    #[test]
    fn a_page_may_name_only_a_folder_the_last_listing_held() {
        let folders = SyncedFolders::default();
        assert!(folders.member("/a").is_err());
        folders.listing(&parse_status_lines(&status_lines()).unwrap());
        assert_eq!(folders.member("/a").unwrap(), "/a");
        assert!(folders.member("/elsewhere").is_err());
        folders.listing(&[]);
        assert!(folders.member("/a").is_err());
    }

    #[test]
    fn a_status_line_that_does_not_read_fails_the_listing() {
        assert!(parse_status_lines(&["{\"sync\":{}}".into()]).is_err());
    }

    #[test]
    fn requests_are_kept_once_per_path_in_order() {
        let folders = SyncedFolders::default();
        let setup = |path: &str, contract: Option<&str>| FolderSetup {
            path: path.into(),
            contract: contract.map(str::to_string),
        };
        folders.request(setup("/a", None));
        folders.request(setup("/b", None));
        folders.request(setup("/a", Some("https://x/c.json")));
        assert_eq!(
            folders.lock().setups,
            vec![setup("/a", Some("https://x/c.json")), setup("/b", None)]
        );
        assert_eq!(
            folders.take_setup("/a"),
            Some(setup("/a", Some("https://x/c.json")))
        );
        assert_eq!(folders.take_setup("/a"), None);
    }

    #[test]
    fn the_service_starts_again_until_it_exits_quickly_three_times_in_a_row() {
        let folders = SyncedFolders::default();
        let run = folders.begin_service();
        let quick = Duration::from_secs(1);
        assert!(folders.service_exited(run, quick, "no".into()));
        assert!(folders.service_exited(run, quick, "no".into()));
        // A long run in between starts the count again.
        assert!(folders.service_exited(run, Duration::from_secs(600), "no".into()));
        assert!(folders.service_exited(run, quick, "no".into()));
        assert!(folders.service_exited(run, quick, "no".into()));
        assert!(!folders.service_exited(run, quick, "bun: not found".into()));
        assert_eq!(
            folders.lock().service.state,
            SyncService::Stopped {
                reason: "bun: not found".into()
            }
        );
    }

    #[test]
    fn a_replaced_service_run_changes_nothing() {
        let folders = SyncedFolders::default();
        let old = folders.begin_service();
        let new = folders.begin_service();
        assert!(!folders.service_is(old, SyncService::Running));
        assert!(!folders.service_exited(old, Duration::ZERO, "old".into()));
        assert!(!folders.is_current(old));
        assert!(folders.service_is(new, SyncService::Running));
        assert_eq!(folders.lock().service.state, SyncService::Running);
    }

    #[test]
    fn epicenters_own_folders_are_never_set_up_for_sync() {
        let temp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(temp.path()).unwrap();
        let paths = DesktopPaths {
            data_dir: root.join("data"),
            folder_dir: root.join("Epicenter"),
        };
        let records = paths
            .open_default(epicenter_folder_core::library::RECORDS)
            .unwrap();
        let notes = paths.folder_dir.join("notes");
        fs::create_dir_all(&notes).unwrap();
        fs::create_dir_all(&paths.data_dir).unwrap();
        for refused in [
            records.root().to_path_buf(),
            paths.folder_dir.clone(),
            paths.data_dir.clone(),
            root.clone(),
        ] {
            assert!(
                admit(&paths, &refused.to_string_lossy()).is_err(),
                "{refused:?}"
            );
        }
        assert!(admit(&paths, &notes.to_string_lossy()).is_ok());
        fs::write(root.join("file"), "").unwrap();
        assert!(admit(&paths, &root.join("file").to_string_lossy()).is_err());
    }

    #[test]
    fn a_page_argument_is_never_an_option() {
        for bad in ["", "  ", "-x", "--desktop", "a\nb"] {
            assert!(argument(bad, "handle").is_err(), "{bad:?}");
        }
        assert_eq!(argument(" ana ", "handle").unwrap(), "ana");
        assert_eq!(argument("me/notes", "name").unwrap(), "me/notes");
    }
}
