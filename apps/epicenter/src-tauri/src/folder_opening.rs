//! Opening a directory another app names (ADR-0646).
//!
//! A standalone app's **Open in Epicenter** asks the operating system to open
//! `epicenter://open?path=<percent-encoded absolute directory>`. Receiving
//! that link, on a cold start, from a running Epicenter, or forwarded by a
//! second launch, only queues the path (`receive`) and shows the Folders
//! window. Nothing reads the directory, registers it, grants it, or
//! remembers it until the person accepts the request there
//! (`accept_folder_opening`).
//!
//! Accepting admits the directory only while it exists as a real directory:
//! it is registered as a data folder (`FolderConfig::data`, never created)
//! under a scope of its own, `opened:<n>`, for the Folders window alone. No
//! bundled app's window is permitted into it, and `open_bundled_app` finds no
//! listed name for it. A directory that is, holds, or lies inside Epicenter's
//! own folder or Epicenter's app data is refused, whichever spelling or link
//! leads there. One resolved directory has one scope for the whole run,
//! however often it is accepted or listed.
//!
//! The accepted path is then remembered in `folders.json`
//! (`remembered_folders`). A failed write is reported beside the opening and
//! does not undo it. `list_remembered_folders` lists the remembered paths and
//! those accepted this run, admitting each that is still there by the same
//! rule; one that is not is listed with its problem and can be forgotten.

use std::collections::BTreeMap;
use std::fs;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use percent_encoding::percent_decode_str;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_epicenter_folder::{FolderConfig, FolderExt, Folders, ScopeConfig};

use crate::app_data::DesktopPaths;
use crate::data_folders::EPICENTER_FOLDER;
use crate::remembered_folders;
use crate::{BuiltInApp, DesktopAppHandle};

/// The event the Folders window hears when the pending requests changed. It
/// carries nothing: the window asks `pending_folder_openings` again.
/// `FOLDER_OPENINGS_CHANGED` in `src/folders/openings.svelte.ts` names it too.
pub const FOLDER_OPENINGS_CHANGED: &str = "epicenter://folder-openings-changed";

/// The scope of a directory admitted by path starts with this.
const SCOPE_PREFIX: &str = "opened:";

/// The directory `epicenter://open?path=<directory>` names, or `None` for any
/// other link.
///
/// The grammar is strict so that one link has one reading. The host is
/// exactly `open`, with no path, user, port, or fragment. The query is one
/// `path=` pair: no `&`, `;`, `=`, or `+` (a space must be `%20`), and every
/// `%` starts a valid escape. The decoded path is UTF-8 with no control
/// character, absolute, and spelled plainly: no `.` or `..` segment, no
/// doubled or trailing separator.
pub fn parse_open_link(url: &tauri::Url) -> Option<String> {
    if url.scheme() != "epicenter"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
        || url.host_str() != Some("open")
        || !url.path().is_empty()
    {
        return None;
    }
    let encoded = url.query()?.strip_prefix("path=")?;
    if encoded.is_empty() || encoded.contains(['&', ';', '=', '+']) || !escapes_are_valid(encoded) {
        return None;
    }
    let directory = percent_decode_str(encoded).decode_utf8().ok()?;
    is_plain_absolute_path(&directory).then(|| directory.into_owned())
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
pub(crate) fn is_plain_absolute_path(path: &str) -> bool {
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

/// The opening requests waiting for the person, and the directories this run
/// admitted.
#[derive(Default)]
pub struct FolderOpenings(Mutex<Openings>);

#[derive(Default)]
struct Openings {
    /// Requested and not yet accepted or dismissed, oldest first, each once.
    pending: Vec<String>,
    /// The scope of each resolved directory this run admitted.
    scopes: BTreeMap<PathBuf, String>,
    /// Accepted this run, in order, whether or not remembering succeeded.
    accepted: Vec<String>,
}

impl FolderOpenings {
    fn lock(&self) -> MutexGuard<'_, Openings> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Hold `directory` for the person to accept. Answers whether it was not
    /// already waiting.
    fn queue(&self, directory: String) -> bool {
        let mut openings = self.lock();
        if openings.pending.contains(&directory) {
            return false;
        }
        openings.pending.push(directory);
        true
    }

    fn pending(&self) -> Vec<String> {
        self.lock().pending.clone()
    }

    /// Let go of the request for `directory`. Answers whether one waited.
    fn take(&self, directory: &str) -> bool {
        let mut openings = self.lock();
        let before = openings.pending.len();
        openings.pending.retain(|pending| pending != directory);
        openings.pending.len() != before
    }

    fn mark_accepted(&self, directory: &str) {
        let mut openings = self.lock();
        if !openings
            .accepted
            .iter()
            .any(|accepted| accepted == directory)
        {
            openings.accepted.push(directory.to_string());
        }
    }

    fn accepted(&self) -> Vec<String> {
        self.lock().accepted.clone()
    }

    fn forget(&self, directory: &str) {
        self.lock()
            .accepted
            .retain(|accepted| accepted != directory);
    }
}

/// Hold `directory`, from an opening link, for the person to accept in the
/// Folders window, and nudge that window. Reads, registers, and remembers
/// nothing. The caller shows the Folders window.
pub fn receive<R: Runtime>(app: &AppHandle<R>, directory: String) {
    if app.state::<FolderOpenings>().queue(directory) {
        let _ = app.emit_to(BuiltInApp::Folders.id(), FOLDER_OPENINGS_CHANGED, ());
    }
}

/// Where a path from a link may not lead: Epicenter's own folder and its app
/// data, each resolved as the disk resolves it.
fn protected(paths: &DesktopPaths) -> [PathBuf; 2] {
    [
        resolved(&paths.folder_dir.join(EPICENTER_FOLDER)),
        resolved(&paths.data_dir),
    ]
}

/// `path` with every link resolved, or its parent's resolved when it does not
/// exist yet, or as written when neither does.
fn resolved(path: &Path) -> PathBuf {
    if let Ok(canonical) = fs::canonicalize(path) {
        return canonical;
    }
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => fs::canonicalize(parent)
            .map(|parent| parent.join(name))
            .unwrap_or_else(|_| path.to_path_buf()),
        _ => path.to_path_buf(),
    }
}

/// Compare containment even when the OS exposes one directory through two
/// absolute paths that canonicalization does not merge (for example a macOS
/// firmlink). A missing protected leaf still has the lexical fallback above.
fn overlaps(candidate: &Path, protected: &Path) -> bool {
    candidate.starts_with(protected)
        || protected.starts_with(candidate)
        || candidate
            .ancestors()
            .any(|ancestor| same_file::is_same_file(ancestor, protected).unwrap_or(false))
        || protected
            .ancestors()
            .any(|ancestor| same_file::is_same_file(ancestor, candidate).unwrap_or(false))
}

/// Let the Folders window open the existing directory `directory`, as a data
/// folder the shell never creates, under its scope for this run. Answers the
/// scope, the same one for each resolved directory.
fn admit(
    folders: &Folders,
    openings: &FolderOpenings,
    paths: &DesktopPaths,
    directory: &str,
) -> Result<String, String> {
    if !is_plain_absolute_path(directory) {
        return Err("This is not a plainly spelled absolute folder path.".to_string());
    }
    let path = Path::new(directory);
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return Err("This folder is not there.".to_string())
        }
        Err(error) => return Err(format!("This folder could not be checked: {error}")),
        Ok(stats) if stats.file_type().is_symlink() => {
            return Err("This path is a link. Open the folder it leads to instead.".to_string())
        }
        Ok(stats) if !stats.is_dir() => return Err("This path is not a folder.".to_string()),
        Ok(_) => {}
    }
    let canonical = fs::canonicalize(path)
        .map_err(|error| format!("This folder could not be checked: {error}"))?;
    if protected(paths)
        .iter()
        .any(|kept| overlaps(&canonical, kept))
    {
        return Err(
            "This folder holds Epicenter's own files, so Epicenter does not open it here."
                .to_string(),
        );
    }
    // Held across registration, so two admissions at once register once.
    let mut openings = openings.lock();
    if let Some(scope) = openings.scopes.get(&canonical) {
        return Ok(scope.clone());
    }
    let scope = format!("{SCOPE_PREFIX}{}", openings.scopes.len() + 1);
    folders.register(ScopeConfig {
        scope: scope.clone(),
        folder: FolderConfig::data(&canonical),
        windows: vec![BuiltInApp::Folders.id().into()],
    })?;
    openings.scopes.insert(canonical, scope.clone());
    Ok(scope)
}

/// An accepted opening: the scope the Folders window opens it by, and why
/// Epicenter could not remember it, when it could not.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AcceptedOpening {
    /// The scope to pass as `directory` to `openFolder`.
    pub id: String,
    /// Why `folders.json` was not updated; the folder is open regardless.
    pub remember_problem: Option<String>,
}

/// One remembered folder, or one accepted this run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RememberedFolder {
    /// The absolute path as stored, which `forget_remembered_folder` matches.
    pub path: String,
    /// The scope to pass as `directory` to `openFolder`, while it can open.
    pub id: Option<String>,
    /// Whether `folders.json` holds it; `false` when remembering it failed.
    pub remembered: bool,
    /// Why it cannot open now, such as a folder that is not there.
    pub problem: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RememberedFolders {
    pub folders: Vec<RememberedFolder>,
    /// Why `folders.json` could not be read; it is left as it is.
    pub problem: Option<String>,
}

fn accept(
    folders: &Folders,
    openings: &FolderOpenings,
    paths: &DesktopPaths,
    directory: &str,
) -> Result<AcceptedOpening, String> {
    if !openings.take(directory) {
        return Err("No app asked Epicenter to open this folder.".to_string());
    }
    let id = admit(folders, openings, paths, directory)?;
    openings.mark_accepted(directory);
    let remember_problem = remembered_folders::add(&paths.data_dir, directory).err();
    if let Some(problem) = &remember_problem {
        log::warn!("an opened folder was not remembered: {problem}");
    }
    Ok(AcceptedOpening {
        id,
        remember_problem,
    })
}

fn remembered(
    folders: &Folders,
    openings: &FolderOpenings,
    paths: &DesktopPaths,
) -> RememberedFolders {
    let (stored, problem) = match remembered_folders::read(&paths.data_dir) {
        Ok(stored) => (stored, None),
        Err(problem) => (Vec::new(), Some(problem)),
    };
    let mut listed: Vec<(String, bool)> = Vec::new();
    let candidates = stored
        .into_iter()
        .map(|path| (path, true))
        .chain(openings.accepted().into_iter().map(|path| (path, false)));
    for (path, remembered) in candidates {
        if !listed.iter().any(|(seen, _)| *seen == path) {
            listed.push((path, remembered));
        }
    }
    let entries = listed
        .into_iter()
        .map(|(path, remembered)| {
            let (id, problem) = match admit(folders, openings, paths, &path) {
                Ok(id) => (Some(id), None),
                Err(problem) => (None, Some(problem)),
            };
            RememberedFolder {
                path,
                id,
                remembered,
                problem,
            }
        })
        .collect();
    RememberedFolders {
        folders: entries,
        problem,
    }
}

/// The directories apps asked Epicenter to open that the person has not
/// accepted or dismissed, oldest first. Reads none of them.
#[tauri::command]
#[specta::specta]
pub fn pending_folder_openings(app: DesktopAppHandle) -> Vec<String> {
    app.state::<FolderOpenings>().pending()
}

/// Open the directory `path` an app asked for, now that the person accepted:
/// only then is it checked, granted to the Folders window, and remembered.
/// Granted to the Folders window alone. Off the main thread, since it reads
/// the disk.
#[tauri::command(async)]
#[specta::specta]
pub fn accept_folder_opening(
    app: DesktopAppHandle,
    path: String,
) -> Result<AcceptedOpening, String> {
    let accepted = accept(
        app.folders(),
        &app.state::<FolderOpenings>(),
        &app.state::<DesktopPaths>(),
        &path,
    );
    let _ = app.emit_to(BuiltInApp::Folders.id(), FOLDER_OPENINGS_CHANGED, ());
    accepted
}

/// Let go of an app's request to open `path` without reading it.
#[tauri::command]
#[specta::specta]
pub fn dismiss_folder_opening(app: DesktopAppHandle, path: String) {
    if app.state::<FolderOpenings>().take(&path) {
        let _ = app.emit_to(BuiltInApp::Folders.id(), FOLDER_OPENINGS_CHANGED, ());
    }
}

/// The folders `folders.json` remembers and those accepted this run, each
/// with the scope it opens by while it is there. Off the main thread, since
/// it reads the disk.
#[tauri::command(async)]
#[specta::specta]
pub fn list_remembered_folders(app: DesktopAppHandle) -> RememberedFolders {
    remembered(
        app.folders(),
        &app.state::<FolderOpenings>(),
        &app.state::<DesktopPaths>(),
    )
}

/// Forget the remembered path `path`, exactly as listed, whether or not it is
/// there. Deletes no files. A folder open now stays open.
#[tauri::command(async)]
#[specta::specta]
pub fn forget_remembered_folder(app: DesktopAppHandle, path: String) -> Result<(), String> {
    remembered_folders::forget(&app.state::<DesktopPaths>().data_dir, &path)?;
    app.state::<FolderOpenings>().forget(&path);
    Ok(())
}

#[cfg(test)]
mod tests {
    //! Receiving, accepting, and listing over real directories, and the
    //! folder plugin's grant through Tauri's real invoke path on the mock
    //! runtime.

    use serde_json::{json, Value};
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY};
    use tauri::utils::acl::ExecutionContext;
    use tauri::webview::InvokeRequest;
    use tauri::{App, WebviewWindow, WebviewWindowBuilder};

    use super::*;
    use crate::bundled_apps::BundledApp;

    /// One run of Epicenter: its app and the run's state.
    struct Run(App<MockRuntime>);

    impl Drop for Run {
        fn drop(&mut self) {
            self.0.folders().shutdown();
        }
    }

    struct Fixture {
        run: Run,
        paths: DesktopPaths,
        /// A directory outside the Epicenter folder root, as a standalone app
        /// keeps its own.
        elsewhere: PathBuf,
        temp: PathBuf,
        _temporary: tempfile::TempDir,
    }

    impl Fixture {
        fn app(&self) -> &App<MockRuntime> {
            &self.run.0
        }

        fn openings(&self) -> tauri::State<'_, FolderOpenings> {
            self.app().state::<FolderOpenings>()
        }

        /// Grant `scope` to the window `label` through the plugin's command.
        fn grant(&self, label: &str, scope: &str) -> Result<Value, Value> {
            invoke(
                &self.window(label),
                "grant_directory",
                json!({ "scope": scope }),
            )
        }

        /// The same machine, launched again: a new app and its state over
        /// the same directories.
        fn restart(self) -> Self {
            let Self {
                run,
                paths,
                elsewhere,
                temp,
                _temporary,
            } = self;
            drop(run);
            Self {
                run: Run(mock_app()),
                paths,
                elsewhere,
                temp,
                _temporary,
            }
        }

        fn receive(&self, directory: &Path) {
            receive(self.app().handle(), directory.to_str().unwrap().to_string());
        }

        fn accept(&self, directory: &Path) -> Result<AcceptedOpening, String> {
            accept(
                self.app().folders(),
                &self.openings(),
                &self.paths,
                directory.to_str().unwrap(),
            )
        }

        fn remembered(&self) -> RememberedFolders {
            remembered(self.app().folders(), &self.openings(), &self.paths)
        }

        /// The window `label`, made the first time it is asked for.
        fn window(&self, label: &str) -> WebviewWindow<MockRuntime> {
            self.app().get_webview_window(label).unwrap_or_else(|| {
                WebviewWindowBuilder::new(self.app(), label, Default::default())
                    .build()
                    .expect("mock window")
            })
        }
    }

    /// An Epicenter run over a fresh temporary home: its folder root, its app
    /// data, and an app's directory elsewhere with one file in it.
    fn fixture() -> Fixture {
        let temporary = tempfile::tempdir().unwrap();
        let temp = fs::canonicalize(temporary.path()).unwrap();
        let paths = DesktopPaths {
            data_dir: temp.join("Application Support/so.epicenter"),
            folder_dir: temp.join("Epicenter"),
        };
        fs::create_dir_all(paths.folder_dir.join(EPICENTER_FOLDER)).unwrap();
        fs::create_dir_all(&paths.data_dir).unwrap();
        let elsewhere = temp.join("Application Support/so.epicenter.todos");
        fs::create_dir_all(elsewhere.join("todos")).unwrap();
        fs::write(elsewhere.join("todos/milk.md"), "---\ntitle: Milk\n---\n").unwrap();
        Fixture {
            run: Run(mock_app()),
            paths,
            elsewhere,
            temp,
            _temporary: temporary,
        }
    }

    fn mock_app() -> App<MockRuntime> {
        let mut context = mock_context(noop_assets());
        for command in tauri_plugin_epicenter_folder::COMMANDS {
            context.runtime_authority_mut().__allow_command(
                format!("plugin:epicenter-folder|{command}"),
                ExecutionContext::Local,
            );
        }
        let app = mock_builder()
            .plugin(tauri_plugin_epicenter_folder::init())
            .build(context)
            .expect("mock app");
        app.manage(FolderOpenings::default());
        app
    }

    fn invoke(
        window: &WebviewWindow<MockRuntime>,
        command: &str,
        args: Value,
    ) -> Result<Value, Value> {
        tauri::test::get_ipc_response(
            window,
            InvokeRequest {
                cmd: format!("plugin:epicenter-folder|{command}"),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: "tauri://localhost".parse().unwrap(),
                body: InvokeBody::Json(args),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .map(|body| body.deserialize::<Value>().expect("a JSON response"))
    }

    fn link(text: &str) -> Option<String> {
        parse_open_link(&text.parse().unwrap())
    }

    #[test]
    fn an_opening_link_names_one_plainly_spelled_absolute_directory() {
        for (url, expected) in [
            (
                "epicenter://open?path=%2FUsers%2Fme%2FLibrary%2FApplication%20Support%2Fso.epicenter.todos",
                "/Users/me/Library/Application Support/so.epicenter.todos",
            ),
            // A separator need not be escaped in a query.
            ("epicenter://open?path=/Users/me/Notes", "/Users/me/Notes"),
            ("epicenter://open?path=%2FUsers%2Fme%2Fa%2Bb%26c", "/Users/me/a+b&c"),
            ("epicenter://open?path=%2FUsers%2Fme%2Fnot%C3%A9s", "/Users/me/notés"),
            ("epicenter://open?path=%2F", "/"),
        ] {
            assert_eq!(link(url).as_deref(), Some(expected), "{url}");
        }
    }

    #[test]
    fn malformed_relative_and_ambiguous_opening_links_are_refused() {
        for url in [
            "epicenter://open",
            "epicenter://open?",
            "epicenter://open?path=",
            "epicenter://open?path=relative%2Fnotes",
            "epicenter://open?path=~%2Fnotes",
            "epicenter://open?path=%2Fa%2F..%2Fb",
            "epicenter://open?path=%2Fa%2F.%2Fb",
            "epicenter://open?path=%2Fa%2F%2Fb",
            "epicenter://open?path=%2Fa%2Fb%2F",
            "epicenter://open?path=%2Fa%00b",
            "epicenter://open?path=%2Fa%0Ab",
            "epicenter://open?path=%2Fa%ZZ",
            "epicenter://open?path=%2Fa%2",
            "epicenter://open?path=%2Fa%FF",
            "epicenter://open?path=/a+b",
            "epicenter://open?path=%2Fa&path=%2Fb",
            "epicenter://open?path=%2Fa&app=todos",
            "epicenter://open?path=%2Fa;b",
            "epicenter://open?path=%2Fa=b",
            "epicenter://open?app=todos&path=%2Fa",
            "epicenter://open?PATH=%2Fa",
            "epicenter://open?p%61th=%2Fa",
            "epicenter://open?path=%2Fa#b",
            "epicenter://open/?path=%2Fa",
            "epicenter://open/x?path=%2Fa",
            "epicenter://OPEN?path=%2Fa",
            "epicenter://user@open?path=%2Fa",
            "epicenter://open:1?path=%2Fa",
            "epicenter:open?path=%2Fa",
            "epicenter:///open?path=%2Fa",
            "epicenter://app/folders?path=%2Fa",
            "https://open?path=%2Fa",
        ] {
            assert_eq!(link(url), None, "{url}");
        }
    }

    #[test]
    fn receiving_a_request_reads_grants_and_remembers_nothing() {
        let fixture = fixture();
        let missing = fixture.temp.join("not/there");
        fixture.receive(&fixture.elsewhere);
        fixture.receive(&missing);
        // The same request again waits once.
        fixture.receive(&fixture.elsewhere);

        assert_eq!(
            fixture.openings().pending(),
            [
                fixture.elsewhere.to_str().unwrap(),
                missing.to_str().unwrap()
            ]
        );
        assert!(!missing.exists());
        assert!(!remembered_folders::file(&fixture.paths.data_dir).exists());
        let refused = fixture.grant("folders", "opened:1").unwrap_err();
        assert_eq!(refused["name"], "UnknownScope");
    }

    #[test]
    fn an_accepted_directory_outside_the_root_opens_in_the_folders_window_alone() {
        let fixture = fixture();
        fixture.receive(&fixture.elsewhere);
        let accepted = fixture.accept(&fixture.elsewhere).unwrap();
        assert_eq!(
            accepted,
            AcceptedOpening {
                id: "opened:1".into(),
                remember_problem: None,
            }
        );
        assert!(fixture.openings().pending().is_empty());

        let folders = fixture.window(BuiltInApp::Folders.id());
        let granted = invoke(&folders, "grant_directory", json!({ "scope": "opened:1" })).unwrap();
        assert_eq!(
            granted,
            json!({ "root": fixture.elsewhere.to_str().unwrap() })
        );
        let children = invoke(
            &folders,
            "read_folder_children",
            json!({ "scope": "opened:1", "directory": "todos" }),
        )
        .unwrap();
        assert_eq!(children, json!({ "files": ["milk.md"], "directories": [] }));

        // No bundled app's window, Settings, or any other window is let in.
        let mut others: Vec<String> = BundledApp::ALL
            .iter()
            .map(|app| app.window_label(app.name()))
            .collect();
        others.extend(["home".to_string(), "todos".to_string()]);
        for label in others {
            let refused = fixture.grant(&label, "opened:1").unwrap_err();
            assert_eq!(refused["name"], "WindowNotPermitted", "{label}");
        }

        assert_eq!(
            remembered_folders::read(&fixture.paths.data_dir).unwrap(),
            [fixture.elsewhere.to_str().unwrap()]
        );
    }

    #[test]
    fn a_request_is_accepted_once_and_only_when_it_was_made() {
        let fixture = fixture();
        assert_eq!(
            fixture.accept(&fixture.elsewhere).unwrap_err(),
            "No app asked Epicenter to open this folder."
        );
        assert_eq!(
            fixture.grant("folders", "opened:1").unwrap_err()["name"],
            "UnknownScope"
        );

        fixture.receive(&fixture.elsewhere);
        fixture.accept(&fixture.elsewhere).unwrap();
        assert!(fixture.accept(&fixture.elsewhere).is_err());
    }

    #[test]
    fn a_dismissed_request_reads_and_remembers_nothing() {
        let fixture = fixture();
        fixture.receive(&fixture.elsewhere);
        assert!(fixture.openings().take(fixture.elsewhere.to_str().unwrap()));
        assert!(fixture.openings().pending().is_empty());
        assert!(fixture.accept(&fixture.elsewhere).is_err());
        assert!(!remembered_folders::file(&fixture.paths.data_dir).exists());
    }

    #[test]
    fn a_missing_directory_is_refused_and_never_created() {
        let fixture = fixture();
        let missing = fixture.temp.join("Notes");
        fixture.receive(&missing);
        assert_eq!(
            fixture.accept(&missing).unwrap_err(),
            "This folder is not there."
        );
        assert!(!missing.exists());
        assert!(!remembered_folders::file(&fixture.paths.data_dir).exists());

        // One removed after it was accepted is refused, not recreated.
        fixture.receive(&fixture.elsewhere);
        let id = fixture.accept(&fixture.elsewhere).unwrap().id;
        fs::remove_dir_all(&fixture.elsewhere).unwrap();
        let refused = fixture.grant("folders", &id).unwrap_err();
        assert_eq!(refused["name"], "Missing");
        assert!(!fixture.elsewhere.exists());
    }

    #[test]
    fn a_file_or_a_link_is_not_admitted() {
        let fixture = fixture();
        let file = fixture.temp.join("notes.md");
        fs::write(&file, "").unwrap();
        fixture.receive(&file);
        assert_eq!(
            fixture.accept(&file).unwrap_err(),
            "This path is not a folder."
        );

        #[cfg(unix)]
        {
            let linked = fixture.temp.join("linked");
            std::os::unix::fs::symlink(&fixture.elsewhere, &linked).unwrap();
            fixture.receive(&linked);
            assert!(fixture.accept(&linked).unwrap_err().contains("link"));
        }
        assert_eq!(
            fixture.grant("folders", "opened:1").unwrap_err()["name"],
            "UnknownScope"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_parent_changing_after_acceptance_cannot_redirect_the_grant() {
        use std::os::unix::fs::symlink;

        let fixture = fixture();
        let alias = fixture.temp.join("alias-parent");
        symlink(fixture.elsewhere.parent().unwrap(), &alias).unwrap();
        let requested = alias.join("so.epicenter.todos");
        fixture.receive(&requested);
        let first = fixture.accept(&requested).unwrap();

        // The link now leads into Epicenter's protected app data before the
        // Folders window asks the plugin for its first grant.
        let protected_child = fixture.paths.data_dir.join("so.epicenter.todos");
        fs::create_dir(&protected_child).unwrap();
        fs::remove_file(&alias).unwrap();
        symlink(&fixture.paths.data_dir, &alias).unwrap();
        assert_eq!(fs::canonicalize(&requested).unwrap(), protected_child);
        assert_eq!(
            fixture.grant("folders", &first.id).unwrap()["root"],
            fixture.elsewhere.to_str().unwrap()
        );
        assert!(fixture.remembered().folders[0].id.is_none());

        // The same bookmarked spelling can later lead to a different safe
        // directory; listing registers that root under a different scope.
        let second_parent = fixture.temp.join("another-app");
        let second = second_parent.join("so.epicenter.todos");
        fs::create_dir_all(&second).unwrap();
        fs::remove_file(&alias).unwrap();
        symlink(&second_parent, &alias).unwrap();
        let listed = fixture.remembered();
        assert_eq!(listed.folders[0].id.as_deref(), Some("opened:2"));
        assert_eq!(
            fixture.grant("folders", "opened:2").unwrap()["root"],
            second.to_str().unwrap()
        );
        assert_eq!(
            fixture.grant("folders", &first.id).unwrap()["root"],
            fixture.elsewhere.to_str().unwrap()
        );
    }

    #[test]
    fn epicenters_own_folder_and_app_data_are_never_opened_from_a_request() {
        let fixture = fixture();
        let own = fixture.paths.folder_dir.join(EPICENTER_FOLDER);
        fs::create_dir_all(own.join("connections")).unwrap();
        let mut refused = vec![
            own.clone(),
            own.join("connections"),
            // A folder holding Epicenter's own folder holds its files.
            fixture.paths.folder_dir.clone(),
            fixture.temp.clone(),
            fixture.paths.data_dir.clone(),
            fixture.paths.data_dir.parent().unwrap().to_path_buf(),
        ];
        #[cfg(unix)]
        {
            // A link to the root, then the plain path of Epicenter's folder
            // below it.
            std::os::unix::fs::symlink(&fixture.paths.folder_dir, fixture.temp.join("alias"))
                .unwrap();
            refused.push(fixture.temp.join("alias").join(EPICENTER_FOLDER));
        }
        for directory in refused {
            fixture.receive(&directory);
            let problem = fixture.accept(&directory).unwrap_err();
            assert!(
                problem.contains("Epicenter's own files"),
                "{directory:?}: {problem}"
            );
        }
        assert_eq!(
            fixture.grant("folders", "opened:1").unwrap_err()["name"],
            "UnknownScope"
        );
        assert!(!remembered_folders::file(&fixture.paths.data_dir).exists());
    }

    #[test]
    fn accepting_again_keeps_one_scope_one_window_and_one_remembered_entry() {
        let fixture = fixture();
        for _ in 0..3 {
            fixture.receive(&fixture.elsewhere);
            assert_eq!(fixture.accept(&fixture.elsewhere).unwrap().id, "opened:1");
        }
        assert!(fixture.grant("folders", "opened:1").is_ok());
        assert_eq!(
            fixture.grant("other", "opened:1").unwrap_err()["name"],
            "WindowNotPermitted"
        );
        assert_eq!(
            fixture.grant("folders", "opened:2").unwrap_err()["name"],
            "UnknownScope"
        );
        let listed = fixture.remembered();
        assert_eq!(listed.folders.len(), 1);
        assert_eq!(listed.folders[0].id.as_deref(), Some("opened:1"));
        assert_eq!(
            remembered_folders::read(&fixture.paths.data_dir).unwrap(),
            [fixture.elsewhere.to_str().unwrap()]
        );
    }

    #[test]
    fn a_remembered_folder_is_listed_after_a_restart_and_a_missing_one_stays_forgettable() {
        let fixture = fixture();
        fixture.receive(&fixture.elsewhere);
        fixture.accept(&fixture.elsewhere).unwrap();
        let path = fixture.elsewhere.to_str().unwrap().to_string();

        let fixture = fixture.restart();
        let listed = fixture.remembered();
        assert_eq!(
            listed,
            RememberedFolders {
                folders: vec![RememberedFolder {
                    path: path.clone(),
                    id: Some("opened:1".into()),
                    remembered: true,
                    problem: None,
                }],
                problem: None,
            }
        );
        assert_eq!(fixture.grant("folders", "opened:1").unwrap()["root"], path);

        fs::remove_dir_all(&fixture.elsewhere).unwrap();
        let fixture = fixture.restart();
        assert_eq!(
            fixture.remembered().folders,
            [RememberedFolder {
                path: path.clone(),
                id: None,
                remembered: true,
                problem: Some("This folder is not there.".into()),
            }]
        );
        remembered_folders::forget(&fixture.paths.data_dir, &path).unwrap();
        assert!(fixture.remembered().folders.is_empty());
        assert!(!fixture.elsewhere.exists());
    }

    #[test]
    fn a_failed_bookmark_write_keeps_the_opening_and_is_reported() {
        let fixture = fixture();
        let list = remembered_folders::file(&fixture.paths.data_dir);
        fs::write(&list, "{ \"not\": \"a list\" }").unwrap();

        fixture.receive(&fixture.elsewhere);
        let accepted = fixture.accept(&fixture.elsewhere).unwrap();
        assert_eq!(accepted.id, "opened:1");
        assert!(accepted
            .remember_problem
            .as_deref()
            .is_some_and(|problem| problem.contains("left unchanged")));
        assert_eq!(
            fs::read_to_string(&list).unwrap(),
            "{ \"not\": \"a list\" }"
        );
        assert!(fixture.grant("folders", "opened:1").is_ok());

        // Listed for this run, as not remembered, beside the list's problem.
        let listed = fixture.remembered();
        assert!(listed.problem.is_some());
        assert_eq!(
            listed.folders,
            [RememberedFolder {
                path: fixture.elsewhere.to_str().unwrap().into(),
                id: Some("opened:1".into()),
                remembered: false,
                problem: None,
            }]
        );
    }

    #[test]
    fn an_unwritable_app_data_directory_is_reported_after_opening() {
        let fixture = fixture();
        fs::remove_dir_all(&fixture.paths.data_dir).unwrap();
        fs::write(&fixture.paths.data_dir, "").unwrap();

        fixture.receive(&fixture.elsewhere);
        let accepted = fixture.accept(&fixture.elsewhere).unwrap();
        assert_eq!(accepted.id, "opened:1");
        assert!(accepted.remember_problem.is_some());
    }

    #[test]
    fn a_hand_edited_entry_is_listed_with_its_problem_and_protected_paths_stay_closed() {
        let fixture = fixture();
        let own = fixture.paths.folder_dir.join(EPICENTER_FOLDER);
        fs::write(
            remembered_folders::file(&fixture.paths.data_dir),
            serde_json::to_string(&[
                "relative/notes",
                own.to_str().unwrap(),
                fixture.elsewhere.to_str().unwrap(),
            ])
            .unwrap(),
        )
        .unwrap();

        let listed = fixture.remembered();
        assert_eq!(listed.problem, None);
        let summary: Vec<(Option<&str>, bool)> = listed
            .folders
            .iter()
            .map(|folder| (folder.id.as_deref(), folder.problem.is_some()))
            .collect();
        assert_eq!(
            summary,
            [(None, true), (None, true), (Some("opened:1"), false)]
        );
    }
}
