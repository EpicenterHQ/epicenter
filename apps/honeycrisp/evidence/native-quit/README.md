# System quit on macOS: guard and harness

This wave closes one gap in the shell: a quit from macOS itself skipped the
close gate. It covers the guard in `src-tauri/src/quit.rs`, what checks it,
and what that does not show.

## The gap

The versions are the ones `src-tauri/Cargo.lock` pins: tauri 2.12.1,
tauri-runtime-wry 2.12.1, and tao 0.37.1, as published on crates.io. Each
fact below names the published crate, its file, and the item:

- tao 0.37.1, `src/platform_impl/macos/app_delegate.rs`,
  `APP_DELEGATE_CLASS`: the delegate class `TaoAppDelegateParent`, an
  `NSResponder` subclass. It adds `applicationWillTerminate:`
  (`application_will_terminate`, which calls `AppState::exit()`) and no
  `applicationShouldTerminate:`.
- tao 0.37.1, `src/platform_impl/macos/app_state.rs`: `AppState::exit` sends
  `Event::LoopDestroyed`. `AppState::cleared` sends `stop:` to the app, never
  `terminate:`, once the handler should exit.
- So AppKit's `terminate:` (the Dock's Quit, a logout or restart, an Apple
  Event) asks no one. It runs `applicationWillTerminate:`, the loop is
  destroyed, and `RunEvent::Exit` follows with no `RunEvent::ExitRequested`
  before it. The gate is never asked, and the page's drafts are lost.
- tauri 2.12.1, `src/app.rs`, `AppHandle::exit`: it calls the runtime's
  `request_exit`. Only if that fails, which means the event loop is already
  gone, does it clean up and call `std::process::exit`.
- tauri-runtime-wry 2.12.1, `src/lib.rs`: `request_exit` sends
  `Message::RequestExit` through the event loop proxy. The loop's handler
  answers that message with `RunEvent::ExitRequested`. When nothing prevents
  the exit, the handler sets `ControlFlow::ExitWithCode(code)`, and `Event::LoopDestroyed`
  becomes `RunEvent::Exit`.

## The guard

During setup, before the menu, the folder, or the window, `quit::install`:

1. Checks it is on the main thread (`pthread_main_np`).
2. Checks the class named `TaoAppDelegateParent` is registered, and that the
   object `[NSApp delegate]` holds is exactly an instance of that class.
3. Checks the class does not already answer `applicationShouldTerminate:`,
   inherited methods included (`class_getInstanceMethod`).
4. Stores the `AppHandle` once (`OnceLock`).
5. Adds the method with `class_addMethod`, type encoding `Q@:@`
   (`NSUInteger` return, 64 bits, asserted at compile time; `self`, `_cmd`,
   sender). The `BOOL` result is read as one byte.

If any step fails, setup returns an error and the app does not start. The
delegate object, its other methods, its ivars, and the event loop proxy are
not touched. No `objc2` dependency was added. The calls go straight to the
Objective-C runtime's C functions, each cast to its exact prototype, so
`Cargo.lock` is unchanged.

The method always returns `NSTerminateCancel`. It takes no lock and keeps no
state. With no stored handle it only cancels. Otherwise it calls
`app.exit(0)`, which with a live event loop only posts a message. The call
sits inside `catch_unwind`, which stops an unwinding panic from crossing into
AppKit, and that is all it covers. A release build aborts on panic
(`panic = "abort"`). If the event loop were already gone, Tauri's own fallback
would end the process, as described above. The exit request then goes through
the existing
`ExitRequested` → `hold` → `CloseGate` path, exactly like the Quit menu item.
The gate and its page are the only things that consent. An exit the gate lets
through ends with `stop:`, never `terminate:`, so the method is not asked
again. On `RunEvent::Exit` the folder plugin refuses new page work, waits up
to 10 seconds for the page's file and Git commands already running, and
unlocks the folder, as for every other exit.

There is no `NSTerminateNow` or `NSTerminateLater` branch, no modal check, no
mirror of the gate's state, and no resumed logout. These are deliberate. A
logout or restart is therefore cancelled even when nothing is unsaved; the
person starts it again after the app has exited.

Other platforms compile without the module (`#[cfg(target_os = "macos")]`).

## The harness: `src-tauri/examples/quit`

```sh
cd apps/honeycrisp
bun run test:quit                     # builds the page, then the example, then runs it
# or, once built:
src-tauri/target/debug/examples/quit [--root <missing or empty dir>] [--files <n>]
```

It needs a macOS login session: it opens a real window and runs AppKit. By
default it makes a fresh directory under `$TMPDIR` and refuses a named one that
is not empty. It quits only its own process.

What runs is the app that `run()` starts: `honeycrisp_lib::build` with
Tauri on Wry and the locked crates. That includes the guard, the Quit menu,
the folder plugin and its scope, the close gate, the capability, and
`is_app_page`. Only the window's page differs. `on_web_resource_request`
replaces `index.html` with `page.html`. After the page loads, the harness
evaluates `page.js` in it, a page-like voter that uses the window's real
IPC: `close_register`, `plugin:event|listen` for `close-requested`,
`plugin:epicenter-folder|grant_directory`, `make_folder_directory`,
`write_folder_file`, `close_opened`, `close_decline`, and `close_approve`.
These are the commands the folder engine writes with; the fixture page does
not run the engine, so the harness makes the empty repository the engine
would. The harness itself never touches the gate.

Each quit is `[NSApp performSelector:@selector(terminate:) withObject:nil
afterDelay:0]`, posted from a main-thread task. AppKit sends `terminate:` on
a later turn of the main run loop, outside every Tao callback.

| Step | What the harness checks |
| --- | --- |
| Page loaded | `TaoAppDelegateParent` answers `applicationShouldTerminate:` with encoding `Q@:@`. |
| Ready | The page took the folder's grant, said its folder is open, and wrote `harness/ready.json`. The folder's cross-process lock is held. |
| First quit | Exactly one `ExitRequested`, code `Some(0)`, held by the app's own `hold_exit`. The shell sent the page one `close-requested` request, and the page declined that request. Afterward it still wrote `harness/declined.json`. The lock is still held and the process is still running. |
| Batch | The page sends `--files` writes of new files (default 4000), each its own `write_folder_file`, and waits for none. The harness waits until some exist and not all: the shell is writing them. |
| Second quit | A held `ExitRequested`, and a second `close-requested` to the same page under a higher request number, so the gate is alive and not closing. The page approves through `close_approve` without settling its writes. That `close_approve` calls `app.exit(0)`, and the resulting `ExitRequested` is not held. At that moment fewer than all the files exist. |
| `RunEvent::Exit` | In the app's own callback, which runs after the folder plugin's handler for the same event: every batch file that exists has its exact bytes, and the lock can be taken. Files missing are writes the shell refused at shutdown; files left in `.git/epicenter/scratch` are counted, not failed, because the engine clears scratch the next time it opens the folder. The log also counts the files written after the approved exit request, which the shell's wait let finish. |

Every line of output is one JSON object. The last line is
`{"event":"verdict","pass":...}`, and the exit status is 0 only on a pass.
Any failed check, and any step that takes over 60 seconds, ends the run with
status 1 and the reason. If the batch finishes before the second quit, the
run fails and says to raise `--files`.

## Probe: `late-method-probe.rs`

This checks the one AppKit behavior the guard depends on without Tauri:
`terminate:` asks a method added to the delegate's class after
`setDelegate:`. A bare `NSApplication` gets a delegate class built like Tao's.
The method is added after the delegate is set. It answers cancel once and
then now. Expected lines: `added`, `should-terminate 1`, `should-terminate 2`,
`will-terminate`. A cached "does not respond" would print `added` and then
`will-terminate` only.

```sh
rustc --edition 2021 -O -o "$TMPDIR/late-method-probe" evidence/native-quit/late-method-probe.rs
"$TMPDIR/late-method-probe"
```

## Results

These results were recorded with the earlier harness, while a Rust folder
owner held the directory: the page sent one batch through the owner's
`apply`, and the owner's drain wrote every file after the approval. The
folder is now opened by the page's own engine and the owner is gone. The
harness above was rewritten for that and has been compiled
(`cargo build --example quit`), not run. The guard, the gate, and the
`terminate:` facts below do not depend on the folder and still hold as
recorded; the batch lines describe the old owner.

The delegated worker wrote this wave in a restricted execution context.
The coordinating agent built and ran that same source in the dedicated clone.
Their results are listed separately.

### Worker: restricted

The worker's sandbox could not read the Cargo home and could not fetch the
locked `specta` git dependency offline, so it built no Rust against Tauri. It
was also not allowed to run an AppKit program. It did run:

- `rustc` on `late-method-probe.rs`: compiled, not run.
- `bun build` on `apps/honeycrisp/src-tauri/examples/quit/page.js`: parsed.
- The page suites, which this wave did not change: 296 pass, and the mounted
  note view 9 pass.

### Root: built and ran

On a Mac with a login session, from `apps/honeycrisp`:

| Check | Result |
| --- | --- |
| `cargo test --locked` | 59 passed, 0 failed. |
| `cargo build --locked --example quit` | Exit 0. |
| `bun run test:native` | 26 pass, 196 assertions. These are the page's close handling with Tauri's `mockIPC` against the real gate, over the folder's storage stand-in; they do not run AppKit. |
| `late-method-probe` | Compiled and ran, exit 0. |
| `examples/quit --root <fresh directory> --files 4000` | Pass, 8.891 s. |

Probe output:

```text
{"event":"added","ok":true}
{"event":"should-terminate","asked":1}
{"event":"should-terminate","asked":2}
{"event":"will-terminate","asked":2}
```

Harness output, in a fresh directory, on Tauri/Wry with real IPC and the real
folder plugin:

```text
{"event":"start","files":4000,"ms":0,"pid":46493,"root":"/private/tmp/complete-row-editing-20261005/honeycrisp-appkit-quit-evidence"}
{"event":"page-loaded","guard":"Q@:@","ms":243}
{"event":"ready","folderLocked":true,"ms":334,"page":{"generation":1,"root":"/private/tmp/complete-row-editing-20261005/honeycrisp-appkit-quit-evidence"}}
{"attempt":1,"event":"terminate-scheduled","ms":334}
{"code":0,"event":"exit-requested","held":true,"landed":0,"ms":335,"of":4000,"stage":1}
{"answer":{"generation":1,"request":1},"asks":[{"generation":1,"request":1}],"event":"declined","exitRequests":[{"code":0,"held":true}],"folderLocked":true,"ms":349,"pid":46493}
{"attempt":2,"event":"terminate-scheduled","landed":3,"ms":372,"of":4000}
{"code":0,"event":"exit-requested","held":true,"landed":4,"ms":372,"of":4000,"stage":3}
{"code":0,"event":"exit-requested","held":false,"landed":6,"ms":373,"of":4000,"stage":3}
{"approvedExitRequestedAt":1791164277716,"event":"exit","exitAt":1791164286168,"folderUnlocked":true,"landed":4000,"lastBatchFileWrittenAt":1791164286146,"ms":8891,"of":4000,"scratchFiles":0,"stage":3}
{"event":"verdict","ms":8891,"pass":true,"problems":[]}
```

What the run shows:

- The first request was declined. The folder stayed locked, and the page
  still wrote to it.
- The second request was approved with 6 of 4000 files written.
- All 4000 files landed with their exact bytes before the app's
  `RunEvent::Exit` callback. The last one was written 8430 ms after the
  approved exit request and 22 ms before that callback.
- The folder was unlocked and scratch was empty.

The coordinating agent kept the raw logs outside the repository; the lines
above are copied from them.

## What this does not show

- That the Dock's Quit, a logout, a restart, a shutdown, or `osascript`
  reaches `terminate:`. The harness sends `terminate:` itself; none of those
  was used, on any physical machine.
- The notes page, or any production GUI. The fixture page is not the notes
  page. It approves without settling, which the notes page never does, and it
  shows no dialog. That the notes page settles before it approves is covered
  by `bun run test:native` against the real gate, not by this harness. Whether a person sees the prompt after a Dock quit is a GUI
  check this does not make. An attempt to drive the bundled app's window found
  no window to drive.
- A bundled, signed app. The harness is a debug example binary with the same
  configuration and embedded assets.
- Other platforms. The guard and the harness are macOS only.
- What happens when AppKit sends `terminate:` while the gate has already let
  an exit through. That exit ends with `stop:`, and the guard would only ask
  again, but no test sends a second `terminate:` during shutdown.
- That these facts still hold after an upgrade of Tauri, Tao, or macOS. At
  startup the guard checks only the class and the method's absence. Whether
  AppKit asks a method added after the delegate was set is not something
  startup can check. Rerun the probe and `bun run test:quit` after any of
  those upgrades.
- The probe of the lock is the folder plugin's own `RootLock` from the same process.
  It relies on SQLite reporting a second connection in one process as busy.
