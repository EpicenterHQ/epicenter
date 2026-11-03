//! Derive an app's data folder from its bundle identifier, the reversed host
//! of its production site (ADR-0722), with `.dev` appended for a development
//! build.

use std::ffi::OsStr;
use std::fmt;
use std::path::{Path, PathBuf};

#[derive(Debug, PartialEq, Eq)]
pub enum FolderNameError {
    /// The identifier does not reverse to a host of lowercase labels.
    InvalidIdentifier(String),
    /// The host has no subdomain to name the app by.
    BareDomain(String),
    /// A label is a name Windows reserves for a device.
    ReservedLabel(String),
    /// The host's first label is `dev`, which a bundle identifier cannot
    /// carry: its trailing `.dev` marks a development build.
    DevLabel(String),
}

impl fmt::Display for FolderNameError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidIdentifier(identifier) => write!(
                formatter,
                "{identifier} is not the reversed host of an app's site"
            ),
            Self::BareDomain(identifier) => write!(
                formatter,
                "{identifier} names no subdomain for the app's site"
            ),
            Self::ReservedLabel(label) => write!(formatter, "{label} is a reserved folder name"),
            Self::DevLabel(identifier) => write!(
                formatter,
                "{identifier} names a site whose first label is dev, which marks a development build"
            ),
        }
    }
}

impl std::error::Error for FolderNameError {}

/// The app a bundle identifier names: its site's host, and whether this is a
/// development build (the identifier ends in `.dev`).
#[derive(Debug, PartialEq, Eq)]
pub struct Identity {
    pub host: String,
    pub development: bool,
}

/// `so.epicenter.whispering` is `whispering.epicenter.so`;
/// `so.epicenter.whispering.dev` is the same host in development.
pub fn identity(identifier: &str) -> Result<Identity, FolderNameError> {
    let (production, development) = match identifier.strip_suffix(".dev") {
        Some(production) => (production, true),
        None => (identifier, false),
    };
    let labels: Vec<_> = production.split('.').rev().collect();
    if labels.iter().any(|label| {
        label.is_empty()
            || !label
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    }) {
        return Err(FolderNameError::InvalidIdentifier(identifier.to_owned()));
    }
    if labels.len() < 3 {
        return Err(FolderNameError::BareDomain(identifier.to_owned()));
    }
    if labels[0] == "dev" {
        return Err(FolderNameError::DevLabel(identifier.to_owned()));
    }
    Ok(Identity {
        host: labels.join("."),
        development,
    })
}

/// The relative folder named by a site's host: the label alone for a direct
/// subdomain of `epicenter.so`, `<owner>/<label>` for any other.
pub fn relative_path(host: &str) -> Result<PathBuf, FolderNameError> {
    let labels: Vec<_> = host.split('.').collect();
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

/// `~/Epicenter`, or `~/Epicenter Dev` for a development build. The caller
/// passes `override_dir` (`EPICENTER_FOLDER_DIR`) only from a debug build.
pub fn root(home: &Path, development: bool, override_dir: Option<&OsStr>) -> PathBuf {
    if let Some(directory) = override_dir.filter(|directory| !directory.is_empty()) {
        return PathBuf::from(directory);
    }
    home.join(if development {
        "Epicenter Dev"
    } else {
        "Epicenter"
    })
}

/// The data folder a bundle identifier derives under `home`.
pub fn derive(
    home: &Path,
    identifier: &str,
    override_dir: Option<&OsStr>,
) -> Result<PathBuf, FolderNameError> {
    let identity = identity(identifier)?;
    Ok(root(home, identity.development, override_dir).join(relative_path(&identity.host)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts_from_bundle_identifiers() {
        assert_eq!(
            identity("so.epicenter.whispering").unwrap(),
            Identity {
                host: "whispering.epicenter.so".into(),
                development: false
            }
        );
        assert_eq!(
            identity("so.epicenter.whispering.dev").unwrap(),
            Identity {
                host: "whispering.epicenter.so".into(),
                development: true
            }
        );
        assert_eq!(
            identity("com.bradenwong.zhongwen").unwrap().host,
            "zhongwen.bradenwong.com"
        );
        assert_eq!(
            identity("so.epicenter"),
            Err(FolderNameError::BareDomain("so.epicenter".into()))
        );
        assert_eq!(
            identity("so.epicenter.dev"),
            Err(FolderNameError::BareDomain("so.epicenter.dev".into()))
        );
        assert_eq!(
            identity("com.Example.notes"),
            Err(FolderNameError::InvalidIdentifier(
                "com.Example.notes".into()
            ))
        );
        assert_eq!(
            identity("com..notes"),
            Err(FolderNameError::InvalidIdentifier("com..notes".into()))
        );
    }

    /// A site at `dev.example.com` would be `com.example.dev`, which reads as
    /// a development build of `example.com`, so `dev` is never a first label.
    #[test]
    fn dev_is_never_a_sites_first_label() {
        assert_eq!(
            identity("com.example.dev.dev"),
            Err(FolderNameError::DevLabel("com.example.dev.dev".into()))
        );
        assert_eq!(
            identity("com.example.app.dev").unwrap(),
            Identity {
                host: "app.example.com".into(),
                development: true
            }
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
    fn roots_by_bundle_and_test_override() {
        let home = Path::new("/home/person");
        assert_eq!(
            derive(home, "so.epicenter.notes", None).unwrap(),
            home.join("Epicenter/notes")
        );
        assert_eq!(
            derive(home, "so.epicenter.notes.dev", None).unwrap(),
            home.join("Epicenter Dev/notes")
        );
        assert_eq!(
            derive(home, "com.bradenwong.zhongwen.dev", None).unwrap(),
            home.join("Epicenter Dev/bradenwong.com/zhongwen")
        );
        assert_eq!(
            derive(
                home,
                "so.epicenter.notes.dev",
                Some(OsStr::new("/test/folders"))
            )
            .unwrap(),
            PathBuf::from("/test/folders/notes")
        );
        assert_eq!(
            root(home, false, Some(OsStr::new(""))),
            home.join("Epicenter")
        );
    }
}
