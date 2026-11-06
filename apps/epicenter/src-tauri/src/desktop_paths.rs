//! Where Epicenter keeps what it keeps, resolved once at startup: the
//! Epicenter folder (`~/Epicenter`, or `~/Epicenter Dev` in development),
//! whose every directory is a folder (ADR-0813), and the app's own data, the
//! operating system's application data directory for its identifier, which
//! holds the sign-in's credentials and this computer's settings. The
//! environment comes from the configuration (`tauri.dev.conf.json` states
//! development), never from the identifier.

use std::path::{Path, PathBuf};

use epicenter_standalone::data_folder::{self, Environment};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_epicenter_folder::admission::{check_sync_directory, resolved};

/// Epicenter's places on this computer.
#[derive(Debug, Clone)]
pub struct DesktopPaths {
    /// The person's home folder, which no folder may be or hold.
    pub home: PathBuf,
    /// The Epicenter folder: `~/Epicenter`, or `~/Epicenter Dev`.
    pub epicenter: PathBuf,
    /// The app's own data: credentials, `account.json`, settings.
    pub app_data: PathBuf,
}

impl DesktopPaths {
    pub fn resolve<R: Runtime>(app: &AppHandle<R>) -> Result<Self, String> {
        let environment =
            Environment::from_config(app.config().plugins.0.get(data_folder::CONFIG_KEY))
                .map_err(|error| error.to_string())?;
        let home = app.path().home_dir().map_err(|error| error.to_string())?;
        let app_data = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?;
        Ok(Self {
            epicenter: data_folder::root(&home, environment),
            home,
            app_data,
        })
    }

    /// Why `location`, where a folder in the Epicenter folder resolves, can
    /// never be a folder: the home folder or one holding it, or inside,
    /// equal to, or holding the app's own data. The folder plugin adds the
    /// Epicenter folder itself and `.git` or `.epicenter` (`Root::Folder`).
    pub fn folder_refusal(&self, location: &Path) -> Option<String> {
        if resolved(&self.home).starts_with(location) {
            return Some(format!(
                "{} is your home folder or holds it, so it cannot be a folder.",
                location.display()
            ));
        }
        check_sync_directory(&self.app_data, &self.epicenter, location).err()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shipped_epicenter_configs_select_their_environment() {
        let home = std::env::temp_dir().join("epicenter-home");
        for (config, expected, folder) in [
            (
                include_str!("../tauri.conf.json"),
                Environment::Production,
                "Epicenter",
            ),
            (
                include_str!("../tauri.dev.conf.json"),
                Environment::Development,
                "Epicenter Dev",
            ),
        ] {
            let config: serde_json::Value = serde_json::from_str(config).unwrap();
            let environment =
                Environment::from_config(config["plugins"].get(data_folder::CONFIG_KEY)).unwrap();
            assert_eq!(environment, expected);
            assert_eq!(data_folder::root(&home, environment), home.join(folder));
        }
    }

    #[test]
    fn unknown_environments_fail() {
        assert!(
            Environment::from_config(Some(&serde_json::json!({"environment": "staging"}))).is_err()
        );
    }

    #[test]
    fn a_folder_is_never_the_home_folder_or_the_apps_data() {
        let temp = tempfile::tempdir().unwrap();
        let home = dunce::canonicalize(temp.path()).unwrap();
        let paths = DesktopPaths {
            epicenter: home.join("Epicenter"),
            app_data: home.join("Library/Application Support/so.epicenter"),
            home: home.clone(),
        };
        std::fs::create_dir_all(&paths.app_data).unwrap();
        assert!(paths.folder_refusal(&home).is_some());
        assert!(paths.folder_refusal(&paths.app_data).is_some());
        assert!(paths
            .folder_refusal(&home.join("Library/Application Support"))
            .is_some());
        assert_eq!(paths.folder_refusal(&home.join("Notes")), None);
    }
}
