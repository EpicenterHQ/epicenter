//! Root-child discovery and launcher invalidation. The combined folder list
//! lives in folder_listing; listing never registers or allocates a directory.
//! The root and its child declarations are watched alongside navigation.sqlite.

use std::fs;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use notify::{EventKind, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer_opt, DebounceEventResult, Debouncer, NoCache};
use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_epicenter_folder::Directory;

#[cfg(test)]
use crate::folder_windows;
use crate::BuiltInApp;
use epicenter_folder_core::{library, navigation};
use tauri_plugin_epicenter_folder::defaults::DesktopPaths;

/// The optional declaration supplying a title while listing files.
const DECLARATION: &str = "epicenter.json";

/// Whether `directory` overlaps Epicenter's own files, so that neither a
/// bundled app nor a handoff may bind it: Settings' folder, the fixed
/// `<folder_dir>/so.epicenter`, its sibling save staging directory, or the
/// app data, anything inside them, or a directory holding them, such as the
/// folder root. No configuration is read. The listed-folder editor does not
/// ask, and may open Settings' folder.
pub fn overlaps_epicenter_files(paths: &DesktopPaths, directory: &Directory) -> bool {
    library::check_app_directory(&paths.data_dir, &paths.folder_dir, directory.root()).is_err()
}

/// Discover visible real children. The combined listing owns titles and order.
pub(crate) fn list_in(folder_dir: &Path) -> Result<Vec<PathBuf>, String> {
    let entries = match fs::read_dir(folder_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("The Epicenter folder could not be read: {error}")),
    };
    let mut listed = Vec::new();
    for entry in entries.flatten() {
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        // `file_type` does not follow links, so a linked directory is skipped.
        let is_directory = entry.file_type().is_ok_and(|kind| kind.is_dir());
        if name.starts_with('.') || !is_directory {
            continue;
        }
        listed.push(entry.path());
    }
    Ok(listed)
}

pub(crate) fn folder_title(path: &Path) -> String {
    let declaration = path.join(DECLARATION);
    fs::symlink_metadata(&declaration)
        .ok()
        .filter(|stats| stats.is_file())
        .and_then(|_| fs::read_to_string(&declaration).ok())
        .as_deref()
        .and_then(declared_title)
        .unwrap_or_else(|| {
            path.file_name()
                .unwrap_or(path.as_os_str())
                .to_string_lossy()
                .into_owned()
        })
}

/// The event the Folders window hears when the listing may have changed. It
/// carries nothing: the window lists again. `DATA_FOLDERS_CHANGED` in
/// `src/folders/App.svelte` names it too.
pub const DATA_FOLDERS_CHANGED: &str = "epicenter://data-folders-changed";

/// How long the root's watcher waits for a burst of events to settle.
const LISTING_DEBOUNCE: Duration = Duration::from_millis(100);

/// The watch on the Epicenter folder root, kept in the app's state until
/// exit; dropping it stops the watch.
pub struct DataFoldersWatch {
    _debouncer: Debouncer<RecommendedWatcher, NoCache>,
}

/// Watch `folder_dir` and send `DATA_FOLDERS_CHANGED` to the Folders window
/// when the combined folder list may have changed: an entry directly under the
/// root, or a folder's optional `epicenter.json` title. The watch is recursive
/// because a declaration is one level down; every deeper change, such as a row saved
/// in a folder, is ignored. A rescan or a watch error is reported too, and so
/// is a change to `navigation.sqlite`. An unavailable root does not prevent
/// navigation watching or startup.
pub fn watch_data_folders<R: Runtime>(
    app: &AppHandle<R>,
    folder_dir: &Path,
    data_dir: &Path,
) -> Result<DataFoldersWatch, String> {
    let root = folder_dir.to_path_buf();
    let navigation_file = navigation::file(data_dir);
    fs::create_dir_all(data_dir).map_err(|error| error.to_string())?;
    let app = app.clone();
    let mut debouncer = new_debouncer_opt::<_, RecommendedWatcher, NoCache>(
        LISTING_DEBOUNCE,
        None,
        move |result: DebounceEventResult| {
            let changed = match result {
                Ok(events) => events.iter().any(|debounced| {
                    debounced.need_rescan()
                        || (!matches!(debounced.kind, EventKind::Access(_))
                            && debounced.paths.iter().any(|path| {
                                changes_listing(&root, path) || *path == navigation_file
                            }))
                }),
                // Some events could not be delivered.
                Err(_) => true,
            };
            if changed {
                let _ = app.emit_to(BuiltInApp::Folders.id(), DATA_FOLDERS_CHANGED, ());
            }
        },
        NoCache,
        notify::Config::default().with_follow_symlinks(false),
    )
    .map_err(|cause| format!("'{}' could not be watched: {cause}", folder_dir.display()))?;
    debouncer
        .watch(data_dir, RecursiveMode::NonRecursive)
        .map_err(|error| format!("{} could not be watched: {error}", data_dir.display()))?;
    // Creating the discovery root enables first-use watching, but is never a
    // prerequisite for navigation elsewhere on the machine.
    if let Err(error) = fs::create_dir_all(folder_dir)
        .map_err(|error| error.to_string())
        .and_then(|()| {
            debouncer
                .watch(folder_dir, RecursiveMode::Recursive)
                .map_err(|error| error.to_string())
        })
    {
        log::warn!("{} could not be watched: {error}", folder_dir.display());
    }
    Ok(DataFoldersWatch {
        _debouncer: debouncer,
    })
}

/// Whether a change at `path` can change the listing of `root`: the root
/// itself, an entry directly in it, or `epicenter.json` directly in one,
/// leaving out dot entries, which are never listed.
fn changes_listing(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    let names: Vec<Component> = relative.components().collect();
    let listed = |name: &std::ffi::OsStr| !name.to_string_lossy().starts_with('.');
    match names.as_slice() {
        [] => true,
        [Component::Normal(entry)] => listed(entry),
        [Component::Normal(entry), Component::Normal(file)] => {
            listed(entry) && *file == DECLARATION
        }
        _ => false,
    }
}

/// `epicenter.json`'s `title`, when the text parses and it is a string.
fn declared_title(text: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    value.get("title")?.as_str().map(str::to_string)
}

#[cfg(test)]
mod tests {
    //! The listing over a real directory, and the editor window the folder
    //! plugin's real commands reach on the mock runtime.

    use serde_json::{json, Value};
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY};
    use tauri::utils::acl::ExecutionContext;
    use tauri::webview::InvokeRequest;
    use tauri::{App, Manager, WebviewWindow, WebviewWindowBuilder};
    use tauri_plugin_epicenter_folder::FolderExt;

    use super::*;

    const RECORDS: &str = library::RECORDS.id;

    struct Fixture {
        app: App<MockRuntime>,
        folder_dir: PathBuf,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.app.folders().shutdown();
            let _ = fs::remove_dir_all(&self.folder_dir);
        }
    }

    impl Fixture {
        fn list(&self) -> Vec<PathBuf> {
            list_in(&self.folder_dir).unwrap()
        }

        /// What `open_folder_editor` does, with a mock window for the WebView.
        fn open_editor(&self, name: &str) -> Result<(String, bool), String> {
            let before = self.app.webview_windows().len();
            let window = folder_windows::open_editor(
                self.app.handle(),
                crate::folder_listing::listed_directory(
                    &self.app.state::<DesktopPaths>(),
                    &self.app.state::<crate::folder_opening::FolderOpenings>(),
                    &crate::folder_listing::folder_id(&self.folder_dir.join(name)),
                )?,
            )
            .map_err(|error| format!("{error:#}"))?;
            Ok((
                window.label().to_owned(),
                self.app.webview_windows().len() == before,
            ))
        }

        fn window(&self, label: &str) -> WebviewWindow<MockRuntime> {
            self.app.get_webview_window(label).expect("an open window")
        }
    }

    /// An app with the folder plugin over an empty folder root.
    fn fixture(label: &str) -> Fixture {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let folder_dir = std::env::temp_dir().join(format!(
            "epicenter-data-folders-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&folder_dir);
        fs::create_dir_all(&folder_dir).unwrap();
        let folder_dir = fs::canonicalize(folder_dir).unwrap();

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
        app.manage(DesktopPaths {
            data_dir: folder_dir.join(".app-data"),
            folder_dir: folder_dir.clone(),
        });
        app.manage(crate::folder_opening::FolderOpenings::default());
        Fixture { app, folder_dir }
    }

    /// A data folder whose optional declaration supplies test metadata.
    fn data_folder(fixture: &Fixture, name: &str, declaration: &str) {
        let root = fixture.folder_dir.join(name);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(DECLARATION), declaration).unwrap();
    }

    fn invoke(
        window: &WebviewWindow<MockRuntime>,
        command: &str,
        args: Value,
    ) -> Result<Value, Value> {
        let args = if command == "open_folder" {
            let channel = tauri::ipc::Channel::<tauri_plugin_epicenter_folder::FolderChanged>::new(
                |_: tauri::ipc::InvokeResponseBody| Ok(()),
            );
            json!({ "onChange": channel })
        } else {
            args
        };
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

    /// Open the window's folder, then list its root's entry names.
    fn root_names(window: &WebviewWindow<MockRuntime>) -> Vec<String> {
        invoke(window, "open_folder", json!({}))
            .unwrap_or_else(|error| panic!("{} did not open: {error}", window.label()));
        let children = invoke(window, "read_folder_children", json!({ "directory": "" })).unwrap();
        let mut names: Vec<String> = ["files", "directories"]
            .iter()
            .flat_map(|kind| children[*kind].as_array().unwrap().clone())
            .map(|name| name.as_str().unwrap().to_string())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn the_folders_window_hears_a_new_data_folder() {
        use tauri::Listener;

        let fixture = fixture("watch");
        let window =
            WebviewWindowBuilder::new(&fixture.app, BuiltInApp::Folders.id(), Default::default())
                .build()
                .unwrap();
        let (heard, hearing) = std::sync::mpsc::channel();
        window.listen(DATA_FOLDERS_CHANGED, move |_| {
            let _ = heard.send(());
        });
        let _watch = watch_data_folders(
            fixture.app.handle(),
            &fixture.folder_dir,
            &fixture.folder_dir.join(".app-data"),
        )
        .unwrap();
        // The operating system may report the root's creation late; settle it.
        std::thread::sleep(Duration::from_millis(500));
        while hearing.try_recv().is_ok() {}

        data_folder(&fixture, "books", "{}");

        hearing
            .recv_timeout(Duration::from_secs(5))
            .expect("the Folders window hears the new folder");
    }

    #[test]
    fn the_launcher_hears_external_navigation_writes() {
        use tauri::Listener;
        let fixture = fixture("navigation-watch");
        let data = fixture.folder_dir.join(".app-data");
        let window =
            WebviewWindowBuilder::new(&fixture.app, BuiltInApp::Folders.id(), Default::default())
                .build()
                .unwrap();
        let (heard, hearing) = std::sync::mpsc::channel();
        window.listen(DATA_FOLDERS_CHANGED, move |_| {
            let _ = heard.send(());
        });
        let _watch = watch_data_folders(fixture.app.handle(), &fixture.folder_dir, &data).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        while hearing.try_recv().is_ok() {}
        let external = fixture.folder_dir.join("external-pinned");
        fs::create_dir(&external).unwrap();
        let module = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../packages/cli/src/navigation.ts")
            .canonicalize()
            .unwrap();
        let script = format!(
            "import {{pinNavigation}} from {}; await pinNavigation(process.argv[1], process.argv[2]);",
            serde_json::to_string(&module.to_string_lossy()).unwrap()
        );
        let output = std::process::Command::new("bun")
            .args([
                "-e",
                &script,
                data.to_str().unwrap(),
                external.to_str().unwrap(),
            ])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        hearing
            .recv_timeout(Duration::from_secs(5))
            .expect("a committed CLI write refreshes the launcher");
        let paths = DesktopPaths {
            data_dir: data,
            folder_dir: fixture.folder_dir.clone(),
        };
        let listed =
            crate::folder_listing::list(&paths, &crate::folder_opening::FolderOpenings::default());
        assert!(listed
            .folders
            .iter()
            .any(|row| row.path == external.to_str().unwrap()
                && row.group == crate::folder_listing::FolderGroup::Pinned));
    }

    #[test]
    fn an_unavailable_root_does_not_prevent_navigation_watching() {
        use tauri::Listener;
        let fixture = fixture("blocked-root-watch");
        let data = fixture.folder_dir.join(".app-data");
        let occupied = fixture.folder_dir.join("occupied");
        fs::write(&occupied, "keep").unwrap();
        let window =
            WebviewWindowBuilder::new(&fixture.app, BuiltInApp::Folders.id(), Default::default())
                .build()
                .unwrap();
        let (heard, hearing) = std::sync::mpsc::channel();
        window.listen(DATA_FOLDERS_CHANGED, move |_| {
            let _ = heard.send(());
        });
        let _watch = watch_data_folders(fixture.app.handle(), &occupied, &data).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        while hearing.try_recv().is_ok() {}
        navigation::pin(&data, "/outside/root", |_| false).unwrap();
        hearing
            .recv_timeout(Duration::from_secs(5))
            .expect("navigation remains watched");
        assert_eq!(fs::read_to_string(occupied).unwrap(), "keep");
    }

    /// Settings' folder is the fixed `so.epicenter` child; any other directory
    /// is ordinary, and listing writes nothing to AppData.
    #[test]
    fn records_are_the_fixed_child_and_other_directories_are_ordinary() {
        let fixture = fixture("fixed-records");
        let data = fixture.folder_dir.join(".app-data");
        fs::create_dir(&data).unwrap();
        let selected = fixture.folder_dir.join("My setup");
        fs::create_dir(&selected).unwrap();
        let paths = DesktopPaths {
            data_dir: data.clone(),
            folder_dir: fixture.folder_dir.clone(),
        };
        let records = paths.open_default(library::RECORDS).unwrap();
        assert_eq!(records.root(), fixture.folder_dir.join(RECORDS));
        assert!(overlaps_epicenter_files(&paths, &records));
        assert!(!overlaps_epicenter_files(
            &paths,
            &Directory::existing(&selected).unwrap()
        ));
        let listed =
            crate::folder_listing::list(&paths, &crate::folder_opening::FolderOpenings::default())
                .folders;
        let row = |path: &Path| {
            listed
                .iter()
                .find(|folder| folder.path == path.to_str().unwrap())
                .unwrap()
        };
        assert!(row(records.root()).protected);
        assert_eq!(
            row(records.root()).default_for.as_deref(),
            Some("Epicenter")
        );
        assert!(!row(&selected).protected);
        assert_eq!(row(&selected).default_for, None);
        assert_eq!(fs::read_dir(&data).unwrap().count(), 0);
    }

    #[test]
    fn only_entries_under_the_root_and_their_declarations_change_the_listing() {
        let root = PathBuf::from("/home/Epicenter");
        for path in ["", "books", "books/epicenter.json", "loose.json"] {
            assert!(changes_listing(&root, &root.join(path)), "{path}");
        }
        for path in [
            "books/b1.md",
            "books/.git/HEAD",
            "books/nested/epicenter.json",
            ".books.epicenter-save-lock",
            ".hidden/epicenter.json",
        ] {
            assert!(!changes_listing(&root, &root.join(path)), "{path}");
        }
        assert!(!changes_listing(&root, Path::new("/elsewhere/books")));
    }

    #[test]
    fn lists_real_directories_without_requiring_epicenter_json() {
        let fixture = fixture("listing");
        data_folder(&fixture, "vault", "{}");
        // A directory without a declaration remains available.
        fs::create_dir_all(fixture.folder_dir.join("plain")).unwrap();
        // A dot directory, file, or lock file is not listed. An unusable
        // declaration does not hide the directory.
        data_folder(&fixture, ".hidden", "{}");
        fs::write(fixture.folder_dir.join("loose.json"), "{}").unwrap();
        fs::write(fixture.folder_dir.join(".vault.epicenter-save-lock"), "").unwrap();
        fs::create_dir_all(fixture.folder_dir.join("odd").join(DECLARATION)).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(
            fixture.folder_dir.join("vault"),
            fixture.folder_dir.join("linked"),
        )
        .unwrap();

        let mut children = fixture.list();
        children.sort();
        assert_eq!(
            children,
            ["odd", "plain", "vault"].map(|name| fixture.folder_dir.join(name))
        );
    }

    #[test]
    fn a_missing_root_lists_nothing() {
        let fixture = fixture("missing");
        fs::remove_dir_all(&fixture.folder_dir).unwrap();
        assert!(fixture.list().is_empty());
    }

    /// Choosing a listed folder opens a separate editor window bound to that
    /// folder alone; choosing it again reveals the same window.
    #[test]
    fn a_listed_folder_opens_in_its_own_editor_window_and_again_reveals_it() {
        let fixture = fixture("editor");
        data_folder(&fixture, "vault", "{}");
        fs::write(fixture.folder_dir.join("vault/notes.md"), "").unwrap();
        data_folder(&fixture, "books", "{}");

        let (vault, was_open) = fixture.open_editor("vault").unwrap();
        assert_eq!(was_open, false);
        assert!(vault.starts_with("files:"), "{vault}");
        let (books, _) = fixture.open_editor("books").unwrap();
        assert_ne!(vault, books);
        assert_eq!(fixture.open_editor("vault").unwrap(), (vault.clone(), true));

        assert_eq!(
            root_names(&fixture.window(&vault)),
            ["epicenter.json", "notes.md"]
        );
        assert_eq!(root_names(&fixture.window(&books)), ["epicenter.json"]);
        // The Folders window itself is bound to no folder.
        let launcher =
            WebviewWindowBuilder::new(&fixture.app, BuiltInApp::Folders.id(), Default::default())
                .build()
                .unwrap();
        assert_eq!(
            invoke(&launcher, "open_folder", json!({})).unwrap_err(),
            json!({ "name": "NotBound" })
        );
    }

    /// Epicenter's own folder is listed and may be edited in its editor
    /// window; Settings is bound to it too, made when it is missing.
    #[test]
    fn epicenters_own_folder_opens_in_settings_and_in_its_editor() {
        let fixture = fixture("epicenter");
        let paths = DesktopPaths {
            data_dir: fixture.folder_dir.join(".app-data"),
            folder_dir: fixture.folder_dir.clone(),
        };
        let settings = paths.open_default(library::RECORDS).unwrap();
        assert!(fixture.folder_dir.join(RECORDS).is_dir());
        assert!(overlaps_epicenter_files(&paths, &settings));
        fs::write(fixture.folder_dir.join("so.epicenter/notes.md"), "").unwrap();

        let home = fixture
            .app
            .folders()
            .bind_while_building("home", settings, || {
                Ok::<_, anyhow::Error>(
                    WebviewWindowBuilder::new(&fixture.app, "home", Default::default()).build()?,
                )
            })
            .unwrap();
        assert_eq!(root_names(&home), ["notes.md"]);
        let (editor, _) = fixture.open_editor(RECORDS).unwrap();
        assert_eq!(root_names(&fixture.window(&editor)), ["notes.md"]);
    }

    #[test]
    fn admission_protects_settings_staged_bytes_and_a_missing_parent_in_app_data() {
        let fixture = fixture("protected-sidecars");
        let scratch = fixture.folder_dir.join(".so.epicenter.epicenter-scratch");
        fs::create_dir(&scratch).unwrap();
        let private = fixture.folder_dir.join("private");
        fs::create_dir(&private).unwrap();
        let paths = DesktopPaths {
            data_dir: fixture.folder_dir.join("absent/../private"),
            folder_dir: fixture.folder_dir.clone(),
        };
        assert!(!fixture.folder_dir.join("absent").exists());

        // Records need not exist for their staging sibling to be protected.
        for protected in [&scratch, &private] {
            let directory = Directory::existing(protected).unwrap();
            assert!(
                overlaps_epicenter_files(&paths, &directory),
                "{protected:?}"
            );
        }
        let ordinary = fixture.folder_dir.join("ordinary");
        fs::create_dir(&ordinary).unwrap();
        let directory = Directory::existing(&ordinary).unwrap();
        assert!(!overlaps_epicenter_files(&paths, &directory));
        assert!(!fixture.folder_dir.join(RECORDS).exists());
    }

    /// A listed folder that is gone, a name that is not one directory entry,
    /// and a link are refused, and nothing is created.
    #[test]
    fn an_editor_opens_only_a_listed_folder_that_is_still_there() {
        let fixture = fixture("editor-refused");
        data_folder(&fixture, "vault", "{}");
        fixture.list();
        fs::remove_dir_all(fixture.folder_dir.join("vault")).unwrap();
        assert_eq!(
            fixture.open_editor("vault").unwrap_err(),
            "This folder is no longer in the list."
        );
        assert!(!fixture.folder_dir.join("vault").exists());

        fs::write(fixture.folder_dir.join("loose.md"), "").unwrap();
        for name in [
            "", ".", "..", "../vault", "/tmp", "a/b", ".hidden", "loose.md",
        ] {
            assert!(fixture.open_editor(name).is_err(), "{name:?}");
        }
        #[cfg(unix)]
        {
            let elsewhere = fixture.folder_dir.with_file_name(format!(
                "{}-elsewhere",
                fixture.folder_dir.file_name().unwrap().to_string_lossy()
            ));
            fs::create_dir_all(&elsewhere).unwrap();
            std::os::unix::fs::symlink(&elsewhere, fixture.folder_dir.join("linked")).unwrap();
            assert!(fixture.open_editor("linked").is_err());
            fs::remove_dir_all(&elsewhere).unwrap();
        }
    }
}
