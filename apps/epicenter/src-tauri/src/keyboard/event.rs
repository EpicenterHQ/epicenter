use serde::{Deserialize, Serialize};

/// The single source of truth for whether Epicenter can paste a transcript at
/// the cursor: a synthetic Cmd/Ctrl+V that, on macOS, needs the Accessibility
/// grant. macOS is the only platform that gates it, and the only process that
/// can authoritatively know is the one holding the tap (this one), so Rust owns
/// this value and the frontend is a pure view over it (ADR-0117).
///
/// It folds two facts the frontend used to infer separately: the macOS trust
/// probe (`AXIsProcessTrusted`) and the tap's liveness. Crucially `Broken` is
/// distinguishable from `Active` only here, because `AXIsProcessTrusted` reports
/// a stale post-update grant as trusted: the tap dying under a held grant is the
/// only signal that tells them apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum DictationCapability {
    /// The supervisor has not determined the value yet. Rust resolves this
    /// synchronously at startup, so it exists only as the frontend's pre-seed
    /// initial value before the first probe lands.
    Unknown,
    /// Auto-paste-at-cursor is off, so nothing needs the grant: the tap is
    /// deliberately not running and no Accessibility is touched. Global shortcuts
    /// are plugin chords and work regardless.
    Inactive,
    /// macOS Accessibility is not granted, so paste at cursor falls back to the
    /// clipboard. Turning Epicenter on in System Settings unlocks the paste.
    Untrusted,
    /// The tap is running and the app is trusted: paste at cursor can land.
    Active,
    /// macOS reports the app trusted, but the tap keeps dying under the held
    /// grant: a stale post-update signature. Removing and re-adding Epicenter
    /// in Accessibility is the fix, which `Untrusted`'s "just toggle on" is not.
    Broken,
}

/// A dictation capability change, for the generated
/// `events.dictationCapabilityEvent`. Nothing emits it yet: ADR-0555 sends it
/// to every window of an app that called `get_dictation_capability`, and until
/// then a page reads the capability with that command.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type, tauri_specta::Event,
)]
#[serde(rename_all = "camelCase")]
pub struct DictationCapabilityEvent {
    pub capability: DictationCapability,
}
