# 0563. A hidden app window keeps running until Epicenter quits

- **Status:** Accepted
- **Date:** 2026-10-16
- **Amended by:** [ADR-0596](0596-native-dictation-code-no-page-can-reach-compiles-only-behind-an-off-by-default-cargo-feature.md) at "A hidden window keeps its global shortcuts live" and push-to-talk from boot: no global-shortcut plugin runs in the default shell until a native API decision exposes it.
- **Relates:** [ADR-0323](0323-background-work-runs-in-the-host-and-a-window-is-for-looking-at.md) (a hidden WebView's timers stop after about seven minutes; its rejection of turning off background throttling is reversed below), [ADR-0555](0555-apps-reach-native-code-through-official-tauri-plugins-first-granted-by-app-id.md) (global shortcuts through the plugin, the panel), [ADR-0556](0556-outside-a-webview-typescript-runs-only-as-the-epicenter-cli.md) (background work is an `epicenter` command Rust starts), [ADR-0328](0328-epicenter-runs-when-you-log-in-and-pause-is-the-only-control-it-offers.md) (login items, nothing opens at login), [ADR-0539](0539-epicenters-own-folder-is-so-epicenter-and-machine-state-splits-by-what-it-costs-to-lose.md) (machine state lives in app data).
- **Unbuilt:** all of it: hide on close in Whispering's page, background throttling disabled on installed windows, `open-windows.json` and session restore. Before Whispering relies on a hidden window, a test must hold a push-to-talk chord after the window has been hidden for 30 minutes, on macOS, Windows, and Linux; nobody has measured whether an IPC message wakes a hidden page, and the throttling switch reaches only macOS 14 and later.

## Context

Whispering's native features were written for one built-in window labelled
`whispering`. Until `8bc2aafd03` the shell created that window hidden at every
host start and hid it on close
(`8bc2aafd03^:apps/epicenter/src-tauri/src/lib.rs:1723`, `:1783-1784`), so
push-to-talk worked from boot with no window on screen. Whispering is now an
installed app
([ADR-0552](0552-every-app-is-installed-from-a-folder-in-any-git-repository.md)):
a closed window is destroyed, and nothing reopens an installed window after a
quit.

[ADR-0323](0323-background-work-runs-in-the-host-and-a-window-is-for-looking-at.md)
measured that a hidden WebView's timers stop after about seven minutes, put
background work in the host, and rejected disabling the platform's background
throttling because Tauri honors that switch only on recent macOS, so a
background feature would silently do nothing on Windows and Linux.
[ADR-0556](0556-outside-a-webview-typescript-runs-only-as-the-epicenter-cli.md)
supersedes 0323 and makes background work an `epicenter` command Rust starts.
What a hidden window still has to do is answer an operating-system event: a
chord press delivered over the global-shortcut plugin's `Channel`, or a
recorder event. The throttling switch is reversed for that work only. It helps
on macOS 14 and later and changes nothing elsewhere, and the 30-minute test
decides, per platform, whether a hidden page answers. ADR-0323's withdrawal of
[ADR-0273](0273-an-epicenter-app-is-an-spa-with-a-namespace-and-background-work-is-a-hidden-window.md)'s
hidden-window background work is not revived.

## Decision

**An app does no periodic work in a hidden window.** A hidden window answers
operating-system events: a global-shortcut press, a recorder event, a
dictation capability change. Periodic work is an `epicenter` command Rust
starts (ADR-0556).

**Hide instead of close is the page's choice.** A page that should keep running
calls `getCurrentWindow().onCloseRequested`, prevents the default, and hides
itself. A page that does not is destroyed on close.

**The shell creates every installed window with
`background_throttling(BackgroundThrottlingPolicy::Disabled)`** (tauri 2.12.1,
`webview/webview_window.rs:1254-1269`; the policy is in `tauri-utils` 2.10.1,
`config.rs:1854-1861`). Tauri documents it as honored on macOS 14 and later and
unsupported on Windows and Linux. Only an app that chose hide on close keeps a
hidden page.

**Epicenter reopens the app windows that were open at quit.** It records each
open installed window's label, which spells its app id and folder, and whether
it was visible, in `open-windows.json` in app data (machine state, ADR-0539).
A panel (`app:<id>:panel`, ADR-0555) is not recorded; its app's page opens it
again. A launch by the person restores each window as it was. A login launch
restores every one hidden: a hidden window is not "opening" in ADR-0328's
sense, because nothing appears on screen. A record whose app or folder is gone
is dropped.

**A hidden window keeps its global shortcuts live.** A chord registered through
the global-shortcut plugin lives until its page unregisters it or Epicenter
quits (ADR-0555). ADR-0328's Pause stops the background work Rust starts and
leaves an app's chords registered.

**Once opened, Whispering's window hides instead of closing, so session restore
reopens it at every launch.** With Epicenter in login items, push-to-talk works
from boot, as it did before `8bc2aafd03`.

## Consequences

- Every hidden app window costs one WebView content process. Nobody has
  measured it here.
- A person sees Whispering's window where they left it after a restart, sees
  nothing at login, and sees Epicenter's tray icon turn red while recording
  (`set_tray_recording_state`, `apps/epicenter/src-tauri/src/shell.rs:64`).
- Before Whispering's window is opened once, its chords are not registered.
- On Windows and Linux a hidden page may still be suspended. If the 30-minute
  test fails on a platform, starting a recording on the chord moves into Rust
  for that platform.

## Considered alternatives

- **A `background` flag in `epicenter.app.json`** that starts an app hidden.
  Session restore already reopens the window, and a flag is a second way to say
  the same thing.
- **`tauri-plugin-window-state` for session restore.** It restores size,
  position, and visibility of windows the app creates; it does not recreate
  windows open at quit. It may still restore their geometry.
- **Keep refusing the throttling switch, as ADR-0323 did.** Every hidden page
  on macOS would then depend on the operating system's suspension policy for a
  chord a person holds down.
