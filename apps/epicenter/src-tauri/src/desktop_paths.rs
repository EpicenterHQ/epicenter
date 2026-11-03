//! Epicenter's machine-local application data and library root, resolved
//! once at startup. The shell passes its data directory and environment to
//! each `epicenter` command, which derives the same root. Window binding and
//! explicitly chosen directories do not depend on them. Standalone apps use
//! neither. A terminal's `epicenter` follows the same rule
//! (`packages/cli/src/app-paths.ts`).

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use epicenter_standalone::data_folder::{self, Environment};
use tauri::{AppHandle, Manager, Runtime};

/// Epicenter's machine-local application data and the library root.
#[derive(Debug, Clone)]
pub struct DesktopPaths {
    pub data_dir: PathBuf,
    /// The library root: `~/Epicenter` or `~/Epicenter Dev`.
    pub folder_dir: PathBuf,
    /// The engine shared by this environment's apps and Git configuration.
    pub engine: PathBuf,
    pub environment: Environment,
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
        let environment =
            Environment::from_config(app.config().plugins.0.get(data_folder::CONFIG_KEY))
                .map_err(|error| error.to_string())?;
        let home = app.path().home_dir().map_err(|error| error.to_string())?;
        let folder_dir = resolve_folder_root(environment, || Ok(home.clone()))?;
        let engine = engine_path(&home, environment);
        for path in [&data_dir, &folder_dir, &engine] {
            path.to_str()
                .ok_or("Desktop directories must be valid UTF-8.")?;
        }
        Ok(Self {
            data_dir,
            folder_dir,
            engine,
            environment,
        })
    }
}

fn engine_path(home: &Path, environment: Environment) -> PathBuf {
    let machine_home = match environment {
        Environment::Production => ".epicenter",
        Environment::Development => ".epicenter-dev",
    };
    home.join(machine_home).join("bin").join(if cfg!(windows) {
        "epicenter.exe"
    } else {
        "epicenter"
    })
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

/// Resolve the authored root before opening any app windows. The configuration
/// states the environment. This computes a path and makes nothing.
fn resolve_folder_root(
    environment: Environment,
    home: impl FnOnce() -> Result<PathBuf, String>,
) -> Result<PathBuf, String> {
    Ok(data_folder::root(&home()?, environment))
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
        for (config, name, expected) in [
            (
                include_str!("../tauri.conf.json"),
                "Epicenter",
                Environment::Production,
            ),
            (
                include_str!("../tauri.dev.conf.json"),
                "Epicenter Dev",
                Environment::Development,
            ),
        ] {
            let config: serde_json::Value = serde_json::from_str(config).unwrap();
            let environment =
                Environment::from_config(config["plugins"].get(data_folder::CONFIG_KEY)).unwrap();
            assert_eq!(environment, expected);
            assert_eq!(
                resolve_folder_root(environment, || Ok(home.clone())).unwrap(),
                home.join(name)
            );
            assert_eq!(
                engine_path(&home, environment),
                home.join(if environment == Environment::Production {
                    ".epicenter"
                } else {
                    ".epicenter-dev"
                })
                .join("bin")
                .join(if cfg!(windows) {
                    "epicenter.exe"
                } else {
                    "epicenter"
                })
            );
        }
    }

    #[test]
    fn missing_home_and_unknown_environments_fail() {
        assert!(
            Environment::from_config(Some(&serde_json::json!({"environment": "staging"}))).is_err()
        );
        assert_eq!(
            resolve_folder_root(Environment::Production, || Err("no home".to_string())),
            Err("no home".to_string())
        );
    }
}
