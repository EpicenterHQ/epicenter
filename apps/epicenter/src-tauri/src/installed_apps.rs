//! Installed applications: which IDs a Bun generation serves, and the native
//! folder each one opens.
//!
//! Bun discovers the installed releases once at boot and names their IDs in
//! its ready frame. Rust never reads the catalog from disk; it checks that the
//! IDs can name managed folders (`read_ready_frame`), admits `app-` windows
//! only for the active generation's IDs (`admit_installed_app`), and registers
//! one Folder scope per ID on the first launch that creates its window.
//!
//! An installed app's folder is `<folderDir>/<app-id>`, beside the compiled
//! applications' folders, whoever is signed in (ADR-0532). The ID rules are the
//! managed folder-name rules in ADR-0488. The folder syncs with whatever
//! `origin` its repository names.

use std::collections::BTreeSet;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{bail, Context, Result};
use tauri::{AppHandle, Runtime};
use tauri_plugin_epicenter_folder::{Author, FolderConfig, FolderExt, ScopeConfig};

/// Folder scopes the compiled applications register at startup. An installed
/// app cannot take one: its scope ID is its app ID.
pub(crate) const TODOS_FOLDER_SCOPE: &str = "so.epicenter.todos";
pub(crate) const CAPTURE_FOLDER_SCOPE: &str = "so.epicenter.capture";

/// A managed folder name is at most this many bytes (ADR-0488).
const MAX_FOLDER_NAME_BYTES: usize = 128;

/// Windows device basenames. Windows resolves `con.example` to the `CON`
/// device, so the label before the first dot must not be one of these.
const WINDOWS_DEVICE_NAMES: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// Check one ID against the managed folder-name rules: two or more
/// dot-separated lowercase ASCII labels, each starting and ending with a letter
/// or digit and otherwise holding letters, digits, and hyphens; at most 128
/// bytes; no Windows device basename before the first dot. Nothing is escaped,
/// case-folded, or renamed.
pub(crate) fn check_folder_name(id: &str) -> Result<()> {
    if id.len() > MAX_FOLDER_NAME_BYTES {
        bail!("installed app id is longer than {MAX_FOLDER_NAME_BYTES} bytes: {id:?}");
    }
    let labels: Vec<&str> = id.split('.').collect();
    let is_edge = |byte: u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
    let well_formed = labels.len() >= 2
        && labels.iter().all(|label| {
            let bytes = label.as_bytes();
            match (bytes.first(), bytes.last()) {
                (Some(&first), Some(&last)) => {
                    is_edge(first)
                        && is_edge(last)
                        && bytes.iter().all(|&byte| is_edge(byte) || byte == b'-')
                }
                _ => false,
            }
        });
    if !well_formed {
        bail!(
            "installed app id must be two or more lowercase dot-separated labels: {id:?}"
        );
    }
    if WINDOWS_DEVICE_NAMES.contains(&labels[0]) {
        bail!("installed app id begins with a reserved Windows device name: {id:?}");
    }
    Ok(())
}

/// Validate the installed IDs one ready frame names. Any invalid, duplicated,
/// or compiled-scope ID refuses the whole frame, so membership is never a
/// partial reading of what Bun sent.
pub(crate) fn validate_installed_ids(ids: Vec<String>) -> Result<Vec<String>> {
    let mut seen = BTreeSet::new();
    for id in &ids {
        check_folder_name(id)?;
        if id == TODOS_FOLDER_SCOPE || id == CAPTURE_FOLDER_SCOPE {
            bail!("installed app id names a compiled application's folder: {id:?}");
        }
        if !seen.insert(id.as_str()) {
            bail!("installed app id appears more than once: {id:?}");
        }
    }
    Ok(ids)
}

/// Make `<folder_dir>/<id>` exist and return it.
///
/// `folder_dir` is the root native startup captured; it is created when
/// missing and may itself be a link a person chose. The app's directory must
/// be a real directory: a symbolic link or a file there is refused, so the
/// folder never resolves outside the managed layout. This is checked when the
/// window opens; it does not defend against a later swap.
pub(crate) fn prepare_folder(folder_dir: &Path, id: &str) -> Result<PathBuf> {
    check_folder_name(id)?;
    fs::create_dir_all(folder_dir)
        .with_context(|| format!("create the folder root at {}", folder_dir.display()))?;
    if !folder_dir.is_dir() {
        bail!("the folder root at {} is not a directory", folder_dir.display());
    }
    let root = folder_dir.join(id);
    ensure_real_directory(&root)?;
    Ok(root)
}

/// Whether `path` is a real directory, `false` when nothing is there. A link
/// or a file there is refused rather than reported missing.
fn is_real_directory(path: &Path) -> Result<bool> {
    let kind = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata.file_type(),
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(error).with_context(|| format!("inspect {}", path.display()));
        }
    };
    if kind.is_symlink() {
        bail!("{} is a symbolic link, not a folder Epicenter manages", path.display());
    }
    if !kind.is_dir() {
        bail!("{} is not a directory", path.display());
    }
    Ok(true)
}

fn ensure_real_directory(path: &Path) -> Result<()> {
    match fs::create_dir(path) {
        Ok(()) => return Ok(()),
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
        Err(error) => {
            return Err(error).with_context(|| format!("create {}", path.display()));
        }
    }
    if !is_real_directory(path)? {
        bail!("{} disappeared while it was being prepared", path.display());
    }
    Ok(())
}

/// Prepare an installed app's folder and register it for exactly its window,
/// once for the native process.
///
/// `registered` holds the IDs already registered and outlives Bun restarts,
/// because the Folder plugin keeps a scope for the process lifetime and
/// refuses to register one twice; the path never changes, so the first
/// registration stays right. An ID is inserted only after registration
/// succeeds, so a refused attempt is retried by the next launch. The directory
/// is prepared on every launch that creates the window, so a deleted folder is
/// recreated and a swapped link is refused before that window opens.
///
/// The caller has already checked that the active Bun generation named `id`;
/// this function grants whatever ID it is given.
pub(crate) fn ensure_folder<R: Runtime>(
    app: &AppHandle<R>,
    registered: &Mutex<BTreeSet<String>>,
    folder_dir: &Path,
    id: &str,
    window: &str,
) -> Result<()> {
    let root = prepare_folder(folder_dir, id)?;
    let mut registered = registered
        .lock()
        .expect("installed folder registry lock poisoned");
    if registered.contains(id) {
        return Ok(());
    }
    let mut folder = FolderConfig::new(
        root,
        Author {
            name: id.to_string(),
            email: format!("{id}@localhost"),
        },
    );
    folder.use_repository_author = true;
    folder.use_repository_origin = true;
    app.folders()
        .register(ScopeConfig {
            scope: id.to_string(),
            folder,
            windows: vec![window.to_string()],
        })
        .map_err(anyhow::Error::msg)
        .with_context(|| format!("register the folder for {id}"))?;
    registered.insert(id.to_string());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct TempDirectory(PathBuf);

    impl Drop for TempDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn temp(label: &str) -> TempDirectory {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "epicenter-installed-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        TempDirectory(path)
    }

    #[test]
    fn folder_names_follow_the_managed_rules() {
        for accepted in [
            "so.epicenter.zhongwen",
            "com.example.notes",
            "a.b",
            "x1.y-2.z3",
            "console.example",
            "com10.example",
            "example.con",
        ] {
            check_folder_name(accepted)
                .unwrap_or_else(|error| panic!("{accepted:?} refused: {error:#}"));
        }
        let longest = format!("a.{}", "b".repeat(MAX_FOLDER_NAME_BYTES - 2));
        assert_eq!(longest.len(), MAX_FOLDER_NAME_BYTES);
        check_folder_name(&longest).unwrap();

        let too_long = format!("{longest}b");
        for denied in [
            "",
            "zhongwen",
            "So.epicenter.zhongwen",
            "so..epicenter",
            ".so.epicenter",
            "so.epicenter.",
            "so.-epicenter",
            "so.epicenter-",
            "so_epicenter.app",
            "so.epicenter/app",
            "so.epicenter\\app",
            "so.épicenter",
            "con.example",
            "prn.example",
            "aux.example",
            "nul.example",
            "com1.example",
            "com9.example",
            "lpt1.example",
            "lpt9.example",
            too_long.as_str(),
        ] {
            assert!(check_folder_name(denied).is_err(), "{denied:?} accepted");
        }
    }

    #[test]
    fn a_frame_with_an_invalid_duplicate_or_compiled_id_is_refused_whole() {
        assert_eq!(
            validate_installed_ids(vec![
                "com.example.notes".into(),
                "so.epicenter.zhongwen".into()
            ])
            .unwrap(),
            ["com.example.notes", "so.epicenter.zhongwen"]
        );
        assert!(validate_installed_ids(Vec::new()).unwrap().is_empty());
        for invalid in [
            vec!["com.example.notes".to_string(), "com.example.notes".to_string()],
            vec!["com.example.notes".to_string(), "notes".to_string()],
            vec!["lpt3.example".to_string()],
            vec![TODOS_FOLDER_SCOPE.to_string()],
            vec![CAPTURE_FOLDER_SCOPE.to_string()],
        ] {
            assert!(validate_installed_ids(invalid.clone()).is_err(), "{invalid:?}");
        }
    }

    #[test]
    fn the_folder_is_created_under_the_captured_root() {
        let directory = temp("fresh");
        let folder_dir = directory.0.join("Epicenter Dev");

        let root = prepare_folder(&folder_dir, "so.epicenter.zhongwen").unwrap();

        assert_eq!(root, folder_dir.join("so.epicenter.zhongwen"));
        assert!(root.is_dir());
        // Nothing is created inside it: the Folder owner lays it out.
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        // Preparing again keeps what is there.
        fs::write(root.join("note.md"), "kept").unwrap();
        assert_eq!(prepare_folder(&folder_dir, "so.epicenter.zhongwen").unwrap(), root);
        assert_eq!(fs::read_to_string(root.join("note.md")).unwrap(), "kept");
    }

    #[test]
    fn a_file_where_the_folder_belongs_is_refused() {
        let directory = temp("leaf-file");
        let folder_dir = directory.0.clone();
        let leaf = folder_dir.join("so.epicenter.zhongwen");
        fs::write(&leaf, "not a folder").unwrap();
        assert!(prepare_folder(&folder_dir, "so.epicenter.zhongwen").is_err());
        assert_eq!(fs::read_to_string(&leaf).unwrap(), "not a folder");
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_folder_is_refused() {
        let directory = temp("linked-leaf");
        let elsewhere = directory.0.join("elsewhere");
        fs::create_dir(&elsewhere).unwrap();
        let folder_dir = directory.0.join("root");
        fs::create_dir_all(&folder_dir).unwrap();
        std::os::unix::fs::symlink(&elsewhere, folder_dir.join("so.epicenter.zhongwen")).unwrap();
        assert!(prepare_folder(&folder_dir, "so.epicenter.zhongwen").is_err());
        assert_eq!(fs::read_dir(&elsewhere).unwrap().count(), 0);

        // The captured root itself may be a link a person chose.
        let directory = temp("linked-root");
        let real = directory.0.join("real");
        fs::create_dir(&real).unwrap();
        let alias = directory.0.join("alias");
        std::os::unix::fs::symlink(&real, &alias).unwrap();
        let root = prepare_folder(&alias, "so.epicenter.zhongwen").unwrap();
        assert_eq!(root, alias.join("so.epicenter.zhongwen"));
        assert!(real.join("so.epicenter.zhongwen").is_dir());
    }

    #[test]
    fn an_id_outside_the_rules_creates_nothing() {
        let directory = temp("invalid");
        let folder_dir = directory.0.join("root");
        assert!(prepare_folder(&folder_dir, "../escape").is_err());
        assert!(prepare_folder(&folder_dir, "con.example").is_err());
        assert!(!folder_dir.exists());
    }

    #[test]
    fn a_folder_is_registered_once_for_its_window_and_only_after_success() {
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_epicenter_folder::init())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let handle = app.handle();
        let registered = Mutex::new(BTreeSet::new());
        let directory = temp("register");
        let id = "so.epicenter.zhongwen";

        let window = "app-so_epicenter_zhongwen";
        ensure_folder(handle, &registered, &directory.0, id, window).unwrap();
        // The plugin refuses a second registration of one scope, so a second
        // launch, including one after a Bun restart, must not ask again.
        ensure_folder(handle, &registered, &directory.0, id, window).unwrap();
        assert_eq!(registered.lock().unwrap().iter().collect::<Vec<_>>(), [id]);

        // A refused preparation registers nothing and records nothing.
        let blocked = temp("register-blocked");
        fs::write(blocked.0.join("com.example.notes"), "not a folder").unwrap();
        assert!(ensure_folder(
            handle,
            &registered,
            &blocked.0,
            "com.example.notes",
            "app-com_example_notes"
        )
        .is_err());
        assert!(!registered.lock().unwrap().contains("com.example.notes"));

        // A refused registration is not recorded, so the next launch retries.
        handle
            .folders()
            .register(ScopeConfig {
                scope: "com.example.taken".into(),
                folder: FolderConfig::new(
                    directory.0.join("elsewhere"),
                    Author {
                        name: "Other".into(),
                        email: "other@localhost".into(),
                    },
                ),
                windows: vec!["other".into()],
            })
            .unwrap();
        assert!(ensure_folder(
            handle,
            &registered,
            &directory.0,
            "com.example.taken",
            "app-com_example_taken"
        )
        .is_err());
        assert!(!registered.lock().unwrap().contains("com.example.taken"));
    }
}
