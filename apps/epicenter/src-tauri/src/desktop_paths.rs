//! Epicenter's machine-local application data and its library root, which
//! the shell resolves once at startup and passes to every `epicenter`
//! command it runs. Window binding and explicitly chosen directories do not
//! depend on them. The apps on `epicenter-standalone` use neither: each
//! keeps its data folder at `~/Epicenter/<productName>`. A terminal's
//! `epicenter` follows the same rule (`packages/cli/src/app-paths.ts`).

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime};

/// Epicenter's machine-local application data and the library root.
#[derive(Debug, Clone)]
pub struct DesktopPaths {
    pub data_dir: PathBuf,
    /// The library root: `~/Epicenter`, `~/Epicenter Dev`, or
    /// `EPICENTER_FOLDER_DIR`.
    pub folder_dir: PathBuf,
}

impl DesktopPaths {
    pub fn resolve<R: Runtime>(app: &AppHandle<R>) -> Result<Self, String> {
        let data_dir = resolve_data_dir(
            &app.config().identifier,
            std::env::var_os("EPICENTER_DATA_DIR").as_deref(),
            || {
                app.path()
                    .local_data_dir()
                    .map_err(|error| error.to_string())
            },
        )?;
        let folder_dir = resolve_folder_root(
            &app.config().identifier,
            std::env::var_os("EPICENTER_FOLDER_DIR").as_deref(),
            || app.path().home_dir().map_err(|error| error.to_string()),
        )?;
        for path in [&data_dir, &folder_dir] {
            path.to_str()
                .ok_or("Desktop directories must be valid UTF-8.")?;
        }
        Ok(Self {
            data_dir,
            folder_dir,
        })
    }
}

fn resolve_data_dir(
    identifier: &str,
    value: Option<&OsStr>,
    base: impl FnOnce() -> Result<PathBuf, String>,
) -> Result<PathBuf, String> {
    resolve_directory("EPICENTER_DATA_DIR", value, || {
        let scope = match identifier {
            "so.epicenter" => "so.epicenter",
            "so.epicenter.dev" => "so.epicenter.dev",
            identifier => {
                return Err(format!(
                "No shared configuration scope for {identifier}; set EPICENTER_DATA_DIR explicitly"
            ))
            }
        };
        Ok(base()?.join(scope))
    })
}

fn resolve_directory(
    variable: &str,
    value: Option<&OsStr>,
    fallback: impl FnOnce() -> Result<PathBuf, String>,
) -> Result<PathBuf, String> {
    match value.filter(|value| !value.is_empty()) {
        Some(value) => {
            let path = Path::new(value);
            if !path.is_absolute() {
                return Err(format!(
                    "{variable} must be an absolute path, not {value:?}."
                ));
            }
            Ok(path.to_path_buf())
        }
        None => fallback(),
    }
}

/// Resolve the authored root before opening any app windows. A nonempty,
/// absolute `EPICENTER_FOLDER_DIR` wins without looking up the home directory.
/// Otherwise the bundle's storage environment selects `~/Epicenter` or
/// `~/Epicenter Dev`. This computes a path and makes nothing.
fn resolve_folder_root(
    identifier: &str,
    override_value: Option<&OsStr>,
    home: impl FnOnce() -> Result<PathBuf, String>,
) -> Result<PathBuf, String> {
    resolve_directory("EPICENTER_FOLDER_DIR", override_value, || {
        let name = match identifier {
            "so.epicenter" => "Epicenter",
            "so.epicenter.dev" => "Epicenter Dev",
            _ => {
                return Err(format!(
                    "No authored root for {identifier}; set EPICENTER_FOLDER_DIR explicitly"
                ))
            }
        };
        Ok(home()?.join(name))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_and_development_keep_separate_machine_configuration() {
        let base = std::env::temp_dir().join("application-support");
        for (identifier, scope) in [
            ("so.epicenter", "so.epicenter"),
            ("so.epicenter.dev", "so.epicenter.dev"),
        ] {
            assert_eq!(
                resolve_data_dir(identifier, None, || Ok(base.clone())).unwrap(),
                base.join(scope)
            );
            assert_eq!(
                resolve_data_dir(identifier, Some(base.as_os_str()), || panic!(
                    "override wins"
                ))
                .unwrap(),
                base
            );
            assert!(
                resolve_data_dir(identifier, Some(OsStr::new("relative")), || panic!(
                    "reject before lookup"
                ))
                .is_err()
            );
        }
    }

    #[test]
    fn shipped_epicenter_configs_select_their_library_root() {
        let home = std::env::temp_dir().join("epicenter-home");
        for (config, name) in [
            (include_str!("../tauri.conf.json"), "Epicenter"),
            (include_str!("../tauri.dev.conf.json"), "Epicenter Dev"),
        ] {
            let config: serde_json::Value = serde_json::from_str(config).unwrap();
            let identifier = config["identifier"].as_str().unwrap();
            for value in [None, Some(OsStr::new(""))] {
                let root = resolve_folder_root(identifier, value, || Ok(home.clone())).unwrap();
                assert_eq!(root, home.join(name));
            }
            let elsewhere = home.join("elsewhere");
            let root = resolve_folder_root(identifier, Some(elsewhere.as_os_str()), || {
                panic!("an explicit root does not need the home directory")
            })
            .unwrap();
            assert_eq!(root, elsewhere);
        }
    }

    #[test]
    fn invalid_overrides_and_unknown_environments_fail_without_resolving_home() {
        let no_home = || panic!("home must not be resolved");
        let error =
            resolve_folder_root("so.epicenter", Some(OsStr::new("relative")), no_home).unwrap_err();
        assert!(error.contains("EPICENTER_FOLDER_DIR must be an absolute path"));
        assert!(resolve_folder_root("unknown", None, no_home).is_err());
        let explicit = std::env::temp_dir().join("explicit-root");
        assert_eq!(
            resolve_folder_root("unknown", Some(explicit.as_os_str()), no_home).unwrap(),
            explicit
        );
        assert_eq!(
            resolve_folder_root("so.epicenter", None, || Err("no home".to_string())),
            Err("no home".to_string())
        );
    }
}
