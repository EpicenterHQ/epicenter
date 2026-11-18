//! The one failure every file operation answers, as the page's `FilesError`.

use std::fmt;
use std::io;

use serde::Serialize;

/// Why a file operation did nothing, or did not finish.
///
/// Internally tagged, so it crosses the IPC boundary as
/// `{ "name": "NotFound" | "Refused" | "Io", "message": string }`, the
/// TypeScript `FilesError`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "name")]
pub enum FilesError {
    /// The file or folder is not there.
    NotFound { message: String },
    /// Not allowed: the path rule refused the path, a link is on the way,
    /// the folder is not granted, or a file already holds a target that
    /// must not be replaced.
    Refused { message: String },
    /// The disk failed.
    Io { message: String },
}

impl FilesError {
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::NotFound {
            message: message.into(),
        }
    }

    pub fn refused(message: impl Into<String>) -> Self {
        Self::Refused {
            message: message.into(),
        }
    }

    pub fn io(message: impl Into<String>) -> Self {
        Self::Io {
            message: message.into(),
        }
    }

    /// An I/O failure about `what`: a missing file is `NotFound`, a taken
    /// target `Refused`, and anything else `Io`.
    pub fn from_io(what: impl fmt::Display, error: &io::Error) -> Self {
        let message = format!("{what}: {error}");
        match error.kind() {
            io::ErrorKind::NotFound => Self::NotFound { message },
            io::ErrorKind::AlreadyExists => Self::Refused { message },
            _ => Self::Io { message },
        }
    }

    pub fn message(&self) -> &str {
        match self {
            Self::NotFound { message } | Self::Refused { message } | Self::Io { message } => {
                message
            }
        }
    }
}

impl fmt::Display for FilesError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for FilesError {}

pub type Result<T> = std::result::Result<T, FilesError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_crosses_as_a_name_and_a_message() {
        for (error, name) in [
            (FilesError::not_found("gone"), "NotFound"),
            (FilesError::refused("no"), "Refused"),
            (FilesError::io("disk"), "Io"),
        ] {
            let json = serde_json::to_value(&error).unwrap();
            assert_eq!(json["name"], name);
            assert_eq!(json["message"], error.message());
            assert_eq!(json.as_object().unwrap().len(), 2);
        }
    }
}
