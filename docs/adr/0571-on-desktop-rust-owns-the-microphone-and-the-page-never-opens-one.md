# 0571. On desktop, Rust owns the microphone and the page never opens one

- **Status:** Proposed
- **Date:** 2026-10-16
- **Amends:** [ADR-0561](0561-rust-serves-every-app-from-one-epicenter-app-origin.md) at its Unbuilt microphone probe: Whispering's page in Epicenter calls no `getUserMedia` or `enumerateDevices`, so the probe narrows to another installed app's WebView microphone on the scheme.
- **Relates:** [ADR-0543](0543-a-recording-streams-into-its-folder-from-the-moment-it-starts.md) (the recorder writes the WAV into the folder), [ADR-0555](0555-apps-reach-native-code-through-official-tauri-plugins-first-granted-by-app-id.md) (the recorder is custom Rust that stays; the opener opens System Settings), [ADR-0567](0567-epicenter-ships-for-macos-only-for-now.md) (macOS only), [ADR-0570](0570-every-installed-apps-window-gets-the-same-grant.md) (one grant for every installed app).
- **Built:** `inputs`, `open_meter`, and `close_meter` in `packages/tauri-plugin-epicenter-recorder`, and `start` choosing the microphone by the same id; the plugin's access gate (`src/permission.rs`), asked by `open_meter` and `start` before any device is resolved; `listInputs` and `openMeter` in `@epicenter/recorder/tauri`; Whispering's desktop microphone (`apps/whispering/src/lib/workspace/desktop-microphone.ts`), with `platform-selection.test.ts` proving the desktop build reaches no WebView microphone code; the shell's `get_microphone_permission`, `request_microphone_permission`, and `request_accessibility_permission` deleted.
- **Unbuilt:** a launch on a Mac with an input device, which asks for access, lists it, meters it, and records from it by id; the build machine had none.

## Context

Whispering's desktop recordings were already Rust's: the recorder plugin
opens the microphone with cpal and writes the WAV into the folder
(ADR-0543). Everything around a recording was still the WebView's. The page
listed inputs with `enumerateDevices`, asked for access with `getUserMedia`,
and tested a microphone through an `AudioContext`. It then handed the shell
the chosen input's WebView label, and the shell recorded from the cpal device
whose name matched it.

That split had three costs. A WebView label and a cpal device name are two
systems' names for one device, and nothing guaranteed they agree. macOS asked
for microphone access on the WebView's behalf for a page served on the
`epicenter-app` scheme, which no probe had checked (ADR-0561's Unbuilt line).
And the page carried two microphone stacks, one of which only existed to
choose an input for the other.

cpal 0.18 gives every device a stable id (`DeviceTrait::id`, the CoreAudio
device UID on macOS) and finds a device by it (`HostTrait::device_by_id`).

## Decision

**On desktop, Rust owns the microphone: Whispering's page never opens one,
and the recorder plugin asks for access before it opens one for any caller.**

- The recorder plugin lists the inputs (`inputs`: id, name, whether it is the
  default), opens one for its level only (`open_meter`, streaming the level
  over the page's `Channel` until `close_meter`, until the page is gone, or
  until the stream dies or the page stops hearing it), and records from one
  (`start`). Each names a microphone by cpal's id as text; an id that is not
  connected is refused, never replaced.
- `open_meter` and `start` ask macOS for microphone access through
  AVFoundation before they resolve a device. A person not yet asked sees the
  prompt; a denial is `PermissionDenied` and nothing opens. Listing asks for
  nothing. A page has no permission command to call or to forget.
- Whispering's desktop build calls no `getUserMedia`, `enumerateDevices`,
  `MediaRecorder`, or `AudioContext`, and has no fallback to them. Its
  browser build keeps its WebView microphone; the build, not the page, picks
  which one runs. A denied desktop control opens System Settings at the
  microphone pane through the opener.

What this does not decide: another installed app's page could still call
`getUserMedia` in its WebView on the scheme. Nothing forbids it, and whether
macOS grants it there is untested (ADR-0561's narrowed Unbuilt item).

## Consequences

- A chosen microphone is matched by an id macOS keeps for the device, so the
  label-to-name match is gone, and a choice survives a relaunch without
  depending on the WebView's IDs.
- Listing needs no permission, so the desktop never withholds input names.
  With no input connected the control says so and offers no enabling step;
  a denial is cleared only by a microphone that opens.
- The shell does not announce connected or removed inputs; the page lists
  again when asked.
- An open meter is an open microphone: the tray shows it as one.
- A meter beside a recording is allowed by the plugin. Whispering's own rule
  that a test never runs beside a recording is the page's, not the plugin's.
- A saved choice from the WebView era names an id the shell does not know and
  shows as not listed until the person chooses again. There is no migration.

## Considered alternatives

- **Keep the WebView for listing and testing, Rust for recording.** That is
  the split this replaces: two names for one device, and a WebView permission
  path nobody tested.
- **Keep the permission commands in the shell and have the page ask before it
  opens anything.** Every caller of the plugin would have to remember to ask,
  and the plugin could not refuse a caller that did not. Moving the
  AVFoundation code into the plugin is a move, not a copy: the shell's
  commands are deleted.
