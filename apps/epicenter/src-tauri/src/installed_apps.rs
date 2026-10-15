//! Installed apps: an app is a Git repository with `epicenter.app.json` at its
//! root, cloned into `<folder_dir>/Apps/<app-id>/` and built on this machine
//! (ADR-0540).
//!
//! ```txt
//! <folder_dir>/Apps/<app-id>/                 the app's source, its own repository
//! <data_dir>/approvals.json                   { [appId]: { commit, approvedAt } }
//! <cache_dir>/builds/<app-id>/<commit>/       the built bundle the host serves
//! <cache_dir>/builds/<app-id>/<commit>.log    what the install and build printed
//! <cache_dir>/builds/<app-id>/current         the commit the host serves
//! ```
//!
//! Approval guards code that arrived from elsewhere. Installing clones and
//! builds nothing: the page shows what it would run and the person approves
//! that commit. A commit made on this machine runs without asking: every
//! commit between the approved one and `HEAD` must be unreachable from every
//! remote-tracking ref and from `FETCH_HEAD`. Building such a commit records
//! it as approved, so pushing it later does not ask again. Anything else,
//! such as an update fetched from upstream, waits for approval, shown its log
//! and diff stat.
//!
//! Approving trusts the app fully: its build runs with the person's
//! permissions. The Git commands here still run as the folder plugin runs a
//! page's: no hooks, no fsmonitor, no terminal prompt, discovery stopped at
//! the repository, and no inherited variable pointing Git elsewhere. Trust
//! covers code, never data.
//!
//! Only the shell writes `approvals.json` and the builds. The page records the
//! installed app as a row of `so.epicenter`'s `apps` table through the folder
//! engine, as it records any row.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs::{self, File};
use std::io::{ErrorKind, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::app_data::DesktopPaths;
use crate::data_folders::{APPLICATION_FOLDERS, EPICENTER_FOLDER};
use crate::{BuiltInApp, DesktopAppHandle};

/// The file at an app repository's root that makes it an app.
pub const MANIFEST: &str = "epicenter.app.json";
const DEFAULT_BUILD: &str = "bun run build";
const DEFAULT_OUTPUT: &str = "dist";
/// The file in an app's build directory naming the commit the host serves.
pub const CURRENT_BUILD: &str = "current";

const GIT_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const BUILD_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_SHAPE_BYTES: u64 = 1024 * 1024;
const MAX_LOG_LINES: &str = "50";

/// What a person is told before approving: approval runs the app's code.
pub const APPROVAL_STATEMENT: &str = "Approving builds this app on this computer. Building runs the app's code with your permissions, so approve only code you trust.";

/// `epicenter.app.json`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Manifest {
    pub id: String,
    pub title: String,
    /// The repository path of the JSON declaration of the shape the app
    /// opens (ADR-0538), such as `shape.json`.
    pub opens: String,
    pub build: String,
    /// The repository path of the built single-page app.
    pub output: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ManifestFile {
    id: String,
    title: String,
    opens: String,
    build: Option<String>,
    output: Option<String>,
}

/// Read and check `epicenter.app.json`'s text.
pub fn parse_manifest(text: &str) -> Result<Manifest, String> {
    let file: ManifestFile = serde_json::from_str(text)
        .map_err(|error| format!("{MANIFEST} is not a valid app manifest: {error}"))?;
    if let Some(problem) = app_id_problem(&file.id) {
        return Err(format!(
            "{MANIFEST} names the id '{}', which {problem}",
            file.id
        ));
    }
    let title = file.title.trim();
    if title.is_empty() || title.chars().count() > 100 || title.chars().any(char::is_control) {
        return Err(format!(
            "{MANIFEST} needs a title of 1 to 100 characters on one line"
        ));
    }
    if let Some(problem) = repository_path_problem(&file.opens) {
        return Err(format!("{MANIFEST}'s opens {problem}"));
    }
    let output = file.output.unwrap_or_else(|| DEFAULT_OUTPUT.to_string());
    if let Some(problem) = repository_path_problem(&output) {
        return Err(format!("{MANIFEST}'s output {problem}"));
    }
    let build = file.build.unwrap_or_else(|| DEFAULT_BUILD.to_string());
    if build.trim().is_empty() || build.contains(['\n', '\r', '\0']) {
        return Err(format!("{MANIFEST}'s build must be one command line"));
    }
    Ok(Manifest {
        id: file.id,
        title: title.to_string(),
        opens: file.opens,
        build,
        output,
    })
}

/// Why `id` cannot name an installed app, if it cannot: it must be a
/// lowercase reverse-domain name, such as `com.example.board`, and must not
/// be Epicenter's own or a built-in app's.
pub fn app_id_problem(id: &str) -> Option<&'static str> {
    let labels: Vec<&str> = id.split('.').collect();
    let well_formed = id.len() <= 128
        && labels.len() >= 2
        && labels.iter().all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
                && !label.starts_with('-')
                && !label.ends_with('-')
        })
        && labels[0].as_bytes()[0].is_ascii_lowercase();
    if !well_formed {
        return Some("is not a lowercase reverse-domain name such as com.example.board");
    }
    let built_in = id == EPICENTER_FOLDER
        || APPLICATION_FOLDERS.iter().any(|folder| folder.scope == id)
        || BuiltInApp::ALL
            .iter()
            .any(|app| id.strip_prefix("so.epicenter.") == Some(app.id()));
    built_in.then_some("belongs to an app built into Epicenter")
}

/// Why `path` cannot name a file in the repository, if it cannot.
fn repository_path_problem(path: &str) -> Option<&'static str> {
    let relative = Path::new(path);
    if path.is_empty() || path.contains('\0') || relative.is_absolute() {
        return Some("must be a path inside the repository");
    }
    let inside = relative.components().all(|component| match component {
        Component::Normal(name) => name.to_str().is_some_and(|name| name != ".git"),
        Component::CurDir => true,
        _ => false,
    });
    (!inside).then_some("must be a path inside the repository, not in .git")
}

/// One app approval, as `approvals.json` keeps it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Approval {
    pub commit: String,
    /// Milliseconds since the Unix epoch.
    pub approved_at: u64,
}

pub type Approvals = BTreeMap<String, Approval>;

/// `approvals.json`, or no approvals when it is missing. A file that cannot
/// be read as approvals approves nothing, so every app asks again.
pub fn read_approvals(file: &Path) -> Approvals {
    match fs::read(file) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|error| {
            log::warn!("{} approves nothing: {error}", file.display());
            Approvals::new()
        }),
        Err(error) if error.kind() == ErrorKind::NotFound => Approvals::new(),
        Err(error) => {
            log::warn!("{} could not be read: {error}", file.display());
            Approvals::new()
        }
    }
}

/// Record that `commit` of app `id` may run on this machine.
pub fn record_approval(file: &Path, id: &str, commit: &str) -> Result<(), String> {
    let mut approvals = read_approvals(file);
    let approved_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default();
    approvals.insert(
        id.to_string(),
        Approval {
            commit: commit.to_string(),
            approved_at,
        },
    );
    let text = serde_json::to_string_pretty(&approvals).map_err(|error| error.to_string())?;
    write_replacing(file, format!("{text}\n").as_bytes())
        .map_err(|error| format!("The approval could not be recorded: {error}"))
}

/// Write `bytes` to `file` through a sibling, so a reader sees the old file or
/// the new one.
fn write_replacing(file: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = file.parent().unwrap_or(Path::new("."));
    fs::create_dir_all(parent)?;
    let staged = parent.join(format!(
        ".{}.{}",
        file.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("file"),
        random_suffix()
    ));
    let written = File::create(&staged).and_then(|mut out| {
        out.write_all(bytes)?;
        out.sync_all()
    });
    if let Err(error) = written.and_then(|()| fs::rename(&staged, file)) {
        let _ = fs::remove_file(&staged);
        return Err(error);
    }
    Ok(())
}

fn random_suffix() -> String {
    let mut bytes = [0_u8; 8];
    getrandom::fill(&mut bytes).expect("the system random source");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// An installed app as the Folders window shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct InstalledApp {
    /// The app's id, which is also its directory under `Apps/`.
    pub id: String,
    pub title: String,
    /// Where it was installed from: the repository's `origin`, or empty when
    /// it has none.
    pub source: String,
    /// The commit checked out, `HEAD`. Empty when the app is `Broken`.
    pub commit: String,
    /// The text of the declaration `opens` names, or `None` when it could not
    /// be read. The page parses it; the shell does not judge it.
    pub opens: Option<String>,
    pub state: AppState,
}

/// Whether an installed app can run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AppState {
    /// Built at its commit; it opens at once.
    Ready,
    /// Its commit may run but has not been built, as after a commit made on
    /// this machine; opening builds it first.
    Unbuilt,
    /// Its commit arrived from elsewhere and runs only once approved.
    NeedsApproval { review: Review },
    /// It cannot run as it is.
    Broken { problem: String },
}

/// What a person is shown before approving a commit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    /// The commit approved before, when there is one this repository has.
    pub from: Option<String>,
    /// `git log --oneline` of what would newly run.
    pub log: String,
    /// `git diff --stat` from the approved commit, empty on a first install.
    pub diff_stat: String,
    pub statement: String,
}

/// Paths and the empty hooks directory every Git command here runs with.
pub struct AppPaths {
    pub apps_dir: PathBuf,
    pub builds_dir: PathBuf,
    pub approvals_file: PathBuf,
    /// An empty directory `core.hooksPath` names, so no hook runs.
    pub no_hooks: PathBuf,
    /// Extra environment for `bun` and the build command.
    pub build_env: Vec<(OsString, OsString)>,
}

impl AppPaths {
    pub fn new(paths: &DesktopPaths) -> Self {
        Self {
            apps_dir: paths.apps_dir(),
            builds_dir: paths.builds_dir(),
            approvals_file: paths.approvals_file(),
            no_hooks: paths.cache_dir.join("no-hooks"),
            build_env: build_environment(&paths.cache_dir),
        }
    }

    fn source(&self, id: &str) -> PathBuf {
        self.apps_dir.join(id)
    }

    fn builds(&self, id: &str) -> PathBuf {
        self.builds_dir.join(id)
    }
}

/// In a release, `bun` is the bundled host itself: `BUN_BE_BUN` makes a
/// compiled Bun executable run as the Bun CLI, and a `bun` link to it heads
/// `PATH` so the build command's own `bun` finds it too. A development run
/// uses the `bun` on `PATH`.
#[cfg(all(unix, not(debug_assertions)))]
fn build_environment(cache_dir: &Path) -> Vec<(OsString, OsString)> {
    let shim = cache_dir.join("bin");
    let Some(host) = std::env::current_exe()
        .ok()
        .and_then(|exe| Some(exe.parent()?.join("epicenter-host")))
    else {
        return Vec::new();
    };
    let link = shim.join("bun");
    let _ = fs::create_dir_all(&shim);
    if fs::read_link(&link).ok().as_deref() != Some(host.as_path()) {
        let _ = fs::remove_file(&link);
        if let Err(error) = std::os::unix::fs::symlink(&host, &link) {
            log::warn!("the bun link for app builds could not be made: {error}");
            return Vec::new();
        }
    }
    let mut path = OsString::from(shim.as_os_str());
    if let Some(inherited) = std::env::var_os("PATH") {
        path.push(":");
        path.push(inherited);
    }
    vec![("BUN_BE_BUN".into(), "1".into()), ("PATH".into(), path)]
}

#[cfg(not(all(unix, not(debug_assertions))))]
fn build_environment(_cache_dir: &Path) -> Vec<(OsString, OsString)> {
    Vec::new()
}

/// One install, approval, update, or build at a time, so two never write the
/// same clone or build directory.
#[derive(Default)]
pub struct AppWork(Mutex<()>);

impl AppWork {
    fn run<T>(&self, work: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        let _held = self.0.try_lock().map_err(|_| {
            "Epicenter is already installing or building an app. Try again when it finishes."
                .to_string()
        })?;
        work()
    }
}

// ---------------------------------------------------------------------------
// Processes

struct Finished {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

/// Run `command` to completion, killing it and what it started after
/// `timeout`. Output goes where the command's own stdio says; piped output is
/// returned.
fn run_bounded(mut command: Command, timeout: Duration, what: &str) -> Result<Finished, String> {
    command.stdin(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("{what} could not be started: {error}"))?;
    let pipe = |stream: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            if let Some(mut stream) = stream {
                let _ = stream.read_to_end(&mut bytes);
            }
            bytes
        })
    };
    let stdout = pipe(
        child
            .stdout
            .take()
            .map(|out| Box::new(out) as Box<dyn Read + Send>),
    );
    let stderr = pipe(
        child
            .stderr
            .take()
            .map(|err| Box::new(err) as Box<dyn Read + Send>),
    );
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                kill_tree(&mut child);
                let _ = child.wait();
                return Err(format!(
                    "{what} did not finish within {} minutes and was stopped",
                    timeout.as_secs() / 60
                ));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(error) => return Err(format!("{what} could not be awaited: {error}")),
        }
    };
    Ok(Finished {
        status,
        stdout: stdout.join().unwrap_or_default(),
        stderr: stderr.join().unwrap_or_default(),
    })
}

fn kill_tree(child: &mut std::process::Child) {
    #[cfg(unix)]
    if let Ok(group) = libc::pid_t::try_from(child.id()) {
        // SAFETY: `kill` takes no pointers. The group is the one the child
        // leads (`process_group(0)`), kept until it is reaped.
        unsafe {
            libc::kill(-group, libc::SIGKILL);
        }
    }
    let _ = child.kill();
}

/// Run `git` in `dir` as the folder plugin runs a page's: no hooks, no
/// fsmonitor, no prompt, discovery stopped at `dir`, and no inherited
/// variable pointing Git elsewhere. Returns stdout, trimmed.
fn git(paths: &AppPaths, dir: &Path, args: &[&str]) -> Result<String, String> {
    let finished = run_bounded(git_command(paths, dir, args)?, GIT_TIMEOUT, "git")?;
    if !finished.status.success() {
        let stderr = String::from_utf8_lossy(&finished.stderr);
        return Err(format!(
            "git {} failed: {}",
            args.first().copied().unwrap_or_default(),
            stderr.trim()
        ));
    }
    Ok(String::from_utf8_lossy(&finished.stdout).trim().to_string())
}

fn git_command(paths: &AppPaths, dir: &Path, args: &[&str]) -> Result<Command, String> {
    let no_hooks = empty_hooks_directory(&paths.no_hooks)?;
    let mut command = Command::new("git");
    command
        .arg("-c")
        .arg(format!("core.hooksPath={}", no_hooks.display()))
        .args(["-c", "core.fsmonitor=false"])
        .args(["-c", "protocol.ext.allow=never"])
        .args(["-c", "protocol.fd.allow=never"])
        .args(["-c", "color.ui=never"])
        .args(args)
        .current_dir(dir);
    for (name, _) in std::env::vars_os() {
        if name.to_str().is_some_and(is_removed_env) {
            command.env_remove(&name);
        }
    }
    command
        .env(
            "GIT_CEILING_DIRECTORIES",
            dir.parent().unwrap_or(Path::new("/")),
        )
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    Ok(command)
}

/// Inherited variables that would point Git at another repository, index,
/// object store, or configuration, or trace its arguments: removed from
/// every command, as the folder plugin removes them from a page's.
fn is_removed_env(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("GIT_") else {
        return false;
    };
    const EXACT: [&str; 18] = [
        "DIR",
        "WORK_TREE",
        "IMPLICIT_WORK_TREE",
        "INDEX_FILE",
        "OBJECT_DIRECTORY",
        "ALTERNATE_OBJECT_DIRECTORIES",
        "COMMON_DIR",
        "NAMESPACE",
        "PREFIX",
        "GRAFT_FILE",
        "SHALLOW_FILE",
        "NO_REPLACE_OBJECTS",
        "REPLACE_REF_BASE",
        "CONFIG",
        "CONFIG_PARAMETERS",
        "CONFIG_COUNT",
        "CURL_VERBOSE",
        "SSH_COMMAND",
    ];
    EXACT.contains(&rest)
        || rest.starts_with("TRACE")
        || ["CONFIG_KEY_", "CONFIG_VALUE_"]
            .iter()
            .any(|prefix| rest.starts_with(prefix))
}

/// The directory `core.hooksPath` names: made when missing, and refused
/// unless it is a real, empty directory, since a hook planted there would run.
fn empty_hooks_directory(path: &Path) -> Result<PathBuf, String> {
    let failed =
        |error: std::io::Error| format!("the empty hooks directory could not be made: {error}");
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == ErrorKind::NotFound => {
            fs::create_dir_all(path).map_err(failed)?;
        }
        Err(error) => return Err(failed(error)),
        Ok(_) => {}
    }
    let kind = fs::symlink_metadata(path).map_err(failed)?.file_type();
    let empty =
        kind.is_dir() && !kind.is_symlink() && fs::read_dir(path).map_err(failed)?.next().is_none();
    if !empty {
        return Err(format!(
            "'{}' must be an empty directory, because every Git command for an app looks for hooks there",
            path.display()
        ));
    }
    Ok(path.to_path_buf())
}

// ---------------------------------------------------------------------------
// Reading an installed app

fn read_manifest(source: &Path) -> Result<Manifest, String> {
    let path = source.join(MANIFEST);
    let text = read_regular_file(&path, MAX_MANIFEST_BYTES)
        .map_err(|problem| format!("{MANIFEST} {problem}"))?;
    parse_manifest(&text)
}

/// A regular file's text, refusing links, other kinds, and large files.
fn read_regular_file(path: &Path, limit: u64) -> Result<String, String> {
    let stats = fs::symlink_metadata(path).map_err(|_| "is missing".to_string())?;
    if !stats.is_file() {
        return Err("is not a regular file".to_string());
    }
    if stats.len() > limit {
        return Err(format!("is larger than {limit} bytes"));
    }
    fs::read_to_string(path).map_err(|error| format!("could not be read: {error}"))
}

fn head(paths: &AppPaths, source: &Path) -> Result<String, String> {
    git(paths, source, &["rev-parse", "--verify", "HEAD^{commit}"])
}

fn origin(paths: &AppPaths, source: &Path) -> String {
    git(paths, source, &["config", "--get", "remote.origin.url"]).unwrap_or_default()
}

/// The commit `builds/<id>/current` names, when its build is there.
pub fn current_build(builds: &Path) -> Option<String> {
    let commit = fs::read_to_string(builds.join(CURRENT_BUILD)).ok()?;
    let commit = commit.trim();
    (is_commit(commit) && builds.join(commit).join("index.html").is_file())
        .then(|| commit.to_string())
}

fn is_commit(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// Whether `head` may run without asking, given the commit approved before.
fn may_run(paths: &AppPaths, source: &Path, approved: Option<&str>, head: &str) -> bool {
    let Some(approved) = approved else {
        return false;
    };
    if approved == head {
        return true;
    }
    if git(
        paths,
        source,
        &["cat-file", "-e", &format!("{approved}^{{commit}}")],
    )
    .is_err()
    {
        return false;
    }
    let count = |extra: &[&str]| -> Option<String> {
        let mut args = vec!["rev-list", "--count", head, "--not", approved];
        args.extend_from_slice(extra);
        git(paths, source, &args).ok()
    };
    let mut remote = vec!["--remotes"];
    let fetched = git(
        paths,
        source,
        &["rev-parse", "--verify", "-q", "FETCH_HEAD"],
    )
    .ok();
    if let Some(fetched) = fetched.as_deref() {
        remote.push(fetched);
    }
    // Every commit `head` adds is unreachable from what was fetched.
    matches!((count(&[]), count(&remote)), (Some(all), Some(local)) if all == local)
}

fn review(paths: &AppPaths, source: &Path, approved: Option<&str>, head: &str) -> Review {
    let from = approved.filter(|approved| {
        git(
            paths,
            source,
            &["cat-file", "-e", &format!("{approved}^{{commit}}")],
        )
        .is_ok()
    });
    let (log, diff_stat) = match from {
        Some(from) => (
            git(
                paths,
                source,
                &[
                    "log",
                    "--oneline",
                    "--no-decorate",
                    "-n",
                    MAX_LOG_LINES,
                    &format!("{from}..{head}"),
                ],
            ),
            git(paths, source, &["diff", "--stat", from, head]),
        ),
        None => (
            git(
                paths,
                source,
                &[
                    "log",
                    "--oneline",
                    "--no-decorate",
                    "-n",
                    MAX_LOG_LINES,
                    head,
                ],
            ),
            Ok(String::new()),
        ),
    };
    Review {
        from: from.map(str::to_string),
        log: log.unwrap_or_else(|problem| problem),
        diff_stat: diff_stat.unwrap_or_else(|problem| problem),
        statement: APPROVAL_STATEMENT.to_string(),
    }
}

/// The installed app under `Apps/<id>/`, as it is now.
pub fn inspect(paths: &AppPaths, id: &str) -> InstalledApp {
    let source = paths.source(id);
    let broken = |title: String, problem: String| InstalledApp {
        id: id.to_string(),
        title,
        source: String::new(),
        commit: String::new(),
        opens: None,
        state: AppState::Broken { problem },
    };
    let manifest = match read_manifest(&source) {
        Ok(manifest) => manifest,
        Err(problem) => return broken(id.to_string(), problem),
    };
    if manifest.id != id {
        return broken(
            manifest.title,
            format!(
                "{MANIFEST} names the id '{}', but the app is in Apps/{id}",
                manifest.id
            ),
        );
    }
    let commit = match head(paths, &source) {
        Ok(commit) => commit,
        Err(problem) => return broken(manifest.title, problem),
    };
    let opens = read_regular_file(&source.join(&manifest.opens), MAX_SHAPE_BYTES).ok();
    let state = if current_build(&paths.builds(id)).as_deref() == Some(commit.as_str()) {
        AppState::Ready
    } else {
        let approvals = read_approvals(&paths.approvals_file);
        let approved = approvals.get(id).map(|approval| approval.commit.as_str());
        if may_run(paths, &source, approved, &commit) {
            AppState::Unbuilt
        } else {
            AppState::NeedsApproval {
                review: review(paths, &source, approved, &commit),
            }
        }
    };
    InstalledApp {
        id: id.to_string(),
        title: manifest.title,
        source: origin(paths, &source),
        commit,
        opens,
        state,
    }
}

/// Every installed app, by id.
pub fn list(paths: &AppPaths) -> Result<Vec<InstalledApp>, String> {
    let entries = match fs::read_dir(&paths.apps_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("The Apps folder could not be read: {error}")),
    };
    let mut ids: Vec<String> = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| !name.starts_with('.'))
        .collect();
    ids.sort();
    Ok(ids.iter().map(|id| inspect(paths, id)).collect())
}

// ---------------------------------------------------------------------------
// Installing, approving, building, updating

/// Why `source` cannot be cloned, if it cannot: an absolute local path, or a
/// `https`, `http`, `ssh`, `git`, or `file` URL, or `user@host:path`.
fn source_problem(source: &str) -> Option<&'static str> {
    if source.is_empty() || source.starts_with('-') || source.chars().any(char::is_control) {
        return Some("is not a Git URL or a local path");
    }
    if Path::new(source).is_absolute() {
        return None;
    }
    if let Some((scheme, _)) = source.split_once("://") {
        return (!matches!(scheme, "https" | "http" | "ssh" | "git" | "file"))
            .then_some("uses a transport Epicenter does not clone from");
    }
    if source.contains("::") {
        return Some("uses a transport Epicenter does not clone from");
    }
    let scp_like = source
        .split_once(':')
        .is_some_and(|(host, path)| !host.is_empty() && !host.contains('/') && !path.is_empty());
    (!scp_like).then_some("is not a Git URL or an absolute local path")
}

/// Clone `source` into `Apps/<id>/`, the id read from its manifest. Builds
/// nothing: the app needs approval before it runs.
pub fn install(paths: &AppPaths, source: &str) -> Result<InstalledApp, String> {
    let source = source.trim();
    if let Some(problem) = source_problem(source) {
        return Err(format!("'{source}' {problem}."));
    }
    fs::create_dir_all(&paths.apps_dir)
        .map_err(|error| format!("The Apps folder could not be made: {error}"))?;
    // A dot directory, which neither listing reads.
    let staging = paths
        .apps_dir
        .join(format!(".installing-{}", random_suffix()));
    let staged = (|| {
        let staging_name = staging
            .to_str()
            .ok_or("The Apps folder is not UTF-8 text")?;
        git(
            paths,
            &paths.apps_dir,
            &[
                "clone",
                "--no-recurse-submodules",
                "--template=",
                "--",
                source,
                staging_name,
            ],
        )?;
        let manifest = read_manifest(&staging)?;
        let destination = paths.source(&manifest.id);
        if fs::symlink_metadata(&destination).is_ok() {
            return Err(format!(
                "An app with the id {} is already installed in Apps/{}.",
                manifest.id, manifest.id
            ));
        }
        fs::rename(&staging, &destination)
            .map_err(|error| format!("The app could not be moved into place: {error}"))?;
        Ok(manifest.id)
    })();
    match staged {
        Ok(id) => Ok(inspect(paths, &id)),
        Err(problem) => {
            let _ = fs::remove_dir_all(&staging);
            Err(problem)
        }
    }
}

/// Approve `commit` of app `id`, which must still be its `HEAD`, then build
/// it.
pub fn approve(paths: &AppPaths, id: &str, commit: &str) -> Result<InstalledApp, String> {
    let source = installed_source(paths, id)?;
    let manifest = read_manifest(&source)?;
    let head = head(paths, &source)?;
    if head != commit {
        return Err(format!(
            "{} changed since it was shown. Review it again.",
            manifest.title
        ));
    }
    require_clean(paths, &source)?;
    record_approval(&paths.approvals_file, id, &head)?;
    build(paths, &source, &manifest, &head)?;
    Ok(inspect(paths, id))
}

/// Make app `id` ready to open: build it when its commit may run and is not
/// built yet. A commit made here is recorded as approved once built.
pub fn prepare(paths: &AppPaths, id: &str) -> Result<InstalledApp, String> {
    let installed = inspect(paths, id);
    match &installed.state {
        AppState::Ready => Ok(installed),
        AppState::Unbuilt => {
            let source = installed_source(paths, id)?;
            let manifest = read_manifest(&source)?;
            build(paths, &source, &manifest, &installed.commit)?;
            let approvals = read_approvals(&paths.approvals_file);
            if approvals.get(id).map(|approval| approval.commit.as_str())
                != Some(installed.commit.as_str())
            {
                record_approval(&paths.approvals_file, id, &installed.commit)?;
            }
            Ok(inspect(paths, id))
        }
        AppState::NeedsApproval { .. } => Err(format!(
            "{} changed from elsewhere. Review and approve it first.",
            installed.title
        )),
        AppState::Broken { problem } => Err(problem.clone()),
    }
}

/// Fetch app `id`'s upstream and bring its commits onto it: a fast-forward,
/// or a rebase of the commits made here. A rebase that conflicts is undone
/// and reported. What arrived then needs approval.
pub fn update(paths: &AppPaths, id: &str) -> Result<InstalledApp, String> {
    let source = installed_source(paths, id)?;
    require_clean(paths, &source)?;
    git(
        paths,
        &source,
        &["fetch", "--no-recurse-submodules", "origin"],
    )?;
    git(
        paths,
        &source,
        &["rev-parse", "--verify", "-q", "@{upstream}^{commit}"],
    )
    .map_err(|_| {
        "This app's branch follows no upstream branch, so there is nothing to update from."
            .to_string()
    })?;
    let behind_only = git(
        paths,
        &source,
        &["merge-base", "--is-ancestor", "HEAD", "@{upstream}"],
    )
    .is_ok();
    if behind_only {
        git(paths, &source, &["merge", "--ff-only", "@{upstream}"])?;
    } else if let Err(problem) = git(paths, &source, &["rebase", "@{upstream}"]) {
        let _ = git(paths, &source, &["rebase", "--abort"]);
        return Err(format!(
            "The commits made here conflict with the update, so nothing changed. Resolve it in Apps/{id} with Git. ({problem})"
        ));
    }
    Ok(inspect(paths, id))
}

fn installed_source(paths: &AppPaths, id: &str) -> Result<PathBuf, String> {
    if let Some(problem) = app_id_problem(id) {
        return Err(format!("'{id}' {problem}."));
    }
    let source = paths.source(id);
    if !fs::symlink_metadata(&source).is_ok_and(|stats| stats.is_dir()) {
        return Err(format!("No app is installed in Apps/{id}."));
    }
    Ok(source)
}

fn require_clean(paths: &AppPaths, source: &Path) -> Result<(), String> {
    let changes = git(
        paths,
        source,
        &["status", "--porcelain", "--untracked-files=no"],
    )?;
    if !changes.is_empty() {
        return Err(
            "This app has changes that are not committed. Commit or discard them first, so what runs is a commit.".to_string(),
        );
    }
    Ok(())
}

/// Build `commit`, checked out in `source`, into `builds/<id>/<commit>/`, and
/// make it the build the host serves. What the install and the build print
/// goes to `builds/<id>/<commit>.log`.
fn build(paths: &AppPaths, source: &Path, manifest: &Manifest, commit: &str) -> Result<(), String> {
    require_clean(paths, source)?;
    let builds = paths.builds(&manifest.id);
    fs::create_dir_all(&builds)
        .map_err(|error| format!("The build folder could not be made: {error}"))?;
    let log_path = builds.join(format!("{commit}.log"));
    let log = File::create(&log_path)
        .map_err(|error| format!("The build log could not be made: {error}"))?;
    let failed = |problem: String| {
        format!(
            "{} did not build: {problem}. See {}",
            manifest.title,
            log_path.display()
        )
    };
    let step = |mut command: Command, what: &str| -> Result<(), String> {
        let out = log.try_clone().map_err(|error| error.to_string())?;
        let err = log.try_clone().map_err(|error| error.to_string())?;
        command
            .current_dir(source)
            .envs(paths.build_env.iter().map(|(name, value)| (name, value)))
            .env("CI", "1")
            .stdout(out)
            .stderr(err);
        let finished = run_bounded(command, BUILD_TIMEOUT, what)?;
        if !finished.status.success() {
            return Err(format!("{what} exited with {}", finished.status));
        }
        Ok(())
    };
    if source.join("package.json").is_file() {
        let mut install = Command::new("bun");
        install.args(["install", "--frozen-lockfile", "--ignore-scripts"]);
        step(install, "bun install").map_err(failed)?;
    }
    step(shell(&manifest.build), &manifest.build).map_err(failed)?;

    let root = fs::canonicalize(source).map_err(|error| failed(error.to_string()))?;
    let output = fs::canonicalize(source.join(&manifest.output))
        .map_err(|_| failed(format!("it wrote no {}", manifest.output)))?;
    if !output.starts_with(&root) || !output.join("index.html").is_file() {
        return Err(failed(format!(
            "{} must be a folder in the repository holding index.html",
            manifest.output
        )));
    }
    let staged = builds.join(format!(".{commit}-{}", random_suffix()));
    let placed = copy_tree(&output, &staged).and_then(|()| {
        let destination = builds.join(commit);
        if destination.exists() {
            fs::remove_dir_all(&destination)?;
        }
        fs::rename(&staged, &destination)
    });
    if let Err(error) = placed {
        let _ = fs::remove_dir_all(&staged);
        return Err(failed(format!("the build could not be kept: {error}")));
    }
    write_replacing(
        &builds.join(CURRENT_BUILD),
        format!("{commit}\n").as_bytes(),
    )
    .map_err(|error| failed(format!("the build could not be made current: {error}")))
}

/// The manifest's build command, run by the system shell.
fn shell(line: &str) -> Command {
    let (program, flag) = if cfg!(windows) {
        ("cmd", "/C")
    } else {
        ("/bin/sh", "-c")
    };
    let mut command = Command::new(program);
    command.args([flag, line]);
    command
}

/// Copy the regular files and directories under `from` to `to`. Links are
/// left behind: the host serves only what is inside the build.
fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let target = to.join(entry.file_name());
        if kind.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else if kind.is_file() {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Commands, granted to the Folders window alone

fn app_paths(app: &DesktopAppHandle) -> AppPaths {
    AppPaths::new(&app.state::<DesktopPaths>())
}

/// Every app installed under `Apps/`, with whether it can run.
#[tauri::command(async)]
#[specta::specta]
pub fn list_installed_apps(app: DesktopAppHandle) -> Result<Vec<InstalledApp>, String> {
    list(&app_paths(&app))
}

/// Clone the app at `source`, a Git URL or a local path, into `Apps/`. It
/// builds and runs nothing until approved.
#[tauri::command(async)]
#[specta::specta]
pub fn install_app(app: DesktopAppHandle, source: String) -> Result<InstalledApp, String> {
    app.state::<AppWork>()
        .run(|| install(&app_paths(&app), &source))
}

/// Approve `commit` of app `id` and build it.
#[tauri::command(async)]
#[specta::specta]
pub fn approve_app(
    app: DesktopAppHandle,
    id: String,
    commit: String,
) -> Result<InstalledApp, String> {
    app.state::<AppWork>()
        .run(|| approve(&app_paths(&app), &id, &commit))
}

/// Fetch app `id`'s upstream and bring it up to date. What arrives needs
/// approval before it runs.
#[tauri::command(async)]
#[specta::specta]
pub fn update_app(app: DesktopAppHandle, id: String) -> Result<InstalledApp, String> {
    app.state::<AppWork>().run(|| update(&app_paths(&app), &id))
}

/// Open app `id` in its own window, building a commit made here first. With
/// `folder`, a scope the Folders window listed, the window is let into that
/// folder and the app is handed it as `?folder=`.
#[tauri::command(async)]
#[specta::specta]
pub fn open_installed_app(
    app: DesktopAppHandle,
    id: String,
    folder: Option<String>,
) -> Result<InstalledApp, String> {
    let installed = app
        .state::<AppWork>()
        .run(|| prepare(&app_paths(&app), &id))?;
    crate::open_installed_window(&app, &installed.id, &installed.title, folder.as_deref())
        .map_err(|error| format!("{error:#}"))?;
    Ok(installed)
}

#[cfg(test)]
mod tests {
    //! The install, approval, and build path over real repositories made in a
    //! temporary directory, with a build command that writes `dist/` itself.

    use super::*;

    struct Fixture {
        root: PathBuf,
        paths: AppPaths,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn fixture(label: &str) -> Fixture {
        // This machine's Git configuration must not change outcomes.
        static ISOLATE: std::sync::Once = std::sync::Once::new();
        ISOLATE.call_once(|| {
            std::env::set_var("GIT_CONFIG_GLOBAL", "/dev/null");
            std::env::set_var("GIT_CONFIG_NOSYSTEM", "1");
        });
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "epicenter-installed-apps-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let paths = DesktopPaths {
            data_dir: root.join("support"),
            folder_dir: root.join("Epicenter"),
            cache_dir: root.join("caches"),
        };
        Fixture {
            paths: AppPaths::new(&paths),
            root,
        }
    }

    /// `git` for the test's own repositories, with a fixed identity and none
    /// of this machine's configuration.
    fn sh_git(dir: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_AUTHOR_NAME", "Test")
            .env("GIT_AUTHOR_EMAIL", "test@localhost")
            .env("GIT_COMMITTER_NAME", "Test")
            .env("GIT_COMMITTER_EMAIL", "test@localhost")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    const BUILD: &str = "mkdir -p dist && cp page.html dist/index.html";

    /// An app repository at `upstream/<name>`: a manifest, its shape, and a
    /// page its build copies into `dist/`.
    fn app_repository(fixture: &Fixture, name: &str, manifest: &str) -> PathBuf {
        let repo = fixture.root.join("upstream").join(name);
        fs::create_dir_all(&repo).unwrap();
        sh_git(&repo, &["init", "-q", "-b", "main"]);
        fs::write(repo.join(MANIFEST), manifest).unwrap();
        fs::write(repo.join("shape.json"), r#"{ "kv": {}, "tables": {} }"#).unwrap();
        fs::write(repo.join("page.html"), "<!doctype html><title>one</title>").unwrap();
        fs::write(repo.join(".gitignore"), "dist/\n").unwrap();
        sh_git(&repo, &["add", "-A"]);
        sh_git(&repo, &["commit", "-q", "-m", "first"]);
        repo
    }

    fn board_manifest() -> String {
        format!(
            r#"{{ "id": "com.example.board", "title": "Board", "opens": "shape.json", "build": "{BUILD}" }}"#
        )
    }

    fn commit_page(repo: &Path, text: &str, message: &str) -> String {
        fs::write(repo.join("page.html"), text).unwrap();
        sh_git(repo, &["commit", "-q", "-am", message]);
        sh_git(repo, &["rev-parse", "HEAD"])
    }

    fn served_page(fixture: &Fixture, id: &str) -> String {
        let builds = fixture.paths.builds(id);
        let commit = current_build(&builds).expect("a current build");
        fs::read_to_string(builds.join(commit).join("index.html")).unwrap()
    }

    #[test]
    fn manifests_are_checked_before_anything_is_installed() {
        let parsed = parse_manifest(
            r#"{ "id": "com.example.board", "title": "Board", "opens": "shape.json" }"#,
        )
        .unwrap();
        assert_eq!(parsed.build, "bun run build");
        assert_eq!(parsed.output, "dist");

        for (manifest, expected) in [
            (
                r#"{ "id": "Board", "title": "Board", "opens": "s.json" }"#,
                "reverse-domain",
            ),
            (
                r#"{ "id": "board", "title": "Board", "opens": "s.json" }"#,
                "reverse-domain",
            ),
            (
                r#"{ "id": "com..board", "title": "Board", "opens": "s.json" }"#,
                "reverse-domain",
            ),
            (
                r#"{ "id": "so.epicenter.todos", "title": "Todos", "opens": "s.json" }"#,
                "built into",
            ),
            (
                r#"{ "id": "so.epicenter", "title": "Epicenter", "opens": "s.json" }"#,
                "built into",
            ),
            (
                r#"{ "id": "so.epicenter.folders", "title": "F", "opens": "s.json" }"#,
                "built into",
            ),
            (
                r#"{ "id": "com.example.board", "title": " ", "opens": "s.json" }"#,
                "title",
            ),
            (
                r#"{ "id": "com.example.board", "title": "B", "opens": "../s.json" }"#,
                "opens",
            ),
            (
                r#"{ "id": "com.example.board", "title": "B", "opens": "/s.json" }"#,
                "opens",
            ),
            (
                r#"{ "id": "com.example.board", "title": "B", "opens": "s.json", "output": ".git" }"#,
                "output",
            ),
            (
                r#"{ "id": "com.example.board", "title": "B", "opens": "s.json", "extra": 1 }"#,
                "not a valid",
            ),
            ("not json", "not a valid"),
        ] {
            let problem = parse_manifest(manifest).unwrap_err();
            assert!(problem.contains(expected), "{manifest}: {problem}");
        }
    }

    #[test]
    fn sources_are_urls_or_absolute_paths() {
        for source in [
            "https://github.com/example/board.git",
            "ssh://git@github.com/example/board.git",
            "git@github.com:example/board.git",
            "/Users/me/board",
        ] {
            assert_eq!(source_problem(source), None, "{source}");
        }
        for source in [
            "",
            "--upload-pack=touch /tmp/x",
            "ext::sh -c touch% /tmp/x",
            "fd::3",
            "board",
            "relative/board",
            "ftp://example.com/board",
        ] {
            assert!(source_problem(source).is_some(), "{source}");
        }
    }

    #[test]
    fn install_clones_and_waits_for_approval_then_approval_builds() {
        let fixture = fixture("install");
        let upstream = app_repository(&fixture, "board", &board_manifest());
        let first = sh_git(&upstream, &["rev-parse", "HEAD"]);

        let pending = install(&fixture.paths, upstream.to_str().unwrap()).unwrap();
        assert_eq!(pending.id, "com.example.board");
        assert_eq!(pending.title, "Board");
        assert_eq!(pending.source, upstream.to_str().unwrap());
        assert_eq!(pending.commit, first);
        assert_eq!(
            pending.opens.as_deref(),
            Some(r#"{ "kv": {}, "tables": {} }"#)
        );
        let AppState::NeedsApproval { review } = &pending.state else {
            panic!("a fresh install needs approval: {pending:?}");
        };
        assert_eq!(review.from, None);
        assert!(review.log.contains("first"), "{}", review.log);
        assert!(review.statement.contains("runs the app's code"));
        // Nothing ran: no approval, no build.
        assert!(!fixture.paths.approvals_file.exists());
        assert!(!fixture.paths.builds_dir.exists());
        assert!(fixture
            .paths
            .apps_dir
            .join("com.example.board/.git")
            .is_dir());
        // The staging clone is gone.
        let names: Vec<_> = fs::read_dir(&fixture.paths.apps_dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, ["com.example.board"]);
        // Opening refuses until approved.
        assert!(prepare(&fixture.paths, "com.example.board")
            .unwrap_err()
            .contains("approve"));

        let ready = approve(&fixture.paths, "com.example.board", &first).unwrap();
        assert_eq!(ready.state, AppState::Ready);
        let approvals = read_approvals(&fixture.paths.approvals_file);
        assert_eq!(approvals["com.example.board"].commit, first);
        assert_eq!(
            served_page(&fixture, "com.example.board"),
            "<!doctype html><title>one</title>"
        );
        assert!(fixture
            .paths
            .builds("com.example.board")
            .join(format!("{first}.log"))
            .is_file());
    }

    #[test]
    fn approval_names_the_commit_it_was_shown() {
        let fixture = fixture("stale");
        let upstream = app_repository(&fixture, "board", &board_manifest());
        let pending = install(&fixture.paths, upstream.to_str().unwrap()).unwrap();
        let other = "0".repeat(40);
        assert!(approve(&fixture.paths, &pending.id, &other)
            .unwrap_err()
            .contains("Review it again"));
        assert!(!fixture.paths.approvals_file.exists());
    }

    #[test]
    fn a_commit_made_here_runs_without_asking_and_is_recorded() {
        let fixture = fixture("local");
        let upstream = app_repository(&fixture, "board", &board_manifest());
        let first = sh_git(&upstream, &["rev-parse", "HEAD"]);
        install(&fixture.paths, upstream.to_str().unwrap()).unwrap();
        approve(&fixture.paths, "com.example.board", &first).unwrap();

        let clone = fixture.paths.apps_dir.join("com.example.board");
        let local = commit_page(&clone, "<!doctype html><title>mine</title>", "mine");
        assert_eq!(
            inspect(&fixture.paths, "com.example.board").state,
            AppState::Unbuilt
        );

        let ready = prepare(&fixture.paths, "com.example.board").unwrap();
        assert_eq!(ready.state, AppState::Ready);
        assert_eq!(ready.commit, local);
        assert_eq!(
            served_page(&fixture, "com.example.board"),
            "<!doctype html><title>mine</title>"
        );
        assert_eq!(
            read_approvals(&fixture.paths.approvals_file)["com.example.board"].commit,
            local
        );
    }

    #[test]
    fn a_fetched_commit_needs_approval_with_its_log_and_diff() {
        let fixture = fixture("fetched");
        let upstream = app_repository(&fixture, "board", &board_manifest());
        let first = sh_git(&upstream, &["rev-parse", "HEAD"]);
        install(&fixture.paths, upstream.to_str().unwrap()).unwrap();
        approve(&fixture.paths, "com.example.board", &first).unwrap();

        let theirs = commit_page(&upstream, "<!doctype html><title>theirs</title>", "theirs");
        let updated = update(&fixture.paths, "com.example.board").unwrap();
        assert_eq!(updated.commit, theirs);
        let AppState::NeedsApproval { review } = &updated.state else {
            panic!("a fetched commit needs approval: {updated:?}");
        };
        assert_eq!(review.from.as_deref(), Some(first.as_str()));
        assert!(review.log.contains("theirs"), "{}", review.log);
        assert!(
            review.diff_stat.contains("page.html"),
            "{}",
            review.diff_stat
        );
        // The approved build still serves until the update is approved.
        assert_eq!(
            served_page(&fixture, "com.example.board"),
            "<!doctype html><title>one</title>"
        );
        assert!(prepare(&fixture.paths, "com.example.board").is_err());

        approve(&fixture.paths, "com.example.board", &theirs).unwrap();
        assert_eq!(
            served_page(&fixture, "com.example.board"),
            "<!doctype html><title>theirs</title>"
        );
    }

    #[test]
    fn a_pull_merged_by_hand_still_needs_approval() {
        let fixture = fixture("merged");
        let upstream = app_repository(&fixture, "board", &board_manifest());
        let first = sh_git(&upstream, &["rev-parse", "HEAD"]);
        install(&fixture.paths, upstream.to_str().unwrap()).unwrap();
        approve(&fixture.paths, "com.example.board", &first).unwrap();

        commit_page(&upstream, "<!doctype html><title>theirs</title>", "theirs");
        let clone = fixture.paths.apps_dir.join("com.example.board");
        fs::write(clone.join("notes.txt"), "mine").unwrap();
        sh_git(&clone, &["add", "notes.txt"]);
        sh_git(&clone, &["commit", "-q", "-m", "mine"]);
        // A merge made here brings in a commit that was fetched.
        sh_git(
            &clone,
            &["pull", "-q", "--no-rebase", "--no-edit", "origin", "main"],
        );
        assert!(matches!(
            inspect(&fixture.paths, "com.example.board").state,
            AppState::NeedsApproval { .. }
        ));
    }

    #[test]
    fn update_rebases_commits_made_here_and_stops_on_a_conflict() {
        let fixture = fixture("rebase");
        let upstream = app_repository(&fixture, "board", &board_manifest());
        let first = sh_git(&upstream, &["rev-parse", "HEAD"]);
        install(&fixture.paths, upstream.to_str().unwrap()).unwrap();
        approve(&fixture.paths, "com.example.board", &first).unwrap();
        let clone = fixture.paths.apps_dir.join("com.example.board");
        sh_git(&clone, &["config", "user.name", "Test"]);
        sh_git(&clone, &["config", "user.email", "test@localhost"]);

        // Unrelated commits on each side rebase cleanly.
        fs::write(clone.join("notes.txt"), "mine").unwrap();
        sh_git(&clone, &["add", "notes.txt"]);
        sh_git(&clone, &["commit", "-q", "-m", "mine"]);
        commit_page(&upstream, "<!doctype html><title>theirs</title>", "theirs");
        let updated = update(&fixture.paths, "com.example.board").unwrap();
        assert!(matches!(updated.state, AppState::NeedsApproval { .. }));
        assert!(clone.join("notes.txt").is_file());
        assert_eq!(
            fs::read_to_string(clone.join("page.html")).unwrap(),
            "<!doctype html><title>theirs</title>"
        );

        // The same line changed on each side stops, and nothing changes.
        let before = commit_page(&clone, "<!doctype html><title>mine</title>", "mine again");
        commit_page(
            &upstream,
            "<!doctype html><title>conflict</title>",
            "conflict",
        );
        let problem = update(&fixture.paths, "com.example.board").unwrap_err();
        assert!(problem.contains("conflict"), "{problem}");
        assert_eq!(sh_git(&clone, &["rev-parse", "HEAD"]), before);
        assert!(!clone.join(".git/rebase-merge").exists());
    }

    #[test]
    fn an_invalid_manifest_is_refused_and_nothing_is_kept() {
        let fixture = fixture("invalid");
        let upstream = app_repository(
            &fixture,
            "board",
            r#"{ "id": "board", "title": "Board", "opens": "shape.json" }"#,
        );
        let problem = install(&fixture.paths, upstream.to_str().unwrap()).unwrap_err();
        assert!(problem.contains("reverse-domain"), "{problem}");
        assert_eq!(fs::read_dir(&fixture.paths.apps_dir).unwrap().count(), 0);
    }

    #[test]
    fn a_built_in_id_and_a_second_install_are_refused() {
        let fixture = fixture("collision");
        let todos = app_repository(
            &fixture,
            "todos",
            r#"{ "id": "so.epicenter.todos", "title": "Todos", "opens": "shape.json" }"#,
        );
        assert!(install(&fixture.paths, todos.to_str().unwrap())
            .unwrap_err()
            .contains("built into Epicenter"));

        let board = app_repository(&fixture, "board", &board_manifest());
        install(&fixture.paths, board.to_str().unwrap()).unwrap();
        assert!(install(&fixture.paths, board.to_str().unwrap())
            .unwrap_err()
            .contains("already installed"));
        assert_eq!(fs::read_dir(&fixture.paths.apps_dir).unwrap().count(), 1);
    }

    #[test]
    fn a_failed_build_keeps_the_approval_and_serves_nothing_new() {
        let fixture = fixture("failed");
        let upstream = app_repository(
            &fixture,
            "board",
            r#"{ "id": "com.example.board", "title": "Board", "opens": "shape.json", "build": "echo broken >&2; exit 3" }"#,
        );
        let pending = install(&fixture.paths, upstream.to_str().unwrap()).unwrap();
        let problem = approve(&fixture.paths, &pending.id, &pending.commit).unwrap_err();
        assert!(problem.contains("did not build"), "{problem}");
        assert!(read_approvals(&fixture.paths.approvals_file).contains_key(&pending.id));
        assert_eq!(current_build(&fixture.paths.builds(&pending.id)), None);
        let log = fs::read_to_string(
            fixture
                .paths
                .builds(&pending.id)
                .join(format!("{}.log", pending.commit)),
        )
        .unwrap();
        assert!(log.contains("broken"), "{log}");
        assert_eq!(
            inspect(&fixture.paths, &pending.id).state,
            AppState::Unbuilt
        );
    }

    #[test]
    fn uncommitted_changes_do_not_build() {
        let fixture = fixture("dirty");
        let upstream = app_repository(&fixture, "board", &board_manifest());
        let pending = install(&fixture.paths, upstream.to_str().unwrap()).unwrap();
        let clone = fixture.paths.apps_dir.join(&pending.id);
        fs::write(clone.join("page.html"), "edited").unwrap();
        assert!(approve(&fixture.paths, &pending.id, &pending.commit)
            .unwrap_err()
            .contains("not committed"));
        assert!(!fixture.paths.approvals_file.exists());
    }

    #[test]
    fn listing_reads_every_installed_app_and_reports_a_broken_one() {
        let fixture = fixture("list");
        assert_eq!(list(&fixture.paths).unwrap(), []);
        let upstream = app_repository(&fixture, "board", &board_manifest());
        install(&fixture.paths, upstream.to_str().unwrap()).unwrap();
        fs::create_dir_all(fixture.paths.apps_dir.join("com.example.empty")).unwrap();
        fs::create_dir_all(fixture.paths.apps_dir.join(".installing-left")).unwrap();

        let listed = list(&fixture.paths).unwrap();
        let ids: Vec<&str> = listed.iter().map(|app| app.id.as_str()).collect();
        assert_eq!(ids, ["com.example.board", "com.example.empty"]);
        assert!(matches!(listed[1].state, AppState::Broken { .. }));
    }

    #[test]
    fn approvals_are_kept_per_app_and_a_damaged_file_approves_nothing() {
        let fixture = fixture("approvals");
        let file = &fixture.paths.approvals_file;
        record_approval(file, "com.example.a", "a").unwrap();
        record_approval(file, "com.example.b", "b").unwrap();
        let approvals = read_approvals(file);
        assert_eq!(approvals.len(), 2);
        assert_eq!(approvals["com.example.a"].commit, "a");
        let text = fs::read_to_string(file).unwrap();
        assert!(text.contains("approvedAt"), "{text}");
        fs::write(file, "{ not json").unwrap();
        assert!(read_approvals(file).is_empty());
    }

    #[test]
    fn git_here_runs_no_hook() {
        let fixture = fixture("hooks");
        let upstream = app_repository(&fixture, "board", &board_manifest());
        let pending = install(&fixture.paths, upstream.to_str().unwrap()).unwrap();
        let clone = fixture.paths.apps_dir.join(&pending.id);
        let hooks = clone.join(".git/hooks");
        fs::create_dir_all(&hooks).unwrap();
        let marker = fixture.root.join("hook-ran");
        let hook = hooks.join("post-merge");
        fs::write(&hook, format!("#!/bin/sh\ntouch '{}'\n", marker.display())).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        }
        commit_page(&upstream, "<!doctype html><title>theirs</title>", "theirs");
        update(&fixture.paths, &pending.id).unwrap();
        assert!(!marker.exists(), "a hook ran");
    }
}
