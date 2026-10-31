//! Which roots a page may open beside its window's own directory: the ones
//! Tauri's runtime file-system scope allows (`tauri-plugin-fs`'s
//! `FsExt::fs_scope`), and never one of the folders no app keeps its files
//! in.
//!
//! The runtime scope is Tauri's own grant: the shell allows an app's default
//! folder there at startup, the dialog plugin's `open` allows the folder a
//! person picks, and `tauri-plugin-persisted-scope` keeps those across
//! launches. An app that does not register `tauri-plugin-fs` has no runtime
//! scope, and its windows reach only their own directories.
//!
//! Even an allowed root is refused when it is a place no app keeps its files
//! in (`Refusals`): the top of a disk, the home folder, a `.git` folder,
//! Epicenter's own records and settings, or a folder holding the app's own
//! data directory.

use std::path::{Path, PathBuf};

use epicenter_folder_core::library::{resolved, RECORDS};
use tauri::{Manager, Runtime, Webview};
use tauri_plugin_fs::FsExt;

use crate::{Directory, WindowError};

/// Admit `root` for the calling window: refused (`Refusals`), not allowed by
/// Tauri's runtime file-system scope (`NotGranted`), or missing (`Missing`,
/// unless `create`, which makes it and its missing parents), in that order.
pub(crate) fn admit<R: Runtime>(
    webview: &Webview<R>,
    root: &str,
    create: bool,
) -> Result<Directory, WindowError> {
    let path = Path::new(root);
    if let Some(reason) = Refusals::resolve(webview)?.refusal(path) {
        return Err(WindowError::Refused {
            root: root.to_string(),
            reason,
        });
    }
    let allowed = webview
        .try_fs_scope()
        .is_some_and(|scope| scope.is_allowed(path) && !scope.is_forbidden(path));
    if !allowed {
        return Err(WindowError::NotGranted {
            root: root.to_string(),
        });
    }
    if create {
        return Directory::create(path).map_err(|error| WindowError::Unavailable {
            message: format!("{root} could not be made: {error}"),
        });
    }
    if !path.exists() {
        return Err(WindowError::Missing);
    }
    Directory::existing(path).map_err(|error| WindowError::Unavailable {
        message: format!("{root}: {error}"),
    })
}

/// The folders no app keeps its files in, on this machine.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusals {
    /// The person's home directory, never a folder itself.
    pub home: PathBuf,
    /// Epicenter's own records (`~/Epicenter/so.epicenter`, and the same in
    /// `~/Epicenter Dev`) and its application data and configuration
    /// directories: never a folder, never inside or around one.
    pub epicenter_own: Vec<PathBuf>,
    /// This app's own data directory, never inside a folder.
    pub app_data: PathBuf,
}

impl Refusals {
    pub fn resolve<R: Runtime, M: Manager<R>>(manager: &M) -> Result<Self, WindowError> {
        let path = manager.path();
        let failed = |error: tauri::Error| WindowError::Unavailable {
            message: error.to_string(),
        };
        let home = path.home_dir().map_err(failed)?;
        let mut epicenter_own = vec![
            home.join("Epicenter").join(RECORDS.id),
            home.join("Epicenter Dev").join(RECORDS.id),
        ];
        for base in [path.data_dir(), path.config_dir(), path.local_data_dir()] {
            let base = base.map_err(failed)?;
            epicenter_own.push(base.join("so.epicenter"));
            epicenter_own.push(base.join("so.epicenter.dev"));
        }
        Ok(Self {
            home,
            epicenter_own,
            app_data: path.app_data_dir().map_err(failed)?,
        })
    }

    /// Why `folder` cannot be a root, in one line, or `None`.
    pub fn refusal(&self, folder: &Path) -> Option<String> {
        let shown = folder.display();
        if !folder.is_absolute() {
            return Some(format!("{shown} is not a full path to a folder."));
        }
        let candidate = resolved(folder);
        if candidate.parent().is_none() {
            return Some(format!(
                "{shown} is the top of a disk; choose a folder inside it."
            ));
        }
        if candidate == resolved(&self.home) {
            return Some(format!(
                "{shown} is your home folder; choose a folder inside it."
            ));
        }
        if candidate
            .components()
            .any(|part| part.as_os_str() == ".git")
        {
            return Some(format!(
                "{shown} is inside a Git repository's own .git folder."
            ));
        }
        for own in &self.epicenter_own {
            let own = resolved(own);
            if candidate.starts_with(&own) || own.starts_with(&candidate) {
                return Some(format!(
                    "{shown} holds Epicenter's own records or settings."
                ));
            }
        }
        if resolved(&self.app_data).starts_with(&candidate) {
            return Some(format!("{shown} holds this app's own settings."));
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsafe_folders_are_refused_each_in_one_line() {
        let temp = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(temp.path()).unwrap();
        let home = base.join("home");
        let support = home.join("Library/Application Support");
        let refusals = Refusals {
            home: home.clone(),
            epicenter_own: vec![
                home.join("Epicenter/so.epicenter"),
                support.join("so.epicenter"),
                support.join("so.epicenter.dev"),
            ],
            app_data: support.join("so.epicenter.notes"),
        };
        let repository = home.join("Code/app");
        std::fs::create_dir_all(repository.join(".git/objects")).unwrap();
        for (refused, why) in [
            (PathBuf::from("/"), "is the top of a disk"),
            (home.clone(), "is your home folder"),
            (
                home.join("Epicenter/so.epicenter"),
                "Epicenter's own records",
            ),
            (
                home.join("Epicenter/so.epicenter/connections"),
                "Epicenter's own records",
            ),
            (home.join("Epicenter"), "Epicenter's own records"),
            (support.join("so.epicenter.dev"), "Epicenter's own records"),
            (support.clone(), "Epicenter's own records"),
            (
                support.join("so.epicenter.notes"),
                "this app's own settings",
            ),
            (repository.join(".git"), "own .git folder"),
            (repository.join(".git/objects"), "own .git folder"),
            (PathBuf::from("relative/Notes"), "not a full path"),
        ] {
            let refusal = refusals
                .refusal(&refused)
                .unwrap_or_else(|| panic!("{} should be refused", refused.display()));
            assert!(refusal.contains(why), "{refusal}");
            assert!(!refusal.contains('\n'), "{refusal}");
        }
        // The default place, any ordinary folder, and a repository's working
        // tree are accepted.
        for accepted in [
            home.join("Epicenter/Notes"),
            home.join("Documents/Notes"),
            repository,
        ] {
            assert_eq!(refusals.refusal(&accepted), None, "{}", accepted.display());
        }
    }
}
