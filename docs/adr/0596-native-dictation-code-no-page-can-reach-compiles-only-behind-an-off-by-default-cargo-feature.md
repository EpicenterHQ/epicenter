# 0596. Native dictation code no page can reach compiles only behind an off-by-default Cargo feature

- **Status:** Accepted
- **Date:** 2026-10-17
- **Amends:** [ADR-0555](0555-apps-reach-native-code-through-official-tauri-plugins-first-granted-by-app-id.md) at "Clipboard-manager, global-shortcut, opener, and autostart are registered", the global-shortcut and clipboard-manager grants, and the custom Rust kept for `write_text`, `simulate_enter_keystroke`, `pause_playback`, `resume_playback`, `open_panel`, and `get_dictation_capability`: none of it is compiled, registered, or in the page API by default, until a native API decision exposes it. [ADR-0563](0563-a-hidden-app-window-keeps-running-until-epicenter-quits.md) at "A hidden window keeps its global shortcuts live" and push-to-talk from boot: no global-shortcut plugin runs in the default shell, so neither applies until a native API decision exposes it.
- **Relates:** [ADR-0589](0589-an-app-is-one-git-repository-of-built-files-at-an-address.md) (after the first release the page API changes only by addition).
- **Unbuilt:** all of it: the `dictation` feature in `apps/epicenter/src-tauri/Cargo.toml`, the `cfg` gates, and a default build whose generated bindings carry none of these commands.

## Context

The shell registers a family of native dictation code that no page can
call. `make_specta_builder` collects `write_text`,
`simulate_enter_keystroke`, `prewarm_model`, `pause_playback`,
`resume_playback`, `set_auto_paste_enabled`, and
`get_dictation_capability`, with `DictationCapabilityEvent`
(`apps/epicenter/src-tauri/src/lib.rs:122-166`). None of
`folders.json`, `home.json`, or `installed-app.json` in
`apps/epicenter/src-tauri/capabilities/` grants any of them, and
Whispering calls none of them. The rest of the family:

```txt
src/delivery.rs        write_text, simulate_enter_keystroke (enigo, tauri-plugin-clipboard-manager)
src/clipboard.rs       the macOS concealed clipboard delivery.rs writes through (objc2)
src/media.rs, media/   pause_playback, resume_playback (zbus on Linux, windows Media_Control)
src/keyboard/          TapController, the supervisor and its CGEventTap, set_auto_paste_enabled,
                       get_dictation_capability
src/overlay.rs         create_recording_overlay, which nothing calls (tauri-nspanel)
lib.rs:321, :323, :331 tauri-plugin-clipboard-manager, tauri-plugin-global-shortcut, tauri-nspanel registered
lib.rs:389             TapController::new(), which spawns the supervisor at launch (keyboard/mod.rs:74)
```

ADR-0589 makes the page API a contract that changes only by addition after
the first release. A command generated into the page API at that release
stays in it.

## Decision

**The native dictation family stays in the repository behind the Cargo
feature `dictation`, which is off by default.** Without it, the shell:

- compiles none of `delivery.rs`, `clipboard.rs`, `media.rs` and `media/`,
  `keyboard/`, or `overlay.rs`;
- registers none of `tauri-plugin-clipboard-manager`,
  `tauri-plugin-global-shortcut`, or `tauri-nspanel`, and the crates only
  these modules use become optional dependencies of the feature;
- collects none of `write_text`, `simulate_enter_keystroke`,
  `prewarm_model`, `pause_playback`, `resume_playback`,
  `set_auto_paste_enabled`, `get_dictation_capability`, or
  `DictationCapabilityEvent`, so the generated bindings and the command
  list `build.rs` reads (`src/command_names.rs`) name none of them;
- starts no keyboard supervisor at launch.

**A native API decision is what exposes any of it.** That decision names
the commands it adds to the page API, the capability that grants them, and
turns the code on in the default build.

**Kept on by default:** the recorder plugin
(`packages/tauri-plugin-epicenter-recorder`) with its WAV recovery, audio
decoding (`src/audio/`), and the transcription commands pages use
(`transcribe_audio_bytes`, `list_inference_models`,
`get_local_transcription_readiness`, and Settings' model administration).

## Consequences

- The first release's page API holds only what a page calls today.
- The default shell links fewer crates and runs no thread that polls the
  macOS Accessibility grant.
- CI builds and tests default features only, so the parked code is not
  compiled there and can stop compiling. Whoever turns it on for a native
  API decision fixes what has rotted.
- Whispering's paste at the cursor, media pause, overlay, and global
  shortcut stay unavailable in Epicenter, as they are today.

## Considered alternatives

- **Leave the family compiled and registered.** Every collected command is
  generated into the page API, so the first release would freeze commands
  no page uses.
- **Delete the family.** The paste, media, and keyboard code carries
  platform work (ADR-0020's tap, ADR-0018's CoreAudio gate) that a future
  native API decision would otherwise write again.
