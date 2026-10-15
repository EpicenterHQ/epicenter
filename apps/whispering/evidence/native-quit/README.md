# System quit on macOS: guard and harness

A quit from macOS itself skipped Whispering's close handshake. This covers the
guard in `src-tauri/src/quit.rs`, the harness in `src-tauri/examples/quit`, the
probe beside this file, and what none of them show.

## The gap

The versions are the ones `src-tauri/Cargo.lock` pins: tauri 2.12.1,
tauri-runtime-wry 2.12.1, wry 0.57.0, and tao 0.37.1, as published on
crates.io. Each fact names the published crate, its file, and the item, so it
can be read at a fixed version (for example
`https://docs.rs/crate/tao/0.37.1/source/src/platform_impl/macos/app_delegate.rs`):

- tao 0.37.1, `src/platform_impl/macos/app_delegate.rs`, `APP_DELEGATE_CLASS`:
  the delegate class `TaoAppDelegateParent`, an `NSResponder` subclass. It
  adds `applicationWillTerminate:` (`application_will_terminate`, which calls
  `AppState::exit()`) and no `applicationShouldTerminate:`.
- tao 0.37.1, `src/platform_impl/macos/app_state.rs`: `AppState::exit` sends
  `Event::LoopDestroyed`. When the handler should exit, Tao sends `stop:` to
  the application, never `terminate:`.
- So AppKit's `terminate:` (the Dock's Quit, a logout, restart, or shutdown,
  an Apple Event) asks no one. It runs `applicationWillTerminate:`, the loop is
  destroyed, and `RunEvent::Exit` follows with no `RunEvent::ExitRequested`
  before it. `on_run_event` in `src-tauri/src/lib.rs` never sees an exit
  request, no close request reaches the host, and the page is never asked.
  What was only in the page is lost.
- tauri 2.12.1, `src/app.rs`, `AppHandle::exit`: it calls the runtime's
  `request_exit`. Only if that fails, which means the event loop is already
  gone, does it clean up and call `std::process::exit`.
- tauri-runtime-wry 2.12.1, `src/lib.rs`: `request_exit` sends
  `Message::RequestExit` through the event loop proxy. The loop's handler
  answers that message with `RunEvent::ExitRequested`. When nothing prevents
  the exit, the handler sets `ControlFlow::ExitWithCode(code)`, and `Event::LoopDestroyed`
  becomes `RunEvent::Exit`.

Whispering's Quit menu item never had the gap: it is the shell's own item and
calls `request_close` directly. The window's close button goes through
`WindowEvent::CloseRequested`. Both are unchanged.

## The guard

The setup closure that `build` in `src-tauri/src/lib.rs` registers calls
`quit::install` first, before the menu, the folder, the host, or any window.
Tauri 2 runs that closure inside `App::run`, on the main thread, once the
event loop is ready, and sends `RunEvent::Ready` after it. It:

1. Checks it is on the main thread (`pthread_main_np`).
2. Checks the class named `TaoAppDelegateParent` is registered, and that the
   object `[NSApp delegate]` holds is exactly an instance of that class.
3. Checks the class does not already answer `applicationShouldTerminate:`,
   inherited methods included (`class_getInstanceMethod`).
4. Stores the `AppHandle` once (`OnceLock`).
5. Adds the method with `class_addMethod`, type encoding `Q@:@`
   (`NSUInteger` return, 64 bits, asserted at compile time; `self`, `_cmd`,
   sender). The `BOOL` result is read as one byte.

If any step fails, setup returns the error and Tauri panics in `run` before
the menu, the host, or any window exists: the app does not start. The delegate object, its
other methods, and its state are not touched; nothing replaces or wraps it.
No dependency was added: the calls go straight to the Objective-C runtime's C
functions, each cast to its exact prototype, and `Cargo.toml` and
`Cargo.lock` are unchanged by this wave.

The method always returns `NSTerminateCancel`. It takes no lock and keeps no
state. With no stored handle it only cancels. Otherwise it calls
`app.exit(0)`, which with a live event loop only posts a message. The call is
inside `catch_unwind`, which stops an unwinding panic from crossing into
AppKit, and that is all it covers. A release build aborts on panic
(`panic = "abort"`). If the event loop were already gone, Tauri's own fallback
would end the process, as described above; that is not a state the harness
reaches.

The exit request then takes the existing path, exactly like any other exit
request: `on_run_event` holds it unless `close_approved` is set and calls
`request_close`, which writes `{"type":"close-requested"}` to the host's
standard input. The host asks the page over `/bridge/events`; the page answers
with `POST /bridge/app { op: "close" }`; on `proceed` the host prints
`{"closeApproved":true}` and the shell sets `close_approved` and calls
`app.exit(0)`. A host that is gone keeps the window and raises
`whispering:close-blocked` in the page, which answers by navigating to the
quit address. A start that never opened a page exits. The page and these
rules are the only things that consent; the guard mirrors none of their state.
An approved exit ends with `stop:`, never `terminate:`, so the method is not
asked again. On `RunEvent::Exit` the folder plugin refuses new page work, waits
for the page's file and Git commands still running, and unlocks the folder,
and `on_run_event` stops the host, as for every other exit. The page settled
its own saves before it approved; nothing drains them after.

There is no `NSTerminateNow` or `NSTerminateLater` branch, no modal check, and
no resumed logout. These are deliberate:

- A logout, restart, or shutdown is always cancelled while Whispering runs,
  even when nothing is unsaved. The person starts it again once Whispering has
  fully exited.
- Force Quit, `kill`, a crash, or power loss are not `terminate:` and are not
  asked. Whatever was only in the page is lost, as before. A page that never
  answers keeps the app running, so Force Quit is the way out, and it loses
  any draft the page held.

Other platforms compile without the module (`#[cfg(target_os = "macos")]`).

## The harness: `src-tauri/examples/quit`

```sh
cd apps/whispering
WHISPERING_BUN="$(command -v bun)" bun run test:quit --scenario approve
WHISPERING_BUN="$(command -v bun)" bun run test:quit --scenario early
WHISPERING_BUN="$(command -v bun)" bun run test:quit --scenario host-gone
WHISPERING_BUN="$(command -v bun)" bun run test:quit --scenario no-page
# or, once built:
src-tauri/target/debug/examples/quit [--scenario approve|early|host-gone|no-page] \
  [--dir <missing or empty directory>] [--files <n>]
```

It needs a macOS login session: it opens a real window and runs AppKit. It
needs this app's dependencies installed (the host runs from `native/main.ts`)
and a loopback port. `WHISPERING_BUN` must name the Bun executable itself, not
a wrapper script: `host-gone` kills the shell's direct child. By default the
run's directory is new under `$TMPDIR`; a named one must be missing or empty.
It holds the folder (`data`), the folder's lock beside it
(`.data.epicenter-lock`), and the fixture page (`page`), and is kept for
inspection. The harness clears every inherited `WHISPERING_*` variable except
`WHISPERING_BUN`, sets `WHISPERING_DATA_ROOT` to the run's folder, and points
Git at no user or system configuration. It quits only its own process and
kills only its own child.

What runs is the app `run()` starts: `whispering_lib::build` with Tauri on Wry
and the locked crates, and `whispering_lib::on_run_event` for every run event.
The harness drives nothing until its run callback has seen `RunEvent::Ready`,
so the app's setup has finished, and it reads the guard and the window on the
main thread. Each wait is bounded by the same 60 seconds as every other step.
That includes the guard, the Quit menu, the folder plugin and the
folder's registration, the capability, the navigation rule, the per-launch credential,
the host's stdout reader, `request_close`, and `stop_host`. The host is the
real Bun host from `native/main.ts`, started by `host_command` as a debug
shell starts it. The one difference is the page: `build(Some(page))` sets the
host's `WHISPERING_UI_DIST` to the run's fixture directory, so the host serves
`page.html` and `page.js` in place of the built page. The harness itself never
sets `close_approved` or calls `request_close`.

`page.js` is a page-like voter in the main window, on the host's origin, with
the window's real IPC and the credential the shell injects. It hears the close
question on the host's real `/bridge/events` stream and answers through the
host's real `/bridge/app` `close` operation, as the desktop workspace does. It
opens the folder as the page's engine does: `grant_directory`, then
`git init` through `run_git`. It writes each file as the engine does, its
bytes staged under `.git/epicenter/scratch` with `write_folder_file` and then
renamed over the path with `rename_folder_path`: two commands, so a quit
between them leaves the path as it was. It answers `proceed` only in answer
to a `close-requested` line on its stream, so a let-through exit request after
the second quit means the real relay carried that second question and its
approval.

Each quit is `[NSApp performSelector:@selector(terminate:) withObject:nil
afterDelay:0]`, posted from a main-thread task. AppKit sends `terminate:` on
a later turn of the main run loop, outside every Tao callback.

The folder's lock is probed from a separate Bun process (`lock-probe.ts`)
asking for the same exclusive SQLite transaction the folder plugin holds. Child
processes are read with `pgrep -P` on the harness's own process.

### `approve` (default)

| Step | What the harness checks |
| --- | --- |
| Ready | The page was granted the run's folder and wrote `harness/ready.json` through the folder plugin. `TaoAppDelegateParent` answers `applicationShouldTerminate:` with encoding `Q@:@`. The lock is held. The host is the one child process and serves its port. |
| First quit | Exactly one `ExitRequested`, code `Some(0)`, held by `on_run_event`. The page answered `cancel` and then wrote `harness/declined.json` (`{"asked":1}`). The lock is still held, and the same host is still running and serving. |
| Batch | The page starts writing `--files` new files (default 4000), one after another, and does not wait for them. The harness waits until the first file exists and the last does not. |
| Second quit | A held `ExitRequested`. The page waits until its batch has settled, as Whispering's page does, then answers `proceed`; after the host printed its approval, an `ExitRequested` that is not held. At that moment every batch file exists. |
| `RunEvent::Exit` | In the app's own callback, after the folder plugin's handler for the same event and after `on_run_event` stopped the host: every batch file exists with its exact bytes, `declined.json` is still there, `.git/epicenter/scratch` is empty, the lock is free, the harness has no child process, and nothing accepts connections on the host's port. |

### `early`

As `approve`, but at the second quit the page answers `proceed` at once, with
its batch still being written, which Whispering's page never does. Nothing
drains the batch after the approval: the folder plugin only waits for the one
command already running. At `RunEvent::Exit` the approved exit request came
before the batch finished, the batch files that exist are exactly the first
ones in order, each with its exact bytes, at least one is missing, scratch
holds at most one staged copy and that copy is the next file's whole bytes,
the lock is free, and the harness has no child process. The next opening
removes the staged copy (`directory-adapter.ts` in `packages/folder`, tested
in `directory-folder.test.ts`); the harness does not reopen the folder.

### `host-gone`

After Ready, the harness kills the host (`kill -KILL`) and waits until its port
refuses connections. First quit: one held `ExitRequested`; the shell finds the
host gone and the page open, keeps the window, and raises
`whispering:close-blocked`; the page writes `harness/blocked.json`
(`{"blocked":1}`) through the folder plugin, so the folder is still open without the
host, and the lock is still held. Second quit: held again, and the page
answers by navigating to `/__whispering__/quit`; the shell refuses that
navigation and, because the host is gone, sets `close_approved` and exits. At
`RunEvent::Exit`: `blocked.json` is there, scratch is empty, the lock is free,
and the harness has no child process.

### `no-page`

The run's `data` is a regular file, so `start` fails before any host starts
and the shell opens its failure page. After `RunEvent::Ready` the harness
checks, on the main thread, that the guard is installed and the failure
window exists, and that there is no child process. One
quit: a held `ExitRequested`, then one that is not held, because no app page
was ever opened (`WithoutHost::Exit`). At `RunEvent::Exit`: the file is
unchanged, no lock file was created, and there is no child process.

Each harness report is one JSON object; host diagnostics may also appear. The last report is
`{"event":"verdict","pass":...}`, and the exit status is 0 only on a pass.
Any failed check, and any step that takes over 60 seconds, ends the run with
status 1 and the reason. If the batch finishes before the second quit, the
run fails and says to raise `--files`.

## Probe: `late-method-probe.rs`

This checks the one AppKit behavior the guard depends on, without Tauri or
any crate: `terminate:` asks a method added to the delegate's class after
`setDelegate:`. A bare `NSApplication` (no Dock icon, no window) gets a
delegate class built like Tao's. The method is added after the delegate is
set. It answers cancel once and then now. Expected lines, exit status 0:
`added`, `should-terminate 1`, `should-terminate 2`, `will-terminate 2`. A
cached "does not respond" would print `added` and then `will-terminate` with
`asked` 0, and exit 1.

```sh
rustc --edition 2021 -O -o "$TMPDIR/late-method-probe" evidence/native-quit/late-method-probe.rs
"$TMPDIR/late-method-probe"
```

## After an upgrade

At startup the guard checks only the class, the delegate's class, and the
method's absence. Whether AppKit asks a method added after the delegate was
set, and whether Tao still reaches `RunEvent::Exit` from `terminate:` without
asking, are not things startup can check. After any upgrade of macOS, Tauri,
tauri-runtime-wry, Wry, or Tao, rerun the probe and all four harness
scenarios. If Tao starts answering `applicationShouldTerminate:` itself, the
app refuses to start, and the guard must be reconsidered rather than removed
blindly.

## Results

### Page engine: run on macOS, 2026-10-14

The harness after Whispering's folder moved to the page's own engine, run on
a Mac with a login session, from a debug example build of this source.

| Scenario | Actual result |
| --- | --- |
| approve (4,000 files) | Pass in 3,429 ms. The approved exit request came with all 4,000 files written; every file exact, scratch empty, lock free, no child, no listening host. |
| early (4,000 files) | Pass in 559 ms. Approved with 3 files written; at exit 3 files, each exact, and one staged copy in scratch holding the fourth file's whole bytes; lock free, no child. |
| host-gone | Pass in 562 ms. |
| no-page | Pass in 222 ms. |

The late-method probe was not rerun; nothing it checks changed.

### Coordinator: reproduced on macOS, with the folder's Rust owner

These results are from the build before the page engine, when the folder's
Rust owner drained an early approval itself. The `approve` row below shows
that drain, which no longer exists.

The coordinator ran the final source on the same Mac outside the worker's
restricted sandbox. These are debug harness results from isolated disposable
directories, with the real Wry window, AppKit callback, Bun host and Folder
plugin.

| Check | Actual result |
| --- | --- |
| Locked Rust tests | 14 passed, no failures. |
| Locked example build | Exit 0. |
| Late-method AppKit probe | Added, asked once, asked twice, will-terminate after the second answer; exit 0. |
| approve --files 4000 | Pass in 8,591 ms. First decline retained host and lock. Second approval arrived with 6 files written. Exit found all 4,000 exact files, zero scratch, a free lock, no child and no listening host. |
| host-gone | Pass in 520 ms. First quit retained page and lock; the explicit second quit exited and unlocked. |
| no-page | Pass in 215 ms. Setup installed the guard and opened the failure window. One held request followed by an allowed request exited without creating a Folder lock. |

In the final approval run, the last batch file was written 7,968 ms after
approval and 54 ms before Exit. This demonstrates admitted work draining
after approval.

The raw native outputs are preserved in [results](results/):
[approval and drain](results/approve.log),
[host gone](results/host-gone.log),
[startup failure](results/no-page.log), and
[late method probe](results/late-method.log).
They came from the same final source and locked dependencies as the tests and
example build above. The worker could not run AppKit or fetch Cargo sources in
its restricted environment; the coordinator reproduced these checks outside
that restriction.

## What this does not show

- That the Dock's Quit, a logout, a restart, a shutdown, or `osascript`
  reaches `terminate:`. The harness sends `terminate:` itself.
- Whispering's page, or any production GUI. The fixture page is not
  Whispering's page. In `approve` it settles its saves before it approves, as
  Whispering's page does; in `early` it does not, which Whispering's page
  never does. It shows no dialog. Whether a person sees the prompt after a
  Dock quit is a GUI check this does not make.
- A bundled, signed app or the compiled host. The harness is a debug example
  binary, and its host is `native/main.ts` run by Bun.
- Other platforms. The guard and the harness are macOS only.
- What happens when AppKit sends `terminate:` while an approved exit is
  already under way. That exit ends with `stop:`, and the guard would only
  ask again, but no check sends a second `terminate:` during shutdown.
- A `terminate:` that arrives while the event loop is already gone, where
  `app.exit` would end the process through Tauri's fallback. `catch_unwind`
  only keeps a panic from unwinding into AppKit; it is not a claim about that
  state.
