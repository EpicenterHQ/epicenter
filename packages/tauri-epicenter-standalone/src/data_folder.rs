//! Derive an app's data folder from its bundle identifier, the reversed host
//! of its production site (ADR-0722), and the build's environment, which the
//! Tauri configuration states (`Environment::from_config`). A development
//! build's identifier is the production one with `.dev` appended; only a
//! development build has that suffix removed.

use std::fmt;
use std::path::{Path, PathBuf};

use serde_json::Value;

/// Which build this is. Only the development configuration
/// (`tauri.dev.conf.json`) states one, as
/// `"plugins": { "epicenter-standalone": { "environment": "development" } }`;
/// a configuration that states none is production.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Environment {
    Production,
    Development,
}

/// The key under the configuration's `plugins` this crate reads.
pub const CONFIG_KEY: &str = "epicenter-standalone";

/// Why the configuration's `plugins.epicenter-standalone` names no
/// environment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EnvironmentError {
    /// The setting is not an object.
    NotAnObject(String),
    /// The object has a key this crate does not read.
    UnknownSetting(String),
    /// `environment` is not `"production"` or `"development"`.
    UnknownEnvironment(String),
}

impl fmt::Display for EnvironmentError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotAnObject(value) => write!(
                formatter,
                "plugins.{CONFIG_KEY} in the app's configuration is {value}, not an object"
            ),
            Self::UnknownSetting(key) => write!(
                formatter,
                "plugins.{CONFIG_KEY}.{key} in the app's configuration is not a setting"
            ),
            Self::UnknownEnvironment(value) => write!(
                formatter,
                "plugins.{CONFIG_KEY}.environment is {value}, not \"production\" or \"development\""
            ),
        }
    }
}

impl std::error::Error for EnvironmentError {}

impl Environment {
    /// The environment the configuration's `plugins.epicenter-standalone`
    /// states, given as `setting`; production when there is none.
    pub fn from_config(setting: Option<&Value>) -> Result<Self, EnvironmentError> {
        let Some(setting) = setting else {
            return Ok(Self::Production);
        };
        let Some(object) = setting.as_object() else {
            return Err(EnvironmentError::NotAnObject(setting.to_string()));
        };
        if let Some(key) = object.keys().find(|key| *key != "environment") {
            return Err(EnvironmentError::UnknownSetting(key.clone()));
        }
        match object
            .get("environment")
            .map(|value| (value, value.as_str()))
        {
            None | Some((_, Some("production"))) => Ok(Self::Production),
            Some((_, Some("development"))) => Ok(Self::Development),
            Some((value, _)) => Err(EnvironmentError::UnknownEnvironment(value.to_string())),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum FolderNameError {
    /// The identifier or host has an invalid site label.
    InvalidIdentifier(String),
    /// The host has no subdomain to name the app by.
    BareDomain(String),
    /// A label is a name Windows reserves for a device.
    ReservedLabel(String),
    /// A development build's identifier does not end in `.dev`.
    NotADevelopmentIdentifier(String),
}

impl fmt::Display for FolderNameError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidIdentifier(identifier) => {
                write!(formatter, "{identifier} has an invalid app site label")
            }
            Self::BareDomain(identifier) => write!(
                formatter,
                "{identifier} names no subdomain for the app's site"
            ),
            Self::ReservedLabel(label) => write!(formatter, "{label} is a reserved folder name"),
            Self::NotADevelopmentIdentifier(identifier) => write!(
                formatter,
                "{identifier} is a development build's identifier, which ends in .dev"
            ),
        }
    }
}

impl std::error::Error for FolderNameError {}

/// The app a bundle identifier names in an environment: its site's host.
#[derive(Debug, PartialEq, Eq)]
pub struct Identity {
    pub host: String,
    pub environment: Environment,
}

fn valid_labels(labels: &[&str]) -> bool {
    labels.iter().all(|label| {
        !label.is_empty()
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    })
}

/// `so.epicenter.whispering` in production is `whispering.epicenter.so`, and
/// so is `so.epicenter.whispering.dev` in development. A production
/// identifier is read whole, so `com.example.dev` is `dev.example.com`.
pub fn identity(identifier: &str, environment: Environment) -> Result<Identity, FolderNameError> {
    let site = match environment {
        Environment::Production => identifier,
        Environment::Development => identifier
            .strip_suffix(".dev")
            .ok_or_else(|| FolderNameError::NotADevelopmentIdentifier(identifier.to_owned()))?,
    };
    let labels: Vec<_> = site.split('.').rev().collect();
    if !valid_labels(&labels) {
        return Err(FolderNameError::InvalidIdentifier(identifier.to_owned()));
    }
    if labels.len() < 3 {
        return Err(FolderNameError::BareDomain(identifier.to_owned()));
    }
    Ok(Identity {
        host: labels.join("."),
        environment,
    })
}

/// The relative folder named by a site's host: the label alone for a direct
/// subdomain of `epicenter.so`, `<owner>/<label>` for any other.
pub fn relative_path(host: &str) -> Result<PathBuf, FolderNameError> {
    let labels: Vec<_> = host.split('.').collect();
    if !valid_labels(&labels) {
        return Err(FolderNameError::InvalidIdentifier(host.to_owned()));
    }
    if labels.len() < 3 {
        return Err(FolderNameError::BareDomain(host.to_owned()));
    }
    for label in &labels {
        if matches!(*label, "con" | "prn" | "aux" | "nul")
            || (label.len() == 4
                && (label.starts_with("com") || label.starts_with("lpt"))
                && matches!(label.as_bytes()[3], b'1'..=b'9'))
        {
            return Err(FolderNameError::ReservedLabel((*label).to_owned()));
        }
    }
    let first = labels[0];
    if labels.len() == 3 && labels[1..] == ["epicenter", "so"] {
        Ok(PathBuf::from(first))
    } else {
        Ok(PathBuf::from(labels[1..].join(".")).join(first))
    }
}

/// The app's platform identifier, with `.dev` only for a development build.
pub fn app_data_identifier(
    host: &str,
    environment: Environment,
) -> Result<String, FolderNameError> {
    relative_path(host)?;
    let identifier = host.split('.').rev().collect::<Vec<_>>().join(".");
    Ok(match environment {
        Environment::Production => identifier,
        Environment::Development => format!("{identifier}.dev"),
    })
}

/// The library root: `~/Epicenter`, or `~/Epicenter Dev` for a development
/// build.
pub fn root(home: &Path, environment: Environment) -> PathBuf {
    home.join(match environment {
        Environment::Production => "Epicenter",
        Environment::Development => "Epicenter Dev",
    })
}

/// The data folder a bundle identifier derives under `home` in
/// `environment`.
pub fn derive(
    home: &Path,
    identifier: &str,
    environment: Environment,
) -> Result<PathBuf, FolderNameError> {
    let identity = identity(identifier, environment)?;
    Ok(root(home, environment).join(relative_path(&identity.host)?))
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;
    use serde_json::json;

    use super::Environment::{Development, Production};
    use super::*;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct NamingCase {
        identifier: String,
        environment: String,
        host: Option<String>,
        folder: Option<String>,
        app_data: Option<String>,
        error: Option<String>,
    }

    #[derive(Deserialize)]
    struct NamingRules {
        cases: Vec<NamingCase>,
        refused: Vec<NamingCase>,
    }

    #[test]
    fn naming_follows_the_shared_fixture() {
        let rules: NamingRules = serde_json::from_str(include_str!(
            "../../definition/fixtures/app-names.json"
        ))
        .unwrap();
        for case in rules.cases {
            let environment = if case.environment == "development" {
                Development
            } else {
                Production
            };
            let named = identity(&case.identifier, environment).unwrap();
            let host = case.host.unwrap();
            assert_eq!(named.host, host, "{}", case.identifier);
            assert_eq!(
                relative_path(&host).unwrap(),
                PathBuf::from(case.folder.unwrap())
            );
            assert_eq!(
                app_data_identifier(&host, environment).unwrap(),
                case.app_data.unwrap()
            );
            let home = Path::new("/home/person");
            let root_name = if environment == Development {
                "Epicenter Dev"
            } else {
                "Epicenter"
            };
            assert_eq!(
                derive(home, &case.identifier, environment).unwrap(),
                home.join(root_name).join(relative_path(&host).unwrap())
            );
        }
        for case in rules.refused {
            let environment = if case.environment == "development" {
                Development
            } else {
                Production
            };
            let result = identity(&case.identifier, environment)
                .and_then(|named| relative_path(&named.host).map(|_| named));
            let kind = match result.unwrap_err() {
                FolderNameError::InvalidIdentifier(_) => "invalidIdentifier",
                FolderNameError::BareDomain(_) => "bareDomain",
                FolderNameError::ReservedLabel(_) => "reservedLabel",
                FolderNameError::NotADevelopmentIdentifier(_) => "notDevelopmentIdentifier",
            };
            assert_eq!(kind, case.error.unwrap(), "{}", case.identifier);
        }
    }

    #[test]
    fn hosts_from_bundle_identifiers() {
        assert_eq!(
            identity("so.epicenter.whispering", Production).unwrap(),
            Identity {
                host: "whispering.epicenter.so".into(),
                environment: Production
            }
        );
        assert_eq!(
            identity("so.epicenter.whispering.dev", Development).unwrap(),
            Identity {
                host: "whispering.epicenter.so".into(),
                environment: Development
            }
        );
        assert_eq!(
            identity("com.bradenwong.zhongwen", Production)
                .unwrap()
                .host,
            "zhongwen.bradenwong.com"
        );
        for (identifier, environment) in [
            ("so.epicenter", Production),
            ("so.epicenter.dev", Development),
        ] {
            assert_eq!(
                identity(identifier, environment),
                Err(FolderNameError::BareDomain(identifier.into()))
            );
        }
        for identifier in ["com.Example.notes", "com..notes"] {
            assert_eq!(
                identity(identifier, Production),
                Err(FolderNameError::InvalidIdentifier(identifier.into()))
            );
        }
    }

    /// Only a development build has `.dev` removed: a development identifier
    /// without it is refused, and a production identifier is read whole, so
    /// a site whose first label is `dev` has one.
    #[test]
    fn the_environment_decides_whether_dev_is_removed() {
        assert_eq!(
            identity("so.epicenter.whispering", Development),
            Err(FolderNameError::NotADevelopmentIdentifier(
                "so.epicenter.whispering".into()
            ))
        );
        assert_eq!(
            identity("com.example.dev", Production).unwrap().host,
            "dev.example.com"
        );
        assert_eq!(
            identity("com.example.dev.dev", Development).unwrap().host,
            "dev.example.com"
        );
    }

    #[test]
    fn names_from_host() {
        assert_eq!(
            relative_path("whispering.epicenter.so").unwrap(),
            PathBuf::from("whispering")
        );
        assert_eq!(
            relative_path("zhongwen.bradenwong.com").unwrap(),
            PathBuf::from("bradenwong.com/zhongwen")
        );
        assert_eq!(
            relative_path("notes.app.epicenter.so").unwrap(),
            PathBuf::from("app.epicenter.so/notes")
        );
        assert_eq!(
            relative_path("notes.con.example.com"),
            Err(FolderNameError::ReservedLabel("con".into()))
        );
        assert_eq!(
            relative_path("lpt1.example.com"),
            Err(FolderNameError::ReservedLabel("lpt1".into()))
        );
    }

    #[test]
    fn roots_by_bundle_identifier_and_environment() {
        let home = Path::new("/home/person");
        assert_eq!(
            derive(home, "so.epicenter.notes", Production).unwrap(),
            home.join("Epicenter/notes")
        );
        assert_eq!(
            derive(home, "so.epicenter.notes.dev", Development).unwrap(),
            home.join("Epicenter Dev/notes")
        );
        assert_eq!(
            derive(home, "com.bradenwong.zhongwen.dev", Development).unwrap(),
            home.join("Epicenter Dev/bradenwong.com/zhongwen")
        );
        assert_eq!(root(home, Production), home.join("Epicenter"));
    }

    #[test]
    fn the_configuration_states_the_environment_or_is_refused() {
        assert_eq!(Environment::from_config(None), Ok(Production));
        assert_eq!(
            Environment::from_config(Some(&json!({ "environment": "development" }))),
            Ok(Development)
        );
        assert_eq!(
            Environment::from_config(Some(&json!({ "environment": "production" }))),
            Ok(Production)
        );
        assert_eq!(Environment::from_config(Some(&json!({}))), Ok(Production));
        assert_eq!(
            Environment::from_config(Some(&json!("development"))),
            Err(EnvironmentError::NotAnObject("\"development\"".into()))
        );
        assert_eq!(
            Environment::from_config(Some(&json!({ "environment": "staging" }))),
            Err(EnvironmentError::UnknownEnvironment("\"staging\"".into()))
        );
        assert_eq!(
            Environment::from_config(Some(&json!({ "environment": true }))),
            Err(EnvironmentError::UnknownEnvironment("true".into()))
        );
        assert_eq!(
            Environment::from_config(Some(&json!({ "enviroment": "development" }))),
            Err(EnvironmentError::UnknownSetting("enviroment".into()))
        );
    }
}
