//! Paths selected once at desktop startup and handed to the `epicenter` CLI.
//!
//! The running bundle identifier selects the native data directory, the cache
//! directory, and a stable checkout folder name. Explicit overrides win before
//! any platform lookup.
//!
//! What a person or an agent reads, edits, or versions lives under
//! `folder_dir`; what only Epicenter writes, and what this machine alone
//! needs, lives in `data_dir` or, when losing it costs only a rebuild, in
//! `cache_dir` (ADR-0539).

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use tauri::{AppHandle, Manager, Runtime};

/// Immutable for the desktop lifetime.
#[derive(Debug)]
pub struct DesktopPaths {
    pub data_dir: PathBuf,
    pub folder_dir: PathBuf,
    /// Disposable: built app bundles, which a rebuild makes again.
    pub cache_dir: PathBuf,
}

impl DesktopPaths {
    pub fn resolve<R: Runtime>(app: &AppHandle<R>) -> Result<Self> {
        let data_dir = resolve_directory(
            "EPICENTER_DATA_DIR",
            std::env::var_os("EPICENTER_DATA_DIR").as_deref(),
            || {
                app.path()
                    .app_local_data_dir()
                    .context("resolve local application data")
            },
        )?;
        let folder_dir = resolve_directory(
            "EPICENTER_FOLDER_DIR",
            std::env::var_os("EPICENTER_FOLDER_DIR").as_deref(),
            || {
                let name = checkout_folder_name(&app.config().identifier)?;
                Ok(app
                    .path()
                    .home_dir()
                    .context("resolve the home directory")?
                    .join(name))
            },
        )?;
        let cache_dir = resolve_directory(
            "EPICENTER_CACHE_DIR",
            std::env::var_os("EPICENTER_CACHE_DIR").as_deref(),
            || {
                app.path()
                    .app_cache_dir()
                    .context("resolve the cache directory")
            },
        )?;
        // Paths must round-trip exactly through the CLI's environment; refuse
        // unrepresentable ones before anything touches a root.
        for path in [&data_dir, &folder_dir, &cache_dir] {
            path.to_str()
                .context("desktop directories must be valid UTF-8")?;
        }
        Ok(Self {
            data_dir,
            folder_dir,
            cache_dir,
        })
    }

    /// Built app bundles, at `<app-id>/<commit>/`. The `epicenter` CLI
    /// writes them, and `approvals.json` in `data_dir`, from the same
    /// directories, which the shell hands it (`installed_apps.rs`).
    pub fn builds_dir(&self) -> PathBuf {
        self.cache_dir.join("builds")
    }

    /// Installed apps' sources, one repository each at `<app-id>/`. Beside
    /// the data folders, never inside one (ADR-0539).
    pub fn apps_dir(&self) -> PathBuf {
        self.folder_dir.join(APPS_DIRECTORY)
    }
}

/// The directory under the folder root that holds installed apps' sources.
/// It holds no `epicenter.json`, so the folder listing skips it.
pub const APPS_DIRECTORY: &str = "Apps";

/// These names are durable destinations, independent of the app's display name.
fn checkout_folder_name(identifier: &str) -> Result<&'static str> {
    match identifier {
        "so.epicenter" => Ok("Epicenter"),
        "so.epicenter.dev" => Ok("Epicenter Dev"),
        _ => bail!("No checkout folder for {identifier}; set EPICENTER_FOLDER_DIR explicitly"),
    }
}

fn resolve_directory(
    variable: &str,
    override_value: Option<&OsStr>,
    platform_directory: impl FnOnce() -> Result<PathBuf>,
) -> Result<PathBuf> {
    match override_value {
        Some(value) if !value.is_empty() => {
            let path = Path::new(value);
            if !path.is_absolute() {
                bail!("{variable} must be an absolute path, not {value:?}.");
            }
            Ok(path.to_path_buf())
        }
        _ => platform_directory(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_absolute_override_wins_without_resolving_the_platform_directory() {
        let directory = std::env::temp_dir().join("epicenter-test");
        for variable in [
            "EPICENTER_DATA_DIR",
            "EPICENTER_FOLDER_DIR",
            "EPICENTER_CACHE_DIR",
        ] {
            assert_eq!(
                resolve_directory(variable, Some(directory.as_os_str()), || panic!(
                    "override wins"
                ))
                .unwrap(),
                directory,
            );
        }
    }

    #[test]
    fn empty_overrides_use_the_default_and_relative_overrides_fail() {
        for variable in [
            "EPICENTER_DATA_DIR",
            "EPICENTER_FOLDER_DIR",
            "EPICENTER_CACHE_DIR",
        ] {
            for value in [None, Some(OsStr::new(""))] {
                assert_eq!(
                    resolve_directory(variable, value, || Ok(std::env::temp_dir())).unwrap(),
                    std::env::temp_dir()
                );
            }
            let error = resolve_directory(variable, Some(OsStr::new("relative/data")), || {
                panic!("relative override must fail")
            })
            .unwrap_err();
            assert!(error.to_string().contains(variable));
            assert!(error.to_string().contains("absolute"));
        }
    }

    #[test]
    fn release_and_development_configs_select_separate_data_and_checkout_directories() {
        let mut roots = Vec::new();
        for (config, folder) in [
            (include_str!("../tauri.conf.json"), "Epicenter"),
            (include_str!("../tauri.dev.conf.json"), "Epicenter Dev"),
        ] {
            let config: serde_json::Value = serde_json::from_str(config).unwrap();
            let identifier = config["identifier"].as_str().unwrap();
            let mut context = tauri::test::mock_context(tauri::test::noop_assets());
            context.config_mut().identifier = identifier.to_owned();
            let app = tauri::test::mock_builder().build(context).unwrap();
            let root = app.path().app_local_data_dir().unwrap();
            assert_eq!(root.file_name().unwrap(), identifier);
            let cache = app.path().app_cache_dir().unwrap();
            assert_eq!(cache.file_name().unwrap(), identifier);
            assert_ne!(cache, root);
            assert_eq!(checkout_folder_name(identifier).unwrap(), folder);
            roots.push((root, cache));
        }
        assert_ne!(roots[0], roots[1]);
        assert!(checkout_folder_name("unconfigured.app").is_err());
    }

    #[test]
    fn machine_state_and_sources_split_by_what_they_cost_to_lose() {
        let paths = DesktopPaths {
            data_dir: PathBuf::from("/support/so.epicenter"),
            folder_dir: PathBuf::from("/home/Epicenter"),
            cache_dir: PathBuf::from("/caches/so.epicenter"),
        };
        assert_eq!(paths.builds_dir(), Path::new("/caches/so.epicenter/builds"));
        assert_eq!(paths.apps_dir(), Path::new("/home/Epicenter/Apps"));
    }
}
