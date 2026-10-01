//! The local GGUF model catalog: the one Rust-owned source of truth for which
//! local models exist, their Hugging Face coordinate, their static capabilities,
//! and their download/cache status.
//!
//! A model is identified by a stable `modelId` string rendered from its Hugging
//! Face coordinate as `"{repo_id}@{revision}/{filename}"`. That id is an opaque
//! catalog key. Epicenter Home names it when it administers models, and the host
//! stores the active dictation choice. Explicit file inference lists cached IDs
//! and passes the selected ID to `transcribe_audio_bytes`; the older
//! `transcribe_recording` path resolves the active choice. An unknown ID is refused
//! rather than parsed. (Custom drop-in GGUF is a later earned feature, not a
//! compatibility path.)
//!
//! Storage is the shared Hugging Face cache (`~/.cache/huggingface/hub`,
//! overridable by `HF_HOME`), owned by `hf-hub`: downloads stage, resume, and
//! integrity-check through it, and a file already in the cache (from this app or
//! any other HF tool) is reused. Rust never stores a path; it resolves the
//! coordinate to a cache path at point of use.

use crate::download::{DownloadManager, DownloadProgress};
use hf_hub::api::tokio::{ApiBuilder, Progress};
use hf_hub::{Cache, Repo, RepoType};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::State;
use thiserror::Error;

/// A Hugging Face coordinate: the single source of a model's identity and its
/// download/resolve location.
struct ModelCoord {
    repo_id: &'static str,
    revision: &'static str,
    filename: &'static str,
}

/// One curated catalog entry. Capabilities are static per model (a UI hint for
/// whether to show the prompt/language fields); the runtime independently guards
/// prompt support via `session.model().supports(Feature::InitialPrompt)` at use,
/// so a slightly-off flag can only hide a field, never misfeed the model.
struct CatalogEntry {
    coord: ModelCoord,
    name: &'static str,
    description: &'static str,
    /// Approximate download size, for the picker's "Download (172 MB)" affordance.
    size_bytes: u64,
    /// Whisper accepts an `initial_prompt`; the Parakeet TDT family does not.
    supports_prompt: bool,
    /// Whether the picker should offer a spoken-language selection for this model.
    supports_language: bool,
    /// The single model the picker builds its first-run default around.
    recommended: bool,
}

/// The curated GGUF catalog. Hand-seeded from the `handy-computer` Hugging Face
/// org (quantizations tested against transcribe.cpp). A build-time generator
/// from the org is deferred until this list is large enough to need it.
///
/// Filenames and sizes are the real repo contents (verified against HF). The
/// `whisper-small` entry keeps the exact anchor the spike and preview CI proved.
static CATALOG: &[CatalogEntry] = &[
    CatalogEntry {
        coord: ModelCoord {
            repo_id: "handy-computer/whisper-tiny-gguf",
            revision: "main",
            filename: "whisper-tiny-Q8_0.gguf",
        },
        name: "Whisper Tiny",
        description: "Fastest, multilingual, basic accuracy",
        size_bytes: 46_000_000,
        supports_prompt: true,
        supports_language: true,
        recommended: false,
    },
    CatalogEntry {
        coord: ModelCoord {
            repo_id: "handy-computer/whisper-small-gguf",
            revision: "main",
            filename: "whisper-small-Q4_K_M.gguf",
        },
        name: "Whisper Small",
        description: "Fast, multilingual, good accuracy",
        size_bytes: 172_000_000,
        supports_prompt: true,
        supports_language: true,
        recommended: true,
    },
    CatalogEntry {
        coord: ModelCoord {
            repo_id: "handy-computer/parakeet-tdt-0.6b-v3-gguf",
            revision: "main",
            filename: "parakeet-tdt-0.6b-v3-Q4_K_M.gguf",
        },
        name: "Parakeet TDT 0.6B v3",
        description: "Fast multilingual model with automatic language detection",
        size_bytes: 485_000_000,
        supports_prompt: false,
        supports_language: false,
        recommended: false,
    },
];

impl CatalogEntry {
    /// The stable, storable model id: `"{repo_id}@{revision}/{filename}"`.
    fn id(&self) -> String {
        format!(
            "{}@{}/{}",
            self.coord.repo_id, self.coord.revision, self.coord.filename
        )
    }

    /// The `hf-hub` repo handle for this entry (a model repo at a pinned revision).
    fn repo(&self) -> Repo {
        Repo::with_revision(
            self.coord.repo_id.to_string(),
            RepoType::Model,
            self.coord.revision.to_string(),
        )
    }

    /// The cache path if this model's file is already present in the shared HF
    /// cache; `None` when it still needs downloading.
    fn cached_path(&self) -> Option<PathBuf> {
        Cache::from_env().repo(self.repo()).get(self.coord.filename)
    }
}

/// Find the catalog entry for a model id, if any.
fn find(model_id: &str) -> Option<&'static CatalogEntry> {
    CATALOG.iter().find(|entry| entry.id() == model_id)
}

/// Resolve a model id to its catalog entry, or the `UnknownModel` error the
/// `download_model`/`delete_model` commands both return for an id not in the
/// catalog. One place owns that message so the two commands cannot drift.
fn find_or_unknown(model_id: &str) -> Result<&'static CatalogEntry, CatalogError> {
    find(model_id).ok_or_else(|| CatalogError::UnknownModel {
        message: format!("Unknown local model \"{model_id}\"."),
    })
}

/// The on-disk GGUF path for a model that is both in this build's catalog and
/// present on this machine; `None` otherwise.
///
/// The one place `transcribe_recording`/`prewarm_model` turn the active model
/// into a path. Deliberately a plain `Option`: an id outside the catalog and a
/// model that is not downloaded are the same public answer ("the active model
/// cannot run"), and the caller composes the user-facing message so that message
/// never has to name a model. Resolution happens at the point of use, so a file
/// that appears on disk after a failed load works on the very next call, and one
/// deleted behind Epicenter's back is noticed on the very next call too.
pub fn installed_model_path(model_id: &str) -> Option<PathBuf> {
    find(model_id).and_then(CatalogEntry::cached_path)
}

/// The one active local model as **Home** sees it: its exact identity and
/// whether its file is on this machine right now.
///
/// Administration data, not application data (ADR-0180). Home chooses the active
/// model, so Home is told which one it is; an ordinary application never learns
/// model identity and reads `get_local_transcription_readiness` instead. Nothing
/// here reports residency: `installed` is disk presence, and how many models are
/// resident or warm stays host-private.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ActiveModel {
    pub id: String,
    /// The curated display name, so a caller can name the model in an error
    /// without holding a catalog of its own.
    pub name: String,
    /// Whether the model's file is present on this machine. Disk presence, the
    /// same verdict `list_models` renders; never a statement about memory.
    pub installed: bool,
    /// Whether this model accepts an initial prompt, so a caller knows whether
    /// to offer the field at all. The runtime still guards the real decision at
    /// use and reports what it applied, so a stale hint can only hide a field,
    /// never misfeed the model.
    pub supports_prompt: bool,
    /// Whether this model takes a spoken-language hint.
    pub supports_language: bool,
}

/// Describe a stored model id against the catalog, or `None` when the id names
/// no model this build ships. Both the settings store (to refuse an unknown
/// choice) and `get_active_model` (to report identity and presence) read
/// through here, so there is one answer to "is this a real model".
pub fn describe(model_id: &str) -> Option<ActiveModel> {
    find(model_id).map(|entry| ActiveModel {
        id: entry.id(),
        name: entry.name.to_string(),
        installed: entry.cached_path().is_some(),
        supports_prompt: entry.supports_prompt,
        supports_language: entry.supports_language,
    })
}

/// Every catalog id. Exists for tests that need a real, resolvable identity
/// without hard-coding one that the catalog could later drop.
#[cfg(test)]
pub fn model_ids() -> Vec<String> {
    CATALOG.iter().map(|entry| entry.id()).collect()
}

/// Every catalog display name, so a test can assert that a message an
/// application receives names none of them.
#[cfg(test)]
pub fn model_names() -> Vec<&'static str> {
    CATALOG.iter().map(|entry| entry.name).collect()
}

/// A catalog model as Home's administration view sees it: identity, display
/// fields, static capabilities, and whether it is already downloaded. Home names
/// `id` when it activates, downloads, or deletes a model; it never learns the
/// Hugging Face coordinate. Applications see none of this.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    /// Approximate download size in bytes. `f64` because specta forbids 64-bit
    /// ints in TS; model sizes are far below `f64`'s exact-integer ceiling.
    #[specta(type = f64)]
    pub size_bytes: u64,
    pub supports_prompt: bool,
    pub supports_language: bool,
    pub recommended: bool,
    pub downloaded: bool,
}

#[derive(Error, Debug, Serialize, Deserialize, specta::Type)]
#[serde(tag = "name")]
pub enum CatalogError {
    #[error("Unknown model: {message}")]
    UnknownModel { message: String },

    #[error("Download failed: {message}")]
    DownloadFailed { message: String },

    #[error("Delete failed: {message}")]
    DeleteFailed { message: String },
}

/// The full local GGUF catalog with per-model download status. The picker's one
/// data source: which models exist, what they can do, and which are on disk.
#[tauri::command]
#[specta::specta]
pub fn list_models() -> Vec<ModelInfo> {
    CATALOG
        .iter()
        .map(|entry| ModelInfo {
            id: entry.id(),
            name: entry.name.to_string(),
            description: entry.description.to_string(),
            size_bytes: entry.size_bytes,
            supports_prompt: entry.supports_prompt,
            supports_language: entry.supports_language,
            recommended: entry.recommended,
            downloaded: entry.cached_path().is_some(),
        })
        .collect()
}

/// Forwards `hf-hub` download progress onto a Tauri channel as a cumulative
/// `DownloadProgress`. Cloned across `hf-hub`'s internal chunk tasks, so the
/// running byte count lives in a shared `Arc<AtomicU64>` and `total` is fixed
/// from `init`.
#[derive(Clone)]
struct ChannelProgress {
    channel: Channel<DownloadProgress>,
    received: Arc<AtomicU64>,
    total: Arc<AtomicU64>,
}

impl ChannelProgress {
    fn emit(&self) {
        let received = self.received.load(Ordering::Relaxed);
        let total = self.total.load(Ordering::Relaxed);
        let _ = self
            .channel
            .send(DownloadProgress::new(received as f64, total as f64));
    }
}

impl Progress for ChannelProgress {
    async fn init(&mut self, size: usize, _filename: &str) {
        self.total.store(size as u64, Ordering::Relaxed);
        self.received.store(0, Ordering::Relaxed);
        self.emit();
    }

    async fn update(&mut self, size: usize) {
        self.received.fetch_add(size as u64, Ordering::Relaxed);
        self.emit();
    }

    async fn finish(&mut self) {
        self.emit();
    }
}

/// Download a catalog model into the shared Hugging Face cache, reporting
/// cumulative progress on `on_progress`. Registered under `download_id` so
/// `cancel_download(download_id)` can abort the in-flight transfer (the aborted
/// task drops mid-download; hf-hub leaves a temp file, never a corrupt final).
/// A no-op-fast when the file is already cached (hf-hub reuses it).
#[tauri::command]
#[specta::specta]
pub async fn download_model(
    model_id: String,
    download_id: String,
    on_progress: Channel<DownloadProgress>,
    manager: State<'_, DownloadManager>,
) -> Result<(), CatalogError> {
    let entry = find_or_unknown(&model_id)?;

    let api = ApiBuilder::from_env()
        .with_progress(false)
        .build()
        .map_err(|e| CatalogError::DownloadFailed {
            message: format!("Failed to initialize Hugging Face API: {e}"),
        })?;
    let repo = api.repo(entry.repo());
    let filename = entry.coord.filename.to_string();
    let progress = ChannelProgress {
        channel: on_progress,
        received: Arc::new(AtomicU64::new(0)),
        total: Arc::new(AtomicU64::new(0)),
    };

    manager
        .run(&download_id, async move {
            repo.download_with_progress(&filename, progress).await
        })
        .await
        .map_err(|e| CatalogError::DownloadFailed { message: e })?
        .map(|_path| ())
        .map_err(|e| CatalogError::DownloadFailed {
            message: format!("Failed to download model: {e}"),
        })
}

/// Remove a downloaded model's file from the shared HF cache, reclaiming its
/// space, and stand down the active choice if this was it.
///
/// One host operation, not two invokes, because the host owns both halves: the
/// file and the active-model setting live on the same side of the boundary, and
/// splitting them would let a caller succeed at deleting and then fail (or
/// forget) to clear, leaving an active model that cannot run and a UI that never
/// learned. Clearing is deliberate rather than promoting another installed
/// model: there is no substitution, so the next transcription fails with an
/// actionable error until the user chooses again.
///
/// Best-effort on the file: removes the snapshot pointer and its backing blob. A
/// no-op when the model is not downloaded. Other quantizations in the same repo
/// are untouched (each is its own blob + pointer).
#[tauri::command]
#[specta::specta]
pub fn delete_model(
    model_id: String,
    model_cache: State<'_, crate::transcription::ModelCache>,
) -> Result<(), CatalogError> {
    let entry = find_or_unknown(&model_id)?;
    let settings = model_cache.settings();

    let clear_active_choice = || -> Result<(), CatalogError> {
        if settings.active_model_id().as_deref() != Some(model_id.as_str()) {
            return Ok(());
        }
        settings
            .set_active_model_id(None)
            .map_err(|error| CatalogError::DeleteFailed {
                message: format!(
                    "Removed the model file, but could not clear it as the active model: {error}"
                ),
            })
    };

    let Some(pointer) = entry.cached_path() else {
        // Nothing on disk, but it may still be the stored choice: a file deleted
        // outside Epicenter leaves exactly that state, and this is where it gets
        // reconciled.
        return clear_active_choice();
    };

    // The pointer is a symlink into `blobs/{etag}`; resolve it before unlinking
    // so we can reclaim the blob too. `canonicalize` fails once the link is gone,
    // so read it first.
    let blob = std::fs::canonicalize(&pointer).ok();
    std::fs::remove_file(&pointer).map_err(|e| CatalogError::DeleteFailed {
        message: format!("Failed to remove model file: {e}"),
    })?;
    if let Some(blob) = blob {
        // Blob removal is best-effort: a failure here only leaks disk, and the
        // model already reads as not-downloaded (its pointer is gone).
        let _ = std::fs::remove_file(blob);
    }
    clear_active_choice()
}
