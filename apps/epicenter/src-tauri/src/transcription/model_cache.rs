use super::catalog::{describe, installed_model_path};
use super::error::{format_error_chain, TranscriptionError};
use super::settings::{LocalTranscriptionSettings, UnloadPolicy};
use super::{
    AppliedHints, LocalTranscriptionReadiness, TranscriptionHints, TranscriptionOutcome,
    UnavailableReason,
};
use log::{debug, info, warn};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Once};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use transcribe_cpp::{
    Backend, Feature, Model, ModelOptions, RunExtension, RunOptions, WhisperRunOptions,
};

/// Resident model metadata. The identity fingerprints the bytes at load time so
/// the cache can notice the file changed underneath a stable path (a delete then
/// re-download of the same coordinate, or an external cache edit). `None`
/// identity never compares equal to a fresh read, so the cache reloads.
/// `transcribe_cpp::Model` is `Arc`-backed and cheap to hold resident; each
/// transcription opens a fresh cheap `Session` from it.
struct CachedModel {
    path: PathBuf,
    disk_identity: Option<DiskIdentity>,
    model: Model,
}

type Cached = Option<CachedModel>;

/// The active model resolved at the point of use.
struct ResolvedModel {
    id: String,
    path: PathBuf,
    supports_prompt: bool,
    supports_language: bool,
}

/// The one precondition failure, before it becomes either an advisory readiness
/// answer or a transcription error. Both renderings carry the same reason and
/// the same identity-free sentence.
struct Unavailable {
    reason: UnavailableReason,
    message: String,
}

impl From<Unavailable> for TranscriptionError {
    fn from(unavailable: Unavailable) -> Self {
        TranscriptionError::LocalRouteUnavailable {
            reason: unavailable.reason,
            message: unavailable.message,
        }
    }
}

/// Owns the resident model's lifecycle: the loaded model and the unload-policy
/// clock, plus the host-owned settings that name the active model. The cache
/// owns native mechanism only; the settings store owns the values. They share
/// the struct because every command that touches one touches the other, and
/// there is exactly one of each per device.
#[derive(Clone)]
pub struct ModelCache {
    /// The currently-resident model and the path it was loaded from. The mutex
    /// is held across `load` and the inference call inside `run_loaded` so
    /// concurrent transcribe calls serialize (one model fits in memory, and
    /// transcribe.cpp 0.x permits one in-flight run per model).
    cached: Arc<Mutex<Cached>>,

    /// Millis since UNIX_EPOCH of the last transcription start or completion.
    /// Atomic so the idle watcher can read it without contending with the
    /// cache mutex during long inference.
    last_activity_ms: Arc<AtomicU64>,

    /// The host's device-local settings: which model is active, and when to drop
    /// it. Read at the point of use on every transcribe, prewarm, and idle tick.
    settings: Arc<LocalTranscriptionSettings>,
}

impl ModelCache {
    pub fn new(settings: LocalTranscriptionSettings) -> Self {
        Self {
            cached: Arc::new(Mutex::new(None)),
            last_activity_ms: Arc::new(AtomicU64::new(now_millis())),
            settings: Arc::new(settings),
        }
    }

    /// The host-owned settings store, for the Home administration commands.
    pub fn settings(&self) -> &LocalTranscriptionSettings {
        &self.settings
    }

    fn current_policy(&self) -> UnloadPolicy {
        self.settings.unload_policy()
    }

    // ── Active model ──────────────────────────────────────────────────

    /// Resolve the active model, at the point of use, to everything a run needs:
    /// its id, its file, and what it accepts.
    ///
    /// The single resolution path. Readiness and transcribe both go through it,
    /// so the answer an application was shown and the answer a transcription
    /// acts on cannot disagree about *why* the route is unusable. Resolving here
    /// rather than from a cached verdict is what makes a model that appears (or
    /// disappears) in the shared cache take effect on the very next call.
    ///
    /// Failure changes nothing: no adoption, no download, no substitution.
    fn resolve_active(&self) -> Result<ResolvedModel, Unavailable> {
        let Some(model_id) = self.settings.active_model_id() else {
            return Err(Unavailable {
                reason: UnavailableReason::NoActiveModel,
                message: "No local transcription model is active on this device. \
                          Choose one in Epicenter Home."
                    .to_string(),
            });
        };
        // Identity stays inside the host. `describe` is read for capabilities,
        // and the message below deliberately names no model.
        match (describe(&model_id), installed_model_path(&model_id)) {
            (Some(model), Some(path)) => Ok(ResolvedModel {
                id: model_id,
                path,
                supports_prompt: model.supports_prompt,
                supports_language: model.supports_language,
            }),
            _ => Err(Unavailable {
                reason: UnavailableReason::ActiveModelUnavailable,
                message: "The active local transcription model is not available on this \
                          device. Open Epicenter Home to download it or choose another."
                    .to_string(),
            }),
        }
    }

    /// The advisory readiness an application may read. Derived from the same
    /// resolution transcribe performs, never from a separate cached verdict.
    pub fn readiness(&self) -> LocalTranscriptionReadiness {
        match self.resolve_active() {
            Ok(model) => LocalTranscriptionReadiness::Ready {
                supports_prompt: model.supports_prompt,
                supports_language: model.supports_language,
            },
            Err(unavailable) => LocalTranscriptionReadiness::Unavailable {
                reason: unavailable.reason,
                message: unavailable.message,
            },
        }
    }

    // ── Transcribe ────────────────────────────────────────────────────

    /// Synchronous inference dispatch. Validates the samples, resolves the
    /// active model to a cached GGUF path, then loads (or reuses) and runs
    /// transcribe.cpp batch with the caller's advisory hints. Called from a
    /// blocking-pool thread.
    ///
    /// Empty audio is the one case that returns without naming a model: there is
    /// nothing to transcribe, so nothing ran.
    pub fn transcribe(
        &self,
        samples: Vec<f32>,
        hints: TranscriptionHints,
    ) -> Result<TranscriptionOutcome, TranscriptionError> {
        // Resolve first: a caller with no active model deserves that error even
        // when it happens to have sent silence. The precondition is about this
        // device being set up, and silence does not make it set up.
        let model = self.resolve_active()?;
        let model_id = model.id.clone();

        if samples.is_empty() {
            // No model is named and no hint is reported: nothing ran, so there is
            // nothing honest to attribute this to.
            warn!("[Transcription] zero samples, nothing to transcribe");
            return Ok(TranscriptionOutcome::EmptyAudio);
        }

        let samples = sanitize_samples(samples);

        info!(
            "[Transcription] starting GGUF transcription: model={} pcm_samples={}",
            model_id,
            samples.len(),
        );

        let inference_started = Instant::now();
        let (text, applied) = self.run_loaded(&model, &hints, &samples)?;

        info!(
            "[Transcription] GGUF transcription complete: characters={} elapsed_ms={}",
            text.len(),
            inference_started.elapsed().as_millis(),
        );
        self.evict_if_immediate();
        Ok(TranscriptionOutcome::Transcribed {
            text,
            model_id,
            applied,
        })
    }

    // ── Model cache + eviction ────────────────────────────────────────

    /// Load the active model into the cache without running inference, so the
    /// next transcribe finds it warm. Idempotent: a no-op when it is already
    /// resident. Called at capture start (manual record / VAD listen) to overlap
    /// the cold load with the user's speech. Shares the one load path
    /// (`ensure_loaded`) with transcribe, and resolves the same active model, so
    /// what is warmed here is exactly what transcribe will run.
    pub fn prewarm(&self) -> Result<(), TranscriptionError> {
        let model = self.resolve_active()?;
        self.touch_activity();
        let _guard = self.ensure_loaded(&model.id, model.path.clone())?;
        Ok(())
    }

    /// Hold the cache lock across load. If `(path, identity)` matches the cache,
    /// reuse; otherwise drop and load fresh under the same lock. The model loads
    /// lazily here, on the transcription that needs it.
    fn ensure_loaded(
        &self,
        model_id: &str,
        model_path: PathBuf,
    ) -> Result<MutexGuard<'_, Cached>, TranscriptionError> {
        let mut guard = lock_cached(&self.cached);

        // Fingerprint the bytes on disk now and reuse only when they match what
        // the resident model was loaded from. A delete + re-download of the same
        // coordinate, or an external cache edit, changes the identity even though
        // the path is unchanged, so the stale resident model is dropped and
        // reloaded.
        let current_identity = disk_identity(&model_path);
        let reuse = matches!(
            &*guard,
            Some(cached)
                if cached.path == model_path
                    && current_identity.is_some()
                    && current_identity == cached.disk_identity
        );

        if reuse {
            crate::timing_note!("model.load warm-reuse model={}", model_id);
            return Ok(guard);
        }

        let _ = guard.take();
        let started = Instant::now();
        match load_gguf_model(&model_path) {
            Ok(model) => {
                let elapsed_ms = started.elapsed().as_millis() as u64;
                debug!(
                    "[Transcription] model loaded: {} ({}ms)",
                    model_path.display(),
                    elapsed_ms
                );
                crate::timing_note!("model.load COLD {elapsed_ms}ms model={}", model_id);
                *guard = Some(CachedModel {
                    path: model_path,
                    disk_identity: current_identity,
                    model,
                });
            }
            Err(message) => {
                return Err(TranscriptionError::ModelLoadError { message });
            }
        }

        Ok(guard)
    }

    /// Run one batch transcription on the resident active model, loading it
    /// first if needed. Holds the cache lock across load and inference. Returns
    /// the text alongside the hints the run actually applied.
    fn run_loaded(
        &self,
        resolved: &ResolvedModel,
        hints: &TranscriptionHints,
        samples: &[f32],
    ) -> Result<(String, AppliedHints), TranscriptionError> {
        self.touch_activity();
        let guard = self.ensure_loaded(&resolved.id, resolved.path.clone())?;

        let model = &guard.as_ref().expect("cache slot populated above").model;
        let started = Instant::now();
        let result = run_gguf(model, samples, hints, resolved.supports_language);
        let elapsed_ms = started.elapsed().as_millis() as u64;
        crate::timing_note!("model.inference {elapsed_ms}ms model={}", resolved.id);
        self.touch_activity();
        // An inference failure leaves the model resident so the next call can
        // reuse it (the failure may be a transient FFI or input issue).
        result
    }

    fn touch_activity(&self) {
        self.last_activity_ms.store(now_millis(), Ordering::Relaxed);
    }

    /// Drop the resident model now if the current policy is `Immediately`.
    /// Called at the end of every successful transcription.
    fn evict_if_immediate(&self) {
        if !matches!(self.current_policy(), UnloadPolicy::Immediately) {
            return;
        }
        if let Some(path) = self.try_unload() {
            debug!(
                "[Transcription] unloaded model (immediate): {}",
                path.display()
            );
        }
    }

    /// Drop the resident model if the cache isn't mid-transcription, returning
    /// the path it unloaded (or `None` when busy or already empty). Uses
    /// `try_lock` so it never blocks behind an in-flight run: a busy cache keeps
    /// its model, which the next transcription reloads against its per-call spec
    /// anyway. Both eviction policies (immediate and idle) unload through here,
    /// so the lock discipline lives in one place and each caller logs its reason.
    fn try_unload(&self) -> Option<PathBuf> {
        let mut guard = self.cached.try_lock().ok()?;
        guard.take().map(|cached| cached.path)
    }

    // ── Idle watcher ──────────────────────────────────────────────────

    /// Start the background idle watcher. Spawns one task on the Tauri
    /// async runtime; safe to call once at setup.
    pub fn start_idle_watcher(&self) {
        let cache = self.clone();
        tauri::async_runtime::spawn(async move {
            let tick = Duration::from_secs(10);
            loop {
                tokio::time::sleep(tick).await;
                cache.tick_idle();
            }
        });
    }

    fn tick_idle(&self) {
        let Some(timeout) = idle_timeout_for(self.current_policy()) else {
            return;
        };
        let idle = Duration::from_millis(
            now_millis().saturating_sub(self.last_activity_ms.load(Ordering::Relaxed)),
        );
        if idle < timeout {
            return;
        }
        // A long transcription in progress just postpones eviction to the next
        // tick (try_unload's try_lock) instead of blocking the watcher.
        if let Some(path) = self.try_unload() {
            debug!(
                "[Transcription] unloaded model (idle {}s): {}",
                idle.as_secs(),
                path.display()
            );
        }
    }
}

/// Load a GGUF model through transcribe.cpp, initializing the compute backends
/// once on first use. The backend (Metal / Vulkan / CPU) is chosen per target.
fn load_gguf_model(model_path: &Path) -> Result<Model, String> {
    init_transcribe_cpp_backends();
    let options = ModelOptions {
        backend: default_backend(),
        gpu_device: 0,
    };
    Model::load_with(model_path, &options).map_err(|e| {
        format!(
            "Failed to load GGUF model {}: {}",
            model_path.display(),
            format_error_chain(&e)
        )
    })
}

/// Open a session on the resident model and run one batch transcription. Whisper
/// accepts an `initial_prompt`; the runtime is asked directly via
/// `Feature::InitialPrompt` so a non-prompt model (Parakeet) simply ignores it,
/// independent of the catalog's static capability hint.
///
/// Returns the text with an `AppliedHints` built from the same expressions that
/// decide what reaches the runtime, so the report cannot drift from the run: a
/// prompt the active model will not take is reported as not applied rather than
/// dropped in silence (ADR-0180).
/// Decide which advisory hints actually reach the runtime, and report exactly
/// those.
///
/// The whole point is that `applied` is derived from the same values that go
/// into `RunOptions`, in one place, so the report cannot drift from the run.
/// A hint the model cannot take is filtered here rather than handed over and
/// silently ignored downstream.
///
/// `accepts_prompt` is runtime-authoritative (`Feature::InitialPrompt`), asked
/// of the loaded model itself. `accepts_language` is the catalog's static
/// verdict, because transcribe.cpp exposes no language feature query: its
/// `Feature` enum covers prompt, temperature fallback, long form, cancellation,
/// PNC, and ITN, and nothing about language. That is the most authoritative
/// answer available, and it is the same value readiness reports, so what an
/// application was told it could send is exactly what gets sent.
fn plan_hints(
    hints: &TranscriptionHints,
    accepts_prompt: bool,
    accepts_language: bool,
) -> (Option<String>, Option<String>) {
    let language = hints
        .language
        .clone()
        .filter(|language| !language.is_empty() && accepts_language);
    let initial_prompt = hints
        .initial_prompt
        .clone()
        .filter(|prompt| !prompt.is_empty() && accepts_prompt);
    (language, initial_prompt)
}

fn run_gguf(
    model: &Model,
    samples: &[f32],
    hints: &TranscriptionHints,
    accepts_language: bool,
) -> Result<(String, AppliedHints), TranscriptionError> {
    let mut session = model
        .session()
        .map_err(|e| TranscriptionError::ModelLoadError {
            message: format!(
                "Failed to create transcription session: {}",
                format_error_chain(&e)
            ),
        })?;

    let accepts_prompt = session.model().supports(Feature::InitialPrompt);
    let (language, initial_prompt) = plan_hints(hints, accepts_prompt, accepts_language);
    if hints.initial_prompt.is_some() && initial_prompt.is_none() {
        debug!("[Transcription] active model does not accept an initial prompt; not applied");
    }
    if hints.language.is_some() && language.is_none() {
        debug!("[Transcription] active model does not accept a language hint; not applied");
    }

    // `applied` mirrors `run_options` field for field: both are built from the
    // same two values, so the transcript cannot report a hint the run did not get.
    let applied = AppliedHints {
        language: language.clone(),
        initial_prompt: initial_prompt.is_some(),
    };
    let run_options = RunOptions {
        language,
        family: initial_prompt.map(|prompt| {
            RunExtension::Whisper(WhisperRunOptions {
                initial_prompt: Some(prompt),
                ..Default::default()
            })
        }),
        ..Default::default()
    };

    session
        .run(samples, &run_options)
        .map(|transcript| (transcript.text.trim().to_string(), applied))
        .map_err(|e| TranscriptionError::TranscriptionError {
            message: format_error_chain(&e),
        })
}

static INIT_TRANSCRIBE_CPP: Once = Once::new();

/// Initialize the transcribe-cpp compute backends exactly once.
///
/// `init_backends_default()` scans the directory of the loaded `libtranscribe`
/// for its dlopen'd ggml modules — exactly our bundle layout on every target
/// (Linux `/usr/lib` on the `$ORIGIN/../lib` rpath; x86_64 Windows the install
/// root beside the exe; a dev build loads from the sys crate's own output dir).
/// A no-op on the static targets (macOS Metal, aarch64 Windows): the backends
/// are compiled in.
fn init_transcribe_cpp_backends() {
    INIT_TRANSCRIBE_CPP.call_once(|| {
        transcribe_cpp::init_logging();
        match transcribe_cpp::init_backends_default() {
            Ok(()) => {
                let devices = transcribe_cpp::devices();
                info!(
                    "transcribe-cpp initialized with {} compute device(s)",
                    devices.len()
                );
            }
            Err(e) => warn!("Failed to initialize transcribe-cpp backends: {}", e),
        }
    });
}

/// The GGU compute backend to request per target. transcribe.cpp appends a CPU
/// fallback, so a GPU-init failure degrades to CPU rather than failing the load.
fn default_backend() -> Backend {
    #[cfg(target_os = "macos")]
    {
        Backend::Metal
    }
    #[cfg(all(windows, target_arch = "x86_64"))]
    {
        Backend::Vulkan
    }
    #[cfg(target_os = "linux")]
    {
        Backend::Vulkan
    }
    #[cfg(not(any(
        target_os = "macos",
        all(windows, target_arch = "x86_64"),
        target_os = "linux"
    )))]
    {
        Backend::Cpu
    }
}

/// Replace NaN/Inf with 0.0 and cap length so a malformed sample buffer never
/// reaches the ggml FFI boundary (where a `GGML_ASSERT` would abort the process
/// and bypass any Rust-level recovery). Cheap insurance against the most common
/// abort class.
fn sanitize_samples(mut samples: Vec<f32>) -> Vec<f32> {
    // Cap at one hour of mono 16kHz audio. Beyond this we don't run inference
    // reliably anyway and the FE imposes its own caps; this is a backstop
    // against integer overflow or pathological inputs.
    const MAX_SAMPLES: usize = 16_000 * 60 * 60;
    if samples.len() > MAX_SAMPLES {
        warn!(
            "[Transcription] truncating {} samples to MAX_SAMPLES ({})",
            samples.len(),
            MAX_SAMPLES
        );
        samples.truncate(MAX_SAMPLES);
    }
    for s in samples.iter_mut() {
        if !s.is_finite() {
            *s = 0.0;
        }
    }
    samples
}

fn idle_timeout_for(policy: UnloadPolicy) -> Option<Duration> {
    match policy {
        UnloadPolicy::Never | UnloadPolicy::Immediately => None,
        UnloadPolicy::AfterFiveMinutes => Some(Duration::from_secs(5 * 60)),
        UnloadPolicy::AfterThirtyMinutes => Some(Duration::from_secs(30 * 60)),
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Lock the cache slot, recovering from poisoning by clearing the cached model
/// so the next caller reloads from scratch instead of reusing corrupted state
/// from a previous panic.
fn lock_cached(cached: &Mutex<Cached>) -> MutexGuard<'_, Cached> {
    cached.lock().unwrap_or_else(|poisoned| {
        warn!(
            "[Transcription] Cache mutex was poisoned from previous panic, clearing state to force reload..."
        );
        let mut recovered = poisoned.into_inner();
        *recovered = None;
        recovered
    })
}

/// Cheap fingerprint of the bytes a resident model was loaded from, used to
/// notice when the file at a stable path changed underneath the cache (a delete
/// + re-download of the same coordinate, or an external cache edit). `len`
/// catches a swap to a different file; `mtime` catches a same-size rewrite.
#[derive(Clone, PartialEq, Eq, Debug)]
struct DiskIdentity {
    len: u64,
    mtime: Option<SystemTime>,
}

/// Read the disk identity of a resolved model path, following symlinks so the
/// identity reflects the bytes transcribe.cpp actually reads (HF cache pointers
/// are symlinks into `blobs/`). Returns `None` when the path cannot be stat'd,
/// which the cache treats as "cannot confirm reuse" and reloads.
fn disk_identity(path: &Path) -> Option<DiskIdentity> {
    let meta = std::fs::metadata(path).ok()?;
    Some(DiskIdentity {
        len: meta.len(),
        mtime: meta.modified().ok(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcription::catalog;

    /// A cache over a settings file in a scratch directory. `label` keeps
    /// concurrent tests off each other's files.
    fn cache_with(label: &str, stored: Option<&str>) -> ModelCache {
        let dir = std::env::temp_dir().join(format!(
            "epicenter-readiness-{label}-{}",
            std::process::id()
        ));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("local-transcription.json");
        if let Some(model_id) = stored {
            // Written directly rather than through `set_active_model_id`, which
            // refuses ids outside the catalog. This is the shape a settings file
            // takes when a build drops a model the user had active.
            std::fs::write(
                &path,
                format!("{{\"activeModelId\":\"{model_id}\",\"unloadPolicy\":\"never\"}}"),
            )
            .unwrap();
        }
        ModelCache::new(LocalTranscriptionSettings::load(path))
    }

    fn unavailable_of(readiness: &LocalTranscriptionReadiness) -> (UnavailableReason, String) {
        match readiness {
            LocalTranscriptionReadiness::Unavailable { reason, message } => {
                (*reason, message.clone())
            }
            LocalTranscriptionReadiness::Ready { .. } => {
                panic!("expected the route to be unavailable")
            }
        }
    }

    #[test]
    fn no_active_model_reads_as_that_precondition() {
        let (reason, message) = unavailable_of(&cache_with("none", None).readiness());
        assert_eq!(reason, UnavailableReason::NoActiveModel);
        assert!(
            message.contains("Epicenter Home"),
            "the message must name the one place that can fix it: {message}"
        );
    }

    #[test]
    fn an_active_model_this_build_dropped_reads_as_unavailable() {
        let (reason, _) =
            unavailable_of(&cache_with("dropped", Some("retired@main/model.gguf")).readiness());
        assert_eq!(reason, UnavailableReason::ActiveModelUnavailable);
    }

    /// Readiness is advisory, so it is allowed to be stale. It is never allowed
    /// to disagree with transcribe about *why* the route cannot run: both go
    /// through one resolution, and this is what pins that.
    #[test]
    fn readiness_and_transcribe_report_the_same_precondition() {
        for (label, stored) in [
            ("agree-none", None),
            ("agree-dropped", Some("retired@main/model.gguf")),
        ] {
            let cache = cache_with(label, stored);
            let (advisory, _) = unavailable_of(&cache.readiness());
            let error = cache
                .transcribe(vec![0.1, 0.2], TranscriptionHints::default())
                .expect_err("an unusable route must fail transcribe");
            match error {
                TranscriptionError::LocalRouteUnavailable { reason, .. } => {
                    assert_eq!(reason, advisory, "advisory and acted-on reason must match");
                }
                other => panic!("expected a precondition failure, got {other:?}"),
            }
        }
    }

    /// Model identity is administration data. An application reads readiness and
    /// receives transcription errors, so neither may name a model, or callers
    /// would start keying behaviour off a name they are not supposed to have.
    #[test]
    fn nothing_an_application_receives_names_a_model() {
        for (label, stored) in [
            ("leak-none", None),
            ("leak-dropped", Some("retired@main/model.gguf")),
        ] {
            let cache = cache_with(label, stored);
            let (_, advisory) = unavailable_of(&cache.readiness());
            let TranscriptionError::LocalRouteUnavailable { message: acted, .. } = cache
                .transcribe(vec![0.1], TranscriptionHints::default())
                .expect_err("an unusable route must fail transcribe")
            else {
                panic!("expected a precondition failure");
            };
            for name in catalog::model_names() {
                assert!(!advisory.contains(name), "readiness leaked {name}");
                assert!(!acted.contains(name), "the error leaked {name}");
            }
        }
    }

    /// A language the active model cannot take must not be handed to the runtime
    /// and must not be reported as applied. Reporting it would tell the user
    /// their choice took effect when the recognizer never saw it.
    #[test]
    fn a_language_the_model_cannot_take_is_neither_sent_nor_claimed() {
        let hints = TranscriptionHints {
            language: Some("fr".to_string()),
            initial_prompt: Some("Epicenter".to_string()),
        };
        let (language, prompt) = plan_hints(&hints, true, false);
        assert_eq!(language, None, "an unsupported language is filtered out");
        assert_eq!(prompt.as_deref(), Some("Epicenter"));
    }

    #[test]
    fn a_prompt_the_model_cannot_take_is_neither_sent_nor_claimed() {
        let hints = TranscriptionHints {
            language: Some("fr".to_string()),
            initial_prompt: Some("Epicenter".to_string()),
        };
        let (language, prompt) = plan_hints(&hints, false, true);
        assert_eq!(language.as_deref(), Some("fr"));
        assert_eq!(prompt, None, "an unsupported prompt is filtered out");
    }

    #[test]
    fn supported_hints_pass_through_exactly() {
        let hints = TranscriptionHints {
            language: Some("fr".to_string()),
            initial_prompt: Some("Epicenter".to_string()),
        };
        let (language, prompt) = plan_hints(&hints, true, true);
        assert_eq!(language.as_deref(), Some("fr"));
        assert_eq!(prompt.as_deref(), Some("Epicenter"));
    }

    #[test]
    fn empty_hints_are_never_sent() {
        let hints = TranscriptionHints {
            language: Some(String::new()),
            initial_prompt: Some(String::new()),
        };
        assert_eq!(plan_hints(&hints, true, true), (None, None));
    }

    /// Failing closed means failing *inert*: a caller that hits the precondition
    /// must not find that the attempt adopted, downloaded, or substituted a model.
    /// Empty audio ran no model, so the outcome must not name one or claim a
    /// hint was applied. The precondition still comes first: silence does not
    /// make an unconfigured device configured.
    #[test]
    fn empty_audio_claims_no_model_and_no_applied_hints() {
        let cache = cache_with("empty-audio", None);
        let error = cache
            .transcribe(Vec::new(), TranscriptionHints::default())
            .expect_err("no active model is still the first answer");
        assert!(matches!(
            error,
            TranscriptionError::LocalRouteUnavailable { .. }
        ));

        // With a resolvable model the empty-audio outcome carries no attribution
        // at all, which is the shape that cannot lie.
        let outcome = TranscriptionOutcome::EmptyAudio;
        let encoded = serde_json::to_string(&outcome).unwrap();
        assert_eq!(encoded, "{\"outcome\":\"empty-audio\"}");
        assert!(
            !encoded.contains("modelId") && !encoded.contains("applied"),
            "empty audio must not attribute a model or hints: {encoded}"
        );
    }

    #[test]
    fn a_failed_precondition_changes_no_host_state() {
        let cache = cache_with("inert", None);
        let _ = cache.transcribe(vec![0.1], TranscriptionHints::default());
        let _ = cache.prewarm();
        assert_eq!(
            cache.settings().active_model_id(),
            None,
            "a failed transcription must not adopt a model"
        );
    }

    #[test]
    fn idle_timeout_is_none_for_non_timed_policies() {
        assert!(idle_timeout_for(UnloadPolicy::Never).is_none());
        assert!(idle_timeout_for(UnloadPolicy::Immediately).is_none());
    }

    #[test]
    fn idle_timeout_matches_minutes() {
        assert_eq!(
            idle_timeout_for(UnloadPolicy::AfterFiveMinutes),
            Some(Duration::from_secs(300))
        );
        assert_eq!(
            idle_timeout_for(UnloadPolicy::AfterThirtyMinutes),
            Some(Duration::from_secs(1800))
        );
    }

    #[test]
    fn sanitize_replaces_nonfinite_samples() {
        let cleaned = sanitize_samples(vec![1.0, f32::NAN, f32::INFINITY, -0.5, f32::NEG_INFINITY]);
        assert_eq!(cleaned, vec![1.0, 0.0, 0.0, -0.5, 0.0]);
    }

    #[test]
    fn disk_identity_stable_when_unchanged() {
        let dir = std::env::temp_dir().join(format!(
            "epicenter-whispering-id-stable-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("model.gguf");
        std::fs::write(&path, b"steady").unwrap();

        let a = disk_identity(&path).expect("identity for existing file");
        let b = disk_identity(&path).expect("identity on second read");
        assert_eq!(
            a, b,
            "identity is stable across reads when bytes are unchanged"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn disk_identity_changes_on_file_rewrite() {
        let dir = std::env::temp_dir().join(format!(
            "epicenter-whispering-id-file-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("model.gguf");

        // A swap to a different model: a different size alone changes identity.
        std::fs::write(&path, b"first").unwrap();
        let first = disk_identity(&path).expect("identity");
        std::fs::write(&path, b"second-and-longer").unwrap();
        let second = disk_identity(&path).expect("identity after size change");
        assert_ne!(first, second, "a size change changes identity");

        // A same-size re-download a tick later: equal length, so only mtime can
        // carry the difference. "thirdx-and-longer" matches "second-and-longer".
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(&path, b"thirdx-and-longer").unwrap();
        let third = disk_identity(&path).expect("identity after same-size rewrite");
        assert_eq!(
            b"second-and-longer".len(),
            b"thirdx-and-longer".len(),
            "test fixture must be same-size to exercise the mtime path"
        );
        assert_ne!(
            second, third,
            "a same-size rewrite changes identity via mtime"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn disk_identity_none_for_missing_path() {
        let path = std::env::temp_dir().join("epicenter-whispering-id-missing-does-not-exist");
        std::fs::remove_file(&path).ok();
        assert!(disk_identity(&path).is_none());
    }
}
