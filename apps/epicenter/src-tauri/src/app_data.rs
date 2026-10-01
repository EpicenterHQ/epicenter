//! Paths selected once at desktop startup and shared with the Bun sidecar.
//!
//! The running bundle identifier selects the native data directory and a stable
//! checkout folder name. Explicit overrides win before any platform lookup.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

/// Immutable for the desktop lifetime, including sidecar restarts.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPaths {
    pub data_dir: PathBuf,
    pub folder_dir: PathBuf,
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
        // JSON paths must round-trip exactly through Bun; refuse unrepresentable
        // paths before recorder cleanup or sidecar launch can touch either root.
        for path in [&data_dir, &folder_dir] {
            path.to_str()
                .context("desktop directories must be valid UTF-8")?;
        }
        Ok(Self {
            data_dir,
            folder_dir,
        })
    }
}

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
        for variable in ["EPICENTER_DATA_DIR", "EPICENTER_FOLDER_DIR"] {
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
        for variable in ["EPICENTER_DATA_DIR", "EPICENTER_FOLDER_DIR"] {
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
            assert_eq!(checkout_folder_name(identifier).unwrap(), folder);
            roots.push(root);
        }
        assert_ne!(roots[0], roots[1]);
        assert!(checkout_folder_name("unconfigured.app").is_err());
    }
}
