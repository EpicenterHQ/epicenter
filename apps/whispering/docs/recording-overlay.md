# Recording overlay

> Historical. This describes the recording overlay of the earlier Whispering that
> ran inside the Epicenter desktop host. The standalone app in this directory has
> no overlay window; see [README.md](../README.md) for what it supports.

A small floating pill that appears while Whispering is capturing audio, inspired
by Handy's recording overlay. It shows that Whispering is listening and lets the
user stop or cancel without returning to the main window.

## How it works

The overlay is driven entirely from the frontend, because Whispering's recording
lifecycle already lives in the frontend (`manualRecorder` and `vadRecorder`
state modules). This is the key difference from Handy, which drives its overlay
from Rust because Handy's recording lifecycle lives in Rust. Pushing our overlay
into Rust would split the source of truth, so we keep it in the main window.

- **Window**: a separate, transparent, undecorated, always-on-top
  `recording-overlay` window, reused (shown/hidden) and positioned centered near
  the bottom of the active monitor. On macOS it is a non-activating `NSPanel`
  created in Rust (`../../epicenter/src-tauri/src/overlay.rs`, via
  tauri-nspanel) so clicking it never activates the app or raises the main
  window; `focusable: false` alone does not prevent app activation on click. On
  Windows and Linux it is a
  `focusable: false` + `alwaysOnTop` `WebviewWindow` created from the frontend.
  The window manager finds the macOS panel by label and only creates a window
  when none exists, so both paths share one show/hide/position code path.
- **Route**: `/recording-overlay` renders the pill. It lives in its own webview,
  so it cannot read the recorder state directly.
- **Shared pill** (`src/lib/recording-pill/`): owns the platform-free status and
  action model, lifecycle projection, presentation, and meter curve.
- **Dictation indicator** (`src/lib/dictation-indicator/`): the build-selected
  presentation mounted once by the app layout. The browser component reads
  `dictationLifecycle` directly and renders the shared pill in-page. The Tauri
  component projects the same lifecycle, synchronizes the native overlay
  window, and listens for overlay actions and reveal requests.
- **Tauri overlay** (`src/lib/recording-overlay/`): owns only the secondary-window
  event protocol, window management, and desktop mic-level transport. The Tauri
  dictation-indicator component drives the native window manager; the browser
  build never resolves that `.tauri` implementation.
- **Protocol** (`src/lib/recording-overlay/events.ts`): binds the shared pill
  model to Tauri event channels. The main window pushes a `status` to the overlay;
  the overlay pushes `action` (stop, cancel, or ship the raw transcript during
  polishing) and a `ready` handshake back. Actions are routed against the live
  lifecycle state in the main window, not the overlay's payload, so a click that
  races a state change is safe.
- **Controls**: the stop and cancel buttons are filled chips (stop is red), and
  polishing offers a ship-raw control. They read as buttons in the small pill and
  stop click propagation.
  Clicking the pill body anywhere else emits `main-window:reveal`, which brings
  the main Whispering window forward (show + unminimize + setFocus); it is a
  separate gesture from stop/cancel so finishing a recording never yanks the
  window up.
- **Mic levels** (`mic-level` channel): the bars reflect real loudness, not a
  loop. Both producers send a raw RMS amplitude and the receiving pill mount
  applies the shared perceptual curve + smoothing:
  - VAD: RMS computed from the frame `@ricky0123/vad-web` already hands us via
    `onFrameProcessed` (no second audio graph), delivered through the
    `#platform/recording-mic-level` seam. The browser implementation lives with
    the pill and updates the host's reactive meter; the Tauri implementation
    lives with the overlay transport and forwards the sample to its webview.
  - Manual (CPAL/Tauri): the PCM lives only in Rust, so the consumer worker
    (`../../epicenter/src-tauri/src/recorder/recorder.rs`) computes RMS and emits
    a throttled (~20 Hz) targeted
    `emit_to("recording-overlay", "mic-level", rms)`, per Tauri's guidance for
    high-frequency events. This is Handy's approach.

The single source of recorder state means no parallel recording lifecycle is
introduced: the overlay only reflects and triggers the existing operations.

## Dev environment note

The TanStack Query devtools were removed from the root layout entirely (the
dependency too): it blocked the view in dev and was not pulling its weight.

The app does not position the Svelte inspector. `svelte.config.js` owns only
its behavior (hold mode, always-visible toggle, `alt-x`); the toggle inherits
the plugin default `top-right`, the corner left free by the current chrome (the
sidebar on the left, the full-width BottomNav at the bottom). Do not reintroduce
CSS that offsets `#svelte-inspector-host`: earlier overrides keyed to nav
z-index broke twice when the nav changed. To move or disable it per-machine, set
an env var instead, for example
`SVELTE_INSPECTOR_OPTIONS='{"toggleButtonPos":"top-left"}'`.

The overlay route still hides `#svelte-inspector-host` in its own webview with
one co-located CSS rule, since the inspector would otherwise sit on the pill.
That is suppression, not positioning, and it stays. All of this is dev-only.

## Deliberately deferred

These are tracked here as follow-ups.

1. **Settings.** There is no `show recording overlay` toggle or top/bottom
   position setting yet. Whispering keeps no folder settings; a toggle would be
   a field of a `settings` table row, which this slice did not warrant, so the
   overlay is on by default in the Tauri build. Add the toggle when touching the
   settings schema is otherwise justified.
