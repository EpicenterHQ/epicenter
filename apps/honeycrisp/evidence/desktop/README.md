# Standalone desktop acceptance

Verified on macOS arm64 on 2026-10-01. Codex operated the actual Honeycrisp
Tauri release bundle through computer use, inspected native files and Git,
and independently reviewed the implementation. The desktop workflow passed:
create, format, save, edit externally, resolve a conflict, quit, and reopen.

Claude Opus 5.5 implemented in the isolated checkout
`/tmp/honeycrisp-opus-20261001`, starting at
`c9699838ac50e0bcbc8d5fbaa87acf556c225a3b`. GPT-6.1 Codex supervised,
integrated, verified, and repaired the live checkout. Worker reports were not
acceptance evidence. Unrelated changes and concurrent Whispering work were
preserved. No repository commits or staging were performed.

## Run and build

From the repository root:

```sh
bun dev:honeycrisp
bun build:honeycrisp
```

For a disposable native directory and test controls:

```sh
HONEYCRISP_ROOT=/tmp/honeycrisp-test HONEYCRISP_FAULTS=1 bun dev:honeycrisp
```

The root development command was also run with
`HONEYCRISP_ROOT=/tmp/honeycrisp-acceptance-20261001/dev-root`; it compiled
and started the debug shell and its native folder host. Desktop UI acceptance
used the release bundle, launched from the repository root with:

```sh
HONEYCRISP_ROOT=/tmp/honeycrisp-acceptance-20261001/ui-root \
HONEYCRISP_FAULTS=1 \
apps/honeycrisp/src-tauri/target/release/bundle/macos/Honeycrisp.app/Contents/MacOS/honeycrisp
```

The packaged app was also opened without a root override: Files displayed
`/Users/braden/Epicenter/local/so.epicenter.honeycrisp`. The fresh root had
`kv.json`, `notes/`, `folders/`, and `.git/`, without an account or API setup.

Browser checks use `bun build:honeycrisp:ui`. Browser storage is a logical
IndexedDB folder; native acceptance did not use that adapter.

## Native acceptance

| Scenario | Observed result |
| --- | --- |
| 1. Fresh standalone launch | App-owned Tauri shell and native host opened an empty root without sign-in, Epicenter bootstrap, or hosted API. |
| 2. Create, rename, organize, edit | Created notes and a logical folder, changed titles, assigned folder membership, and renamed a saved file through Files. Membership kept the original note stem. |
| 3. Formatting and reopen | Exercised bold, italic, strike, inline code, link, headings 1 through 3, bullet, numbered and checked task lists, quote, fenced code, divider, Undo and Redo. Native Markdown and reopened rich text retained them. |
| 4. Source and rich text | Held a save, changed Source, and switched to rich text. Both displayed the same current draft, including later typing. |
| 5. Untouched bytes | Opened and switched views on the saved formatted note without editing. Native bytes equaled the captured before-image. |
| 6. Frontmatter preservation | An external edit inserted an unknown value, map, and comment. A subsequent body edit preserved their exact source strings. |
| 7. Outside edits | Ran real `pwd`, `git status`, and `git log` in Terminal, appended a body through the shell, and separately edited through an external process. Clean UI refreshed without import or restart. Reveal opened the same root in Finder. Terminal state remained while hidden. |
| 8. Dirty conflict | Failed a save, changed the file externally, and observed paused autosave, retained draft, Compare, and explicit overwrite. Switching notes retained the conflict draft. |
| 9. In-flight typing | Held the captured save, added newer text, released it with delay, and saw the in-flight status. Git recorded captured text first, then newer typing in the next commit. |
| 10. Delete or corrupt | Deleted a dirty note externally. Its draft remained and Save draft as a note recovered it. A malformed frontmatter file stayed listed and was repaired through Source. |
| 11. Undo and redo | Undid and redid rich edits. Clean external adoption reset obsolete Undo; new Source content replaced the rich document. |
| 12. Save and commit faults | Failed save retained the draft and left native bytes unchanged. Failed commit left the file saved and displayed a separate Git failure. Explicit commit retry succeeded. |
| 13. Quit and relaunch | Reopened the repaired release bundle and verified saved formatting, metadata, notes, and per-note Git history. Cmd+W, Cmd+Q, and reload protected unsaved work. |
| 14. Historical restore | Restored commit `8c2ac39` into a separate root, opened it natively, and quit. Restored bytes remained exactly equal to the Git version. |
| 15. No Yjs runtime | Audited the actual Svelte desktop build: 1,635 runtime modules, zero Yjs, auth, or sync modules. Host build contained 898 modules; platform tests also checked the browser and host graphs. |

All listed UI scenarios were exercised in the native release app. Automated
tests additionally cover unreadable files, stale saves, deterministic
save/refresh races, semantic document equivalence, and rich-session history.

The first native Cmd+Q attempt exposed Cocoa's predefined Quit bypassing
Tauri's exit guard. A custom native menu action fixed it. Final review also
removed the asynchronous draft-count permission race: every close now asks
the page. Native retesting held an immediate quit. Killing only the disposable
file host kept the window and draft readable in Source; Keep editing retained
it, and explicit Discard and quit exited. Tests cover close requests arriving
before page mount and across event-stream reconnects.

Superseded: [ADR-0542](../../../../docs/adr/0542-quitting-is-immediate-because-unfinished-work-already-lives-in-its-folder.md)
removed this close gate. Closing the window or quitting now quits at once,
and each save renames into place, so nothing is asked or waited for.

## Files and Git

[Native evidence](native-evidence.json) records the canonical roots, file
sizes and SHA-256 hashes, full commit IDs, clean Git status, and final assertions.
The [current files](native/current/notes/uiev0ddolh.md) are copied from the
actual native directory, with its [logical folder](native/current/folders/glvayou6cq.md).

The delayed-save proof has two independent persisted versions:

- `f3f7bed`: [captured save](native/captured-save.md) has “Captured save text.”
  and excludes newer typing.
- `fb9fc19`: [next save](native/newer-save.md) contains both captured text and
  “Newer typing during save.”

Commit failure did not roll back the native file. The retry became `3a100b8`.
The [recovered note](native/current/notes/recovered-note.md) retains the deleted
draft, and the [repaired source](native/current/notes/malformed.md) retains its
body. [Historical bytes](native/historical-restored.md) match the separately
opened restore. Final native Git status was clean, with no remaining Git locks.

## Screenshots

These are unaltered captures from actual Tauri interaction. They show UI state;
the files and Git versions above supply persistence evidence.

![Formatted native editor](screenshots/formatted-editor.png)

![Source view](screenshots/source.png)

![Native Files](screenshots/files.png)

![Native Terminal and Git](screenshots/terminal-git.png)

![Dirty conflict and recovery](screenshots/conflict-recovery.png)

Additional captures: [in-flight typing](screenshots/held-save-newer-typing.png),
[save failure](screenshots/save-failure.png),
[commit failure](screenshots/commit-failure.png),
[Cmd+Q protection](screenshots/native-quit-protection.png),
[host-loss protection](screenshots/host-loss-protection.png),
[retained Source after host loss](screenshots/host-loss-retained-source.png),
[unsupported source](screenshots/source-only-refusal.png),
[Finder reveal](screenshots/reveal-folder.png),
[note history](screenshots/note-history.png),
[historical restore](screenshots/historical-restore.png), and
[default root](screenshots/default-root-launch.png).

## Automated checks

| Command from repository root | Result |
| --- | --- |
| `bun run --cwd apps/honeycrisp test` | [150 passed, 415 assertions](checks/final-tests.log). |
| `bun test packages/app/src/files` | [90 passed, 492 assertions](checks/shared-files-tests.log). |
| `bun run --cwd apps/honeycrisp typecheck` | [Browser and Tauri Svelte checks: zero errors or warnings; scripts TypeScript passed](checks/final-typecheck.log). |
| `bun build:honeycrisp:ui` | [Passed](checks/browser-build.log). |
| `bun build:honeycrisp` | [Passed; built macOS release bundle and compiled host](checks/final-desktop-build.log). |
| `bun x biome check --diagnostic-level=error apps/honeycrisp` | [Passed](checks/lint.log). |
| `bun run check:boot-purity` and `bun run check:ui-boundary` | Passed. |
| `git diff --check` on owned edits | Passed. |

The independent [cumulative review](review.md) records ownership boundaries and
repaired findings. [Runtime audit](runtime-audit.json) includes the real Svelte
editor and draft modules, rather than relying only on a synthetic import probe.

Two broader checks remain outside this milestone's passing checks.
<!-- doc-path-check: ignore-next-line -->
`packages/app/src/product-startup.test.ts` fails its LocalMail and Vocab cases
resolving `wellcrafted/logger` and `wellcrafted/error`; the same failures were
reproduced against unchanged task-start source in the isolated checkout
([live](checks/product-startup-tests.log),
[baseline](checks/baseline-product-startup-tests.log)). Global `check:doc-paths`
reports 51 dead references in the shared checkout. Its three Honeycrisp paths
were already absent at task-start HEAD; the remaining references include
historical reports and concurrent app work. Those shared failures were not
silently repaired or reported as passing.

## Clean break and limits

Removed Honeycrisp's direct `@y/y` and `@y/prosemirror` dependencies, Yjs editor
and undo bindings, workspace resources/store, providers, sync/device/Svelte
store dependencies, account lifecycle scripts, auth routes, and hosted auth
platform leaves. Added native `prosemirror-history`. No migrations, legacy
readers, or dual writes exist. The auth account-popover smoke fixture remains
because another package consumes it; its auth/app-shell dev dependencies are
outside the app runtime.

HTML, images, and tables remain accessible in Source only. Underline is absent.
The editor refuses Markdown-unspellable emphasis boundaries and heading line
breaks. Empty paragraphs, terminal block line breaks, and emphasis on whitespace
alone do not carry content semantics. Rich edits may normalize spelling;
opening or merely switching views does not rewrite a file.

Native conditional saves check immediately before replacement, without a
filesystem-wide atomic compare-and-swap guarantee against arbitrary writers.
Drafts live in the window and do not survive killing or crashing the app.
The native terminal is a retained command runner, without a PTY or interactive
input; output arrives on command completion and environment changes do not
persist between commands.

Windows, Linux, OS shutdown/logout, Dock Force Quit, notarization, and installers
were not verified. The tested artifact is the macOS arm64 demo bundle. Remote
sync, accounts, and collaboration are outside this milestone.
