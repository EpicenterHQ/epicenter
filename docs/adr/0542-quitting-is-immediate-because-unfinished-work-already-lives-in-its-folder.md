# 0542. Quitting is immediate, because unfinished work already lives in its folder

- **Status:** Proposed
- **Date:** 2026-10-15
- **Unbuilt:** deleting the departure round, the page quit voters, the folder plugin's quit wait, the standalone close gates, and the native quit harnesses.

## Context

Quitting Epicenter runs a departure round: `apps/epicenter/src-tauri/src/departure.rs`
and `departure/machine.rs` ask each participant window (Capture, Todos) through
`departure_status` and `departure_answer`, wait for each page to settle, fall
back to a native three-button dialog after three seconds, and intercept macOS
quits in `departure/terminate.rs`. The folder plugin then fences new work and
waits up to ten seconds (`PAGE_WORK_GRACE`). Honeycrisp has its own close gate
(`close.rs`, `quit.rs`); Whispering relays close requests through its Bun host
and holds a recording, captured audio, and run results in page memory
(`unsavedWork()` in `library.svelte.ts`). No record holds the design; it lives in
module docs and the "Leaving Epicenter" section of `apps/epicenter/README.md`.

Todos and Honeycrisp already ask nothing: they wait until nothing is saving and
approve. Every save is an atomic rename ([ADR-0531](0531-the-page-runs-the-folder-engine-and-the-shell-grants-the-directory.md)).
The folder's cross-process lock is released by the OS when the process ends
(`core/src/lock.rs`).

## Decision

**Quitting is immediate.** No window is asked, nothing is waited for, and no
dialog appears. A host restart reloads the windows; a sign-in or sign-out
restart is immediate, as [ADR-0415](0415-runtime-replacement-ends-application-sessions.md)
decided.

**No work lives only in memory longer than a keystroke, where the host allows
it.** Text is saved when a person submits it; a field mid-edit is lost on quit,
as people expect, including Capture's "New capture" text and thought inputs
before they are added. Long-running work writes its row and its output into the
folder from the start:

| Work | Written when it starts | Filled when it finishes |
| --- | --- | --- |
| A recording | `recordings/<name>.md` and the audio file ([ADR-0543](0543-a-recording-streams-into-its-folder-from-the-moment-it-starts.md)) | The audio, as it is captured |
| A transcription or recipe run in Whispering | Its result row, with every field fixed and an empty body | The body, when the answer arrives |
| A recipe run on pasted text | The same row, saved without a separate Save | The body |

A row with no body and no live request is unfinished, derived, never written as
a status. If writing an answer fails, the page retries the write while it lives;
after a reload the row stays without a body and a person runs it again. In the
browser, a page refresh may lose work in progress, and the folder shows what is
missing.

**Persist facts; derive state.** A row records what happened: a file, a time, a
transcript. Nothing that says what is happening is written: no `status`,
`pending`, `running`, `interrupted`, or `failed` field. What is happening lives
in memory and ends with the process, and what a person sees is computed from
files and live handles each time.

**Unfinished work is repaired when its folder opens, idempotently.** A
recording whose audio was cut off has its header rewritten
(`recoverRecordings`, ADR-0543). Leftover scratch is swept by age, as today. A
Git ref lock left by a commit cut off at quit is reported by Git, and a person
or an agent deletes it ([ADR-0503](0503-file-authoritative-workflows-preserve-information-and-tolerate-repairable-states.md)).

**Saves are durable against a crash, not against power loss.** There is no
`fsync`.

## Consequences

Deleted, about 9,000 lines including tests and harnesses:

| Where | What |
| --- | --- |
| `apps/epicenter/src-tauri` | `departure.rs`, `departure/machine.rs`, most of `departure/terminate.rs`, the `departure-*` capabilities, about 250 lines of `lib.rs` |
| `apps/epicenter/src` | `departure-wire.ts`, `departure-page.svelte.ts`, `departure-window.ts`, the relaunch grant protocol in `sidecar-runtime.ts` and `desktop-auth-authority.ts` |
| `apps/todos`, `apps/capture` | Their departure participants and notices |
| `packages/tauri-plugin-epicenter-folder` | `PAGE_WORK_GRACE` and the shutdown wait |
| `apps/honeycrisp` | `close.rs`, `quit.rs`, the close commands, `examples/quit`, `evidence/native-quit` |
| `apps/whispering` | `closing.ts`, `leave.svelte.ts`, `LeavePrompt.svelte`, the close relay through the Bun host, `examples/quit`, `evidence/native-quit` |

Kept: closing a built-in window hides it; the Bun host's graceful shutdown; the
browser's `beforeNavigate` guards; the shell's checked save.

Also deleted, by writing run results when they start: the held results in
`apps/whispering/src/lib/runs.svelte.ts` (`unsaved`, `retrySaveResult`,
`saveTextRun`, `discardTransformationRun`, `held()`), part of
`RecoveryNotices.svelte`, and their tests, about 1,000 lines. With
[ADR-0545](0545-an-interrupted-incoming-update-is-ordinary-changed-files-and-the-next-sync-finishes-it.md)
and ADR-0543 the two principles delete about 14,000 lines in all.

Kept, because each is a fact rather than a state: Capture's
`recovery/legacy-import-receipt-<account>.json`, which records which old items
were imported so a deleted capture is not imported again; the scratch directory
`.git/epicenter/scratch`; and the sibling `.<folder>.epicenter-lock` file.

Lost: what a person typed and did not submit, a recording in the browser on
refresh, and the last fraction of a second of audio buffered when a desktop
process ends.

[ADR-0374](0374-the-host-selects-one-account-and-replacement-restarts-its-applications.md)'s
"native close barrier" and "one awaited departure" no longer hold; it is edited
to match.

## Considered alternatives

- **A flag per window for unsaved work, and "Quit anyway?" only when one is
  up.** About 150 lines, and the only work it would have guarded is a
  recording, which ADR-0543 keeps on disk instead.
- **Keep a short wait for running `git` commands.** Commits rename private
  index copies, so a cut commit leaves at most a ref lock Git names.
- **`fsync` before each rename.** Guards power loss, which is not the failure
  this product meets.
