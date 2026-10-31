//! How an app's folder reaches Epicenter (decisions 81 and 82): the page asks
//! the shell to open `epicenter://init?path=<folder>&contract=<url>`, naming
//! the folder it keeps its files in, which must be a root its window reaches
//! (`Folders::bound_root`), and the URL its contract is published at.
//! Epicenter, if installed, asks the person where to sync it and runs
//! `epicenter init`. The page can also ask whether Epicenter already syncs a
//! folder it reaches, which reads the folder's Git configuration and changes
//! nothing.

use std::fmt;
use std::fs;
use std::path::Path;

use serde::Serialize;
use specta::Type;
use tauri::{Manager, Runtime, Webview};

use crate::Folders;

/// Why the request to Epicenter was not made: what the page is told.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "name")]
pub enum SyncRequestError {
    /// `path` is not a root the calling window reaches, or it is gone.
    Folder { path: String },
    /// The contract URL is not `https:`, or `http:` on this machine.
    Contract { url: String },
    /// The operating system did not open the link (Epicenter may not be installed).
    NotOpened { message: String },
}

impl fmt::Display for SyncRequestError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Folder { path } => {
                write!(formatter, "{path} is not a folder this window can use.")
            }
            Self::Contract { url } => write!(formatter, "{url} is not a contract URL."),
            Self::NotOpened { message } => {
                write!(formatter, "The system did not open Epicenter: {message}")
            }
        }
    }
}

/// Ask the operating system to open Epicenter with a request to sync the
/// folder at `path` under `contract`, the URL its contract is published at.
/// Answers once the system took the request; whether Epicenter sets the
/// folder up is the person's choice there.
#[tauri::command]
#[specta::specta]
pub async fn sync_with_epicenter<R: Runtime>(
    webview: Webview<R>,
    path: String,
    contract: String,
) -> Result<(), SyncRequestError> {
    let folder = reached(&webview, &path)?;
    let link = init_link(folder.root(), &contract)?;
    tauri_plugin_opener::open_url(link, None::<&str>).map_err(|error| SyncRequestError::NotOpened {
        message: error.to_string(),
    })
}

/// Whether Epicenter syncs the folder at `path` (`synced`).
#[tauri::command]
#[specta::specta]
pub async fn synced_with_epicenter<R: Runtime>(
    webview: Webview<R>,
    path: String,
) -> Result<bool, SyncRequestError> {
    let folder = reached(&webview, &path)?;
    Ok(
        tauri::async_runtime::spawn_blocking(move || synced(folder.root()))
            .await
            .unwrap_or(false),
    )
}

/// The root at `path` among the calling window's, or `Folder`.
fn reached<R: Runtime>(
    webview: &Webview<R>,
    path: &str,
) -> Result<crate::Directory, SyncRequestError> {
    webview
        .app_handle()
        .state::<Folders>()
        .bound_root(webview.label(), Some(path))
        .map_err(|_| SyncRequestError::Folder {
            path: path.to_owned(),
        })
}

/// `path` when it is absolute and names an existing directory.
fn existing_folder(path: &str) -> Result<String, SyncRequestError> {
    let folder = Path::new(path);
    if folder.is_absolute() && folder.is_dir() {
        Ok(path.to_owned())
    } else {
        Err(SyncRequestError::Folder {
            path: path.to_owned(),
        })
    }
}

/// `epicenter://init?path=<root>&contract=<contract>`, each value encoded so
/// it has one reading. The contract must be an `https:` URL, or `http:` on
/// this machine for a local build; `root` must be an existing directory.
pub fn init_link(root: &Path, contract: &str) -> Result<String, SyncRequestError> {
    let local = [
        "http://localhost:",
        "http://localhost/",
        "http://127.0.0.1:",
    ];
    if !contract.starts_with("https://") && !local.iter().any(|start| contract.starts_with(start)) {
        return Err(SyncRequestError::Contract {
            url: contract.to_string(),
        });
    }
    let root = existing_folder(root.to_str().unwrap_or_default())?;
    Ok(format!(
        "epicenter://init?path={}&contract={}",
        encode_value(&root),
        encode_value(contract)
    ))
}

/// `value` with every byte but unreserved characters and `/` percent-encoded,
/// so `+`, `&`, `%`, `:`, and spaces have one reading.
fn encode_value(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~' | b'/') {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

/// Whether Epicenter syncs the folder at `root`: `epicenter init` records the
/// repository it adopted as `epicenter.root` in `<root>/.git/config`, and
/// `epicenter forget` removes it. A folder with no repository, or one whose
/// `epicenter.root` names another directory, is not synced. Git itself is
/// not needed to answer.
pub fn synced(root: &Path) -> bool {
    let Ok(config) = fs::read_to_string(root.join(".git/config")) else {
        return false;
    };
    let Some(recorded) = config_value(&config, "epicenter", "root") else {
        return false;
    };
    let recorded = Path::new(&recorded);
    recorded == root
        || matches!(
            (dunce::canonicalize(recorded), dunce::canonicalize(root)),
            (Ok(recorded), Ok(root)) if recorded == root
        )
}

/// The last value of `section.key` (no subsection) in Git configuration
/// `text`: names compare case-insensitively, quotes and backslash escapes
/// are read, and `#` or `;` outside quotes starts a comment.
fn config_value(text: &str, section: &str, key: &str) -> Option<String> {
    let mut current = String::new();
    let mut found = None;
    for line in text.lines() {
        let line = line.trim();
        if let Some(header) = line.strip_prefix('[') {
            let name = header.split(']').next().unwrap_or_default().trim();
            current = name.to_ascii_lowercase();
            continue;
        }
        if current != section {
            continue;
        }
        let (name, value) = line.split_once('=').unwrap_or((line, ""));
        if name.trim().eq_ignore_ascii_case(key) {
            found = Some(unquote(value));
        }
    }
    found
}

/// A Git configuration value as Git reads it.
fn unquote(raw: &str) -> String {
    let mut value = String::new();
    // Up to here, `value` keeps its whitespace: quoted or escaped text.
    let mut kept = 0;
    let mut quoted = false;
    let mut chars = raw.trim_start().chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => quoted = !quoted,
            '#' | ';' if !quoted => break,
            '\\' => {
                match chars.next() {
                    Some('n') => value.push('\n'),
                    Some('t') => value.push('\t'),
                    Some('b') => value.push('\u{8}'),
                    Some(other) => value.push(other),
                    None => {}
                }
                kept = value.len();
            }
            _ => {
                value.push(c);
                if quoted || !c.is_whitespace() {
                    kept = value.len();
                }
            }
        }
    }
    value.truncate(kept);
    value
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    #[test]
    fn the_link_names_the_folder_and_the_contract_with_one_reading() {
        let temp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(temp.path())
            .unwrap()
            .join("Epicenter Dev/Capture");
        fs::create_dir_all(&root).unwrap();
        assert_eq!(
            init_link(&root, "https://capture.epicenter.so/contract.json").unwrap(),
            format!(
                "epicenter://init?path={}&contract=https%3A//capture.epicenter.so/contract.json",
                encode_value(root.to_str().unwrap())
            )
        );
        assert!(encode_value(root.to_str().unwrap()).ends_with("/Epicenter%20Dev/Capture"));
        assert_eq!(
            encode_value("/tmp/a+b&c=d%e;f#g?h/notés"),
            "/tmp/a%2Bb%26c%3Dd%25e%3Bf%23g%3Fh/not%C3%A9s"
        );
        assert!(init_link(&root, "http://localhost:5179/contract.json").is_ok());
        for refused in [
            "file:///etc/passwd",
            "http://example.com/c.json",
            "contract.json",
        ] {
            assert_eq!(
                init_link(&root, refused),
                Err(SyncRequestError::Contract {
                    url: refused.into()
                })
            );
        }
        // Only an existing folder, named absolutely.
        for refused in [root.join("missing"), PathBuf::from("relative/folder")] {
            assert_eq!(
                init_link(&refused, "https://capture.epicenter.so/contract.json"),
                Err(SyncRequestError::Folder {
                    path: refused.to_str().unwrap().into()
                })
            );
        }
    }

    fn git_config(root: &Path, text: &str) {
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join(".git/config"), text).unwrap();
    }

    #[test]
    fn a_folder_is_synced_once_init_records_it_as_epicenter_root() {
        let temp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(temp.path()).unwrap().join("Capture");
        fs::create_dir(&root).unwrap();
        // No repository yet.
        assert!(!synced(&root));
        // A repository Epicenter did not adopt (`git init` alone, or after `forget`).
        git_config(&root, "[core]\n\tbare = false\n");
        assert!(!synced(&root));
        // As `epicenter init` writes it.
        git_config(
            &root,
            &format!(
                "[core]\n\tbare = false\n[epicenter]\n\troot = {}\n[remote \"origin\"]\n\turl = x\n",
                root.display()
            ),
        );
        assert!(synced(&root));
        // A root naming another repository is not this folder's.
        git_config(&root, "[epicenter]\n\troot = /elsewhere\n");
        assert!(!synced(&root));
    }

    #[test]
    fn config_values_are_read_as_git_reads_them() {
        let text =
            "[Epicenter]\n  ROOT = \"/a b/c;d \" ; comment\n[epicenter \"sub\"]\n\troot = /no\n";
        assert_eq!(
            config_value(text, "epicenter", "root").as_deref(),
            Some("/a b/c;d ")
        );
        assert_eq!(
            config_value(
                "[epicenter]\nroot = /one\nroot = /two   # last\n",
                "epicenter",
                "root"
            )
            .as_deref(),
            Some("/two")
        );
        assert_eq!(
            config_value("[epicenter]\nroot = C:\\\\Epicenter\n", "epicenter", "root").as_deref(),
            Some("C:\\Epicenter")
        );
        assert_eq!(
            config_value("[core]\nroot = /x\n", "epicenter", "root"),
            None
        );
    }
}
