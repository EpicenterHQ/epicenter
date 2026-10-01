//! The host's device-local local-transcription settings: which model is
//! **active**, and when to drop it from memory.
//!
//! Epicenter has exactly one active local transcription model per device
//! (ADR-0180). The host owns it and Epicenter Home administers it; no
//! application carries a model name into a transcribe call, so no ordinary
//! request can reassign the shared model cache behind the user's back.
//!
//! Device-local on purpose, and durable here rather than in any workspace: the
//! value names model files and an accelerator that exist on *this* machine. A
//! second device may have neither the bytes nor compatible hardware, so this
//! must never synchronize.
//!
//! This is ownership, not a mirror of a frontend value, which is why it does not
//! reopen [ADR-0012](../../../../docs/adr/0012-transcription-settings-are-read-at-use-not-mirrored-into-rust.md).
//! There is exactly one copy and exactly one writer, so the staleness class that
//! record closed (a frontend pushing a copy Rust then re-read) cannot appear.
//! Language and prompt remain application-owned and still travel per call.

use super::catalog;
use log::warn;
use serde::{Deserialize, Serialize};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::RwLock;
use thiserror::Error;

/// How long after the last transcription the resident model should be dropped.
///
/// `Immediately` is enforced synchronously at the end of each transcription;
/// timed variants are enforced by the background idle watcher.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum UnloadPolicy {
    Never,
    Immediately,
    #[default]
    #[serde(rename = "after_5_minutes")]
    AfterFiveMinutes,
    #[serde(rename = "after_30_minutes")]
    AfterThirtyMinutes,
}

/// The on-disk shape. Both fields tolerate absence so a settings file written by
/// an older build, or one a user hand-edited, still loads.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    /// The active model's catalog id, or `None` when nobody has chosen one.
    /// Absence is a real state with an explicit error, never a silent default.
    #[serde(default)]
    active_model_id: Option<String>,
    #[serde(default)]
    unload_policy: UnloadPolicy,
}

/// Failures the Home administration commands can report. Both are actionable:
/// the id is not a model this build knows, or the choice could not be made
/// durable.
#[derive(Error, Debug, Serialize, Deserialize, specta::Type)]
#[serde(tag = "name")]
pub enum SettingsError {
    #[error("Unknown model: {message}")]
    UnknownModel { message: String },

    #[error("Could not save: {message}")]
    SaveFailed { message: String },
}

/// The one host-owned store for the active model and the unload policy.
///
/// The in-memory value is authoritative for the running process and every write
/// is flushed to disk before it is reported successful, so a choice the user
/// made either survives a restart or fails loudly at the moment they made it.
pub struct LocalTranscriptionSettings {
    path: PathBuf,
    state: RwLock<Stored>,
}

impl LocalTranscriptionSettings {
    /// Load the settings file, falling back to the defaults (no active model,
    /// default unload policy) when it is missing or unreadable. A corrupt file
    /// is a warning, not a startup failure: the user re-picks in Home, and the
    /// next successful write replaces it.
    pub fn load(path: PathBuf) -> Self {
        let state = match std::fs::read_to_string(&path) {
            Ok(contents) => serde_json::from_str(&contents).unwrap_or_else(|error| {
                warn!(
                    "[Transcription] unreadable settings at {}, starting from defaults: {error}",
                    path.display()
                );
                Stored::default()
            }),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Stored::default(),
            Err(error) => {
                warn!(
                    "[Transcription] could not read settings at {}: {error}",
                    path.display()
                );
                Stored::default()
            }
        };
        Self {
            path,
            state: RwLock::new(state),
        }
    }

    /// The active model's catalog id, or `None` when nobody has chosen one.
    /// Read at the point of use by every transcribe and prewarm.
    pub fn active_model_id(&self) -> Option<String> {
        self.read().active_model_id
    }

    /// Make `model_id` the active model, or clear the choice with `None`.
    /// A non-`None` id must name a model in this build's catalog: an id nothing
    /// can resolve is refused here rather than stored and failed later.
    pub fn set_active_model_id(&self, model_id: Option<String>) -> Result<(), SettingsError> {
        if let Some(id) = &model_id {
            if catalog::describe(id).is_none() {
                return Err(SettingsError::UnknownModel {
                    message: format!("\"{id}\" is not a model Epicenter knows about."),
                });
            }
        }
        self.update(|stored| stored.active_model_id = model_id)
    }

    /// When the host drops the resident model.
    pub fn unload_policy(&self) -> UnloadPolicy {
        self.read().unload_policy
    }

    pub fn set_unload_policy(&self, policy: UnloadPolicy) -> Result<(), SettingsError> {
        self.update(|stored| stored.unload_policy = policy)
    }

    fn read(&self) -> Stored {
        self.state
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Apply `change` and flush. The lock is held across the write so two
    /// concurrent settings changes cannot interleave into a file that reflects
    /// neither.
    fn update(&self, change: impl FnOnce(&mut Stored)) -> Result<(), SettingsError> {
        let mut guard = self
            .state
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let previous = guard.clone();
        change(&mut guard);
        persist(&self.path, &guard).map_err(|error| {
            // Roll back so the in-memory value never claims a choice the disk
            // does not hold.
            *guard = previous;
            SettingsError::SaveFailed {
                message: error.to_string(),
            }
        })
    }
}

/// Write the settings file by replacing it: serialize to a unique sibling temp
/// file, then rename that over the target. A crash mid-write leaves the previous
/// settings intact rather than a truncated file the next launch cannot parse.
///
/// `std::fs::rename` is the right primitive on every platform Epicenter
/// supports, and it supports being called again and again over an existing file.
/// The std documentation states it "[r]enames a file or directory to a new name,
/// replacing the original file if `to` already exists", implemented by `rename`
/// on Unix and `MoveFileExW` or `SetFileInformationByHandle` on Windows. The one
/// documented Windows restriction is that the destination must not be a
/// directory, which a settings file never is. Repeated writes therefore need no
/// delete-then-rename dance, which would be the unsafe version anyway: it opens
/// a window where neither file exists.
///
/// The temp name carries the process id and a per-process counter, so two
/// writers (or a retry after a crash) never contend for one scratch path, and a
/// failed write cleans its own temp file up instead of leaving litter that a
/// later run might mistake for real state.
fn persist(path: &Path, stored: &Stored) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let contents = serde_json::to_vec_pretty(stored)?;
    let temp = path.with_extension(format!(
        "{}.{}.tmp",
        std::process::id(),
        NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
    ));
    if let Err(error) = std::fs::write(&temp, contents) {
        let _ = std::fs::remove_file(&temp);
        return Err(error);
    }
    std::fs::rename(&temp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&temp);
    })
}

/// Distinguishes scratch files written by this process, so concurrent writes and
/// retries never share a temp path.
static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "epicenter-local-transcription-{label}-{}",
            std::process::id()
        ));
        std::fs::remove_dir_all(&dir).ok();
        dir.join("local-transcription.json")
    }

    /// The catalog id used wherever a test needs a real, resolvable model
    /// identity. Taken from the live catalog so the test cannot drift from it.
    fn a_catalog_model_id() -> String {
        catalog::model_ids()
            .first()
            .expect("the catalog ships at least one model")
            .clone()
    }

    #[test]
    fn absent_file_starts_with_no_active_model() {
        let settings = LocalTranscriptionSettings::load(temp_path("absent"));
        assert_eq!(settings.active_model_id(), None);
        assert_eq!(settings.unload_policy(), UnloadPolicy::default());
    }

    #[test]
    fn active_model_survives_a_reload() {
        let path = temp_path("durable");
        let id = a_catalog_model_id();

        let settings = LocalTranscriptionSettings::load(path.clone());
        settings.set_active_model_id(Some(id.clone())).unwrap();
        settings.set_unload_policy(UnloadPolicy::Never).unwrap();

        let reloaded = LocalTranscriptionSettings::load(path.clone());
        assert_eq!(reloaded.active_model_id(), Some(id));
        assert_eq!(reloaded.unload_policy(), UnloadPolicy::Never);

        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn clearing_the_active_model_is_a_real_state() {
        let path = temp_path("cleared");
        let settings = LocalTranscriptionSettings::load(path.clone());
        settings
            .set_active_model_id(Some(a_catalog_model_id()))
            .unwrap();
        settings.set_active_model_id(None).unwrap();

        let reloaded = LocalTranscriptionSettings::load(path.clone());
        assert_eq!(reloaded.active_model_id(), None);

        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn an_unknown_id_is_refused_rather_than_stored() {
        let path = temp_path("unknown");
        let settings = LocalTranscriptionSettings::load(path.clone());
        let error = settings
            .set_active_model_id(Some("not-a-model".to_string()))
            .expect_err("an id outside the catalog is refused");
        assert!(matches!(error, SettingsError::UnknownModel { .. }));
        assert_eq!(
            settings.active_model_id(),
            None,
            "a refused choice leaves the previous state untouched"
        );

        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    /// The settings file is rewritten on every administration act, so replacing
    /// an existing file has to keep working, not just creating one.
    #[test]
    fn successive_writes_replace_the_file_and_leave_no_litter() {
        let path = temp_path("successive");
        let ids = catalog::model_ids();
        let settings = LocalTranscriptionSettings::load(path.clone());

        for id in &ids {
            settings.set_active_model_id(Some(id.clone())).unwrap();
        }
        settings
            .set_unload_policy(UnloadPolicy::Immediately)
            .unwrap();
        settings.set_unload_policy(UnloadPolicy::Never).unwrap();

        let reloaded = LocalTranscriptionSettings::load(path.clone());
        assert_eq!(reloaded.active_model_id().as_ref(), ids.last());
        assert_eq!(reloaded.unload_policy(), UnloadPolicy::Never);

        let dir = path.parent().unwrap();
        let leftovers: Vec<_> = std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "temp files left behind: {leftovers:?}"
        );

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_corrupt_file_falls_back_to_defaults() {
        let path = temp_path("corrupt");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"{ not json").unwrap();

        let settings = LocalTranscriptionSettings::load(path.clone());
        assert_eq!(settings.active_model_id(), None);
        assert_eq!(settings.unload_policy(), UnloadPolicy::default());

        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn unload_policy_wire_tags_match_the_frontend_values() {
        // The frontend persists these exact strings; a rename here would silently
        // reset every user's policy to the default on read.
        let cases = [
            (UnloadPolicy::Never, "\"never\""),
            (UnloadPolicy::Immediately, "\"immediately\""),
            (UnloadPolicy::AfterFiveMinutes, "\"after_5_minutes\""),
            (UnloadPolicy::AfterThirtyMinutes, "\"after_30_minutes\""),
        ];
        for (policy, wire) in cases {
            assert_eq!(serde_json::to_string(&policy).unwrap(), wire);
        }
    }
}
