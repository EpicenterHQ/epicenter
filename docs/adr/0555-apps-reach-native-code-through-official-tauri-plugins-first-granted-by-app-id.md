# 0555. Apps reach native code through official Tauri plugins first, granted by app id

- **Status:** Accepted
- **Date:** 2026-10-16
- **Amends:** [ADR-0552](0552-every-app-is-installed-from-a-folder-in-any-git-repository.md) at "Whispering's recorder and global shortcuts, and Honeycrisp's terminal and 'reveal folder', are host functions": shortcuts come from the global-shortcut plugin, reveal is a folder action every window offers, and the terminal is refused.
- **Amended by:** [ADR-0570](0570-every-installed-apps-window-gets-the-same-grant.md) at "granted by app id" and "Each app is granted in one file, `installed-<app>.json`": every installed app's window is granted by one file, `installed-app.json`, whose `windows` is `app:*`.
- **Amended by:** [ADR-0596](0596-native-dictation-code-no-page-can-reach-compiles-only-behind-an-off-by-default-cargo-feature.md) at the registered clipboard-manager and global-shortcut plugins, their grants, and the custom Rust kept for paste, media, the panel, and the dictation capability: none of it is compiled, registered, or in the page API by default, until a native API decision exposes it.
- **Relates:** [ADR-0117](0117-global-shortcut-input-is-plugin-chords-only-and-the-macos-tap-is-just-the-paste-grant-watcher.md) (plugin chords only, the tap watches the paste grant), [ADR-0563](0563-a-hidden-app-window-keeps-running-until-epicenter-quits.md) (a hidden app window keeps running, and its 30-minute test), [ADR-0328](0328-epicenter-runs-when-you-log-in-and-pause-is-the-only-control-it-offers.md) (Epicenter adds itself to login items once), [ADR-0540](0540-an-app-is-installed-by-building-its-source-and-approving-a-commit-trusts-it-fully.md) (an approved app is trusted fully), [ADR-0561](0561-rust-serves-every-app-from-one-epicenter-app-origin.md) (one capability file per app).
- **Built:** the deletions of `is_autostart_enabled`, `set_autostart_enabled`, and `open_accessibility_settings`; the opener's `allow-open-url` for `x-apple.systempreferences:` in `installed-app.json`, which Whispering calls through `@tauri-apps/plugin-opener` (ADR-0571).
- **Unbuilt:** the other plugin JS packages and grants, registering the notification plugin, `open_panel`, `reveal_folder` and `open_folder_in_terminal`, the rest of the deletions below, and autostart: the plugin is not registered, so nothing enables it once on first run (ADR-0328).

## Context

Whispering's native features were written for one built-in window labelled
`whispering`. Rust emits to that label by name: `GlobalShortcutTriggered` from
`replace_global_shortcuts` (`apps/epicenter/src-tauri/src/shell.rs:16`, `:85`,
`:153`) and `DictationCapabilityEvent`
(`apps/epicenter/src-tauri/src/keyboard/mod.rs:49`, `:132`). Until `8bc2aafd03`
the shell created that window hidden at every host start and hid it on close
(`8bc2aafd03^:apps/epicenter/src-tauri/src/lib.rs:1723`, `:1783-1784`), so
push-to-talk worked from boot with no window on screen.

Whispering is now an installed app ([ADR-0552](0552-every-app-is-installed-from-a-folder-in-any-git-repository.md)).
Its windows are labelled `app:so_epicenter_whispering[:<folder hex>]`
(`installed_window_label`, `apps/epicenter/src-tauri/src/lib.rs:1515`), and
`installed-whispering-*.json` grants it the recorder, local transcription, and
`open_home`, nothing else. No window has the label `whispering`, so the
shortcut and capability events reach nobody, and the paste, media, permission,
and autostart commands are granted to no window.

Meanwhile Epicenter registers official plugins it never grants:
clipboard-manager (`lib.rs:522`), global-shortcut (`:525`), opener (`:526`),
and autostart (`:527`). The notification plugin is a dependency
(`apps/epicenter/src-tauri/Cargo.toml:56`) and is not registered. No
`@tauri-apps/plugin-*` JS package is a dependency of any app Epicenter serves;
`@tauri-apps/api` is the only one. Several custom commands duplicate those
plugins.

## Decision

**An app's page reaches native code through `invoke` or an official Tauri
plugin's TypeScript API, granted by its app id. A custom Rust command exists
only where no official plugin does the job.**

Each app is granted in one file, `apps/epicenter/src-tauri/capabilities/installed-<app>.json`
([ADR-0561](0561-rust-serves-every-app-from-one-epicenter-app-origin.md)),
whose `windows` are `app:<id with _ for .>` and `app:<id with _ for .>:*`, as
`installed-whispering-*` already does. A grant lists what the app calls; under
ADR-0540 it is wiring, not a sandbox.

**Official plugins, and what an app is granted from each:**

| Plugin (crate as locked) | JS package | Grant |
| --- | --- | --- |
| global-shortcut 2.3.2 | `@tauri-apps/plugin-global-shortcut` | `allow-register`, `allow-unregister`, `allow-is-registered`; never `allow-unregister-all` |
| clipboard-manager 2.3.2 | `@tauri-apps/plugin-clipboard-manager` | `allow-read-text`, `allow-write-text` |
| notification 2.3.3 | `@tauri-apps/plugin-notification` | `default` |
| opener 2.5.4 | `@tauri-apps/plugin-opener` | `allow-open-url` for `x-apple.systempreferences:` and `ms-settings:` |
| core window and webview | `@tauri-apps/api` 2.12 | `core:window:allow-hide`, `allow-show`, `allow-set-focus`, `allow-destroy` |
| autostart 2.5.1 | none | granted to no window; Rust calls it |

Of these, a default build registers only the opener. Clipboard-manager and
global-shortcut build and register only with the shell's `dictation` Cargo
feature, parked with native dictation until a grant uses them (ADR-0596).
Autostart is not registered (see Unbuilt above), and registering notification
is part of this decision. Each JS package is published on npm as 2.x.

**Custom Rust stays for six things:**

```txt
write_text, simulate_enter_keystroke   paste into the focused app; macOS checks the Accessibility grant (delivery.rs, keyboard/)
pause_playback, resume_playback        pause other apps' media (media.rs)
open_panel                             the macOS non-activating NSPanel (overlay.rs)
epicenter-recorder                     the recorder, with get/request_microphone_permission (command.rs:166, :241)
transcribe_audio_bytes and kin         local transcription (transcription/)
epicenter-folder                       the folder plugin, with reveal_folder and open_folder_in_terminal
```

`get_dictation_capability` answers the calling window, and the capability
change is an event emitted to every window of an app that called it, never to a
fixed label.

**A folder offers Reveal in Finder and Open in Terminal.** The Folders window
offers both on every folder, and an app may offer them on the folder it holds.
They are two commands in the folder plugin, `reveal_folder(scope)` and
`open_folder_in_terminal(scope)`, that resolve the window's granted root and
call the opener's Rust API: `reveal_item_in_dir`, and `open_path(root, "Terminal")`,
which is `/usr/bin/open <root> -a Terminal`. The page cannot name another path.

**An app may open a panel.** `open_panel(route)` opens a second window of the
calling app at one of its own routes, labelled `app:<id>:panel`, so the app's
own capability selects it. It is always on top and does not take focus. On
macOS it is a non-activating `NSPanel` with a transparent background, and it is
hidden, never destroyed. Elsewhere it is an always-on-top window that may take
focus, and Linux transparency depends on the compositor. Any app may have one.

**A global shortcut lives until the page unregisters it or Epicenter quits.**
The plugin registers into one process-wide table and delivers presses through
the registering page's `Channel`; nothing unregisters when that WebView is
reloaded or destroyed. A page therefore unregisters its chords before it
registers them. A hidden window keeps its chords live
([ADR-0563](0563-a-hidden-app-window-keeps-running-until-epicenter-quits.md)).

**Whispering's overlay is its panel.**

**Deleted:**

- `replace_global_shortcuts`, `GlobalShortcutRegistry`, `GlobalShortcutTriggered`, and `WHISPERING_WINDOW` (`apps/epicenter/src-tauri/src/shell.rs:16-39`, `:83-158`), once ADR-0563's 30-minute test passes on every platform. On a platform where it fails, Rust keeps starting a recording on the chord.
- `is_autostart_enabled` and `set_autostart_enabled` (`shell.rs:160-177`); Rust enables autostart once on first run, as ADR-0328 decides.
- `open_accessibility_settings` (in `command.rs`, since deleted), replaced by the opener's `openUrl`.
- `MAIN_WINDOW` in `apps/epicenter/src-tauri/src/keyboard/mod.rs:49` and its `emit_to` at `:132`.
- `create_recording_overlay`'s fixed label and URL (`apps/epicenter/src-tauri/src/overlay.rs:24`, `:39`), which become `open_panel`'s.

## Consequences

- A new native need first looks for an official plugin, then for a command in
  an existing custom module; a new Rust module is the last resort.
- Paste into the focused app needs the macOS Accessibility permission, granted
  to Epicenter, not to Whispering: System Settings lists "Epicenter", and every
  installed app granted `write_text` shares that grant.
- Any app granted global-shortcut can unregister another app's chord by naming
  it, and two apps cannot hold one chord; on macOS a second registration of a
  held chord fails (`global-hotkey` 0.8.0, `macos/mod.rs:125-129`). Full trust
  (ADR-0540) accepts the first; the second shows as a registration error in
  the app that asked second.
- A shortcut whose window was destroyed stays registered and fires into a dead
  channel until Epicenter quits. Only a window that closes without hiding
  leaves one behind.
- Open in Terminal works on macOS. Windows and Linux have no terminal the
  opener can open at a directory, so they do not offer it until each has its
  own launch line.
- The panel cannot be destroyed (`lib.rs:1592-1595`), so an app that opens
  one keeps it until Epicenter quits.

## Considered alternatives

- **An embedded command runner in the folder, as the standalone Whispering
  shell had** (`createShellTerminal`, deleted in `2034ddebcb`). A terminal
  without a PTY is worse than the person's own terminal, which Open in
  Terminal reaches.
- **The opener's JS API for reveal and open.** `reveal_item_in_dir` checks no
  scope (opener 2.5.4, `commands.rs:74`), and `open_path`'s scope is a static
  glob, so neither can say "the folder this window holds".
- **Rust keeps the shortcut table and emits to the app's windows.** One more
  custom module beside a plugin that delivers to the page that asked.
- **A per-app autostart toggle.** ADR-0328 leaves login items to the operating
  system.
