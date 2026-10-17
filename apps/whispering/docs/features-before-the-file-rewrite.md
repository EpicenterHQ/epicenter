# Features before the file rewrite

This is a reference for rebuilding Whispering features that existed before
the October 2026 file-based rewrite. Each entry says what the feature did,
where its code last lived, what is left of it today, and what a rebuild needs
on the current architecture. Point a prompt at the entry, for example "bring
back push-to-talk, see `apps/whispering/docs/features-before-the-file-rewrite.md`".

Three points in history matter:

| Ref | Date | What it is |
| --- | --- | --- |
| `v7.11.0` (`a6b15c28db`) | 2025-12-27 | The last release: what users had. A standalone Tauri app in `apps/whispering/src-tauri/`. |
| `8bc2aafd03^` (`0ae4177383`) | 2026-10-01 | The last Yjs-based Whispering, running as a built-in window of the Epicenter desktop app, before "feat(whispering): replace Yjs app with standalone file desktop". |
| `bd3e40f353^` (`b836dabad2`) | 2026-10-15 | The last Epicenter shell that compiled in Whispering and granted it the dictation commands, before "refactor(epicenter)!: stop compiling in Whispering and grant installed apps native commands by app id". |

Conventions in this document:

- A historical path is relative to `apps/whispering/` at the ref its entry
  names, unless it starts with a ref, such as
  `bd3e40f353^:apps/epicenter/src-tauri/src/shell.rs`.
- A path starting with `apps/` and no ref is in the current tree.
- "Shipped" means the feature was in `v7.11.0`. "2026" means it was added
  after `v7.11.0` and was present at `8bc2aafd03^`.
- "Parked" means the Rust is still compiled into Epicenter and registered as
  a command, but no window is granted it and no page calls it.
- "Inferred" marks a claim not checked against the code.

## Summary

| Feature | In v7.11.0 | Status today |
| --- | --- | --- |
| [Voice-activated recording](#voice-activated-recording) | yes | gone |
| [Recording backends and audio options](#recording-backends-and-audio-options) | yes | reduced |
| [Compression before upload](#compression-before-upload) | yes | gone |
| [Import audio and video files](#import-audio-and-video-files) | yes | gone |
| [Named transcription providers](#named-transcription-providers) | yes | reduced to one OpenAI-compatible endpoint |
| [Local transcription chosen in Whispering](#local-transcription-chosen-in-whispering) | yes | partially present |
| [Language, prompt, and temperature](#language-prompt-and-temperature) | yes | gone |
| [Custom vocabulary](#custom-vocabulary) | no (2026) | gone |
| [Transcribe automatically after recording](#transcribe-automatically-after-recording) | yes | gone, by decision |
| [Model prewarm](#model-prewarm) | no (2026) | parked |
| [Hosted transcription with account credits](#hosted-transcription-with-account-credits) | no (2026) | gone, by decision |
| [Copy to clipboard automatically](#copy-to-clipboard-automatically) | yes | gone |
| [Paste at the cursor](#paste-at-the-cursor) | yes | parked |
| [Press Enter after pasting](#press-enter-after-pasting) | yes | parked |
| [Global shortcuts](#global-shortcuts) | yes | gone (plugin registered, not granted) |
| [Push-to-talk](#push-to-talk) | yes | gone |
| [In-app shortcuts and the shortcut editor](#in-app-shortcuts-and-the-shortcut-editor) | yes | reduced |
| [macOS Accessibility setup](#macos-accessibility-setup) | yes | parked |
| [Recording overlay](#recording-overlay) | no (2026) | parked |
| [Tray recording indicator](#tray-recording-indicator) | yes | rebuilt in Epicenter |
| [Always on top](#always-on-top) | yes | gone |
| [Pause media while recording](#pause-media-while-recording) | no (2026) | parked |
| [Sound effects](#sound-effects) | yes | gone |
| [Notifications and the notification log](#notifications-and-the-notification-log) | yes | gone |
| [Multi-step transformations](#multi-step-transformations) | yes | partially rebuilt |
| [Transform automatically after transcription](#transform-automatically-after-transcription) | yes | reduced to a Run button |
| [Polish](#polish) | no (2026) | gone |
| [Transformation picker and transform clipboard](#transformation-picker-and-transform-clipboard) | yes | gone |
| [Recording retention limit](#recording-retention-limit) | yes | gone |
| [Download a recording and export](#download-a-recording-and-export) | yes | partially present |
| [Open the recordings folder](#open-the-recordings-folder) | yes | gone |
| [Reading earlier data](#reading-earlier-data) | n/a | gone, no migration |
| [Add to Capture](#add-to-capture) | no (2026) | gone |
| [Onboarding prompt](#onboarding-prompt) | yes | reduced |
| [Launch at login](#launch-at-login) | yes | gone |
| [Updates](#updates) | yes | gone |
| [Analytics](#analytics) | yes | gone |
| [Layout mode setting](#layout-mode-setting) | yes | replaced by automatic layout |

38 features. The current README's
[What is not supported](../README.md#what-is-not-supported) states the
deliberate omissions; this document adds where each one's code is.

## How to recover code

Read old code without checking it out:

```sh
# What files a ref had
git ls-tree -r --name-only v7.11.0 -- apps/whispering/
git ls-tree -r --name-only '8bc2aafd03^' -- apps/whispering/src/lib/operations/

# One file at a ref
git show 'v7.11.0:apps/whispering/src/lib/settings/settings.ts'
git show '8bc2aafd03^:apps/whispering/src/lib/operations/push-to-talk.ts'
git show 'bd3e40f353^:apps/epicenter/src-tauri/capabilities/trusted-whispering-native-production.json'

# Search a ref
git grep -n 'pushToTalk' '8bc2aafd03^' -- apps/whispering/src

# When a file appeared, and when it left
git log --diff-filter=A --format='%h %ad %s' --date=short '8bc2aafd03^' -- apps/whispering/src/lib/operations/media.ts
git log --diff-filter=D --format='%h %ad %s' --date=short -- apps/whispering/src/lib/operations/media.ts

# When a symbol appeared or disappeared
git log -S 'replace_global_shortcuts' --format='%h %ad %s' --date=short -- apps/epicenter/src-tauri/src

# Copy an old file out to read beside the current code
mkdir -p /tmp/whispering-old
git show '8bc2aafd03^:apps/whispering/src/lib/operations/delivery.ts' > /tmp/whispering-old/delivery.ts
```

Quote a ref ending in `^` in zsh. `git log --diff-filter=A` on a file that
was moved names the move, not the feature; follow it with
`git log --follow` or search the subject for `feat(`.

## The native API direction

The parked Rust is meant to become generic APIs that Epicenter grants to
installed apps, with Whispering rebuilding dictation on top of them. This
direction comes from the owner's discussion; no ADR or spec uses these names
yet:

| Planned API | What it wraps today |
| --- | --- |
| `input.insertText` | `write_text` in `apps/epicenter/src-tauri/src/delivery.rs`, with `apps/epicenter/src-tauri/src/clipboard.rs` for the macOS pasteboard restore |
| `input.pressKey` | `simulate_enter_keystroke` in `apps/epicenter/src-tauri/src/delivery.rs` |
| input permission status | `get_dictation_capability` and `set_auto_paste_enabled` in `apps/epicenter/src-tauri/src/keyboard/commands.rs` |
| `media.pause`, `media.resume` | `pause_playback`, `resume_playback` in `apps/epicenter/src-tauri/src/media.rs` |
| `transcription.prepare` | `prewarm_model` in `apps/epicenter/src-tauri/src/transcription/mod.rs` |
| `shortcuts.register` | the global-shortcut plugin, registered in `apps/epicenter/src-tauri/src/lib.rs` and granted to no window |
| `panel.open` | `create_recording_overlay` in `apps/epicenter/src-tauri/src/overlay.rs`, never called |

Each would be granted per app. The accepted decisions that bear on it:

- [ADR-0555](../../../docs/adr/0555-apps-reach-native-code-through-official-tauri-plugins-first-granted-by-app-id.md)
  keeps custom Rust for paste, Enter, media pause, the panel, the recorder,
  and local transcription, and routes shortcuts, clipboard, and notifications
  through official plugins. Its `open_panel` and plugin grants are unbuilt.
- [ADR-0570](../../../docs/adr/0570-every-installed-apps-window-gets-the-same-grant.md)
  replaced per-app grant files with one, `apps/epicenter/src-tauri/capabilities/installed-app.json`.
  A per-app grant for dictation would revisit it.
- [ADR-0563](../../../docs/adr/0563-a-hidden-app-window-keeps-running-until-epicenter-quits.md)
  requires a hidden Whispering window to keep answering a push-to-talk chord
  for 30 minutes on every platform before dictation relies on it. It is
  unbuilt.
- [ADR-0117](../../../docs/adr/0117-global-shortcut-input-is-plugin-chords-only-and-the-macos-tap-is-just-the-paste-grant-watcher.md):
  shortcuts are plugin chords only; the macOS tap only watches the paste grant.
- [ADR-0045](../../../docs/adr/0045-playback-pause-is-opt-in-because-resume-can-start-unrelated-media.md):
  media pause is opt-in.

`apps/whispering/src/lib/tauri/bindings.gen.ts` still contains the generated
`writeText`, `simulateEnterKeystroke`, `prewarmModel`, `pausePlayback`,
`resumePlayback`, `setAutoPasteEnabled`, and `getDictationCapability`. Nothing
in Whispering calls them.

### What the old shell granted

At `bd3e40f353^`, `bd3e40f353^:apps/epicenter/src-tauri/capabilities/trusted-whispering-native-production.json`
(and its `-development` twin) granted the window labelled `whispering`:

- delivery: `allow-write-text`, `allow-simulate-enter-keystroke`
- recording and transcription: `epicenter-recorder:default`, `allow-prewarm-model`, `allow-get-local-transcription-readiness`, `allow-open-home`
- permissions: `allow-open-accessibility-settings`, `allow-request-accessibility-permission`, `allow-get-microphone-permission`, `allow-request-microphone-permission`
- media: `allow-pause-playback`, `allow-resume-playback`
- paste grant watch: `allow-set-auto-paste-enabled`, `allow-get-dictation-capability`
- shortcuts and login: `allow-replace-global-shortcuts`, `allow-is-autostart-enabled`, `allow-set-autostart-enabled`
- plugins: `dialog:allow-open`, `dialog:allow-save`, `deep-link:default`, `log:default`, `notification:default`, `opener:allow-default-urls`, `opener:allow-open-url`, `os:default`
- window: `core:default`, `core:event:allow-emit`, `core:event:allow-listen`, and window hide, show, close, set-focus, unminimize, set-size, set-position

`trusted-whispering-overlay-*.json` granted the `recording-overlay` window
`core:event:allow-emit`, `core:event:allow-listen`, and `log:default`.
`trusted-app-windows-production.json` added `http:default`,
`allow-transcribe-audio-bytes`, `allow-list-inference-models`, and
clipboard-manager read and write text for `whispering`.

At that ref the hidden `whispering` window and the overlay were already gated
off (`BuiltInApp::Whispering.is_hosted()` returned false). At `8bc2aafd03^`
the shell created both at every start and hid the window on close, so
push-to-talk worked with no window on screen
(`8bc2aafd03^:apps/epicenter/src-tauri/src/lib.rs`, around lines 1721 to 1784).

Deletions since:

- `bd3e40f353` (2026-10-15) removed the `trusted-whispering-*` files, the
  hidden window, and the overlay call site.
- `46dfdad9cb` and `48fc04ef7f` (2026-10-16) deleted the global shortcut
  registry: `replace_global_shortcuts`, `GlobalShortcutRegistry`,
  `GlobalShortcutTriggered`, `WHISPERING_WINDOW`.
- `fe476113af` (2026-10-16) deleted the autostart commands,
  `open_accessibility_settings`, and the autostart plugin registration.
- `0f987822ec` (2026-10-16) dropped the os and http plugins and unregistered
  notification.

## Recording and capture

### Voice-activated recording

- **What it did.** Listened to the microphone and recorded each stretch of
  speech as its own recording, then transcribed it, with no key held.
- **When.** Shipped.
- **Where.** `v7.11.0`: `src/lib/stores/vad-recorder.svelte.ts` (uses
  `MicVAD` from `@ricky0123/vad-web`), setting `recording.mode` = `vad`
  (default `manual`). `8bc2aafd03^`: `src/lib/state/vad-recorder.svelte.ts`,
  `src/routes/(app)/_components/VadRecordingAction.svelte`, KV
  `recordingTrigger` (`vad` or `manual`, default `manual`), global binding
  `shortcuts.global.toggleVadRecording` (unbound), in-app key V.
- **Today.** Gone. The README lists voice-activated recording as unsupported.
- **Rebuild.** Page work: run VAD in the page on the microphone stream, and
  write each speech segment as a recording through the workspace recorder.
  Hands-free use outside the window needs `shortcuts.register` to toggle it.

### Recording backends and audio options

- **What it did.** Let the person pick how audio was captured on the desktop
  (Rust CPAL, the browser's MediaRecorder, or FFmpeg), with a sample rate,
  a bitrate, a folder for audio files, and editable FFmpeg arguments.
- **When.** Shipped. FFmpeg recording left in `ab38299455` (2026-05-25) and
  the FFmpeg install page in `12d916c822` (2026-05-26).
- **Where.** `v7.11.0`: `src-tauri/src/recorder/`, `src/lib/services/desktop/recorder/ffmpeg.ts`,
  `src/routes/(app)/(config)/settings/recording/+page.svelte`,
  `src/routes/(app)/(config)/install-ffmpeg/+page.svelte`. Settings
  `recording.method` (`cpal`), `recording.cpal.sampleRate` (`16000`),
  `recording.cpal.outputFolder` (null, the app data folder),
  `recording.navigator.bitrateKbps`, `recording.ffmpeg.globalOptions`,
  `recording.ffmpeg.inputOptions`, `recording.ffmpeg.outputOptions`.
- **Today.** Reduced. Epicenter's recorder writes `audio/<id>.wav` into the
  folder; a browser tab records with MediaRecorder. Microphone choice is
  rebuilt (Home, under the recorder). No format, rate, or folder choice.
- **Rebuild.** Mostly unneeded. A format or rate choice needs a recorder
  plugin option; the audio location is fixed by the folder layout.

### Compression before upload

- **What it did.** Re-encoded audio with FFmpeg before sending it to a
  transcription provider, to stay under upload limits and cut transfer time.
- **When.** Shipped.
- **Where.** `v7.11.0`: `src/lib/components/settings/CompressionBody.svelte`,
  `src/lib/components/settings/selectors/CompressionSelector.svelte`;
  settings `transcription.compressionEnabled` (false),
  `transcription.compressionOptions`.
- **Today.** Gone. Transcription sends the saved file as is
  (`apps/whispering/src/lib/transcription.ts`).
- **Rebuild.** Needs an encoder: an Epicenter command over `apps/epicenter/src-tauri/src/audio/`,
  or WebCodecs in the page.

### Import audio and video files

- **What it did.** Took dropped or chosen audio and video files (mp3, wav,
  m4a, mp4, mov, and others; up to 10 files of 25 MB each in 2026) and
  transcribed them like recordings.
- **When.** Shipped as recording mode `upload` ("Upload File"). In 2026 it
  became its own surface (`17dbd3c14d`, 2026-06-16, ADR-0013).
- **Where.** `v7.11.0`: `src/lib/constants/audio/recording-modes.ts`.
  `8bc2aafd03^`: `src/lib/operations/import.ts`,
  `src/lib/constants/import-formats.ts`, `src/lib/components/ImportFileButton.svelte`.
- **Today.** Gone. The README lists importing audio files as unsupported.
- **Rebuild.** Page work over the recordings table: copy the file into
  `audio/`, write a row whose `audioPath` names it. Video needs audio
  extraction, which needs an encoder.

## Transcription

### Named transcription providers

- **What it did.** Offered a list of providers, each with its own key field
  and model list: OpenAI, Groq, ElevenLabs, Deepgram, Mistral, and Speaches
  (self-hosted), plus base-URL overrides for OpenAI and Groq.
- **When.** Shipped. In 2026 providers became AI connections, then account
  catalogs (`6225905ee9`, 2026-09-18).
- **Where.** `v7.11.0`: `src/lib/services/isomorphic/transcription/cloud/`,
  `src/lib/services/isomorphic/transcription/self-hosted/speaches.ts`,
  `src/lib/services/isomorphic/transcription/registry.ts`,
  `src/routes/(app)/(config)/settings/transcription/+page.svelte`. Settings
  `transcription.selectedTranscriptionService` (default `moonshine`),
  `transcription.openai.model` (`gpt-4o-mini-transcribe`),
  `transcription.groq.model` (`whisper-large-v3-turbo`),
  `transcription.elevenlabs.model` (`scribe_v1`),
  `transcription.deepgram.model` (`nova-3`),
  `transcription.mistral.model` (`voxtral-mini-latest`),
  `transcription.speaches.baseUrl` (`http://localhost:8000`), `apiKeys.*`,
  `apiEndpoints.openai`, `apiEndpoints.groq`.
- **Today.** Reduced to one connection: an OpenAI-compatible base URL, a model
  name, and a key. Groq, OpenAI, and Speaches work through it. Deepgram and
  ElevenLabs do not, since their APIs differ (inferred from the request shape
  in `apps/whispering/src/lib/transcription.ts`).
- **Rebuild.** Page work: a provider adapter per non-compatible API, routed
  through the same connection and `ai_send`.

### Local transcription chosen in Whispering

- **What it did.** Transcribed on the computer with no network. In `v7.11.0`
  Whispering downloaded and ran whisper.cpp, Parakeet, or Moonshine models
  itself. In 2026 Epicenter owned one active model (transcribe-cpp GGUF) and
  Whispering offered it as a choice.
- **When.** Shipped; the runtime changed in `786fa00248` (2026-07-03).
- **Where.** `v7.11.0`: `src-tauri/src/transcription/model_manager.rs`,
  `src/lib/components/settings/LocalModelDownloadCard.svelte`,
  `src/lib/components/settings/LocalModelSelector.svelte`; settings
  `transcription.whispercpp.modelPath`, `transcription.parakeet.modelPath`,
  `transcription.moonshine.modelPath`. `8bc2aafd03^`:
  `src/lib/components/TranscriptionModelPicker.svelte`, `src/lib/tauri.tauri.ts`.
- **Today.** Partially present. `apps/whispering/src/lib/workspace/local-transcription.ts`
  transcribes with Epicenter's active model, and `installed-app.json` grants
  it, but Settings cannot choose it.
- **Rebuild.** Page work: a choice in Settings that routes Transcribe to the
  local path.

### Language, prompt, and temperature

- **What it did.** Sent an output language (default `auto`), a prompt to bias
  spelling, and a sampling temperature with each transcription request.
- **When.** Shipped. In 2026 the language was KV `transcriptionLanguage`
  (`auto`) and the prompt moved to the speech profile.
- **Where.** `v7.11.0`: settings `transcription.outputLanguage`,
  `transcription.prompt` (empty), `transcription.temperature` (`0.0`);
  `src/lib/constants/languages/supported-languages.ts`.
- **Today.** Gone. The request carries the file, `model`, and
  `response_format` only (`apps/whispering/src/lib/transcription.ts`).
- **Rebuild.** Page work: fields on the transcription connection, appended to
  the form data.

### Custom vocabulary

- **What it did.** Kept a dictionary of words and a transcription prompt in a
  speech profile tied to the account, so names and jargon came out spelled
  right on every device.
- **When.** 2026 (not traced).
- **Where.** `8bc2aafd03^`: `src/lib/whispering/personal.ts`,
  `src/routes/(app)/(config)/settings/dictation/PersonalSettings.svelte`,
  `src/lib/operations/build-system-prompt.ts`; speech profile KV
  `dictionary` (null), `transcriptionPrompt` (empty), `polishInstructions`.
- **Today.** Gone.
- **Rebuild.** Page work: a file in the folder holding the words, sent as the
  transcription prompt (needs the prompt field above).

### Transcribe automatically after recording

- **What it did.** Sent every recording to the provider as soon as it
  stopped, then delivered the text.
- **When.** Shipped.
- **Where.** `v7.11.0`: `src/lib/query/isomorphic/actions.ts`.
  `8bc2aafd03^`: `src/lib/operations/pipeline.ts`.
- **Today.** Gone by decision: "Nothing is sent or seeded on its own"
  (`apps/whispering/AGENTS.md`). Transcribe is a button.
- **Rebuild.** A setting the person turns on, which would amend that
  constraint. Dictation cannot work without it.

### Model prewarm

- **What it did.** Loaded the local model into memory ahead of use so the
  first transcription did not wait for it.
- **When.** 2026, `ef82427a33` (2026-07-10) in Epicenter.
- **Where.** `8bc2aafd03^`: `prewarmModel` in `src/lib/tauri.tauri.ts`; no page
  caller found at that ref (not traced further).
- **Today.** Parked: `prewarm_model` in `apps/epicenter/src-tauri/src/transcription/mod.rs`.
- **Rebuild.** Needs `transcription.prepare`, called when recording starts.

### Hosted transcription with account credits

- **What it did.** Transcribed through Epicenter's hosted API with account
  credits, and offered "Add credits" when they ran out.
- **When.** 2026: Account page `6355739b4d` (2026-06-04), credit action
  `15b730fd19` (2026-09-08).
- **Where.** `8bc2aafd03^`: `src/lib/operations/credit-action.ts`,
  `src/lib/auth.svelte.ts`, `src/routes/(app)/(config)/settings/account/+page.svelte`.
- **Today.** Gone by decision: the README excludes accounts and hosted
  transport.
- **Rebuild.** Would reverse that decision; Epicenter's `account_send` exists
  and is granted.

## Delivery

### Copy to clipboard automatically

- **What it did.** Put each transcript on the clipboard when it arrived.
- **When.** Shipped.
- **Where.** `v7.11.0`: `src/lib/query/isomorphic/delivery.ts`; setting
  `transcription.copyToClipboardOnSuccess` (true). `8bc2aafd03^`:
  `src/lib/operations/delivery.ts`, `src/lib/operations/sink.ts`,
  `src/lib/components/OutputDeliveryControls.svelte`; KV
  `outputTranscriptionClipboard` (true).
- **Today.** Gone. Copy buttons are the only way text leaves the app.
- **Rebuild.** Page work with `navigator.clipboard.writeText` while the window
  has focus; from a hidden window it needs the clipboard-manager plugin grant.

### Paste at the cursor

- **What it did.** Typed the transcript into whatever app had focus: wrote it
  to the clipboard, sent Cmd+V or Ctrl+V, then restored the clipboard. In
  2026 macOS restored every pasteboard type, not just text, and left the text
  on the clipboard when paste could not land.
- **When.** Shipped. `keep_on_clipboard` and the `LeftOnClipboard` outcome
  arrived in `44097cc031` (2026-06-20).
- **Where.** `v7.11.0`: `write_text` in `src-tauri/src/lib.rs` (enigo);
  setting `transcription.writeToCursorOnSuccess` (true).
  `8bc2aafd03^`: `src/lib/operations/sink.ts`,
  `src/lib/services/text/index.tauri.ts`, `src/lib/operations/delivery-reach.ts`;
  KV `outputTranscriptionCursor` (false).
- **Today.** Parked: `apps/epicenter/src-tauri/src/delivery.rs` and
  `apps/epicenter/src-tauri/src/clipboard.rs` (macOS).
- **Rebuild.** Needs `input.insertText` and the input permission status.

### Press Enter after pasting

- **What it did.** Pressed Return after the paste, to send a chat message.
- **When.** Shipped.
- **Where.** `v7.11.0`: `simulate_enter_keystroke` in `src-tauri/src/lib.rs`;
  settings `transcription.simulateEnterAfterOutput` (false) and
  `transformation.simulateEnterAfterOutput` (false). `8bc2aafd03^`: KV
  `outputTranscriptionEnter` (false), shown only when paste is on.
- **Today.** Parked: `simulate_enter_keystroke` in `apps/epicenter/src-tauri/src/delivery.rs`.
- **Rebuild.** Needs `input.pressKey`.

## Shortcuts

### Global shortcuts

- **What it did.** Started, stopped, and cancelled recording from any app.
- **When.** Shipped.
- **Where.** `v7.11.0`: `src/lib/services/desktop/global-shortcut-manager.ts`,
  `src/routes/(app)/(config)/settings/shortcuts/global/+page.svelte`,
  `src/lib/commands.ts`; defaults
  `shortcuts.global.toggleManualRecording` CmdOrCtrl+Shift+;,
  `shortcuts.global.cancelManualRecording` CmdOrCtrl+Shift+',
  `shortcuts.global.pushToTalk` CmdOrAlt+Shift+D,
  `shortcuts.global.openTransformationPicker` CmdOrCtrl+Shift+X,
  `shortcuts.global.runTransformationOnClipboard` CmdOrCtrl+Shift+R, the rest
  unbound. `8bc2aafd03^`: `src/lib/state/device-config.svelte.ts` (bindings
  as `{ modifiers, keys }`), `src/lib/platform/system-shortcuts.tauri.ts`,
  `src/lib/shortcuts/`; defaults toggle Cmd+Shift+Space (Ctrl+Shift+Space off
  Apple), cancel Cmd+. (Ctrl+Shift+.), push-to-talk and VAD unbound. Rust
  registered chords and emitted `GlobalShortcutTriggered` to the `whispering`
  window (`8bc2aafd03^:apps/epicenter/src-tauri/src/shell.rs`).
- **Today.** Gone. The Rust registry was deleted (`48fc04ef7f`). The
  global-shortcut plugin is registered in `apps/epicenter/src-tauri/src/lib.rs`
  but granted to no window.
- **Rebuild.** Needs `shortcuts.register` (the plugin's register and
  unregister, granted to Whispering) and ADR-0563's hidden-window work.

### Push-to-talk

- **What it did.** Recorded while a chord was held and stopped on release. In
  2026 a release was tied to the recording its press started, a release
  during startup was honored, and a 5-minute cap stopped a recording whose
  key-up was lost.
- **When.** Shipped. The stuck-recording fix is `1df0b19ae7` (2026-06-22).
- **Where.** `v7.11.0`: command `pushToTalk` (`on: ['Pressed', 'Released']`)
  in `src/lib/commands.ts`; in-app key P. `8bc2aafd03^`:
  `src/lib/operations/push-to-talk.ts`; KV `shortcutPushToTalkModifiers`,
  `shortcutPushToTalkKeys` (unbound).
- **Today.** Gone.
- **Rebuild.** Needs `shortcuts.register` with press and release events;
  port `src/lib/operations/push-to-talk.ts` from `8bc2aafd03^` as page logic.

### In-app shortcuts and the shortcut editor

- **What it did.** Single keys worked while the window had focus, and a
  settings page recorded new bindings for both in-app and global shortcuts.
- **When.** Shipped.
- **Where.** `v7.11.0`: `src/lib/services/isomorphic/local-shortcut-manager.ts`,
  `src/routes/(app)/(config)/settings/shortcuts/`; defaults Space toggle,
  C cancel, V VAD, P push-to-talk, T picker, R run on clipboard.
  `8bc2aafd03^`: `src/lib/shortcuts/focused.ts`,
  `src/routes/(app)/(config)/settings/shortcuts/keyboard-shortcut-recorder/create-chord-recorder.ts`,
  `src/lib/utils/reserved-shortcuts.ts`; defaults Space, C, V, and Comma for
  settings.
- **Today.** Reduced: Space on Home, Ctrl+B or Command-B for the sidebar,
  Ctrl+Shift+E for Files. No editor.
- **Rebuild.** Page work: a key map file or setting, and the old chord
  recorder.

## Settings and onboarding

### macOS Accessibility setup

- **What it did.** Explained that pasting at the cursor needs the
  Accessibility permission, opened the right System Settings pane, and noticed
  a stale grant after an update, which reads as granted but drops pastes.
- **When.** Shipped as a page. In 2026 a guide dialog
  (`b4a0bbdb87`, 2026-06-15) and a Rust capability watch (`4131e59f33`,
  2026-06-16).
- **Where.** `v7.11.0`: `src/routes/(app)/(config)/macos-enable-accessibility/+page.svelte`.
  `8bc2aafd03^`: `src/lib/state/dictation-capability.svelte.ts`,
  `src/lib/components/MacosAccessibilityGuide.svelte`,
  `src/lib/components/DictationCapabilityNotice.svelte`,
  `src/lib/components/accessibility-feature-copy.ts`.
- **Today.** Parked: `apps/epicenter/src-tauri/src/keyboard/` (the tap
  supervisor runs; `DictationCapabilityEvent` reaches no window). Opening a
  System Settings pane is granted (`x-apple.systempreferences:`), and
  Whispering already uses it for the microphone.
- **Rebuild.** Needs the input permission status API, emitted to the calling
  app's windows (ADR-0555). The permission is Epicenter's, not Whispering's.

### Onboarding prompt

- **What it did.** On first launch, a notice asked the person to pick a
  transcription service or enter its key, with a link to the setting.
- **When.** Shipped.
- **Where.** `v7.11.0`: `src/routes/(app)/_layout-utils/register-onboarding.ts`,
  `src/routes/(app)/_layout-utils/register-permissions.ts`.
- **Today.** Reduced: the Transcription model control on Home reads
  "Transcription is not set up" and opens its settings. Nothing prompts at
  launch.
- **Rebuild.** Page work, if wanted.

### Launch at login

- **What it did.** A switch to start Whispering when the computer starts.
- **When.** Shipped; the 2026 switch is
  `src/routes/(app)/(config)/settings/AutostartSwitch.svelte` at `8bc2aafd03^`.
- **Where.** `v7.11.0`: `src/lib/services/desktop/autostart.ts`.
- **Today.** Gone. The commands were deleted (`fe476113af`); ADR-0328 has
  Epicenter add itself to login items once, which is unbuilt.
- **Rebuild.** Epicenter's job, not Whispering's.

### Updates

- **What it did.** Checked for a new release and offered to install it.
- **When.** Shipped.
- **Where.** `v7.11.0`: `src/lib/components/UpdateDialog.svelte`,
  `src/routes/(app)/_layout-utils/check-for-updates.ts`.
- **Today.** Gone from Whispering. An installed app updates from its
  repository through Epicenter (`update_app`, ADR-0552).
- **Rebuild.** None.

### Analytics

- **What it did.** Sent anonymous usage events to Aptabase, with a switch to
  turn them off.
- **When.** Shipped. KV `analyticsEnabled` (true) at `8bc2aafd03^`.
- **Where.** `v7.11.0`: `src/lib/services/isomorphic/analytics/`,
  `src/routes/(app)/(config)/settings/analytics/+page.svelte`.
- **Today.** Gone. Nothing is sent.
- **Rebuild.** None planned.

### Layout mode setting

- **What it did.** Chose between a sidebar and header navigation.
- **When.** Shipped; replaced by automatic layout in `0b49821ebb`
  (2026-04-02).
- **Where.** `v7.11.0`: setting `ui.layoutMode` (`sidebar`),
  `src/lib/constants/ui/layout-mode.ts`.
- **Today.** Replaced: a sidebar on a wide window, a bottom bar on a narrow
  one.
- **Rebuild.** None.

## Overlay and indicators

### Recording overlay

- **What it did.** A small floating pill near the bottom of the screen while
  recording, with live microphone levels, Stop, Cancel, and "ship raw" while
  polishing. On macOS it was a non-activating panel, so clicking it did not
  pull focus from the app being dictated into.
- **When.** 2026, `82013bf085` (2026-06-13).
- **Where.** `8bc2aafd03^`: `src/lib/recording-overlay/`,
  `src/lib/recording-pill/`, `src/lib/dictation-indicator/`,
  `src/routes/recording-overlay/+page.svelte`. Design notes:
  [recording-overlay.md](./recording-overlay.md).
- **Today.** Parked: `apps/epicenter/src-tauri/src/overlay.rs`. Its
  `create_recording_overlay` is never called, and no capability selects the
  `recording-overlay` label.
- **Rebuild.** Needs `panel.open` (ADR-0555's `open_panel`), plus a page route
  for the pill and an event channel between windows.

### Tray recording indicator

- **What it did.** Changed the tray or menu bar icon while recording.
- **When.** Shipped.
- **Where.** `v7.11.0`: `src/lib/services/desktop/tray.ts`,
  `src/routes/(app)/_layout-utils/syncIconWithRecorderState.svelte.ts`,
  `src-tauri/recorder-state-icons/`.
- **Today.** Rebuilt in Epicenter: the recorder plugin calls
  `set_tray_recording_state` in `apps/epicenter/src-tauri/src/shell.rs`. The
  tray no longer offers Show Whispering.
- **Rebuild.** None for the icon.

### Always on top

- **What it did.** Kept the window above others: Always, When Recording and
  Transcribing, When Recording, or Never.
- **When.** Shipped.
- **Where.** `v7.11.0`: setting `system.alwaysOnTop` (`Never`),
  `src/lib/constants/ui/always-on-top.ts`,
  `src/routes/(app)/_layout-utils/alwaysOnTop.svelte.ts`.
- **Today.** Gone.
- **Rebuild.** Needs a core window grant for always-on-top; the overlay
  covers most of the need.

### Pause media while recording

- **What it did.** Paused music and video that was playing when recording
  began and tried to resume it after. Off by default (ADR-0045), because
  resume on macOS can start a different app's media.
- **When.** 2026, `2239d9e427` (2026-06-14).
- **Where.** `8bc2aafd03^`: `src/lib/operations/media.ts`; KV
  `recordingPausePlayback` (false).
- **Today.** Parked: `apps/epicenter/src-tauri/src/media.rs` and
  `apps/epicenter/src-tauri/src/media/`.
- **Rebuild.** Needs `media.pause` and `media.resume`; port `src/lib/operations/media.ts`.

## Sounds and notifications

### Sound effects

- **What it did.** Played a short sound on recording start, stop, and cancel,
  on VAD start, capture, and stop, and when a transcription or transformation
  finished, each with its own switch.
- **When.** Shipped (8 events); 7 at `8bc2aafd03^`, without transformation
  complete.
- **Where.** `v7.11.0`: settings `sound.playOn.*` (all true),
  `src/lib/services/isomorphic/sound/assets/`,
  `src/routes/(app)/(config)/settings/sound/+page.svelte`. `8bc2aafd03^`:
  `src/lib/operations/sound.ts`, `src/lib/services/sound/assets/`; KV
  `soundManualStart` and the rest (true).
- **Today.** Gone.
- **Rebuild.** Page work: `HTMLAudioElement` with the old assets. A hidden
  window may be throttled (ADR-0563).

### Notifications and the notification log

- **What it did.** Showed system notifications for results and failures, and
  kept a log of recent notices in the app.
- **When.** Shipped. The log left in `6862edde9a` (2026-05-26); OS
  notifications stayed through `8bc2aafd03^`.
- **Where.** `v7.11.0`: `src/lib/components/NotificationLog.svelte`,
  `src/lib/services/isomorphic/notifications/`. `8bc2aafd03^`:
  `src/lib/report/os-notify.tauri.ts`,
  `src/routes/(app)/_app-effects/notify-dictation-failures.svelte.ts`.
- **Today.** Gone. The notification plugin is not registered (`0f987822ec`).
- **Rebuild.** Needs the notification plugin registered and granted
  (ADR-0555).

## Transformations and post-processing

### Multi-step transformations

- **What it did.** A transformation was a chain of steps: a prompt to an LLM
  (OpenAI, Groq, Anthropic, Google, OpenRouter, or a custom endpoint, each
  with a model) or a find-and-replace, optionally by regex. Prompts used
  `{{input}}`. Runs were kept per recording.
- **When.** Shipped. Deleted in `bac7a18fe7` (2026-06-27), when Polish took
  its place.
- **Where.** `v7.11.0`: `src/lib/services/isomorphic/db/models/transformation-steps.ts`,
  `src/lib/components/transformations-editor/`,
  `src/routes/(app)/(config)/transformations/`,
  `src/lib/services/isomorphic/completion/`, `src/lib/utils/template.ts`;
  settings `completion.openrouter.model`, `completion.custom.baseUrl`.
- **Today.** Partially rebuilt: one prompt, one request, over one text
  connection (README, "Transformations"). No steps, no find-and-replace, no
  provider list.
- **Rebuild.** Page work over the transformations table: a step list in the
  file, run in order.

### Transform automatically after transcription

- **What it did.** Ran the selected transformation on every new transcript
  and delivered the result with its own clipboard, paste, and Enter settings.
- **When.** Shipped.
- **Where.** `v7.11.0`: setting `transformations.selectedTransformationId`
  (null); `src/lib/query/isomorphic/actions.ts`; settings
  `transformation.copyToClipboardOnSuccess` (true),
  `transformation.writeToCursorOnSuccess` (false),
  `transformation.simulateEnterAfterOutput` (false).
- **Today.** Reduced: Post-processing on Home chooses a transformation, and
  Run sends it. Nothing runs on its own.
- **Rebuild.** Same decision as automatic transcription, then the delivery
  APIs.

### Polish

- **What it did.** Cleaned every transcript with an LLM by default ("Fix
  grammar and punctuation. Keep my wording."), kept the original beside the
  cleaned text, and let the person ship the raw text while it ran. A failed
  pass delivered the raw text.
- **When.** 2026, `cf3e78ea02` (2026-06-27).
- **Where.** `8bc2aafd03^`: `src/lib/operations/run-polish.ts`,
  `src/lib/state/polish.ts`, `src/lib/state/polish-hud.svelte.ts`,
  `src/routes/(app)/(config)/settings/dictation/DeviceCleanupSettings.svelte`,
  `src/routes/(app)/(config)/settings/processing/+page.svelte`; KV
  `polishEnabled` (true), `completionConnection`, `completionModel`; profile
  `polishInstructions`.
- **Today.** Gone. A "Clean up" starter transformation run by hand is the
  closest.
- **Rebuild.** Page work once automatic post-processing is allowed.

### Transformation picker and transform clipboard

- **What it did.** A global shortcut opened a small window to pick a
  transformation; another ran the selected one on the clipboard's text and
  delivered the result.
- **When.** Shipped. Renamed to Recipe surfaces (`cf75fa341f`, 2026-06-27),
  then deleted with transformations.
- **Where.** `v7.11.0`: `src/routes/transform-clipboard/`,
  `src-tauri/capabilities/transform-clipboard.json`, commands
  `openTransformationPicker` and `runTransformationOnClipboard` in
  `src/lib/query/isomorphic/actions.ts`.
- **Today.** Gone. Try it on pasted text is the in-window equivalent.
- **Rebuild.** Needs `shortcuts.register`, `panel.open`, clipboard read, and
  `input.insertText`.

## History and recordings

### Recording retention limit

- **What it did.** Kept only the newest N recordings (default 100) when set
  to limit, and deleted the rest.
- **When.** Shipped.
- **Where.** `v7.11.0`: settings `database.recordingRetentionStrategy`
  (`keep-forever`), `database.maxRecordingCount` (`100`).
- **Today.** Gone.
- **Rebuild.** Page work over the recordings table, using the existing
  deletion path. Git history keeps deleted rows.

### Download a recording and export

- **What it did.** Saved a recording's audio file elsewhere. In 2026,
  exported all recordings as a Markdown zip on web and desktop.
- **When.** Download shipped; export 2026, `e60c9e2204` (2026-06-16).
- **Where.** `v7.11.0`: `src/lib/services/isomorphic/download/`.
  `8bc2aafd03^`: `src/routes/(app)/(config)/recordings/actions/DownloadRecordingButton.svelte`,
  `src/lib/whispering/recordings-markdown-export.ts`.
- **Today.** Partially present: the folder is plain files, so it is the
  export. Files can copy paths and text; there is no Save As.
- **Rebuild.** Page work if wanted: a download link for an audio file in a
  browser tab.

### Open the recordings folder

- **What it did.** Opened the recordings folder in Finder or Explorer.
- **When.** Shipped.
- **Where.** `v7.11.0`: `src/lib/components/OpenFolderButton.svelte`.
- **Today.** Gone. The README lists Reveal folder as unsupported.
- **Rebuild.** Needs ADR-0555's `reveal_folder(scope)`, which is unbuilt.

### Reading earlier data

- **What it did.** `v7.11.0` desktop kept recordings as Markdown files plus
  audio in the app data folder, and its Migration dialog moved older
  IndexedDB data into those files; the web build kept recordings in
  IndexedDB. In 2026 recordings lived in a Yjs store.
- **When.** n/a.
- **Where.** `v7.11.0`: `src/lib/services/isomorphic/db/file-system.ts`,
  `src/lib/components/MigrationDialog.svelte`. `8bc2aafd03^`:
  `src/lib/data.ts`.
- **Today.** Gone. Nothing reads either; the README says there is no
  migration.
- **Rebuild.** A one-time import: read the `v7.11.0` Markdown and audio and
  write rows and audio into the folder.

### Add to Capture

- **What it did.** Sent a transcript to the signed-in account's Capture app,
  with a local receipt so a lost acknowledgement did not send it twice.
- **When.** 2026, `4b298ea2f3` (2026-09-24).
- **Where.** `8bc2aafd03^`: `src/lib/operations/capture-promotion.ts`, table
  `capturePromotions` in `src/lib/data.ts`.
- **Today.** Gone; it needs an account.
- **Rebuild.** Inferred: write into Capture's folder instead, if Epicenter
  grants one app another app's folder.

## Not counted

- The standalone file desktop's terminal and Reveal folder existed only
  between `8bc2aafd03` and `bd3e40f353`, so they are outside this inventory;
  the README covers them.
- The browser build (whispering.epicenterhq.com in `v7.11.0`) still exists as
  a browser tab over browser storage.
