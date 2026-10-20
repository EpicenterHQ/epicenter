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
//! Accepting resolves an existing directory and opens its own bound editor
//! window. The launcher stays unbound. The accepted path is remembered in
//! `folders.json`; bookmarks are shortcuts, never native file permissions.
//! Reopening requires a stored or this-run accepted path and checks it again.
//! Like a bundled app's launcher, the handoff refuses paths overlapping
//! Epicenter's own folder or app data (`overlaps_epicenter_files`). Receiving or
//! dismissing a request reads none of its files.

use std::fs;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use percent_encoding::percent_decode_str;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_epicenter_folder::Directory;

use crate::app_data::DesktopPaths;
use crate::data_folders::overlaps_epicenter_files;
use crate::remembered_folders;
use crate::{BuiltInApp, DesktopAppHandle};

/// The event the Folders window hears when the pending requests changed. It
/// carries nothing: the window asks `pending_folder_openings` again.
/// `FOLDER_OPENINGS_CHANGED` in `src/folders/openings.svelte.ts` names it too.
pub const FOLDER_OPENINGS_CHANGED: &str = "epicenter://folder-openings-changed";

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

/// Resolve and check an existing handoff directory without granting it to
/// the launcher. The returned canonical Directory is the one the editor binds.
fn admit(paths: &DesktopPaths, directory: &str) -> Result<Directory, String> {
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
    let directory = Directory::existing(path).map_err(|error| error.to_string())?;
    if overlaps_epicenter_files(paths, &directory) {
        return Err(
            "This folder holds Epicenter's own files, so Epicenter does not open it here."
                .to_string(),
        );
    }
    Ok(directory)
}

/// A successful native opening, with a separate persistence failure if any.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AcceptedOpening {
    /// Why `folders.json` was not updated; the folder is open regardless.
    pub remember_problem: Option<String>,
}

/// One remembered folder, or one accepted this run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RememberedFolder {
    /// The absolute path as stored, which `forget_remembered_folder` matches.
    pub path: String,
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

/// Consume only a pending request, then resolve it without creating anything.
fn requested_directory(
    openings: &FolderOpenings,
    paths: &DesktopPaths,
    directory: &str,
) -> Result<Directory, String> {
    if !openings.take(directory) {
        return Err("No app asked Epicenter to open this folder.".to_string());
    }
    admit(paths, directory)
}

/// Called only after its editor opened. Failed persistence leaves the editor open.
fn remember_accepted(
    openings: &FolderOpenings,
    paths: &DesktopPaths,
    directory: &str,
) -> AcceptedOpening {
    openings.mark_accepted(directory);
    let remember_problem = remembered_folders::add(&paths.data_dir, directory).err();
    if let Some(problem) = &remember_problem {
        log::warn!("an opened folder was not remembered: {problem}");
    }
    AcceptedOpening { remember_problem }
}

/// A stale launcher row is no authority: require current bookmark membership,
/// then resolve and check the path again before opening its editor.
fn remembered_directory(
    openings: &FolderOpenings,
    paths: &DesktopPaths,
    path: &str,
) -> Result<Directory, String> {
    let accepted = openings.accepted().iter().any(|entry| entry == path);
    if !accepted
        && !remembered_folders::read(&paths.data_dir)?
            .iter()
            .any(|entry| entry == path)
    {
        return Err("This folder is not in the remembered folders.".to_string());
    }
    admit(paths, path)
}

fn remembered(openings: &FolderOpenings, paths: &DesktopPaths) -> RememberedFolders {
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
            let problem = admit(paths, &path).err();
            RememberedFolder {
                path,
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

/// Accept a pending request and open its own editor, then remember the path.
#[tauri::command]
#[specta::specta]
pub async fn accept_folder_opening(
    app: DesktopAppHandle,
    path: String,
) -> Result<AcceptedOpening, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let result = (|| {
            let openings = app.state::<FolderOpenings>();
            let paths = app.state::<DesktopPaths>();
            let directory = requested_directory(&openings, &paths, &path)?;
            crate::folder_windows::show_editor(&app, directory)
                .map_err(|error| format!("{error:#}"))?;
            Ok(remember_accepted(&openings, &paths, &path))
        })();
        let _ = app.emit_to(BuiltInApp::Folders.id(), FOLDER_OPENINGS_CHANGED, ());
        result
    })
    .await
    .map_err(|error| format!("the folder could not be opened: {error}"))?
}

/// Open a currently remembered or this-run accepted path in its own editor.
#[tauri::command]
#[specta::specta]
pub async fn open_remembered_folder(app: DesktopAppHandle, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let directory = remembered_directory(
            &app.state::<FolderOpenings>(),
            &app.state::<DesktopPaths>(),
            &path,
        )?;
        crate::folder_windows::show_editor(&app, directory).map_err(|error| format!("{error:#}"))
    })
    .await
    .map_err(|error| format!("the folder could not be opened: {error}"))?
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
/// with its availability problem, if any. Off the main thread, since
/// it reads the disk.
#[tauri::command(async)]
#[specta::specta]
pub fn list_remembered_folders(app: DesktopAppHandle) -> RememberedFolders {
    remembered(&app.state::<FolderOpenings>(), &app.state::<DesktopPaths>())
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
    use super::*;
    use crate::data_folders::EPICENTER_FOLDER;
    use serde_json::{json, Value};
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY};
    use tauri::utils::acl::ExecutionContext;
    use tauri::webview::InvokeRequest;
    use tauri::{App, WebviewWindow, WebviewWindowBuilder};
    use tauri_plugin_epicenter_folder::FolderExt;

    struct Fixture {
        app: App<MockRuntime>,
        openings: FolderOpenings,
        paths: DesktopPaths,
        elsewhere: PathBuf,
        temp: tempfile::TempDir,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            self.app.folders().shutdown();
        }
    }
    impl Fixture {
        fn request(&self, path: &Path) {
            self.openings.queue(path.to_str().unwrap().into());
        }
        fn accept(&self, path: &Path) -> Result<AcceptedOpening, String> {
            let path = path.to_str().unwrap();
            let directory = requested_directory(&self.openings, &self.paths, path)?;
            self.editor(directory);
            Ok(remember_accepted(&self.openings, &self.paths, path))
        }
        fn reopen(&self, path: &Path) -> Result<String, String> {
            let directory =
                remembered_directory(&self.openings, &self.paths, path.to_str().unwrap())?;
            Ok(self.editor(directory))
        }
        fn editor(&self, directory: Directory) -> String {
            let label = crate::folder_windows::label(
                crate::folder_windows::EDITOR_PREFIX,
                directory.root(),
            );
            if self.app.get_webview_window(&label).is_none() {
                self.app
                    .folders()
                    .bind_while_building(&label, directory, || {
                        WebviewWindowBuilder::new(&self.app, &label, Default::default())
                            .build()
                            .map_err(|e| -> Box<dyn std::error::Error> { Box::new(e) })
                    })
                    .unwrap();
            }
            label
        }
        fn listed(&self) -> RememberedFolders {
            remembered(&self.openings, &self.paths)
        }
        fn root(&self, label: &str) -> PathBuf {
            self.app
                .folders()
                .bound(label)
                .unwrap()
                .root()
                .to_path_buf()
        }
    }
    fn fixture() -> Fixture {
        let temp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(temp.path()).unwrap();
        let paths = DesktopPaths {
            data_dir: root.join("Application Support/so.epicenter"),
            folder_dir: root.join("Epicenter"),
        };
        fs::create_dir_all(paths.folder_dir.join(EPICENTER_FOLDER)).unwrap();
        fs::create_dir_all(&paths.data_dir).unwrap();
        let elsewhere = root.join("Application Support/so.epicenter.todos");
        fs::create_dir_all(elsewhere.join("todos")).unwrap();
        fs::write(elsewhere.join("todos/milk.md"), "---\ntitle: Milk\n---\n").unwrap();
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
            .unwrap();
        Fixture {
            app,
            openings: FolderOpenings::default(),
            paths,
            elsewhere,
            temp,
        }
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
                invoke_key: INVOKE_KEY.into(),
            },
        )
        .map(|body| body.deserialize().unwrap())
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
    fn receiving_and_dismissing_reads_binds_and_remembers_nothing() {
        let f = fixture();
        let missing = f.temp.path().join("not/there");
        f.request(&f.elsewhere);
        f.request(&missing);
        f.request(&f.elsewhere);
        assert_eq!(f.openings.pending().len(), 2);
        assert!(f.openings.take(f.elsewhere.to_str().unwrap()));
        assert!(f.accept(&f.elsewhere).is_err());
        assert!(!missing.exists());
        assert!(!remembered_folders::file(&f.paths.data_dir).exists());
        assert!(f.app.webview_windows().is_empty());
    }
    #[test]
    fn acceptance_opens_only_its_bound_editor_and_leaves_the_launcher_unbound() {
        let f = fixture();
        assert!(f.accept(&f.elsewhere).is_err());
        f.request(&f.elsewhere);
        assert_eq!(f.accept(&f.elsewhere).unwrap().remember_problem, None);
        assert!(f.accept(&f.elsewhere).is_err());
        let label = f.reopen(&f.elsewhere).unwrap();
        let window = f.app.get_webview_window(&label).unwrap();
        assert_eq!(f.root(&label), f.elsewhere);
        assert_eq!(invoke(&window, "open_folder", json!({})), Ok(Value::Null));
        assert_eq!(
            invoke(
                &window,
                "read_folder_children",
                json!({"directory":"todos"})
            )
            .unwrap(),
            json!({"files":["milk.md"],"directories":[]})
        );
        let launcher = WebviewWindowBuilder::new(&f.app, "folders", Default::default())
            .build()
            .unwrap();
        assert_eq!(
            invoke(&launcher, "open_folder", json!({})).unwrap_err()["name"],
            "NotBound"
        );
        assert!(f.app.folders().bound("home").is_err());
        assert_eq!(
            remembered_folders::read(&f.paths.data_dir).unwrap(),
            [f.elsewhere.to_str().unwrap()]
        );
    }
    #[test]
    fn repeated_acceptance_reveals_one_editor_and_remembers_once() {
        let f = fixture();
        for _ in 0..3 {
            f.request(&f.elsewhere);
            f.accept(&f.elsewhere).unwrap();
        }
        assert_eq!(f.app.webview_windows().len(), 1);
        assert_eq!(f.listed().folders.len(), 1);
        assert_eq!(f.openings.accepted().len(), 1);
    }
    #[test]
    fn a_missing_directory_is_refused_and_never_created() {
        let f = fixture();
        let missing = f.temp.path().join("missing");
        f.request(&missing);
        assert_eq!(f.accept(&missing).unwrap_err(), "This folder is not there.");
        assert!(!missing.exists());
        f.request(&f.elsewhere);
        f.accept(&f.elsewhere).unwrap();
        fs::remove_dir_all(&f.elsewhere).unwrap();
        assert!(f.reopen(&f.elsewhere).is_err());
        assert!(!f.elsewhere.exists());
        assert!(f.listed().folders[0].problem.is_some());
    }
    #[test]
    fn files_leaf_links_and_nonplain_paths_are_refused() {
        let f = fixture();
        let file = f.temp.path().join("notes.md");
        fs::write(&file, "").unwrap();
        f.request(&file);
        assert_eq!(f.accept(&file).unwrap_err(), "This path is not a folder.");
        assert!(admit(&f.paths, "relative/notes").is_err());
        #[cfg(unix)]
        {
            let link = f.temp.path().join("link");
            std::os::unix::fs::symlink(&f.elsewhere, &link).unwrap();
            f.request(&link);
            assert!(f.accept(&link).unwrap_err().contains("link"));
        }
        assert!(f.app.webview_windows().is_empty());
    }
    #[test]
    fn handoffs_preserve_the_protected_overlap_policy() {
        let f = fixture();
        let own = f.paths.folder_dir.join(EPICENTER_FOLDER);
        fs::create_dir(own.join("connections")).unwrap();
        for path in [
            &own,
            &own.join("connections"),
            &f.paths.folder_dir,
            &f.paths.data_dir,
            f.paths.data_dir.parent().unwrap(),
        ] {
            f.request(path);
            assert!(f
                .accept(path)
                .unwrap_err()
                .contains("Epicenter's own files"));
        }
        assert!(f.app.webview_windows().is_empty());
        assert!(!remembered_folders::file(&f.paths.data_dir).exists());
    }
    #[cfg(unix)]
    #[test]
    fn a_retargeted_parent_cannot_redirect_an_admitted_directory_or_bypass_reopen_checks() {
        use std::os::unix::fs::symlink;
        let f = fixture();
        let alias = f.temp.path().join("alias");
        symlink(f.elsewhere.parent().unwrap(), &alias).unwrap();
        let path = alias.join("so.epicenter.todos");
        f.request(&path);
        let admitted = requested_directory(&f.openings, &f.paths, path.to_str().unwrap()).unwrap();
        let protected = f.paths.data_dir.join("so.epicenter.todos");
        fs::create_dir(&protected).unwrap();
        fs::remove_file(&alias).unwrap();
        symlink(&f.paths.data_dir, &alias).unwrap();
        let first = f.editor(admitted);
        remember_accepted(&f.openings, &f.paths, path.to_str().unwrap());
        assert_eq!(f.root(&first), f.elsewhere);
        assert!(f
            .reopen(&path)
            .unwrap_err()
            .contains("Epicenter's own files"));
        assert!(f.listed().folders[0].problem.is_some());
        let second_parent = f.temp.path().join("another-app");
        let second = second_parent.join("so.epicenter.todos");
        fs::create_dir_all(&second).unwrap();
        fs::remove_file(&alias).unwrap();
        symlink(&second_parent, &alias).unwrap();
        let next = f.reopen(&path).unwrap();
        assert_ne!(first, next);
        assert_eq!(f.root(&next), dunce::canonicalize(second).unwrap());
        assert_eq!(f.root(&first), f.elsewhere);
    }
    #[test]
    fn restart_lists_shortcuts_without_binding_and_missing_paths_stay_forgettable() {
        let f = fixture();
        f.request(&f.elsewhere);
        f.accept(&f.elsewhere).unwrap();
        let restarted = FolderOpenings::default();
        let listed = remembered(&restarted, &f.paths);
        assert_eq!(
            listed.folders,
            [RememberedFolder {
                path: f.elsewhere.to_str().unwrap().into(),
                remembered: true,
                problem: None
            }]
        );
        assert!(remembered_directory(&restarted, &f.paths, f.elsewhere.to_str().unwrap()).is_ok());
        fs::remove_dir_all(&f.elsewhere).unwrap();
        assert!(remembered(&restarted, &f.paths).folders[0]
            .problem
            .is_some());
        remembered_folders::forget(&f.paths.data_dir, f.elsewhere.to_str().unwrap()).unwrap();
        assert!(remembered(&restarted, &f.paths).folders.is_empty());
        assert!(!f.elsewhere.exists());
    }
    #[test]
    fn arbitrary_and_forgotten_paths_cannot_reopen_but_live_editors_stay_bound() {
        let f = fixture();
        assert!(f.reopen(&f.elsewhere).is_err());
        f.request(&f.elsewhere);
        f.accept(&f.elsewhere).unwrap();
        let label = f.reopen(&f.elsewhere).unwrap();
        remembered_folders::forget(&f.paths.data_dir, f.elsewhere.to_str().unwrap()).unwrap();
        f.openings.forget(f.elsewhere.to_str().unwrap());
        assert!(f.reopen(&f.elsewhere).is_err());
        assert_eq!(f.root(&label), f.elsewhere);
    }
    #[test]
    fn a_failed_bookmark_write_keeps_the_editor_and_this_run_shortcut() {
        let f = fixture();
        let list = remembered_folders::file(&f.paths.data_dir);
        fs::write(&list, "{\"not\":\"a list\"}").unwrap();
        f.request(&f.elsewhere);
        let accepted = f.accept(&f.elsewhere).unwrap();
        assert!(accepted.remember_problem.is_some());
        assert_eq!(fs::read_to_string(&list).unwrap(), "{\"not\":\"a list\"}");
        assert!(f.reopen(&f.elsewhere).is_ok());
        let listed = f.listed();
        assert!(listed.problem.is_some());
        assert!(!listed.folders[0].remembered);
        assert_eq!(listed.folders[0].problem, None);
    }
    #[test]
    fn unusable_app_data_is_reported_after_the_editor_opens() {
        let f = fixture();
        fs::remove_dir_all(&f.paths.data_dir).unwrap();
        fs::write(&f.paths.data_dir, "").unwrap();
        f.request(&f.elsewhere);
        assert!(f.accept(&f.elsewhere).unwrap().remember_problem.is_some());
        assert_eq!(f.app.webview_windows().len(), 1);
        assert!(f.reopen(&f.elsewhere).is_ok());
    }
    #[test]
    fn hand_edited_bookmarks_are_checked_before_opening() {
        let f = fixture();
        let own = f.paths.folder_dir.join(EPICENTER_FOLDER);
        fs::write(
            remembered_folders::file(&f.paths.data_dir),
            serde_json::to_string(&[
                "relative/notes",
                own.to_str().unwrap(),
                f.elsewhere.to_str().unwrap(),
            ])
            .unwrap(),
        )
        .unwrap();
        let listed = f.listed();
        assert_eq!(
            listed
                .folders
                .iter()
                .map(|f| f.problem.is_some())
                .collect::<Vec<_>>(),
            [true, true, false]
        );
        assert!(f.app.webview_windows().is_empty());
        assert!(f.reopen(&own).is_err());
    }
}
