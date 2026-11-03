//! Derive an app's data folder from its declared production site and bundle.

use std::ffi::OsStr;
use std::fmt;
use std::path::{Path, PathBuf};

use url::{Host, Url};

#[derive(Debug, PartialEq, Eq)]
pub enum FolderNameError {
    InvalidSite(String),
    InsecureSite,
    BareDomain,
    ReservedLabel(String),
}

impl fmt::Display for FolderNameError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidSite(site) => write!(formatter, "{site} is not a valid site origin"),
            Self::InsecureSite => write!(formatter, "the app site must use HTTPS on port 443"),
            Self::BareDomain => write!(formatter, "the app site must have a subdomain"),
            Self::ReservedLabel(label) => write!(formatter, "{label} is a reserved folder name"),
        }
    }
}

impl std::error::Error for FolderNameError {}

/// The relative folder named by a declared production origin.
pub fn relative_path(site: &str) -> Result<PathBuf, FolderNameError> {
    let url = Url::parse(site).map_err(|_| FolderNameError::InvalidSite(site.to_owned()))?;
    if url.scheme() != "https" || url.port().is_some_and(|port| port != 443) {
        return Err(FolderNameError::InsecureSite);
    }
    if url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(FolderNameError::InvalidSite(site.to_owned()));
    }
    let host = match url.host() {
        Some(Host::Domain(host)) => host,
        _ => return Err(FolderNameError::InvalidSite(site.to_owned())),
    };
    let labels: Vec<_> = host.split('.').collect();
    if labels.len() < 3 {
        return Err(FolderNameError::BareDomain);
    }
    if labels.iter().any(|label| {
        label.is_empty()
            || !label
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    }) {
        return Err(FolderNameError::InvalidSite(site.to_owned()));
    }
    for label in &labels {
        let lower = label.to_ascii_lowercase();
        if matches!(lower.as_str(), "con" | "prn" | "aux" | "nul")
            || (lower.len() == 4
                && (lower.starts_with("com") || lower.starts_with("lpt"))
                && matches!(lower.as_bytes()[3], b'1'..=b'9'))
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

/// `EPICENTER_FOLDER_DIR` overrides the root for tests only.
pub fn root(home: &Path, identifier: &str, override_dir: Option<&OsStr>) -> PathBuf {
    if let Some(directory) = override_dir {
        return PathBuf::from(directory);
    }
    home.join(if identifier.ends_with(".dev") {
        "Epicenter Dev"
    } else {
        "Epicenter"
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_from_site() {
        assert_eq!(
            relative_path("https://Whispering.Epicenter.So").unwrap(),
            PathBuf::from("whispering")
        );
        assert_eq!(
            relative_path("https://zhongwen.bradenwong.com").unwrap(),
            PathBuf::from("bradenwong.com/zhongwen")
        );
        assert_eq!(
            relative_path("https://notes.app.epicenter.so").unwrap(),
            PathBuf::from("app.epicenter.so/notes")
        );
        assert_eq!(
            relative_path("https://bradenwong.com"),
            Err(FolderNameError::BareDomain)
        );
        assert_eq!(
            relative_path("https://notes.CON.example.com"),
            Err(FolderNameError::ReservedLabel("con".into()))
        );
        assert_eq!(
            relative_path("http://notes.example.com"),
            Err(FolderNameError::InsecureSite)
        );
        assert_eq!(
            relative_path("https://notes.example.com:444"),
            Err(FolderNameError::InsecureSite)
        );
        assert_eq!(
            relative_path("https://notes.example.com:443").unwrap(),
            PathBuf::from("example.com/notes")
        );
    }

    #[test]
    fn roots_by_bundle_and_test_override() {
        let home = Path::new("/home/person");
        assert_eq!(
            root(home, "so.epicenter.notes", None),
            home.join("Epicenter")
        );
        assert_eq!(
            root(home, "so.epicenter.notes.dev", None),
            home.join("Epicenter Dev")
        );
        assert_eq!(
            root(
                home,
                "so.epicenter.notes.dev",
                Some(OsStr::new("/test/folders"))
            ),
            PathBuf::from("/test/folders")
        );
    }
}
